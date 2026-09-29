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

/** Later than the run's start: another run saw this row more recently. */
function newerThan(iso, nowIso) {
  var t = Date.parse(iso || '');
  return isFinite(t) && t > Date.parse(nowIso);
}

/** A list id as rows carry it; a row or run without one reads as null. */
function listKey(id) {
  return id == null || id === '' ? null : String(id);
}

/**
 * What a COMPLETE pull of list `listId` changes in the mirror. Never call it
 * with part of one: anything missing here is counted absent.
 *   mirror  every task_nodes row of this user, gone ones and other lists' included
 *   pulled  every task Google returned, deleted ones included
 *   nowIso  the run's START: the stamp for gone_at, missing_since and synced_at
 * Returns {refused: why} when the pull cannot be believed. Otherwise
 * {write, missing, gone, deep, orphans, added, changed, revived}: `write` are
 * whole rows to upsert on (user_id, google_id), all with the same keys;
 * `missing` are ids to stamp missing_since (a first absence); `gone` are ids to
 * stamp gone_at (a second absence in a row, or moved too deep). Rows of other
 * lists are never counted, stamped or refused over. A row that has not changed
 * is not written; nor is one a later run has already synced.
 */
function diffPull(mirror, pulled, nowIso, listId) {
  mirror = mirror || [];
  pulled = (pulled || []).filter(function (t) { return t && t.id; });
  var list = listKey(listId);
  var here = mirror.filter(function (n) { return listKey(n.list_id) === list; });
  var openNow = here.filter(nodeOpen).length;
  // Deleted tasks do not count: a page of only those is as empty as none.
  var live = pulled.filter(function (t) { return !t.deleted; }).length;
  if (!live && openNow > EMPTY_PULL_TRUST) {
    return { refused: 'Google Tasks sent back an empty list while ProBeing holds ' + openNow +
                      ' open tasks, so nothing was removed. If you emptied it on purpose, this ' +
                      'clears once the list holds a task again.' };
  }

  var byId = {};
  pulled.forEach(function (t) { byId[t.id] = t; });
  // Every list's rows, so a task moved between lists keeps its uuid.
  var have = {};
  mirror.forEach(function (n) { have[n.google_id] = n; });

  var out = { write: [], missing: [], gone: [], deep: 0, orphans: 0, added: 0, changed: 0, revived: 0 };
  var seen = {};
  var tooDeep = {};
  pulled.forEach(function (t) {
    var kind = kindOf(t, byId);
    if (kind === 'deep') {
      if (!t.deleted) out.deep += 1;
      tooDeep[t.id] = true;                     // not mirrored, so a row for it goes below
      return;
    }
    if (kind === 'orphan') {
      if (!t.deleted) out.orphans += 1;
      kind = 'subtask';
    }
    var old = have[t.id] || null;
    seen[t.id] = true;
    if (old && newerThan(old.synced_at, nowIso)) return;   // a later run's copy wins
    if (!old && t.deleted) return;              // deleted before we ever saw it

    var done = t.status === 'completed';
    var row = {
      google_id: String(t.id),
      list_id: list,
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
      missing_since: null,                      // it is here, so any first strike is cleared
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

  // In this list, not in a complete pull. Moved too deep is known, so gone at
  // once; plain absence needs two complete runs in a row.
  here.forEach(function (n) {
    if (n.gone_at || seen[n.google_id] || newerThan(n.synced_at, nowIso)) return;
    if (tooDeep[n.google_id] || n.missing_since) out.gone.push(n.id);
    else out.missing.push(n.id);
  });
  return out;
}

/** Everything diffPull writes, compared as Postgres hands it back. */
function sameRow(old, row) {
  return listKey(old.list_id) === row.list_id &&
         (old.parent_google_id || null) === row.parent_google_id &&
         old.kind === row.kind &&
         String(old.title || '') === row.title &&
         String(old.position || '') === row.position &&
         dueOf(old.due) === row.due &&
         old.g_status === row.g_status &&
         sameInstant(old.g_completed_at, row.g_completed_at) &&
         sameInstant(old.g_updated, row.g_updated) &&
         sameInstant(old.g_reopened_at, row.g_reopened_at) &&
         sameInstant(old.missing_since, row.missing_since) &&
         sameInstant(old.gone_at, row.gone_at);
}

/**
 * The Home card: open leaves due on or before `today`, the COUNTER date
 * (day.js's counterDate, so at 02:00 it is still yesterday), earliest due
 * first; then every open leaf with no due date, in Google's order (Saad's list
 * has no dates at all). A leaf due later than today is left out. A leaf is a
 * sub-task, or a project with no sub-task left; a project with sub-tasks is
 * never listed itself. Pass one list's rows.
 * Each is {id, title, project, due, overdue}; `due` is null when undated, and
 * `project` is null when the task has none: a childless project, or a sub-task
 * whose parent is not here.
 */
function todaysPlan(nodes, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return [];
  var list = nodes || [];
  var byGoogle = {};
  var hasKids = {};
  list.forEach(function (n) {
    byGoogle[n.google_id] = n;
    if (n.kind === 'subtask' && !n.gone_at) hasKids[n.parent_google_id] = true;
  });
  return list.filter(function (n) {
    var due = dueOf(n.due);
    if (!nodeOpen(n) || (due && due > today)) return false;
    if (n.kind === 'project') return !hasKids[n.google_id];
    var up = byGoogle[n.parent_google_id];
    return n.kind === 'subtask' && !(up && up.gone_at);
  }).map(function (n) {
    var up = n.kind === 'subtask' ? byGoogle[n.parent_google_id] : null;
    var due = dueOf(n.due);
    // Dated first ('0'), then undated ('1'); within each, due then Google's order.
    return { id: n.id, title: String(n.title || ''), project: up ? String(up.title || '') : null,
             due: due, overdue: Boolean(due) && due < today,
             order: [due ? '0' : '1', due || '', String((up || n).position || ''),
                     up ? String(n.position || '') : ''] };
  }).sort(function (a, b) {
    for (var i = 0; i < 4; i++) {
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

/**
 * Projects with their sub-tasks, for the read-only view: [{node, state, children}].
 * Sub-tasks whose project is not here come last, in one group with node null.
 */
function mirrorTree(nodes) {
  var list = nodes || [];
  var rank = { open: 0, done: 1, gone: 2 };
  var projects = list.filter(function (n) { return n.kind === 'project'; });
  var isProject = {};
  projects.forEach(function (p) { isProject[p.google_id] = true; });
  function leaves(kids) {
    return kids.sort(byStateThenPosition).map(function (k) { return { node: k, state: nodeState(k) }; });
  }
  var out = projects.sort(byStateThenPosition).map(function (p) {
    return { node: p, state: nodeState(p), children: leaves(list.filter(function (n) {
      return n.kind === 'subtask' && n.parent_google_id === p.google_id;
    })) };
  });
  var orphans = leaves(list.filter(function (n) {
    return n.kind === 'subtask' && !isProject[n.parent_google_id];
  }));
  if (orphans.length) {
    out.push({ node: null, state: orphans.reduce(function (best, c) {
      return rank[c.state] < rank[best] ? c.state : best;
    }, 'gone'), children: orphans });
  }
  return out;
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
