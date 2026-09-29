/* ProBeing — the Google Tasks mirror's logic, shared by the browser and the server.
 *
 * The browser loads it as a classic <script> after day.js; the tasks-sync Edge
 * Function imports it and reads globalThis.ProBeingTree at the bottom. So, as in
 * day.js: no import/export, valid in strict mode, and nothing here touches the
 * page, the network or storage.
 *
 * Mirror rows are task_nodes rows. Pulled tasks are Google's Task resources.
 */

'use strict';

/* An empty pull is believed only while the mirror holds at most this many open
 * nodes. More than that, and "Google sent nothing" is likelier a fault than a
 * list he emptied. */
var EMPTY_PULL_TRUST = 3;

/** 'YYYY-MM-DD' of a `due`, read as text and never through a Date: Google keeps
 *  only the date, and a time zone would move it a day. null when there is none. */
function dueOf(due) {
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(due || ''));
  return m ? m[1] : null;
}

/** Postgres and Google spell the same instant differently (+00:00 vs .000Z). */
function sameInstant(a, b) {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === Date.parse(b);
}

/** 'open', 'done' or 'gone'. Gone wins: a deleted task is dropped, done or not. */
function nodeState(n) {
  if (n.gone_at) return 'gone';
  return n.g_status === 'completed' ? 'done' : 'open';
}

function nodeOpen(n) {
  return nodeState(n) === 'open';
}

/** 'project', 'subtask', 'deep' (under a sub-task, not mirrored) or 'orphan':
 *  its parent was not in the pull. Google still has the task, so an orphan is
 *  kept as a sub-task of the missing parent rather than marked gone. */
function kindOf(task, byId) {
  if (!task.parent) return 'project';
  var up = byId[task.parent];
  if (!up) return 'orphan';
  return up.parent ? 'deep' : 'subtask';
}

/**
 * What a COMPLETE pull changes in the mirror. Never call it with part of one:
 * anything missing here is marked gone.
 *   mirror  every task_nodes row of this user, gone ones included
 *   pulled  every task Google returned, deleted ones included
 *   nowIso  the stamp for gone_at, g_reopened_at and synced_at
 * Returns {refused: why} when the pull cannot be believed. Otherwise
 * {write, gone, deep, orphans, added, changed, revived}: `write` are whole rows
 * to upsert on (user_id, google_id), all with the same keys; `gone` are the ids
 * of rows to stamp gone_at. A row that has not changed is not written.
 */
function diffPull(mirror, pulled, nowIso) {
  mirror = mirror || [];
  pulled = (pulled || []).filter(function (t) { return t && t.id; });
  var openNow = mirror.filter(nodeOpen).length;
  if (!pulled.length && openNow > EMPTY_PULL_TRUST) {
    return { refused: 'Google Tasks sent back an empty list while ProBeing holds ' + openNow +
                      ' open tasks, so nothing was removed. If you emptied it on purpose, this ' +
                      'clears once the list holds a task again.' };
  }

  var byId = {};
  pulled.forEach(function (t) { byId[t.id] = t; });
  var have = {};
  mirror.forEach(function (n) { have[n.google_id] = n; });

  var out = { write: [], gone: [], deep: 0, orphans: 0, added: 0, changed: 0, revived: 0 };
  var seen = {};
  pulled.forEach(function (t) {
    var kind = kindOf(t, byId);
    if (kind === 'deep') {
      if (!t.deleted) out.deep += 1;
      return;                                   // not mirrored, so a row for it goes below
    }
    if (kind === 'orphan') {
      if (!t.deleted) out.orphans += 1;
      kind = 'subtask';
    }
    var old = have[t.id] || null;
    seen[t.id] = true;
    if (!old && t.deleted) return;              // deleted before we ever saw it

    var done = t.status === 'completed';
    var row = {
      google_id: String(t.id),
      parent_google_id: kind === 'subtask' ? String(t.parent) : null,
      kind: kind,
      title: String(t.title || ''),
      position: String(t.position || ''),
      due: dueOf(t.due),
      g_status: done ? 'completed' : 'needsAction',
      g_completed_at: done ? (t.completed || null) : null,
      g_updated: t.updated || null,
      // Unticked in Google since the last pull: Stage 15 must not tick it straight back.
      g_reopened_at: old && old.g_status === 'completed' && !done ? nowIso
                   : (old && old.g_reopened_at) || null,
      gone_at: t.deleted ? (old && old.gone_at) || nowIso : null,
      synced_at: nowIso
    };
    if (!old) {
      out.added += 1;
    } else if (!sameRow(old, row)) {
      out.changed += 1;
      if (old.gone_at && !row.gone_at) out.revived += 1;
    } else {
      return;
    }
    out.write.push(row);
  });

  // In the mirror, missing from a complete pull: deleted for good, or moved too deep.
  mirror.forEach(function (n) {
    if (!seen[n.google_id] && !n.gone_at) out.gone.push(n.id);
  });
  return out;
}

