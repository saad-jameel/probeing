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

/** When an untick in Google happened, as near as the pull can tell: Google's
 *  own `updated` (it is the untick or a later edit), never after the run's
 *  start, and never before ProBeing's own completion of it (Google's clock may
 *  run behind ours; Stage 15 compares the two). */
function reopenedAt(task, nowIso, old) {
  var now = Date.parse(nowIso);
  var t = Date.parse(task.updated || '');
  var at = isFinite(t) && t < now ? t : now;
  var sent = Date.parse((old && old.pb_pushed_at) || '');
  if (isFinite(sent) && sent > at) at = Math.min(sent, now);
  return at === now ? nowIso : new Date(at).toISOString();
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

    // A run that read Google before ProBeing's own tick landed: its "open" is
    // older than the tick (both on Google's clock), so the tick stands.
    var stale = Boolean(old && old.g_status === 'completed' && t.status !== 'completed' && old.pb_completed_at &&
                        Date.parse(t.updated || '') < Date.parse(old.pb_completed_at));
    var done = t.status === 'completed' || stale;
    var row = {
      google_id: String(t.id),
      list_id: list,
      parent_google_id: kind === 'subtask' ? String(t.parent) : null,
      kind: kind,
      title: String(t.title || ''),
      position: String(t.position || ''),
      due: dueOf(t.due),
      g_status: done ? 'completed' : 'needsAction',
      g_completed_at: stale ? old.g_completed_at : done ? (t.completed || null) : null,
      g_updated: stale ? old.g_updated : t.updated || null,
      // Unticked in Google since the last pull: Stage 15 must not tick it straight back.
      g_reopened_at: old && old.g_status === 'completed' && !done ? reopenedAt(t, nowIso, old)
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

/* ── Stage 15: what finishing in ProBeing sends to Google ──────────────────
 * Only SUB-TASKS are ever ticked or unticked (Saad, 2 Oct): a project, with
 * sub-tasks or without, stays as he left it in Google.
 * `items` are items rows ({rid, node_id}); `newest` maps an item rid to its
 * newest mark ({mark, at}), as the item_mark_latest view or day.js itemNewest
 * gives it. Times are compared as instants, never as strings. */

function msOf(iso) {
  var t = Date.parse(iso || '');
  return isFinite(t) ? t : NaN;
}

/** item rids by node id. */
function itemsByNode(items) {
  var out = {};
  (items || []).forEach(function (it) {
    if (it && it.rid && it.node_id) (out[it.node_id] = out[it.node_id] || []).push(it.rid);
  });
  return out;
}

/** After an untick in Google, only something newer counts. */
function afterReopen(n, t) {
  var re = msOf(n.g_reopened_at);
  return !isFinite(re) || t > re;
}

/** When a sub-task finished in ProBeing: at least one item, every one Done or
 *  Dropped, at least one Done (all dropped finished nothing), and the newest
 *  mark after any untick in Google. null when it has not. */
function leafDoneAt(n, rids, newest) {
  if (!rids || !rids.length) return null;
  var last = -Infinity;
  var anyDone = false;
  for (var i = 0; i < rids.length; i++) {
    var m = newest[rids[i]];
    if (!m || (m.mark !== 'done' && m.mark !== 'drop')) return null;
    if (m.mark === 'done') anyDone = true;
    var t = msOf(m.at);
    if (t > last) last = t;
  }
  if (!anyDone || !isFinite(last) || !afterReopen(n, last)) return null;
  return last;
}

/* ── Feedback 1: Done pressed on the sub-task itself ──────────────────────
 * A `subdone` row whose rid starts DIRECT_DONE, undone by a `subopen` row
 * whose rid starts DIRECT_OPEN. rid = prefix + node id + '-' + gen: a Done
 * after a reopen takes the next gen, so a second tap, or the other device,
 * makes the same rid and the unique index keeps one row.
 * Edit queue 2: a `subdrop` row (DIRECT_DROP) drops a task: not finished, so
 * never sent to Google as done, and hidden until a Reopen of the same gen. */
var DIRECT_DONE = 'sdd-';
var DIRECT_OPEN = 'sdo-';
var DIRECT_DROP = 'sdx-';
var DIRECT_TYPES = ['subdone', 'subopen', 'subdrop'];
var DIRECT_MARK = { subdone: 'done', subopen: 'open', subdrop: 'drop' };
var DIRECT_PREFIX = { subdone: DIRECT_DONE, subopen: DIRECT_OPEN, subdrop: DIRECT_DROP };

/** The rid of a direct Done or Reopen of node `nodeId`, generation `gen`. */
function directRid(prefix, nodeId, gen) {
  return prefix + String(nodeId) + '-' + gen;
}

/** {mark, gen} from a direct row's type and rid, or null when it is not one. */
function directParse(type, rid, nodeId) {
  var prefix = DIRECT_PREFIX.hasOwnProperty(type) ? DIRECT_PREFIX[type] : '';
  var head = prefix + String(nodeId || '') + '-';
  rid = String(rid || '');
  if (!prefix || !nodeId || rid.indexOf(head) !== 0) return null;
  var tail = rid.slice(head.length);
  if (!/^\d{1,6}$/.test(tail)) return null;
  return { mark: DIRECT_MARK[type], gen: Number(tail) };
}

/** Later in the direct order: generation, then a Reopen after its Done or Drop,
 *  then time (a Done and a Drop of one gen, from two devices). */
function directNewer(a, b) {
  if (a.gen !== b.gen) return a.gen > b.gen;
  if (a.mark !== b.mark && (a.mark === 'open' || b.mark === 'open')) return a.mark === 'open';
  var ta = msOf(a.at);
  var tb = msOf(b.at);
  if (ta !== tb) return ta > tb;
  return String(a.rid) > String(b.rid);
}

/** node id -> its newest direct row as {mark, gen, at, rid}, from events rows
 *  ({type, rid, node_id, at}). Other rows are ignored. */
function directMarks(rows) {
  var out = {};
  (rows || []).forEach(function (r) {
    if (!r || !r.node_id) return;
    var p = directParse(r.type, r.rid, r.node_id);
    if (!p || !isFinite(msOf(r.at))) return;
    var d = { mark: p.mark, gen: p.gen, at: r.at, rid: String(r.rid), text: String(r.raw_text || '') };
    var have = out[r.node_id];
    if (!have || directNewer(d, have)) out[r.node_id] = d;
  });
  return out;
}

/** When an item under the node was last reopened (Undo), or -Infinity. */
function itemOpenAt(rids, newest) {
  var last = -Infinity;
  (rids || []).forEach(function (rid) {
    var m = newest[rid];
    if (m && m.mark === 'open' && msOf(m.at) > last) last = msOf(m.at);
  });
  return last;
}

/** When node `n` was finished by its own Done button, or null: its newest
 *  direct row is a Done, after any untick in Google and any Undo on an item. */
function directDoneAt(n, d, rids, newest) {
  if (!d || d.mark !== 'done') return null;
  var t = msOf(d.at);
  if (!isFinite(t) || !afterReopen(n, t) || itemOpenAt(rids, newest || {}) > t) return null;
  return t;
}

/** When node `n` finished in ProBeing, by its items or its own Done, or null.
 *  A Reopen newer than the items' close undoes that close too. */
function finishedAt(n, rids, newest, d) {
  newest = newest || {};
  var a = directDoneAt(n, d, rids, newest);
  var b = leafDoneAt(n, rids, newest);
  if (b !== null && d && d.mark !== 'done' && msOf(d.at) > b) b = null;   // a newer Reopen or Drop
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}

/** node id -> true for every node finished by its own Done button. */
function directDone(nodes, items, newest, direct) {
  var rids = itemsByNode(items);
  var out = {};
  (nodes || []).forEach(function (n) {
    if (n && directDoneAt(n, (direct || {})[n.id], rids[n.id], newest || {}) !== null) out[n.id] = true;
  });
  return out;
}

/** node id -> true for every node whose newest direct row is a Drop. */
function directDropped(direct) {
  var out = {};
  Object.keys(direct || {}).forEach(function (id) {
    if (direct[id] && direct[id].mark === 'drop') out[id] = true;
  });
  return out;
}

/* ── Edit queue 4: Stop on a task is a pause ─────────────────────────────
 * A `substop` row (node_id = the task) keeps it in Upcoming tasks until it is
 * started again (a work or voice row under it, later than the Stop), or Done,
 * Dropped or Reopened later than the Stop. The browser and the morning push
 * both read it through stoppedTasks, so they pick the same tasks. */
var STOP_TYPE = 'substop';
var START_TYPES = ['work', 'voice'];

/** node id -> its newest Stop (ms), for tasks stopped and not picked up since.
 *  stops: substop rows; starts: work/voice rows with node_id; direct: directMarks(). */
function stoppedTasks(stops, starts, direct) {
  var last = {};
  (stops || []).forEach(function (r) {
    if (!r || r.type !== STOP_TYPE || !r.node_id) return;
    var t = msOf(r.at);
    if (isFinite(t) && !(last[r.node_id] >= t)) last[r.node_id] = t;
  });
  (starts || []).forEach(function (r) {
    if (!r || START_TYPES.indexOf(r.type) === -1 || !r.node_id || !last.hasOwnProperty(r.node_id)) return;
    if (msOf(r.at) > last[r.node_id]) delete last[r.node_id];
  });
  var d = direct || {};
  Object.keys(last).forEach(function (id) {
    if (d.hasOwnProperty(id) && d[id] && msOf(d[id].at) > last[id]) delete last[id];
  });
  return last;
}

/** The oldest Stop in `stopped` as an ISO stamp: where a read of starts begins. '' for none. */
function stoppedSince(stopped) {
  var min = Infinity;
  Object.keys(stopped || {}).forEach(function (id) { if (stopped[id] < min) min = stopped[id]; });
  return isFinite(min) ? new Date(min).toISOString() : '';
}

/* ── Stage 18a: a Drop deletes the task in Google; Reopen makes it again ────
 * Only a Drop whose text ends DROP_DELETE_MARK (written since 18a; older Drops
 * were promised to stay in Google) and only a sub-task, or a project with no
 * live sub-task. pb_deleted_for is the Drop's rid once Google has deleted it;
 * pb_recreated_for the Reopen's rid once a new copy was asked for. A refused
 * delete or copy is tried CHANGE_TRIES runs (push_refused counts them), then
 * left. A task he completed in Google himself is never deleted. The mark says
 * what was asked, not what happened: only gone_at says Google deleted it. */
var DROP_DELETE_MARK = ' (to remove from Google Tasks)';
var CHANGE_TRIES = 3;

/** How often Google refused `kind` ('delete' or 'recreate') for row `rid` on node `n`. */
function triesFor(n, kind, rid) {
  var r = n && n.push_refused;
  return r && r.body === kind + '|' + rid ? Number(r.n) || 0 : 0;
}

/** Was this Drop row written to delete its task in Google? */
function dropDeletes(text) {
  var t = String(text || '');
  return t.length >= DROP_DELETE_MARK.length && t.slice(-DROP_DELETE_MARK.length) === DROP_DELETE_MARK;
}

/** node id -> true for projects with a live sub-task. */
function liveParents(nodes) {
  var out = {};
  (nodes || []).forEach(function (n) {
    if (n && n.kind === 'subtask' && !n.gone_at) out[(n.list_id || '') + '|' + n.parent_google_id] = true;
  });
  return out;
}

/** Tasks of one list to delete in Google now: [{node, rid}], `rid` the Drop's. */
function deleteWanted(nodes, direct) {
  direct = direct || {};
  var list = nodes || [];
  var kids = liveParents(list);
  var byGoogle = {};
  list.forEach(function (n) { byGoogle[(n.list_id || '') + '|' + n.google_id] = n; });
  return list.filter(function (n) {
    var d = direct[n.id];
    if (!d || d.mark !== 'drop' || !dropDeletes(d.text) || n.gone_at || n.pb_deleted_for === d.rid) return false;
    if (triesFor(n, 'delete', d.rid) >= CHANGE_TRIES) return false;          // refused 3 times: left
    if (n.g_status === 'completed' && !oursInGoogle(n)) return false;
    if (n.kind === 'project') return !kids[(n.list_id || '') + '|' + n.google_id];
    var up = byGoogle[(n.list_id || '') + '|' + n.parent_google_id];
    return n.kind === 'subtask' && !(up && up.gone_at);
  }).map(function (n) { return { node: n, rid: direct[n.id].rid }; });
}

/** Tasks ProBeing deleted and he has reopened since: [{node, rid}], `rid` the
 *  Reopen's. A sub-task only while its project is still in Google. A copy asked
 *  for and not seen yet (pb_recreated_for set, still gone) stays wanted: the job
 *  looks for it in the pull before it asks again, CHANGE_TRIES times at most. */
function recreateWanted(nodes, direct) {
  direct = direct || {};
  var list = nodes || [];
  var byGoogle = {};
  list.forEach(function (n) { byGoogle[(n.list_id || '') + '|' + n.google_id] = n; });
  return list.filter(function (n) {
    var d = direct[n.id];
    if (!d || d.mark !== 'open' || !n.gone_at || !n.pb_deleted_for) return false;
    if (n.pb_deleted_for !== directRid(DIRECT_DROP, n.id, d.gen)) return false;   // not the Drop this Reopen undoes
    if (n.kind === 'project') return true;
    var up = byGoogle[(n.list_id || '') + '|' + n.parent_google_id];
    return n.kind === 'subtask' && Boolean(up) && !up.gone_at;
  }).map(function (n) { return { node: n, rid: direct[n.id].rid }; });
}

/** Tasks ProBeing deleted that Google lists again: [{node, rid}], `rid` the
 *  Reopen to write for the Drop (Google wins: the drop is undone, never sent again). */
function listedAgain(nodes, direct) {
  direct = direct || {};
  return (nodes || []).filter(function (n) {
    var d = direct[n.id];
    return n && !n.gone_at && n.pb_deleted_for && d && d.mark === 'drop' && d.rid === n.pb_deleted_for;
  }).map(function (n) { return { node: n, rid: directRid(DIRECT_OPEN, n.id, direct[n.id].gen) }; });
}

/** Completed in Google by ProBeing's own PATCH, still: Google's `completed`
 *  is the one it returned to that PATCH. An untick and re-tick by him, even
 *  between two pulls, gives a new completed time, and makes it his. */
function oursInGoogle(n) {
  return n.g_status === 'completed' && Boolean(n.pb_completed_at) && pushedSinceReopen(n) &&
         msOf(n.g_completed_at) === msOf(n.pb_completed_at);
}

/** Sent to Google already, and not unticked there since. An untick is never
 *  stamped before the send (diffPull), so equal means unticked. */
function pushedSinceReopen(n) {
  var sent = msOf(n.pb_pushed_at);
  if (!isFinite(sent)) return false;
  var re = msOf(n.g_reopened_at);
  return !isFinite(re) || sent > re;
}

/** A live sub-task whose project, when known, is not deleted. */
function liveSubtasks(nodes) {
  var byGoogle = {};
  nodes.forEach(function (n) { byGoogle[n.google_id] = n; });
  return nodes.filter(function (n) {
    if (n.kind !== 'subtask' || n.gone_at) return false;
    var up = byGoogle[n.parent_google_id];
    return !(up && up.gone_at);
  });
}

/**
 * Sub-tasks of one list that finished in ProBeing (finishedAt: by their items,
 * or their own Done in `direct`, from directMarks) and are still open in
 * Google: [{node, at}], `at` the ISO instant of the closing mark or the Done.
 * Edge-triggered: one already sent is not listed again until it is unticked
 * (by him in Google, after a newer mark; or by ProBeing on an Undo).
 */
function rollUp(nodes, items, newest, direct) {
  newest = newest || {};
  direct = direct || {};
  var rids = itemsByNode(items);
  return liveSubtasks(nodes || []).filter(function (n) {
    return n.g_status !== 'completed' && !pushedSinceReopen(n);
  }).map(function (n) {
    var at = finishedAt(n, rids[n.id], newest, direct[n.id]);
    return at === null ? null : { node: n, at: new Date(at).toISOString() };
  }).filter(Boolean);
}

/**
 * Sub-tasks to untick in Google because an item under them was undone, or the
 * sub-task itself was reopened or dropped (`direct`): ticked by ProBeing and still ours
 * (oursInGoogle), the Undo or Reopen later than the finish that was sent. One
 * he or Google completed is never touched.
 */
function unpushWanted(nodes, items, newest, direct) {
  newest = newest || {};
  direct = direct || {};
  var rids = itemsByNode(items);
  return liveSubtasks(nodes || []).filter(function (n) {
    if (!oursInGoogle(n)) return false;
    var since = msOf(n.pb_done_at);
    if (!isFinite(since)) since = msOf(n.pb_pushed_at);
    var d = direct[n.id];
    if (d && d.mark !== 'done' && msOf(d.at) > since) return true;      // Reopened or Dropped
    return (rids[n.id] || []).some(function (rid) {
      var m = newest[rid];
      return m && m.mark === 'open' && msOf(m.at) > since;
    });
  });
}

/** 'YYYY-MM-DD' of instant `ms` on the clock of `zone`; Karachi's if the zone is unknown. */
function zoneDate(ms, zone) {
  var f;
  try {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone || 'Asia/Karachi', year: 'numeric',
                                           month: '2-digit', day: '2-digit' });
  } catch (_e) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric',
                                           month: '2-digit', day: '2-digit' });
  }
  var p = {};
  f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day;
}

