// ProBeing — the `sheets-export` Edge Function. Stage 18.
//
// Writes a readable copy of his tables into one Google Sheet in his Drive:
// tabs Entries, Tasks, Items, Marks, Money and Reports. pg_cron calls it once
// a day at 12:00 Karachi with the cron secret (docs/sheets_export.sql); Settings'
// "Export now" calls it with his JWT. The database wins: the sheet is a copy,
// rewritten whole every run, and nothing is ever read back from it.
//
// The sheet is one ProBeing made itself, which is all drive.file allows. Its id
// is google_grants.sheet_id. If that file is in the bin or gone, a new one is
// made and sync_state.sheet_note says so; the old file is left exactly as it is.
//
// Every write is valueInputOption=RAW: "+ Tea" typed with USER_ENTERED once
// became #NAME?, and "=HYPERLINK(...)" would run as a formula.
//
// DORMANT until Google is connected: {ok:true, skipped}, nothing written.
// Secrets: the Stage 12 three, CRON_SECRET and ALLOWED_USER_ID. Needs the
// export_error and sheet_note columns of sync_state (supabase_schema.sql).
//
// Deployed by hand, like the others:
//   npx supabase functions deploy sheets-export --project-ref <ref> --use-api

import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/google.js';

const { RECONNECT, googleConfig, importTokenKey, scrub, markReconnect, accessToken, reconnectError } =
  (globalThis as unknown as { ProBeingGoogle: Record<string, any> }).ProBeingGoogle;

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

/* ── Pure helpers. Plain JS with `var`, as in tasks-sync, so a node test can
 *    lift them. Clock, network and database arrive as arguments. ─────────── */

var SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
var DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files/';
var DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
var SHEET_TITLE = 'ProBeing copy';
var TABS = ['Entries', 'Tasks', 'Items', 'Marks', 'Money', 'Reports'];
var DEFAULT_ZONE = 'Asia/Karachi';
// Google's limit is 50,000 characters a cell.
var CELL_MAX = 49000;
// Per values.update. Google advises payloads under 2 MB.
var CHUNK_ROWS = 2000;
var CHUNK_BYTES = 1000000;
var UTF8 = new TextEncoder();   // request sizes are bytes, and Urdu is 2 bytes a letter
var READ_PAGE = 1000;
var CLAIM_MS = 5 * 60 * 1000;   // a run that died frees the next one after this           // PostgREST's cap; every read pages past it
var NO_DRIVE = 'Drive not allowed: reconnect Google and tick both boxes to get the Sheet copy.';

function sheetUrl(id) {
  return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/edit';
}

/** A zone Intl accepts, else Karachi. */
function zoneOr(zone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: String(zone || '') });
    return zone ? String(zone) : DEFAULT_ZONE;
  } catch (_e) {
    return DEFAULT_ZONE;
  }
}

/** "2026-10-07 14:05:09" in `zone`, or '' for no time. Text, so it sorts as written. */
function localStamp(iso, zone) {
  var ms = Date.parse(iso || '');
  if (!isFinite(ms)) return '';
  var p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
                                     hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}

/** One cell: numbers stay numbers, everything else is text, cut to fit. */
function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return isFinite(v) ? v : String(v);
  var s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length <= CELL_MAX) return s;
  // Never end on the first half of a surrogate pair (an emoji cut in two).
  var end = /[\uD800-\uDBFF]/.test(s.charAt(CELL_MAX - 1)) ? CELL_MAX - 1 : CELL_MAX;
  return s.slice(0, end) + '… (cut)';
}

/** A cancelled row and the row that cancels it both say so; neither counts. */
function moneyStatus(r, voidedBy) {
  if (r.voids_rid) return 'cancels ' + r.voids_rid;
  if (voidedBy[r.rid]) return 'cancelled by ' + voidedBy[r.rid];
  return '';
}

/** item rid -> its newest mark, ordered as the item_mark_latest view orders them. */
function latestMarks(marks) {
  var best = {};
  (marks || []).forEach(function (m) {
    var b = best[m.item_rid];
    var newer = !b || Date.parse(m.at) > Date.parse(b.at) ||
      (Date.parse(m.at) === Date.parse(b.at) && (Date.parse(m.created_at) > Date.parse(b.created_at) ||
        (Date.parse(m.created_at) === Date.parse(b.created_at) && String(m.rid) > String(b.rid))));
    if (newer) best[m.item_rid] = m;
  });
  return best;
}

/**
 * The six tabs as rows: [{title, header, rows}]. `data` holds every row of
 * events, task_nodes, items, item_marks, money and reports for one user.
 */