/** Everything diffPull writes, compared as Postgres hands it back. */
function sameRow(old, row) {
  return (old.parent_google_id || null) === row.parent_google_id &&
         old.kind === row.kind &&
         String(old.title || '') === row.title &&
         String(old.position || '') === row.position &&
         dueOf(old.due) === row.due &&
         old.g_status === row.g_status &&
         sameInstant(old.g_completed_at, row.g_completed_at) &&
         sameInstant(old.g_updated, row.g_updated) &&
         sameInstant(old.g_reopened_at, row.g_reopened_at) &&
         sameInstant(old.gone_at, row.gone_at);
}

/**
 * The Home card: open sub-tasks due on or before `today`, the COUNTER date
 * (day.js's counterDate, so at 02:00 it is still yesterday). Earliest due first.
 * Each is {id, title, project, due, overdue}.
 */
function todaysPlan(nodes, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return [];
  var byGoogle = {};
  (nodes || []).forEach(function (n) { byGoogle[n.google_id] = n; });
  return (nodes || []).filter(function (n) {
    var up = byGoogle[n.parent_google_id];
    var due = dueOf(n.due);
    return n.kind === 'subtask' && nodeOpen(n) && due && due <= today && !(up && up.gone_at);
  }).map(function (n) {
    var up = byGoogle[n.parent_google_id];
    var due = dueOf(n.due);
    return { id: n.id, title: String(n.title || ''), project: up ? String(up.title || '') : '',
             due: due, overdue: due < today,
             order: [due, up ? String(up.position || '') : '', String(n.position || '')] };
  }).sort(function (a, b) {
    for (var i = 0; i < 3; i++) {
      if (a.order[i] !== b.order[i]) return a.order[i] < b.order[i] ? -1 : 1;
    }
    return 0;
  }).map(function (p) {
    delete p.order;
    return p;
  });
}

/** Open, then done, then gone; Google's own order within each. */
function byStateThenPosition(a, b) {
  var rank = { open: 0, done: 1, gone: 2 };
  var d = rank[nodeState(a)] - rank[nodeState(b)];
  if (d) return d;
  var pa = String(a.position || '');
  var pb = String(b.position || '');
  if (pa !== pb) return pa < pb ? -1 : 1;
  var ta = String(a.title || '');
  var tb = String(b.title || '');
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

/** Projects with their sub-tasks, for the read-only view: [{node, state, children}]. */
function mirrorTree(nodes) {
  var list = nodes || [];
  return list.filter(function (n) { return n.kind === 'project'; })
    .sort(byStateThenPosition)
    .map(function (p) {
      var kids = list.filter(function (n) {
        return n.kind === 'subtask' && n.parent_google_id === p.google_id;
      }).sort(byStateThenPosition);
      return { node: p, state: nodeState(p),
               children: kids.map(function (k) { return { node: k, state: nodeState(k) }; }) };
    });
}

// What tasks-sync uses. The browser reads the globals directly.
globalThis.ProBeingTree = {
  EMPTY_PULL_TRUST: EMPTY_PULL_TRUST,
  dueOf: dueOf,
  nodeState: nodeState,
  diffPull: diffPull,
  todaysPlan: todaysPlan,
  mirrorTree: mirrorTree
};