/**
 * The due date to send for task `n`, from his plan: {due, for, already} or null for
 * nothing to send. `due` is 'YYYY-MM-DD', or null to clear the one ProBeing
 * set; `already` means Google has it, so only the record changes. Sent only
 * when the finish itself changed since it was last sent (`for`, the finish
 * sent; a zone change alone sends nothing) to another date, and only while
 * Google still has the date ProBeing sent: once he sets one in Google, his
 * date stands (cleared or changed in ProBeing, or a zone change, never
 * overwrites it). A task ProBeing never dated keeps Google's own date until a
 * finish is set.
 */
function duePush(n, plan, zone) {
  if (!n || n.gone_at) return null;
  var t = msOf(plan && plan.expected_at);
  var want = isFinite(t) ? zoneDate(t, zone) : null;
  if (n.pb_due_sent_at) {
    if (dueMovedInGoogle(n) || want === dueOf(n.pb_due)) return null;
    var was = msOf(n.pb_due_for);
    if (was === t || (!isFinite(was) && !isFinite(t))) return null;
  } else if (want === null) {
    return null;
  }
  return { due: want, for: isFinite(t) ? new Date(t).toISOString() : null, already: dueOf(n.due) === want };
}

/** Google's due date is no longer the one ProBeing sent: changed in Google, so it is the one shown. */
function dueMovedInGoogle(n) {
  return Boolean(n && n.pb_due_sent_at) && dueOf(n.due) !== dueOf(n.pb_due);
}

