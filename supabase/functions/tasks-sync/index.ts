// ProBeing — the `tasks-sync` Edge Function. Stages 13 and 15.
//
// Copies his chosen Google Tasks list into task_nodes, then sends back what
// finished in ProBeing: pull -> compute -> push. pg_cron calls it every 15
// minutes with the cron secret (docs/tasks_sync.sql), a Done/Drop or a changed
// finish date pokes it through a trigger, and the app calls it on open with
// his JWT.
//
// DORMANT until Google is connected and a list is picked: it answers
// {ok:true, skipped} and writes nothing, not even an error.
//
// A pull is believed only when it is complete. A failed or unreadable page, a
// missing list, or an empty answer against a full mirror marks NOTHING; the
// reason goes to sync_state.last_error instead, which Settings shows. Even a
// complete pull only marks an absent task missing; a second one in a row
// marks it gone. Nothing is sent to Google after a pull that failed.
//
// What it sends (Stage 15, tree.js rollUp / unpushWanted / duePush): a
// sub-task finished in ProBeing (its items, or its own Done button) is
// completed, once per finish; an Undo or Reopen under one ProBeing completed
// unticks it again; a finish date set in ProBeing
// becomes the due date. Projects are never touched (Saad, 2 Oct). At most one
// PATCH per task per run; a PATCH Google refuses (a 4xx) is tried 3 runs, then left.
//
// Stage 18a: a Drop (written since 18a) deletes the task in Google — a
// sub-task, or a project with no live sub-task — and a Reopen of it makes it
// again under the same task_nodes row (tree.js deleteWanted / recreateWanted).
// A sub-task added by hand on the Tasks page (a `subnew` row) is made here too,
// once: subtask_requests records each try before it is sent.
//
// Secrets: the Stage 12 three (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GOOGLE_TOKEN_KEY), CRON_SECRET and ALLOWED_USER_ID. Needs task_nodes and
// tasks_sync_wants from docs/supabase_schema.sql.
//
// Deployed by hand, like the others:
//   npx supabase functions deploy tasks-sync --project-ref <ref> --use-api

import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/google.js';
import '../_shared/tree.js';

// Classic scripts, so they hand their functions over on globalThis.
const { RECONNECT, googleConfig, importTokenKey, scrub, markReconnect, tasksGet, accessToken, reconnectError } =
  (globalThis as unknown as { ProBeingGoogle: Record<string, any> }).ProBeingGoogle;
const { diffPull, rollUp, unpushWanted, duePush, dueOf, directMarks, deleteWanted, recreateWanted } =
  (globalThis as unknown as { ProBeingTree: Record<string, any> }).ProBeingTree;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

/* ── Pure helpers. Plain JS with `var`, as in google-link, so a node test can
 *    lift them. Clock, network and database arrive as arguments. ─────────── */

var TASKS_LISTS_URL = 'https://tasks.googleapis.com/tasks/v1/lists/';
// All three flags spelled out: Google's own pages disagree on their defaults.
var PULL_QUERY = 'showCompleted=true&showHidden=true&showDeleted=true&maxResults=100';
// 20,000 tasks. A list still paging past this is not read as complete.
var MAX_PAGES = 200;
var WRITE_BATCH = 500;
var GONE_BATCH = 100;
var LIST_GONE = 'Tasks list not found — pick it again in Settings.';

function pageUrl(listId, pageToken) {
  return TASKS_LISTS_URL + encodeURIComponent(listId) + '/tasks?' + PULL_QUERY +
         (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
}

/** Plainly Google's answer to tasks.list. An HTML error page, a cut-off body
 *  or a null reaches here as {} or null, and must not read as "no tasks". */
function readablePage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.kind !== 'tasks#tasks') return false;
  if (!('items' in body)) return true;            // Google leaves items out of an empty list
  return Array.isArray(body.items) && body.items.every(function (t) {
    return t && typeof t === 'object' && typeof t.id === 'string' && t.id !== '';
  });
}

/** Every task in the list, or a throw. Never part of one. */
async function pullAll(d, grant) {
  var tasks = [];
  var page = '';
  for (var i = 0; i < MAX_PAGES; i++) {
    var body = await tasksGet(d, grant, pageUrl(grant.list_id, page));
    if (!readablePage(body)) throw new Error('page ' + (i + 1) + ' of the list came back unreadable');
    (body.items || []).forEach(function (t) { tasks.push(t); });
    page = body.nextPageToken || '';
    if (!page) return { tasks: tasks, pages: i + 1 };
  }
  throw new Error('the list is longer than ' + (MAX_PAGES * 100) + ' tasks, so it was not read whole');
}