function buildTabs(data, zone) {
  var when = 'When (' + zone + ')';
  var nodes = data.task_nodes || [];
  var byId = {};
  var byGoogle = {};
  nodes.forEach(function (n) { byId[n.id] = n; byGoogle[n.google_id] = n; });
  function taskName(id) {
    var n = byId[id];
    if (!n) return id ? '(task not in the copy)' : '';
    var up = n.parent_google_id ? byGoogle[n.parent_google_id] : null;
    return (up ? (up.title || '(untitled)') + ' › ' : '') + (n.title || '(untitled)');
  }
  var items = data.items || [];
  var itemTitle = {};
  items.forEach(function (i) { itemTitle[i.rid] = i.title; });
  var newest = latestMarks(data.item_marks);
  var voidedBy = {};
  (data.money || []).forEach(function (r) { if (r.voids_rid) voidedBy[r.voids_rid] = r.rid; });

  // Projects in Google's order, each followed by its sub-tasks; strays last.
  function byPos(a, b) {
    return String(a.position) < String(b.position) ? -1 : String(a.position) > String(b.position) ? 1
         : String(a.google_id) < String(b.google_id) ? -1 : 1;
  }
  var placed = {};
  var taskRows = [];
  function taskRow(n) {
    placed[n.id] = true;
    var up = n.parent_google_id ? byGoogle[n.parent_google_id] : null;
    taskRows.push([n.kind === 'project' ? n.title : (up ? up.title : ''), n.kind === 'project' ? '' : n.title,
                   n.kind, n.due || '', n.g_status, localStamp(n.g_completed_at, zone),
                   localStamp(n.pb_done_at, zone), localStamp(n.gone_at, zone), n.list_id, n.google_id]);
  }
  nodes.filter(function (n) { return n.kind === 'project'; }).sort(byPos).forEach(function (p) {
    taskRow(p);
    nodes.filter(function (n) { return n.kind !== 'project' && n.parent_google_id === p.google_id && n.list_id === p.list_id; })
      .sort(byPos).forEach(taskRow);
  });
  nodes.filter(function (n) { return !placed[n.id]; }).sort(byPos).forEach(taskRow);

  return [
    { title: 'Entries',
      header: [when, 'Type', 'Text', 'Project', 'Detail', 'Task', 'Time (UTC)', 'Row id'],
      rows: (data.events || []).map(function (e) {
        return [localStamp(e.at, zone), e.type, e.raw_text, e.project, e.detail, taskName(e.node_id), e.at, e.rid];
      }) },
    { title: 'Tasks',
      header: ['Project', 'Sub-task', 'Kind', 'Due', 'Google status', 'Completed in Google',
               'Done in ProBeing', 'Deleted in Google', 'List id', 'Google id'],
      rows: taskRows },
    { title: 'Items',
      header: [when, 'Item', 'Task', 'State', 'Made by', 'From entry', 'Row id'],
      rows: items.map(function (i) {
        var m = newest[i.rid];
        return [localStamp(i.at, zone), i.title, i.node_id ? taskName(i.node_id) : 'Unsorted',
                m ? m.mark : 'open', i.made_by, i.source_rid, i.rid];
      }) },
    { title: 'Marks',
      header: [when, 'Mark', 'Item', 'Item id', 'Row id'],
      rows: (data.item_marks || []).map(function (m) {
        return [localStamp(m.at, zone), m.mark, itemTitle[m.item_rid] || '(item not in the copy)', m.item_rid, m.rid];
      }) },
    { title: 'Money',
      header: [when, 'Kind', 'Direction', 'Amount', 'Currency', 'Tag', 'Person', 'Note', 'Status', 'Row id'],
      rows: (data.money || []).map(function (r) {
        var n = Number(r.amount);
        return [localStamp(r.at, zone), r.kind || 'cash', r.dir, isFinite(n) ? n : String(r.amount), r.currency,
                r.tag, r.person, r.note, moneyStatus(r, voidedBy), r.rid];
      }) },
    { title: 'Reports',
      header: ['Period', 'From', 'To', 'Written (' + zone + ')', 'Model', 'Text', 'Figures'],
      rows: (data.reports || []).map(function (r) {
        return [r.period, r.start_date, r.end_date, localStamp(r.generated_at, zone), r.model, r.text, r.stats];
      }) }
  ];
}

/** Banner, header, rows: what goes in the tab, every cell made safe. */
function tabMatrix(tab, stamp) {
  var out = [['Copy written by ProBeing at ' + stamp + ' — edits here are overwritten.'], tab.header];
  tab.rows.forEach(function (r) { out.push(r.map(cell)); });
  return out;
}