/** Completed in Google by ProBeing, and not unticked or re-ticked there since. */
function sentToGoogle(n) {
  return Boolean(n) && !n.gone_at && oursInGoogle(n);
}

// What tasks-sync uses. The browser reads the globals directly.
globalThis.ProBeingTree = {
  EMPTY_PULL_TRUST: EMPTY_PULL_TRUST,
  dueOf: dueOf,
  nodeState: nodeState,
  diffPull: diffPull,
  todaysPlan: todaysPlan,
  mirrorTree: mirrorTree,
  rollUp: rollUp,
  unpushWanted: unpushWanted,
  DIRECT_DONE: DIRECT_DONE,
  DIRECT_OPEN: DIRECT_OPEN,
  DIRECT_DROP: DIRECT_DROP,
  DIRECT_TYPES: DIRECT_TYPES,
  directRid: directRid,
  directDropped: directDropped,
  directMarks: directMarks,
  finishedAt: finishedAt,
  directDone: directDone,
  zoneDate: zoneDate,
  duePush: duePush,
  dueMovedInGoogle: dueMovedInGoogle,
  sentToGoogle: sentToGoogle,
  STOP_TYPE: STOP_TYPE,
  START_TYPES: START_TYPES,
  stoppedTasks: stoppedTasks,
  stoppedSince: stoppedSince,
  DROP_DELETE_MARK: DROP_DELETE_MARK,
  CHANGE_TRIES: CHANGE_TRIES,
  triesFor: triesFor,
  listedAgain: listedAgain,
  dropDeletes: dropDeletes,
  deleteWanted: deleteWanted,
  recreateWanted: recreateWanted
};