/** The database side. `sb` is a service-role client, so every query names the user. */
function mirrorStore(sb) {
  function must(r) {
    if (r.error) throw new Error(r.error.message || 'database error');
    return r.data;
  }
  return {
    getGrant: async function (userId) {
      var rows = must(await sb.from('google_grants').select('*').eq('user_id', userId).limit(1));
      return (rows || [])[0] || null;
    },
    // An update, not an upsert, as in google-link: refresh_enc is not null.
    patchGrant: async function (userId, fields) {
      must(await sb.from('google_grants').update(fields).eq('user_id', userId));
    },
    setSync: async function (row) {
      must(await sb.from('sync_state').upsert(Object.assign({}, row,
        { updated_at: new Date().toISOString() }), { onConflict: 'user_id' }));
    },
    // Paged, because PostgREST stops at 1000 rows and a short read would hide rows from the diff.
    nodes: async function (userId) {
      var out = [];
      for (var from = 0; ; from += 1000) {
        var rows = must(await sb.from('task_nodes').select('*').eq('user_id', userId)
          .order('google_id', { ascending: true }).range(from, from + 999)) || [];
        out = out.concat(rows);
        if (rows.length < 1000) return out;
      }
    },
    // On (user_id, google_id), so the uuid is kept and two syncs at once cannot duplicate a row.
    upsertNodes: async function (userId, rows) {
      for (var i = 0; i < rows.length; i += WRITE_BATCH) {
        var batch = rows.slice(i, i + WRITE_BATCH).map(function (r) {
          return Object.assign({ user_id: userId }, r);
        });
        must(await sb.from('task_nodes').upsert(batch, { onConflict: 'user_id,google_id' }));
      }
    },
    // Both skip a row a later run has synced since this run began (nowIso is its start).
    markMissing: async function (userId, ids, nowIso) {
      for (var i = 0; i < ids.length; i += GONE_BATCH) {
        must(await sb.from('task_nodes').update({ missing_since: nowIso })
          .eq('user_id', userId).in('id', ids.slice(i, i + GONE_BATCH)).is('gone_at', null)
          .is('missing_since', null).lte('synced_at', nowIso));
      }
    },
    markGone: async function (userId, ids, nowIso) {
      for (var i = 0; i < ids.length; i += GONE_BATCH) {
        must(await sb.from('task_nodes').update({ gone_at: nowIso })
          .eq('user_id', userId).in('id', ids.slice(i, i + GONE_BATCH)).is('gone_at', null)
          .lte('synced_at', nowIso));
      }
    },

    /* Stage 15. Every read is whole or throws: a short read of items could
     * make a task look finished. */
    items: function (userId) {
      return paged(function () {
        return sb.from('items').select('rid,node_id').eq('user_id', userId)
          .not('node_id', 'is', null).order('rid', { ascending: true });
      });
    },
    // item rid -> its newest mark, through the same view the app reads.
    latestMarks: async function (userId) {
      var rows = await paged(function () {
        return sb.from('item_mark_latest').select('item_rid,mark,at').eq('user_id', userId)
          .order('item_rid', { ascending: true });
      });
      var out = {};
      rows.forEach(function (m) { out[m.item_rid] = m; });
      return out;
    },
    // Feedback 1: Done and Reopen pressed on a sub-task itself; a Drop too (edit queue 2).
    direct: async function (userId) {
      var rows = await paged(function () {
        return sb.from('events').select('type,rid,node_id,at,raw_text').eq('user_id', userId)
          .in('type', ['subdone', 'subopen', 'subdrop']).not('node_id', 'is', null).order('rid', { ascending: true });
      });
      return directMarks(rows);
    },
    plans: async function (userId) {
      var rows = await paged(function () {
        return sb.from('task_plans').select('node_id,expected_at').eq('user_id', userId)
          .order('node_id', { ascending: true });
      });
      var out = {};
      rows.forEach(function (p) { out[p.node_id] = p; });
      return out;
    },
    zone: async function (userId) {
      var rows = must(await sb.from('user_settings').select('time_zone').eq('user_id', userId).limit(1));
      return ((rows || [])[0] || {}).time_zone || '';
    },
    /* Take task `n` for one PATCH: only while no other run holds it and its
     * sent-state is still what this run read, so two runs at once send once. */
    claim: async function (userId, n, nowIso, untilIso) {
      var q = sb.from('task_nodes').update({ push_claim_until: untilIso })
        .eq('user_id', userId).eq('id', n.id)
        // Quoted: PostgREST reserves '.' and ':' inside an or=(...) value.
        .or('push_claim_until.is.null,push_claim_until.lt."' + nowIso + '"');
      ['g_status', 'pb_pushed_at', 'pb_due_sent_at', 'gone_at', 'pb_deleted_for', 'pb_recreated_for'].forEach(function (col) {
        if (!(col in n)) return;              // a column the database does not have yet
        q = n[col] == null ? q.is(col, null) : q.eq(col, n[col]);
      });
      return (must(await q.select('id')) || []).length === 1;
    },
    settle: async function (userId, id, fields) {
      must(await sb.from('task_nodes').update(Object.assign({ push_claim_until: null }, fields))
        .eq('user_id', userId).eq('id', id));
    },
    // Stage 18a: written while the claim is still held, before Google is asked.
    mark: async function (userId, id, fields) {
      must(await sb.from('task_nodes').update(fields).eq('user_id', userId).eq('id', id));
    },
    // Sub-tasks asked for by hand since `sinceIso` (`subnew` rows).
    subnew: async function (userId, sinceIso) {
      return paged(function () {
        return sb.from('events').select('rid,at,raw_text,node_id').eq('user_id', userId).eq('type', 'subnew')
          .not('node_id', 'is', null).gte('at', sinceIso).order('rid', { ascending: true });
      });
    },
    // rid -> its subtask_requests row. null when the table is not there yet.
    requests: async function (userId, rids) {
      var r = await sb.from('subtask_requests').select('*').eq('user_id', userId).in('rid', rids);
      if (r.error) return null;
      var out = {};
      (r.data || []).forEach(function (x) { out[x.rid] = x; });
      return out;
    },
    // A first try: false when another run took it first.
    requestNew: async function (userId, row) {
      var r = await sb.from('subtask_requests').insert(Object.assign({ user_id: userId }, row));
      if (r.error && r.error.code === '23505') return false;
      must(r);
      return true;
    },
    // Only while it is still as `was` read it.
    requestSet: async function (userId, rid, was, fields) {
      var q = sb.from('subtask_requests').update(fields).eq('user_id', userId).eq('rid', rid);
      q = was.tried_at == null ? q.is('tried_at', null) : q.eq('tried_at', was.tried_at);
      return (must(await q.select('rid')) || []).length === 1;
    },
    // A made sub-task's mirror row, kept if a sync wrote it first.
    putNode: async function (userId, row) {
      must(await sb.from('task_nodes').upsert(Object.assign({ user_id: userId }, row),
        { onConflict: 'user_id,google_id', ignoreDuplicates: true }));
    },
    /* The trigger's queue (docs/tasks_sync.sql): wanted_n counts taps, sent_at
     * says a request is out. null when there is no row. */
    wantsRead: async function (userId) {
      var rows = must(await sb.from('tasks_sync_wants').select('wanted_n').eq('user_id', userId).limit(1));
      return rows && rows[0] ? Number(rows[0].wanted_n) : null;
    },
    // Release the request, unless a tap came in since `n` was read.
    wantsDone: async function (userId, n) {
      if (n === null) return true;
      var rows = must(await sb.from('tasks_sync_wants').update({ sent_at: null })
        .eq('user_id', userId).eq('wanted_n', n).select('user_id'));
      return (rows || []).length === 1;
    },
    wantsClear: async function (userId) {
      must(await sb.from('tasks_sync_wants').update({ sent_at: null }).eq('user_id', userId));
    }
  };

  // All pages of a query, 1000 rows at a time (PostgREST's cap).
  async function paged(query) {
    var out = [];
    for (var from = 0; ; from += 1000) {
      var rows = must(await query().range(from, from + 999)) || [];
      out = out.concat(rows);
      if (rows.length < 1000) return out;
    }
  }
}