/** Column letters for 1-based n: 1 -> A, 27 -> AA. */
function colName(n) {
  var s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Rows cut into pieces of at most CHUNK_ROWS rows and about CHUNK_BYTES of JSON: [{start, rows}]. */
function chunkRows(matrix, maxRows, maxBytes) {
  maxRows = maxRows || CHUNK_ROWS;
  maxBytes = maxBytes || CHUNK_BYTES;
  var out = [];
  var cur = null;
  var bytes = 0;
  matrix.forEach(function (row, i) {
    var size = UTF8.encode(JSON.stringify(row)).length + 1;
    if (!cur || cur.rows.length >= maxRows || (cur.rows.length && bytes + size > maxBytes)) {
      cur = { start: i, rows: [] };
      out.push(cur);
      bytes = 0;
    }
    cur.rows.push(row);
    bytes += size;
  });
  return out;
}

/** One Google request with his token; a 401 gets one forced refresh. Answers {status, ok, body}. */
async function googleSend(d, grant, method, url, body) {
  function send(token) {
    var headers = { Authorization: 'Bearer ' + token };
    if (body === undefined) return d.fetch(url, { method: method, headers: headers });
    headers['Content-Type'] = 'application/json';
    return d.fetch(url, { method: method, headers: headers, body: JSON.stringify(body) });
  }
  var res = await send(await accessToken(d, grant, false));
  if (res.status === 401) res = await send(await accessToken(d, grant, true));
  var got = await res.json().catch(function () { return null; });
  return { status: res.status, ok: res.ok, body: got };
}

/** A failed answer as a plain error: reconnect, not enabled, busy, or Google's words. */
function googleError(what, r) {
  var said = JSON.stringify(r.body || {});
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used/.test(said)) {
    return new Error('The Google ' + what + ' API is not enabled in the Cloud project.');
  }
  if (r.status === 429 || /rateLimit|RATE_LIMIT|quota|dailyLimit|usageLimits/i.test(said)) {
    return new Error('Google ' + what + ' is busy; try again in a minute.');
  }
  if (/SCOPE_INSUFFICIENT|insufficient.*scope/i.test(said)) return new Error(NO_DRIVE);
  if (r.status === 401) return reconnectError('Google refused the Drive permission');
  var e = new Error('Google ' + what + ' answered ' + r.status + ': ' +
                    scrub(r.body && r.body.error && r.body.error.message));
  e.status = r.status;
  return e;
}

/** Is our sheet still there and out of the bin? true, false (make a new one), or a throw. */
async function sheetAlive(d, grant, id) {
  var r = await googleSend(d, grant, 'GET', DRIVE_FILES_URL + encodeURIComponent(id) +
                           '?fields=id%2Ctrashed&supportsAllDrives=false');
  if (r.ok) return Boolean(r.body && r.body.id) && r.body.trashed !== true;
  // Gone: a 404, or a 403 that names this file. Any other 403 (a quota, a scope) is an error.
  if (r.status === 404 || (r.status === 403 && /appNotAuthorizedToFile|insufficientFilePermissions/.test(JSON.stringify(r.body || {})))) {
    return false;
  }
  throw googleError('Drive', r);
}

/** A new spreadsheet with the six tabs, sized for `need` (title -> rows). */
async function createSheet(d, grant, need) {
  var r = await googleSend(d, grant, 'POST', SHEETS_URL, {
    properties: { title: SHEET_TITLE },
    sheets: TABS.map(function (t) {
      return { properties: { title: t, gridProperties: { rowCount: Math.max(need[t].rows, 100),
                                                         columnCount: Math.max(need[t].cols, 10),
                                                         frozenRowCount: 2 } } };
    })
  });
  if (!r.ok || !r.body || !r.body.spreadsheetId) throw googleError('Sheets', r);
  return String(r.body.spreadsheetId);
}