/* ── Stage 15: the push ─────────────────────────────────────────────── */

// A claim older than this is a run that died; another may take the task.
var CLAIM_MS = 60 * 1000;
// A change Google refuses (a 4xx that is not 401/403/404/429) is tried on this
// many runs, then left until the change itself is different.
var REFUSED_MAX = 3;
// A poked run goes round again while taps keep arriving, at most this often.
var POKE_ROUNDS = 3;

/** PATCH one task. A 401 gets one forced refresh, as tasksGet does; a lost
 *  permission means reconnect. Other failures carry Google's status. */
async function tasksPatch(d, grant, taskId, body) {
  var url = TASKS_LISTS_URL + encodeURIComponent(grant.list_id) + '/tasks/' + encodeURIComponent(taskId);
  function send(token) {
    return d.fetch(url, { method: 'PATCH', body: JSON.stringify(body),
                          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  }
  var res = await send(await accessToken(d, grant, false));
  if (res.status === 401) res = await send(await accessToken(d, grant, true));
  var got = await res.json().catch(function () { return null; });
  if (res.ok) return got || {};
  var said = JSON.stringify(got || {});
  if (/rateLimit|RATE_LIMIT|quota/i.test(said)) {
    var busy = new Error('Google Tasks is busy; it is sent on the next sync.');
    busy.status = res.status;
    busy.busy = true;
    throw busy;
  }
  if (res.status === 429) {
    var slow = new Error('Google Tasks is busy; it is sent on the next sync.');
    slow.status = 429;
    slow.busy = true;
    throw slow;
  }
  if (res.status === 401 || res.status === 403) throw reconnectError('Google refused to change a task');
  var e = new Error('Google Tasks answered ' + res.status + ': ' + scrub(got && got.error && got.error.message));
  e.status = res.status;
  throw e;
}

/** Stage 18a: DELETE one task. A 404 is already gone, which is what was wanted. */
async function tasksDelete(d, grant, taskId) {
  var url = TASKS_LISTS_URL + encodeURIComponent(grant.list_id) + '/tasks/' + encodeURIComponent(taskId);
  function send(token) {
    return d.fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  }
  var res = await send(await accessToken(d, grant, false));
  if (res.status === 401) res = await send(await accessToken(d, grant, true));
  if (res.ok || res.status === 404) return true;
  var got = await res.json().catch(function () { return null; });
  if (res.status === 429 || /rateLimit|RATE_LIMIT|quota/i.test(JSON.stringify(got || {}))) {
    var busy = new Error('Google Tasks is busy; it is sent on the next sync.');
    busy.status = res.status;
    busy.busy = true;
    throw busy;
  }
  if (res.status === 403) throw reconnectError('Google refused to delete a task');
  var e = new Error('Google Tasks answered ' + res.status + ': ' + scrub(got && got.error && got.error.message));
  e.status = res.status;
  throw e;
}

/** Stage 18a: insert one task, under `parentId` when given. {verdict, task, why}:
 *  'made', 'refused' (nothing made), 'later' (busy: nothing made) or 'unsure'. */
async function tasksInsert(d, grant, parentId, body) {
  var url = TASKS_LISTS_URL + encodeURIComponent(grant.list_id) + '/tasks' +
            (parentId ? '?parent=' + encodeURIComponent(parentId) : '');
  function send(token) {
    return d.fetch(url, { method: 'POST', body: JSON.stringify(body),
                          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  }
  var res;
  try {
    res = await send(await accessToken(d, grant, false));
    if (res.status === 401) res = await send(await accessToken(d, grant, true));
  } catch (e) {
    if (e && e.reconnect) throw e;
    return { verdict: 'unsure', task: null, why: 'could not reach Google Tasks: ' + scrub((e && e.message) || e) };
  }
  var got = await res.json().catch(function () { return null; });
  if (res.ok) {
    return got && typeof got.id === 'string' && got.id ? { verdict: 'made', task: got, why: '' }
                                                       : { verdict: 'unsure', task: null, why: 'no task in the answer' };
  }
  var why = 'Google Tasks answered ' + res.status + ': ' + scrub(got && got.error && got.error.message);
  if (res.status === 429 || /rateLimit|RATE_LIMIT|quota/i.test(JSON.stringify(got || {}))) {
    return { verdict: 'later', task: null, why: why };
  }
  if (res.status === 403) throw reconnectError('Google refused to make a task');
  if (res.status >= 400 && res.status < 500) return { verdict: 'refused', task: null, why: why };
  return { verdict: 'unsure', task: null, why: why };
}

/** Google said no to this change itself (a bad request), not to us or to the moment. */
function refusedByGoogle(e) {
  return Boolean(e) && !e.reconnect && !e.busy && e.status >= 400 && e.status < 500 && e.status !== 404;
}

/** What makes a change THIS change: its body, and the close or the tick it is
 *  about, so an Undo and a new Done later is a new change with fresh tries. */
function changeKey(j) {
  return JSON.stringify(j.body) + '|' + (j.doneAt || '') + '|' + (j.undo ? String(j.node.pb_pushed_at || '') : '');
}

/** How often Google has refused exactly this change to `n`. */
function refusedCount(n, j) {
  var r = n.push_refused;
  return r && r.body === changeKey(j) ? Number(r.n) || 0 : 0;
}

/** One task's PATCH, and what the mirror records once Google takes it.
 *  'sent', 'recorded', 'gone' (Google says 404), 'refused' (a 4xx, counted),
 *  'busy' (another run has it), or a throw. */
async function sendJob(d, grant, j, nowIso) {
  var n = j.node;
  var now = d.now();
  var stamp = new Date(now).toISOString();
  if (!(await d.store.claim(d.userId, n, stamp, new Date(now + CLAIM_MS).toISOString()))) return 'busy';
  var task = null;
  if (Object.keys(j.body).length) {
    try {
      task = await tasksPatch(d, grant, n.google_id, j.body);
    } catch (e) {
      var left = {};
      if (e && e.status === 404) left = { gone_at: nowIso };
      else if (refusedByGoogle(e)) {
        left = { push_refused: { body: changeKey(j), n: refusedCount(n, j) + 1,
                                 why: scrub((e && e.message) || e) } };
      }
      try { await d.store.settle(d.userId, n.id, left); Object.assign(n, left); } catch (_e) { /* the claim lapses */ }
      if (e && e.status === 404) return 'gone';
      if (refusedByGoogle(e)) return 'refused';
      throw e;
    }
  }
  var f = { push_refused: null };
  if (task && task.updated) f.g_updated = task.updated;
  if (j.body.status === 'completed') {
    // Google's own completed time for this tick: while it is unchanged, the tick is ours.
    Object.assign(f, { g_status: 'completed', g_completed_at: (task && task.completed) || stamp,
                       pb_completed_at: (task && task.completed) || null, pb_done_at: j.doneAt, pb_pushed_at: stamp });
  }
  if (j.undo) {
    // Ours to take back; cleared, so the next close is sent again, once.
    Object.assign(f, { g_status: 'needsAction', g_completed_at: null, pb_completed_at: null, pb_done_at: null,
                       pb_pushed_at: null });
  }
  if ('due' in j) {
    Object.assign(f, { pb_due: j.due, pb_due_for: j.dueFor, pb_due_sent_at: stamp });
    if ('due' in j.body) f.due = task && task.due ? dueOf(task.due) : null;
  }
  await d.store.settle(d.userId, n.id, f);
  Object.assign(n, f);
  return task ? 'sent' : 'recorded';
}

/* ── Stage 18a: Drop deletes, Reopen makes it again ─────────────────── */

/** Delete task `j.node` in Google for Drop `j.rid`. 'deleted', 'busy' (another
 *  run has it), 'refused' (a 4xx, recorded) or a throw. */
async function deleteJob(d, grant, j) {
  var n = j.node;
  var now = d.now();
  var stamp = new Date(now).toISOString();
  if (!(await d.store.claim(d.userId, n, stamp, new Date(now + CLAIM_MS).toISOString()))) return 'busy';
  try {
    await tasksDelete(d, grant, n.google_id);
  } catch (e) {
    if (refusedByGoogle(e)) {
      var left = { push_refused: { body: 'delete|' + j.rid, n: 1, why: scrub((e && e.message) || e) },
                   pb_deleted_for: j.rid };        // not asked again for this Drop
      try { await d.store.settle(d.userId, n.id, left); Object.assign(n, left); } catch (_e) { /* the claim lapses */ }
      return 'refused';
    }
    try { await d.store.settle(d.userId, n.id, {}); } catch (_e) { /* the claim lapses */ }
    throw e;
  }
  var f = { gone_at: n.gone_at || stamp, pb_deleted_for: j.rid, pb_deleted_at: stamp, push_refused: null };
  await d.store.settle(d.userId, n.id, f);
  Object.assign(n, f);
  return 'deleted';
}

/** Make task `j.node` again in Google for Reopen `j.rid`, under the same row:
 *  its google_id becomes the new task's, so its time and items stay with it.
 *  The try is recorded before the insert, so a run that dies cannot make two. */
async function recreateJob(d, grant, j) {
  var n = j.node;
  var now = d.now();
  var stamp = new Date(now).toISOString();
  if (!(await d.store.claim(d.userId, n, stamp, new Date(now + CLAIM_MS).toISOString()))) return 'busy';
  await d.store.mark(d.userId, n.id, { pb_recreated_for: j.rid });
  n.pb_recreated_for = j.rid;
  var got = await tasksInsert(d, grant, n.kind === 'subtask' ? n.parent_google_id : null,
                              { title: String(n.title || '') });
  if (got.verdict !== 'made') {
    // Busy: nothing was made, so the next run tries again. Refused or unclear: left.
    var left = got.verdict === 'later' ? { pb_recreated_for: null }
             : { push_refused: { body: 'recreate|' + j.rid, n: 1, why: got.why } };
    try { await d.store.settle(d.userId, n.id, left); Object.assign(n, left); } catch (_e) { /* the claim lapses */ }
    return got.verdict === 'later' ? 'busy' : 'refused';
  }
  var t = got.task;
  var f = { google_id: String(t.id), position: String(t.position || ''), title: String(t.title || n.title || ''),
            due: null, g_status: 'needsAction', g_completed_at: null, g_updated: t.updated || stamp,
            g_reopened_at: null, missing_since: null, gone_at: null, pb_done_at: null, pb_pushed_at: null,
            pb_completed_at: null, pb_due: null, pb_due_sent_at: null, pb_due_for: null, push_refused: null,
            pb_deleted_for: null, pb_deleted_at: null, pb_recreated_for: j.rid, synced_at: stamp };
  await d.store.settle(d.userId, n.id, f);
  Object.assign(n, f);
  return 'made';
}

/* A sub-task added by hand (a `subnew` row: node_id = its project, raw_text = the
 * title). One subtask_requests row per ask: 'sending' before the insert, 'made'
 * after; a try Google may have taken is looked for in the next whole pull
 * before it is sent again, at most SUBNEW_TRIES times. */
var SUBNEW_DAYS = 3;
var SUBNEW_SETTLE_MS = 5 * 60000;
var SUBNEW_SLACK_MS = 10 * 60000;
var SUBNEW_TRIES = 3;
var SUBNEW_TITLE_MAX = 80;

function subnewTitle(raw) {
  var t = String(raw || '').replace(/\s+/g, ' ').trim();
  var chars = Array.from(t);
  return chars.length > SUBNEW_TITLE_MAX ? chars.slice(0, SUBNEW_TITLE_MAX - 1).join('').trim() + '…' : t;
}

function sameTitleText(a, b) {
  var f = function (x) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().replace(/\.$/, '').toLowerCase(); };
  return f(a) !== '' && f(a) === f(b);
}

/** In a whole pull, the live task under `parent` called `title` and touched since `sinceMs`, or null. */
function foundIn(pulled, parent, title, sinceMs) {
  return (pulled || []).filter(function (t) {
    return t && t.id && !t.deleted && t.parent === parent && sameTitleText(t.title, title) &&
           !(Date.parse(t.updated || '') < sinceMs);
  })[0] || null;
}

/** The mirror row for a task Google made under `parent` (a project row). */
function madeRow(t, parent, nowIso) {
  return { google_id: String(t.id), list_id: parent.list_id, parent_google_id: parent.google_id, kind: 'subtask',
           title: String(t.title || ''), position: String(t.position || ''), due: dueOf(t.due),
           g_status: 'needsAction', g_updated: t.updated || nowIso, synced_at: nowIso };
}

async function makeSubtasks(d, grant, nodes, pulled) {
  var out = { made: 0, error: '' };
  var now = d.now();
  var asks = await d.store.subnew(d.userId, new Date(now - SUBNEW_DAYS * 86400000).toISOString());
  if (!asks.length) return out;
  var recs = await d.store.requests(d.userId, asks.map(function (a) { return a.rid; }));
  if (!recs) return out;                    // before its table exists: nothing is made
  var byId = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  for (var i = 0; i < asks.length; i++) {
    var a = asks[i];
    var rec = recs[a.rid] || null;
    if (rec && (rec.state === 'made' || rec.state === 'failed')) continue;
    var up = byId[a.node_id];
    var title = subnewTitle(a.raw_text);
    if (!up || up.kind !== 'project' || up.gone_at || String(up.list_id) !== String(grant.list_id) || !title) {
      if (!rec) await d.store.requestNew(d.userId, { rid: a.rid, state: 'failed', why: 'its project is not in your list' });
      continue;
    }
    var stamp = new Date(d.now()).toISOString();
    // Already there (made before, or by a try whose answer was lost): adopted, never made twice.
    var since = rec && rec.tried_at ? Date.parse(rec.tried_at) - SUBNEW_SLACK_MS : -Infinity;
    var hit = foundIn(pulled, up.google_id, title, since);
    if (hit) {
      await d.store.putNode(d.userId, madeRow(hit, up, stamp));
      if (rec) await d.store.requestSet(d.userId, a.rid, rec, { state: 'made', google_id: String(hit.id) });
      else await d.store.requestNew(d.userId, { rid: a.rid, state: 'made', google_id: String(hit.id), tried_at: stamp, tries: 0 });
      continue;
    }
    if (rec && rec.tried_at && now - Date.parse(rec.tried_at) < SUBNEW_SETTLE_MS) continue;   // Google may still list it
    var tries = rec ? Number(rec.tries) || 0 : 0;
    if (tries >= SUBNEW_TRIES) {
      await d.store.requestSet(d.userId, a.rid, rec, { state: 'failed', why: 'not made after ' + tries + ' tries' });
      continue;
    }
    var took = rec ? await d.store.requestSet(d.userId, a.rid, rec, { state: 'sending', tried_at: stamp, tries: tries + 1 })
                   : await d.store.requestNew(d.userId, { rid: a.rid, state: 'sending', tried_at: stamp, tries: 1 });
    if (!took) continue;                    // another run has it
    var mine = { tried_at: stamp };
    var got = await tasksInsert(d, grant, up.google_id, { title: title });
    if (got.verdict === 'made') {
      await d.store.putNode(d.userId, madeRow(got.task, up, stamp));
      await d.store.requestSet(d.userId, a.rid, mine, { state: 'made', google_id: String(got.task.id) });
      out.made += 1;
    } else if (got.verdict === 'later') {
      await d.store.requestSet(d.userId, a.rid, mine, { tried_at: null, tries: tries });   // nothing made: again next run
    } else if (got.verdict === 'refused') {
      await d.store.requestSet(d.userId, a.rid, mine, { state: 'failed', why: got.why });
      out.error = 'Google Tasks refused to add "' + title.slice(0, 60) + '": ' + got.why;
    }
    // 'unsure': left 'sending'; the next whole pull looks for it before any new try.
  }
  return out;
}

/**
 * Pull is done; send what ProBeing finished or undid. Stops at the first
 * failure that is not about one task (a 500, a busy Google, a lost
 * permission): nothing was recorded, so the next run tries again. A 404 marks
 * the task gone; a refusal is counted against that change and the run goes on.
 */
async function pushPhase(d, grant, nowIso) {
  var out = { pushed: 0, failed: 0, gone: 0, error: '', reconnect: false };
  var nodes = (await d.store.nodes(d.userId)).filter(function (n) {
    return String(n.list_id) === String(grant.list_id);
  });
  var items = await d.store.items(d.userId);
  var newest = await d.store.latestMarks(d.userId);
  var direct = await d.store.direct(d.userId);
  var plans = await d.store.plans(d.userId);
  var zone = await d.store.zone(d.userId);

  // Stage 18a: deletes and new copies first; a task being deleted is sent nothing else.
  var dels = typeof deleteWanted === 'function' ? deleteWanted(nodes, direct) : [];
  var res = typeof recreateWanted === 'function' ? recreateWanted(nodes, direct) : [];
  var held = {};
  dels.concat(res).forEach(function (x) { held[x.node.id] = true; });
  var special = dels.map(function (x) { return { kind: 'delete', j: x }; })
    .concat(res.map(function (x) { return { kind: 'recreate', j: x }; }));
  for (var k = 0; k < special.length; k++) {
    try {
      var r = special[k].kind === 'delete' ? await deleteJob(d, grant, special[k].j)
                                           : await recreateJob(d, grant, special[k].j);
      if (r === 'deleted' || r === 'made') out.pushed += 1;
      if (r === 'refused') {
        out.failed += 1;
        out.error = 'Google Tasks refused to ' + (special[k].kind === 'delete' ? 'delete' : 'make again') + ' "' +
                    String(special[k].j.node.title || '').slice(0, 60) + '"';
      }
    } catch (e) {
      out.failed += 1;
      if (e && e.reconnect) {
        out.reconnect = true;
        out.error = RECONNECT + ': ' + e.message;
      } else {
        out.error = 'Could not send a change to Google Tasks, so it is tried again on the next sync: ' +
                    scrub((e && e.message) || e);
      }
      return out;
    }
  }

  var jobs = {};
  var order = [];
  function job(n) {
    if (!jobs[n.id]) { jobs[n.id] = { node: n, body: {} }; order.push(n.id); }
    return jobs[n.id];
  }
  nodes = nodes.filter(function (n) { return !held[n.id]; });
  unpushWanted(nodes, items, newest, direct).forEach(function (n) {
    var j = job(n);
    j.undo = true;
    j.body.status = 'needsAction';
    j.body.completed = null;                // not documented to clear by itself
  });
  rollUp(nodes, items, newest, direct).forEach(function (r) {
    var j = job(r.node);
    j.body.status = 'completed';
    j.doneAt = r.at;
  });
  nodes.forEach(function (n) {
    if (!plans[n.id] && !n.pb_due_sent_at) return;
    var want = duePush(n, plans[n.id], zone);
    if (!want) return;
    var j = job(n);
    j.due = want.due;
    j.dueFor = want.for;
    if (!want.already) j.body.due = want.due ? want.due + 'T00:00:00.000Z' : null;
  });

  var refused = [];
  for (var i = 0; i < order.length; i++) {
    var j = jobs[order[i]];
    if (Object.keys(j.body).length && refusedCount(j.node, j) >= REFUSED_MAX) {
      refused.push(j.node);                 // given up on: said below, never sent again as it is
      continue;
    }
    try {
      var got = await sendJob(d, grant, j, nowIso);
      if (got === 'sent') out.pushed += 1;
      if (got === 'gone') out.gone += 1;
      if (got === 'refused') { out.failed += 1; refused.push(j.node); }
    } catch (e) {
      out.failed += 1;
      if (e && e.reconnect) {
        out.reconnect = true;
        out.error = RECONNECT + ': ' + e.message;
      } else {
        out.error = 'Could not send a change to Google Tasks, so it is tried again on the next sync: ' +
                    scrub((e && e.message) || e);
      }
      return out;
    }
  }
  if (refused.length) {
    var r = refused[0];
    var tries = Math.min(Number(r.push_refused && r.push_refused.n) || 0, REFUSED_MAX);
    out.error = 'Google Tasks refused a change to "' + String(r.title || '').slice(0, 60) + '"' +
                (refused.length > 1 ? ' and ' + (refused.length - 1) + ' more' : '') +
                (tries >= REFUSED_MAX ? '; ProBeing stopped trying after ' + REFUSED_MAX + ' runs'
                                      : '; tried ' + tries + ' of ' + REFUSED_MAX + ' runs') +
                ': ' + String((r.push_refused && r.push_refused.why) || '');
  }
  return out;
}

/** A poked run (a tap, through the trigger) goes round again while taps keep
 *  coming, then lets the next tap send a new request. The queue table is only
 *  a throttle: if it cannot be read, the run is a plain sync. */
async function runSync(d, poke) {
  if (!poke) return syncTasks(d);
  var out = null;
  for (var round = 0; round < POKE_ROUNDS; round++) {
    var seen;
    try { seen = await d.store.wantsRead(d.userId); } catch (_e) { return syncTasks(d); }
    out = await syncTasks(d);
    var settled = true;
    try { settled = await d.store.wantsDone(d.userId, seen); } catch (_e) { /* settled */ }
    if (settled) return out;
  }
  try { await d.store.wantsClear(d.userId); } catch (_e) { /* it goes stale by itself */ }
  return out;
}

async function failSync(d, why, listId) {
  try {
    await d.store.setSync({ user_id: d.userId, list_id: listId, last_error: why,
                            last_error_at: new Date(d.now()).toISOString() });
  } catch (_e) { /* the reply still says it */ }
}

/** One pull. `d`: {cfg, key, store, userId, fetch, now}. */
async function syncTasks(d) {
  var grant = await d.store.getGrant(d.userId);
  if (!grant || !grant.list_id) return { ok: true, skipped: 'not connected' };
  // The run's start: rows another run synced after it are left alone.
  var nowIso = new Date(d.now()).toISOString();

  var pull;
  try {
    pull = await pullAll(d, grant);
  } catch (e) {
    if (e && e.reconnect) {
      await markReconnect(d, e.message);
      return { ok: false, reconnect: true, error: RECONNECT + ' — ' + e.message + '.' };
    }
    var why = e && e.status === 404 ? LIST_GONE
            : 'Could not read Google Tasks, so nothing changed: ' + scrub((e && e.message) || e);
    await failSync(d, why, grant.list_id);
    return { ok: false, error: why };
  }

  var diff;
  try {
    diff = diffPull(await d.store.nodes(d.userId), pull.tasks, nowIso, grant.list_id);
    if (diff.refused) {
      await failSync(d, diff.refused, grant.list_id);
      return { ok: false, error: diff.refused };
    }
    await d.store.upsertNodes(d.userId, diff.write);
    await d.store.markMissing(d.userId, diff.missing, nowIso);
    await d.store.markGone(d.userId, diff.gone, nowIso);
  } catch (e) {
    var said = 'Could not save the copy of your Tasks: ' + scrub((e && e.message) || e);
    await failSync(d, said, grant.list_id);
    return { ok: false, error: said };
  }

  // Only after a whole, saved pull: never send on a guess.
  var push = { pushed: 0, failed: 0, gone: 0, error: '', reconnect: false };
  try {
    push = await pushPhase(d, grant, nowIso);
  } catch (e) {
    push.error = 'Could not work out what to send to Google Tasks: ' + scrub((e && e.message) || e);
  }
  // Stage 18a: sub-tasks added by hand, looked for in this whole pull first.
  var made = 0;
  if (!push.reconnect) {
    try {
      var mk = await makeSubtasks(d, grant, (await d.store.nodes(d.userId)).filter(function (n) {
        return String(n.list_id) === String(grant.list_id);
      }), pull.tasks);
      made = mk.made;
      if (mk.error && !push.error) push.error = mk.error;
    } catch (e) {
      if (e && e.reconnect) {
        push.reconnect = true;
        push.error = RECONNECT + ': ' + e.message;
      } else if (!push.error) {
        push.error = 'Could not add a sub-task to Google Tasks, so it is tried again on the next sync: ' +
                     scrub((e && e.message) || e);
      }
    }
  }

  // list_id tells the browser which rows are the current list's.
  var state = { user_id: d.userId, list_id: grant.list_id, last_pull_ok_at: nowIso,
                last_error: push.error || null,
                last_error_at: push.error ? new Date(d.now()).toISOString() : null, deep_ignored: diff.deep };
  if (push.pushed) state.last_push_ok_at = new Date(d.now()).toISOString();
  await d.store.setSync(state);
  var out = { ok: true, tasks: pull.tasks.length, pages: pull.pages, added: diff.added,
              changed: diff.changed, revived: diff.revived, missing: diff.missing.length,
              gone: diff.gone.length, deep_ignored: diff.deep,
              pushed: push.pushed, push_failed: push.failed, push_gone: push.gone, subtasks_made: made };
  if (push.error) out.push_error = push.error;
  if (push.reconnect) out.reconnect = true;
  return out;
}

/* ─────────────────────────────────────────────────────────────────────── */

/** Constant-time compare, copied from glance-refresh (the two share no module). */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] || 0) ^ (y[i % (y.length || 1)] || 0);
  return diff === 0 && x.length > 0;
}

/** The claims half of a JWT, unverified; getUser() does the verifying. As in gemini. */
function claims(jwt: string): Record<string, unknown> {
  try {
    const body = jwt.split('.')[1] || '';
    const pad = '='.repeat((4 - (body.length % 4)) % 4);
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/') + pad));
  } catch (_e) {
    return {};
  }
}

/** The signed-in user's id, or '' — the same checks as google-link. */
async function jwtUser(auth: string): Promise<string> {
  if (!/^Bearer\s+\S/i.test(auth)) return '';
  const jwt = auth.replace(/^Bearer\s+/i, '').trim();
  // The public anon key is also a valid JWT; only a signed-in user gets through.
  if (claims(jwt).role !== 'authenticated') return '';
  const sbUser = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_ANON_KEY') || '',
    { global: { headers: { Authorization: auth } }, auth: { persistSession: false } }
  );
  try {
    const { data, error } = await sbUser.auth.getUser();
    if (!error && data && data.user) return data.user.id;
  } catch (_e) { /* unreachable auth server = not signed in */ }
  return '';
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  // Unset refuses everyone, never admits everyone.
  const owner = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (!owner) return reply(403, { ok: false, error: 'set the ALLOWED_USER_ID secret first' });

  // The scheduler proves itself with the cron secret; the app with his JWT.
  const cronSaid = req.headers.get('x-cron-secret');
  // {poke:true} is the trigger's request after a tap (docs/tasks_sync.sql).
  let poke = false;
  if (cronSaid !== null) {
    const secret = (Deno.env.get('CRON_SECRET') || '').trim();
    if (!secret) return reply(403, { ok: false, error: 'CRON_SECRET is not set on this function' });
    if (!sameSecret(cronSaid, secret)) return reply(401, { ok: false, error: 'not the scheduler' });
    try {
      const body = await req.json();
      poke = Boolean(body && body.poke === true);
    } catch (_e) { /* no body: a plain run */ }
  } else {
    const who = await jwtUser(req.headers.get('Authorization') || '');
    if (!who) return reply(401, { ok: false, error: 'sign in first' });
    if (who !== owner) return reply(403, { ok: false, error: 'not your app' });
  }

  const cfg = googleConfig((name: string) => Deno.env.get(name));
  if (!cfg.configured) return reply(200, { ok: true, skipped: 'not set up' });
  let key: CryptoKey;
  try {
    key = await importTokenKey(cfg.tokenKey);
  } catch (_e) {
    // Named, never quoted, as in google-link: the parser's message could echo part of the key.
    return reply(503, { ok: false, error: 'Google setup has a problem: the token key is malformed.' });
  }

  const d = {
    cfg, key, userId: owner, fetch: fetch, now: Date.now,
    store: mirrorStore(createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false } }
    ))
  };

  try {
    const out = await runSync(d, poke);
    return reply(out.ok ? 200 : 502, out);
  } catch (e) {
    return reply(500, { ok: false, error: scrub((e as Error)?.message || e) });
  }
});