/** Add a tab he deleted, and grow any tab too small for its rows. Never shrinks. */
async function fitTabs(d, grant, id, need) {
  var r = await googleSend(d, grant, 'GET', SHEETS_URL + '/' + encodeURIComponent(id) +
                           '?fields=sheets.properties(sheetId%2Ctitle%2CgridProperties)');
  if (!r.ok) throw googleError('Sheets', r);
  var have = {};
  ((r.body && r.body.sheets) || []).forEach(function (s) {
    if (s && s.properties) have[s.properties.title] = s.properties;
  });
  var requests = [];
  TABS.forEach(function (t) {
    var p = have[t];
    var rows = Math.max(need[t].rows, 100);
    var cols = Math.max(need[t].cols, 10);
    if (!p) {
      requests.push({ addSheet: { properties: { title: t, gridProperties: { rowCount: rows, columnCount: cols,
                                                                            frozenRowCount: 2 } } } });
      return;
    }
    var g = p.gridProperties || {};
    if ((g.rowCount || 0) < need[t].rows || (g.columnCount || 0) < need[t].cols) {
      requests.push({ updateSheetProperties: {
        properties: { sheetId: p.sheetId, gridProperties: { rowCount: Math.max(g.rowCount || 0, need[t].rows),
                                                            columnCount: Math.max(g.columnCount || 0, need[t].cols) } },
        fields: 'gridProperties.rowCount,gridProperties.columnCount' } });
    }
  });
  if (!requests.length) return 0;
  var b = await googleSend(d, grant, 'POST', SHEETS_URL + '/' + encodeURIComponent(id) + ':batchUpdate',
                           { requests: requests });
  if (!b.ok) throw googleError('Sheets', b);
  return requests.length;
}

/** Clear the tab, then write it in chunks, RAW. Answers how many requests it sent. */
async function writeTab(d, grant, id, title, matrix) {
  var base = SHEETS_URL + '/' + encodeURIComponent(id) + '/values/';
  var whole = "'" + title + "'";
  var c = await googleSend(d, grant, 'POST', base + encodeURIComponent(whole) + ':clear', {});
  if (!c.ok) throw googleError('Sheets', c);
  var width = 1;
  matrix.forEach(function (r) { if (r.length > width) width = r.length; });
  var chunks = chunkRows(matrix);
  for (var i = 0; i < chunks.length; i++) {
    var ch = chunks[i];
    var range = whole + '!A' + (ch.start + 1) + ':' + colName(width) + (ch.start + ch.rows.length);
    var u = await googleSend(d, grant, 'PUT', base + encodeURIComponent(range) + '?valueInputOption=RAW',
                             { range: range, majorDimension: 'ROWS', values: ch.rows });
    if (!u.ok) throw googleError('Sheets', u);
  }
  return chunks.length;
}

/** The database side. `sb` is a service-role client, so every query names the user. */
function exportStore(sb) {
  function must(r) {
    if (r.error) throw new Error(r.error.message || 'database error');
    return r.data;
  }
  // Every page, newest first; a unique tie-break so paging neither skips nor repeats.
  async function all(table, cols, userId, first) {
    var out = [];
    // The next page starts after what came back; only an empty page ends it,
    // so a server cap below READ_PAGE cannot cut the read short.
    for (;;) {
      var q = sb.from(table).select(cols).eq('user_id', userId);
      if (first) q = q.order(first, { ascending: false });
      var rows = must(await q.order('id', { ascending: true }).range(out.length, out.length + READ_PAGE - 1)) || [];
      if (!rows.length) return out;
      out = out.concat(rows);
    }
  }
  return {
    getGrant: async function (userId) {
      var rows = must(await sb.from('google_grants').select('*').eq('user_id', userId).limit(1));
      return (rows || [])[0] || null;
    },
    // Take the export: only while no other run holds it. True when this run has it.
    claim: async function (userId, nowIso, untilIso) {
      var rows = must(await sb.from('google_grants').update({ export_claim_until: untilIso })
        .eq('user_id', userId)
        // Quoted: PostgREST reserves '.' and ':' inside an or=(...) value.
        .or('export_claim_until.is.null,export_claim_until.lt."' + nowIso + '"').select('user_id'));
      return (rows || []).length === 1;
    },
    release: async function (userId, untilIso) {
      must(await sb.from('google_grants').update({ export_claim_until: null })
        .eq('user_id', userId).eq('export_claim_until', untilIso));
    },
    patchGrant: async function (userId, fields) {
      must(await sb.from('google_grants').update(fields).eq('user_id', userId));
    },
    setSync: async function (row) {
      must(await sb.from('sync_state').upsert(Object.assign({}, row,
        { updated_at: new Date().toISOString() }), { onConflict: 'user_id' }));
    },
    zone: async function (userId) {
      var rows = must(await sb.from('user_settings').select('time_zone').eq('user_id', userId).limit(1));
      return ((rows || [])[0] || {}).time_zone || '';
    },
    data: async function (userId) {
      return {
        events: await all('events', 'id,at,type,raw_text,project,detail,node_id,rid', userId, 'at'),
        task_nodes: await all('task_nodes', 'id,google_id,list_id,parent_google_id,kind,title,position,due,' +
                              'g_status,g_completed_at,pb_done_at,gone_at', userId, ''),
        items: await all('items', 'id,rid,node_id,source_rid,title,made_by,at', userId, 'at'),
        item_marks: await all('item_marks', 'id,rid,item_rid,mark,at,created_at', userId, 'at'),
        money: await all('money', 'id,rid,at,kind,dir,amount,currency,tag,person,note,voids_rid', userId, 'at'),
        reports: await all('reports', 'id,period,start_date,end_date,text,stats,model,generated_at', userId, 'start_date')
      };
    }
  };
}

async function failExport(d, why) {
  try {
    await d.store.setSync({ user_id: d.userId, export_error: why });
  } catch (_e) { /* the reply still says it */ }
}

/** One export. `d`: {cfg, key, store, userId, fetch, now}. */
async function exportSheet(d) {
  var grant = await d.store.getGrant(d.userId);
  if (!grant) return { ok: true, skipped: 'not connected' };
  if ((grant.scopes || []).indexOf(DRIVE_FILE_SCOPE) === -1) {
    await failExport(d, NO_DRIVE);
    return { ok: false, error: NO_DRIVE };
  }
  var nowIso = new Date(d.now()).toISOString();
  var until = new Date(d.now() + CLAIM_MS).toISOString();
  // One export at a time: the noon run and Export now together must not make two sheets.
  try {
    if (!(await d.store.claim(d.userId, nowIso, until))) {
      return { ok: true, busy: true, skipped: 'an export is already running' };
    }
  } catch (e) {
    var why = 'Could not start the Google Sheet copy: ' + scrub((e && e.message) || e);
    await failExport(d, why);
    return { ok: false, error: why };
  }
  try {
    // Read again under the claim: a run that just finished may have stored the sheet.
    return await runExport(d, (await d.store.getGrant(d.userId)) || grant, nowIso);
  } finally {
    try { await d.store.release(d.userId, until); } catch (_e) { /* it lapses after CLAIM_MS */ }
  }
}

async function runExport(d, grant, nowIso) {
  var made = '';
  try {
    var zone = zoneOr(await d.store.zone(d.userId));
    var tabs = buildTabs(await d.store.data(d.userId), zone);
    var stamp = localStamp(nowIso, zone) + ' (' + zone + ')';
    var need = {};
    var matrices = {};
    tabs.forEach(function (t) {
      matrices[t.title] = tabMatrix(t, stamp);
      need[t.title] = { rows: matrices[t.title].length, cols: t.header.length };
    });

    var id = grant.sheet_id ? String(grant.sheet_id) : '';
    if (id && !(await sheetAlive(d, grant, id))) {
      made = 'replaced';
      id = '';
    }
    if (!id) {
      id = await createSheet(d, grant, need);
      made = made || 'created';
      // Stored at once, so a write that fails below does not make another file next run.
      await d.store.patchGrant(d.userId, { sheet_id: id, updated_at: nowIso });
      var note = made === 'replaced'
        ? 'Made a new Google Sheet on ' + localStamp(nowIso, zone).slice(0, 10) +
          ': the old one was in the bin or deleted. It was left as it is.'
        : null;
      await d.store.setSync({ user_id: d.userId, sheet_url: sheetUrl(id), sheet_note: note });
    } else {
      await fitTabs(d, grant, id, need);
    }

    var counts = {};
    var requests = 0;
    for (var i = 0; i < tabs.length; i++) {
      requests += await writeTab(d, grant, id, tabs[i].title, matrices[tabs[i].title]);
      counts[tabs[i].title] = tabs[i].rows.length;
    }
    await d.store.setSync({ user_id: d.userId, sheet_url: sheetUrl(id), last_export_at: nowIso, export_error: null });
    var out = { ok: true, sheet_url: sheetUrl(id), rows: counts, writes: requests };
    if (made) out[made] = true;
    return out;
  } catch (e) {
    if (e && e.reconnect) {
      await markReconnect(d, e.message);
      await failExport(d, RECONNECT + ': ' + e.message);
      return { ok: false, reconnect: true, error: RECONNECT + ' — ' + e.message + '.' };
    }
    var why = 'Could not write the Google Sheet copy: ' + scrub((e && e.message) || e);
    await failExport(d, why);
    return { ok: false, error: why };
  }
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
  if (cronSaid !== null) {
    const secret = (Deno.env.get('CRON_SECRET') || '').trim();
    if (!secret) return reply(403, { ok: false, error: 'CRON_SECRET is not set on this function' });
    if (!sameSecret(cronSaid, secret)) return reply(401, { ok: false, error: 'not the scheduler' });
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
    store: exportStore(createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false } }
    ))
  };

  try {
    const out = await exportSheet(d);
    return reply(out.ok ? 200 : 502, out);
  } catch (e) {
    return reply(500, { ok: false, error: scrub((e as Error)?.message || e) });
  }
});
