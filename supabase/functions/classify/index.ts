// ProBeing — the `classify` Edge Function. Stage 14a.
//
// Files typed entries under his Google tasks: one Gemini call per batch, told
// only the open tasks of his chosen list, which also splits each entry into a
// few items. An entry it cannot place goes to the Unsorted tray (entry_filing
// state 'unsorted'), where he files it by hand.
//
// Called with the cron secret by an insert trigger on each new entry and by
// pg_cron every 5 minutes (docs/classify.sql). A run calls Gemini only when a
// batch is ready — FILE_BATCH_MIN entries waiting, or the oldest waiting
// FILE_WAIT_MIN minutes (default 30) — else it answers "waiting" after one
// small read. Simulated, 35-40 entries a day spread 08:00-23:00 take about 16
// calls a day with almost nothing sent to Unsorted for budget, and an entry
// waits at most about 35 minutes. At 15 minutes the same days used all 18
// calls and left 5-7 entries a day in the tray.
//
// Budget: a gemini_usage slot is taken BEFORE each request, on Google's quota
// day (the Pacific date), cap GEMINI_DAILY, default 18; at most one call per
// GEMINI_PACE_MS. Past the cap, an entry whose words name exactly one task is
// filed there without items; the rest go to Unsorted with reason 'budget'.
// Google refusing for the day marks it spent.
//
// Secrets: CRON_SECRET, ALLOWED_USER_ID, GEMINI_API_KEY and GEMINI_MODEL (all
// already set for the other functions); GEMINI_DAILY and FILE_WAIT_MIN optional.
// Needs the "filing (14a)" tables of docs/supabase_schema.sql.
//
// Deployed by hand:
//   npx supabase functions deploy classify --project-ref <ref> --use-api

import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/day.js';
import '../_shared/tree.js';
import { usageDay, takeCall, spendDay } from '../_shared/usage.ts';

// Classic scripts, so they hand their functions over on globalThis.
const Day = (globalThis as unknown as { ProBeingDay: Record<string, any> }).ProBeingDay;
const Tree = (globalThis as unknown as { ProBeingTree: Record<string, any> }).ProBeingTree;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/* ── The pure part: no clock, database or network. Plain JS with `var`, so
 *    claudeWorkingDocs/tests/classify_*.js can lift it. Day and Tree are
 *    day.js and tree.js. ─────────────────────────────────────────────────── */

var FILE_WAIT_MIN_DEFAULT = 30;
var FILE_BATCH_MIN = 8;              // this many waiting: no need to wait longer
var FILE_BATCH_MAX = 20;             // entries in one prompt
var FILE_MAX_AGE_MS = 48 * 3600000;  // a pending row older than this goes to Unsorted
var FILE_MAX_TRIES = 3;              // unusable answers before an entry goes to Unsorted
var CLAIM_LEASE_MS = 3 * 60000;      // a run that dies frees its rows after this
var GEMINI_DAILY_DEFAULT = 18;
var GEMINI_PACE_MS = 15000;          // 4 a minute, under the free tier's 5
var GEMINI_RPM = 4;
var GEMINI_TIMEOUT_MS = 30000;
var ITEMS_PER_ENTRY = 5;
var ITEMS_PER_NODE = 5;              // open items shown to Gemini per task
var ITEM_MAX_CHARS = 120;
var NAME_MIN_CHARS = 3;              // a shorter title is too easy to hit by accident

var CLASSIFY_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      n: { type: 'INTEGER' },
      subtask: { type: 'STRING' },
      project: { type: 'STRING' },
      items: { type: 'ARRAY', items: { type: 'STRING' } },
      same_as: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['n', 'subtask', 'project', 'items']
  }
};

/** A positive whole number from a secret, or `fallback`. */
function envCount(v, fallback) {
  var n = Math.floor(Number(v));
  return isFinite(n) && n > 0 ? n : fallback;
}

function ms(iso) {
  var t = Date.parse(String(iso || ''));
  return isFinite(t) ? t : NaN;
}

/** Pending rows split: `old` go to Unsorted, `live` (oldest first) may be filed. */
function splitPending(rows, now) {
  var sorted = (rows || []).slice().sort(function (a, b) { return ms(a.created_at) - ms(b.created_at); });
  return {
    old: sorted.filter(function (r) { return now - ms(r.created_at) > FILE_MAX_AGE_MS; }),
    live: sorted.filter(function (r) { return !(now - ms(r.created_at) > FILE_MAX_AGE_MS); })
  };
}

/**
 * The batching rule. `live` oldest first. Rows another run holds are skipped.
 * {act: 'nothing' | 'waiting' | 'file', take: rows to claim}.
 */
function batchDecision(live, now, waitMin) {
  var free = (live || []).filter(function (r) { return !(ms(r.claimed_until) > now); });
  if (!free.length) return { act: 'nothing', take: [] };
  var ready = free.length >= FILE_BATCH_MIN || now - ms(free[0].created_at) >= waitMin * 60000;
  if (!ready) return { act: 'waiting', take: [] };
  return { act: 'file', take: free.slice(0, FILE_BATCH_MAX) };
}

function byPosition(a, b) {
  var x = String(a.position || '');
  var y = String(b.position || '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The tasks Gemini may choose from: open projects of the list as p1, p2…, and
 * their open sub-tasks as s1, s2…. A project with no open sub-task is itself a
 * place to file (correction C3). {list, byId}.
 */
function candidateTasks(nodes, listId) {
  var mine = (nodes || []).filter(function (n) {
    return n && n.list_id === listId && Tree.nodeState(n) === 'open';
  });
  var list = [];
  var byId = Object.create(null);
  var p = 0;
  var s = 0;
  mine.filter(function (n) { return n.kind === 'project'; }).sort(byPosition).forEach(function (proj) {
    var entry = { id: 'p' + (++p), node: proj, project: proj, parent: '', subs: [] };
    list.push(entry);
    byId[entry.id] = entry;
    mine.filter(function (n) { return n.kind === 'subtask' && n.parent_google_id === proj.google_id; })
      .sort(byPosition).forEach(function (sub) {
        var c = { id: 's' + (++s), node: sub, project: proj, parent: entry.id, subs: [] };
        entry.subs.push(c.id);
        list.push(c);
        byId[c.id] = c;
      });
  });
  return { list: list, byId: byId };
}

/** The prompt: his tasks with short ids, their open items, then the numbered lines. */
function classifyPrompt(texts, cands, itemsByNode) {
  var lines = [
    'You are filing lines from a personal work log under the person\'s own task list. ' +
    'Answer with JSON only.',
    '',
    'The task list. Projects have p-ids; their sub-tasks have s-ids and are indented under them:'
  ];
  var itemIds = 0;
  cands.list.forEach(function (c) {
    var head = (c.parent ? '  ' : '') + c.id + ' ' + JSON.stringify(String(c.node.title || '')) +
               (!c.parent && !c.subs.length ? ' (no sub-tasks)' : '');
    lines.push(head);
    (itemsByNode[c.node.id] || []).forEach(function (it) {
      it.promptId = 'i' + (++itemIds);
      lines.push((c.parent ? '    ' : '  ') + 'item ' + it.promptId + ': ' + JSON.stringify(String(it.title)));
    });
  });
  lines.push('');
  lines.push('There are ' + texts.length + ' lines, numbered:');
  texts.forEach(function (t, i) { lines.push((i + 1) + '. ' + JSON.stringify(String(t))); });
  lines.push('');
  lines.push('Return a JSON array of exactly ' + texts.length + ' objects, one for each line, in the ' +
             'same order as the numbering above. Answer for every line, including any you cannot file.');
  lines.push('n: the number of the line this object answers, copied from the list above. The first ' +
             'object must have n=1, the second n=2, and so on up to n=' + texts.length + '. Never ' +
             'renumber, reorder or skip a line.');
  lines.push('subtask: the s-id of the sub-task the line is about, or "" if none fits.');
  lines.push('project: the p-id of that sub-task\'s project; for a project with no sub-tasks, its own ' +
             'p-id; "" if the line fits no project.');
  lines.push('items: the small concrete jobs the line mentions, a few words each, in the line\'s own ' +
             'words. [] if it names none. Never invent one.');
  lines.push('same_as: the ids of items listed above that a job in this line repeats; leave those ' +
             'jobs out of items. [] if none.');
  lines.push('Use only ids from the list. If you are unsure, use "": a line left unfiled is fine, ' +
             'a line filed in the wrong place is not.');
  lines.push('These lines are often dictated, and speech-to-text mangles unusual names: "NeuraVue" ' +
             'arrives as "my review", "OneNet" as "one night". If a phrase sounds like a title above, ' +
             'read it as that title. Only when the sounds plainly match.');
  return lines.join('\n');
}

/** The model's text as JSON, fences and all; null when it is not JSON. */
function parseAnswer(text) {
  var body = String(text || '').trim();
  var fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  try { return JSON.parse(body); } catch (e) { return null; }
}

/** askGeminiMany's rule: exactly one answer per line, each saying which. '' when aligned. */
function misaligned(got, count) {
  if (!Array.isArray(got) || got.length !== count) {
    return 'gemini answered ' + (Array.isArray(got) ? got.length + ' lines' : 'something that is not a list') +
           ' for ' + count;
  }
  for (var i = 0; i < got.length; i++) {
    var said = got[i] && typeof got[i] === 'object' ? Number(got[i].n) : NaN;
    if (said !== i + 1) return 'gemini numbered line ' + (i + 1) + ' wrongly';
  }
  return '';
}

/** Up to ITEMS_PER_ENTRY short, distinct item titles. */
function tidyItems(raw) {
  if (!Array.isArray(raw)) return [];
  var seen = Object.create(null);
  var out = [];
  raw.forEach(function (x) {
    if (typeof x !== 'string') return;
    var t = x.replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (Array.from(t).length > ITEM_MAX_CHARS) t = Array.from(t).slice(0, ITEM_MAX_CHARS - 1).join('') + '…';
    var k = t.toLowerCase();
    if (seen[k] || out.length >= ITEMS_PER_ENTRY) return;
    seen[k] = 1;
    out.push(t);
  });
  return out;
}

/**
 * Where one answer files its line: {project, sub, items} with sub null for a
 * project of its own, or {unsorted: reason, items}. An id not in the list,
 * or a sub-task under another project than the one named, is Unsorted.
 */
function readAnswer(ans, cands) {
  var items = tidyItems(ans && ans.items);
  var sid = String((ans && ans.subtask) || '').trim();
  var pid = String((ans && ans.project) || '').trim();
  var sub = sid ? cands.byId[sid] : null;
  var proj = pid ? cands.byId[pid] : null;
  if ((sid && !(sub && sub.parent)) || (pid && !(proj && !proj.parent))) {
    return { unsorted: 'no-match', items: items };
  }
  if (sub) {
    if (proj && proj.id !== sub.parent) return { unsorted: 'no-match', items: items };
    return { project: sub.project, sub: sub.node, items: items };
  }
  if (proj && !proj.subs.length) return { project: proj.node, sub: null, items: items };
  return { unsorted: proj ? 'no-sub-task' : 'no-match', items: items };
}

function nameWords(s) {
  return String(s == null ? '' : s).toLowerCase().split(/[^0-9a-z\u0080-￿]+/)
    .filter(function (w) { return w; });
}

function saysName(words, want) {
  if (!want.length || want.length > words.length) return false;
  for (var i = 0; i + want.length <= words.length; i++) {
    var all = true;
    for (var j = 0; j < want.length; j++) {
      if (words[i + j] !== want[j]) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}

/**
 * The free fallback: the one place (a sub-task, or a project with none) whose
 * title the line plainly says, as app.js's localProjectName does for names.
 * The longest title wins; two different places tied is no answer.
 */
function localMatch(text, cands) {
  var words = nameWords(text);
  var best = null;
  var bestKey = [0, 0];
  var tied = false;
  cands.list.forEach(function (c) {
    if (!c.parent && c.subs.length) return;            // a project with sub-tasks is not a place
    var want = nameWords(c.node.title);
    if (want.join('').length < NAME_MIN_CHARS || !saysName(words, want)) return;
    var key = [want.length, String(c.node.title).length];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = c; bestKey = key; tied = false;
    } else if (key[0] === bestKey[0] && key[1] === bestKey[1]) {
      tied = true;
    }
  });
  if (!best || tied) return null;
  return best.parent ? { project: best.project, sub: best.node, items: [] }
                     : { project: best.node, sub: null, items: [] };
}

/** Google's refusal, narrowed to "the day is gone" (app.js's isDailyRefusal). */
function isDailyRefusal(msg) {
  var s = String(msg || '');
  if (!/quota|rate.?limit|RESOURCE_EXHAUSTED|exceeded/i.test(s)) return false;
  if (/per.?minute|PerMinute/i.test(s)) return false;
  var lim = /limit:\s*([0-9]+)/i.exec(s);
  return !!lim && Number(lim[1]) > GEMINI_RPM + 2;
}

function isQuota(status, msg) {
  return status === 429 || /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(String(msg || ''));
}

/** Deterministic, so filing the same entry twice inserts one set. */
function itemRid(entryRid, k) {
  return entryRid + '-i' + k;
}

/**
 * The columns filing writes on the entry. The titles only when renaming its
 * tile is safe (day.js canRename): a tile Stopped before filing keeps its
 * sentence, or the new name would reopen it.
 */
function filingFields(rows, entry, place) {
  var project = String(place.project.title || '').trim() || '(untitled)';
  var detail = place.sub ? String(place.sub.title || '').trim() || '(untitled)' : '';
  var node = place.sub || place.project;
  var key = String(entry.raw_text || '').trim();
  if (Day.canRename(rows, entry.rid, key, project)) return { node_id: node.id, project: project, detail: detail };
  return { node_id: node.id };
}

/* ─────────────────────────────────────────────────── end of the pure part */

/** Constant-time compare, as in the other cron functions. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] || 0) ^ (y[i % (y.length || 1)] || 0);
  return diff === 0 && x.length > 0;
}

/** Nothing that leaves this function may carry the key. */
function scrub(text: unknown): string {
  return String(text ?? '').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]');
}

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

/** One call. {ok, text} or {ok:false, quota: 'day'|'minute'|'', error}. */
async function askGemini(key: string, model: string, prompt: string) {
  const ask: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    // No thinking knob: gemini-flash-lite-latest refused it (400), so every batch
    // cost two calls (1 Oct, live). A batch is not waiting on a person, so speed is moot.
    generationConfig: { responseMimeType: 'application/json', responseSchema: CLASSIFY_SCHEMA }
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
  const call = (payload: unknown) => fetch(GEMINI_URL + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(payload),
    signal: ctrl.signal
  });
  try {
    let res = await call(ask);

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const why = scrub((body && body.error && body.error.message) || res.status);
      const quota = isQuota(res.status, why) ? (isDailyRefusal(why) ? 'day' : 'minute') : '';
      return { ok: false, quota, error: 'gemini (' + model + ') refused: ' + why };
    }
    const parts = (body && body.candidates && body.candidates[0] && body.candidates[0].content &&
                   body.candidates[0].content.parts) || [];
    return { ok: true, text: parts.map((p: { text?: string }) => p.text || '').join('') };
  } catch (e) {
    return { ok: false, quota: '', error: 'could not reach gemini: ' + scrub((e as Error)?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** The database side. `sb` is the service-role client, so every query names the user. */
function store(sb: any, owner: string) {
  function must(r: { error?: { message?: string } | null; data?: any }) {
    if (r.error) throw new Error(r.error.message || 'database error');
    return r.data;
  }
  const stamp = () => new Date().toISOString();
  return {
    sb,
    pending: async () => must(await sb.from('entry_filing')
      .select('entry_rid,tries,claimed_until,created_at')
      .eq('user_id', owner).eq('state', 'pending').order('created_at', { ascending: true }).limit(200)) || [],
    syncState: async () => (must(await sb.from('sync_state').select('connected,list_id,list_title')
      .eq('user_id', owner).limit(1)) || [])[0] || null,
    expire: async (rids: string[]) => {
      if (rids.length) {
        must(await sb.from('entry_filing').update({ state: 'unsorted', reason: 'too-old', updated_at: stamp() })
          .eq('user_id', owner).eq('state', 'pending').in('entry_rid', rids));
      }
    },
    // One conditional update: a row another run holds is not taken.
    claim: async (rids: string[], runId: string, now: number) => must(await sb.from('entry_filing')
      .update({ claimed_until: new Date(now + CLAIM_LEASE_MS).toISOString(), claim_id: runId })
      .eq('user_id', owner).eq('state', 'pending').in('entry_rid', rids)
      .or('claimed_until.is.null,claimed_until.lt."' + new Date(now).toISOString() + '"')
      .select('entry_rid,tries,created_at')) || [],
    // Back to waiting, or to its final state; only while this run still holds it.
    release: async (rid: string, runId: string, tries: number) => {
      must(await sb.from('entry_filing').update({ claimed_until: null, claim_id: null, tries, updated_at: stamp() })
        .eq('user_id', owner).eq('entry_rid', rid).eq('claim_id', runId));
    },
    finish: async (rid: string, runId: string, state: string, reason: string, tries: number) => {
      must(await sb.from('entry_filing').update({ state, reason, tries, claimed_until: null, claim_id: null,
                                                  updated_at: stamp() })
        .eq('user_id', owner).eq('entry_rid', rid).eq('claim_id', runId));
    },
    entries: async (rids: string[]) => must(await sb.from('events')
      .select('rid,at,type,raw_text,project,detail,node_id').eq('user_id', owner).in('rid', rids)) || [],
    // The work session's rows since `iso`, newest first as replayDay takes them.
    rowsSince: async (iso: string) => must(await sb.from('events')
      .select('rid,at,type,raw_text,project,detail').eq('user_id', owner).in('type', Day.LEAD_TYPES)
      .gte('at', iso).order('at', { ascending: false }).order('created_at', { ascending: false })
      .limit(2000)) || [],
    nodes: async (listId: string) => must(await sb.from('task_nodes')
      .select('id,google_id,list_id,parent_google_id,kind,title,position,g_status,gone_at')
      .eq('user_id', owner).eq('list_id', listId).limit(1000)) || [],
    items: async (nodeIds: string[]) => nodeIds.length ? must(await sb.from('items')
      .select('rid,node_id,title').eq('user_id', owner).in('node_id', nodeIds)
      .order('created_at', { ascending: false }).limit(500)) || [] : [],
    // Fill-once, as the browser's label: only a row still blank.
    file: async (rid: string, fields: Record<string, unknown>) => (must(await sb.from('events')
      .update(fields).eq('user_id', owner).eq('rid', rid).eq('project', '').is('node_id', null)
      .select('rid')) || []).length,
    nodeOf: async (rid: string) => ((must(await sb.from('events').select('node_id')
      .eq('user_id', owner).eq('rid', rid).limit(1)) || [])[0] || {}).node_id || null,
    putItems: async (rows: Record<string, unknown>[]) => {
      if (rows.length) {
        must(await sb.from('items').upsert(rows, { onConflict: 'user_id,rid', ignoreDuplicates: true }));
      }
    }
  };
}

type Claim = { entry_rid: string; tries: number; created_at: string };
type Entry = { rid: string; at: string; raw_text: string; project: string; node_id: string | null };
type Place = { project: any; sub: any; items: string[]; unsorted?: string };

/** One run. `d`: {db, owner, now, key, model, cap, waitMin, runId}. */
async function classifyRun(d: any) {
  const db = d.db;
  const now = d.now();
  const pend = await db.pending();
  if (!pend.length) return { ok: true, act: 'nothing' };

  const sync = await db.syncState();
  if (!sync || !sync.connected || !sync.list_id || !sync.list_title) {
    return { ok: true, act: 'skipped', why: 'Google Tasks is not connected' };
  }

  const split = splitPending(pend, now);
  await db.expire(split.old.map((r: Claim) => r.entry_rid));
  const plan = batchDecision(split.live, now, d.waitMin);
  if (plan.act !== 'file') return { ok: true, act: plan.act, waiting: split.live.length };

  const claimed: Claim[] = await db.claim(plan.take.map((r: Claim) => r.entry_rid), d.runId, now);
  if (!claimed.length) return { ok: true, act: 'busy' };
  claimed.sort((a, b) => ms(a.created_at) - ms(b.created_at));     // oldest first in the prompt

  const out = { ok: true, act: 'filed', filed: 0, unsorted: 0, retry: 0, calls: 0 } as Record<string, any>;
  const finish = async (c: Claim, state: string, reason: string, tries?: number) => {
    await db.finish(c.entry_rid, d.runId, state, reason, tries === undefined ? c.tries : tries);
    out[state === 'filed' ? 'filed' : 'unsorted'] += 1;
  };

  const byRid: Record<string, Entry> = {};
  (await db.entries(claimed.map((c) => c.entry_rid))).forEach((e: Entry) => { byRid[e.rid] = e; });
  const live: { c: Claim; e: Entry }[] = [];
  for (const c of claimed) {
    const e = byRid[c.entry_rid];
    if (!e) await finish(c, 'unsorted', 'missing');
    else if (e.project || e.node_id) await finish(c, 'filed', 'labelled');   // named elsewhere first
    else live.push({ c, e });
  }
  if (!live.length) return out;

  const cands = candidateTasks(await db.nodes(sync.list_id), sync.list_id);
  if (!cands.list.length) {
    for (const x of live) await finish(x.c, 'unsorted', 'no-tasks');
    return out;
  }

  // The rename check's rows, read just before deciding: a Stop pressed while
  // Gemini was answering must be seen.
  const oldest = Math.min(...live.map((x) => ms(x.e.at)).filter(isFinite));
  const since = new Date((isFinite(oldest) ? oldest : now) - Day.LEAD_MAX_MS).toISOString();
  let rows: unknown[] = [];

  // Writes one entry's filing: the row first, then its items, then its state.
  const apply = async (x: { c: Claim; e: Entry }, place: Place, how: string) => {
    if (place.unsorted) {
      await db.putItems(place.items.map((t, k) => ({ user_id: d.owner, rid: itemRid(x.e.rid, k + 1),
        node_id: null, source_rid: x.e.rid, title: t, made_by: 'gemini', at: x.e.at })));
      await finish(x.c, 'unsorted', place.unsorted);
      return;
    }
    const fields = filingFields(rows, x.e, place) as { node_id: string };
    if (!(await db.file(x.e.rid, fields)) && (await db.nodeOf(x.e.rid)) !== fields.node_id) {
      await finish(x.c, 'filed', 'labelled');            // filed elsewhere meanwhile: its items are not ours
      return;
    }
    await db.putItems(place.items.map((t, k) => ({ user_id: d.owner, rid: itemRid(x.e.rid, k + 1),
      node_id: fields.node_id, source_rid: x.e.rid, title: t, made_by: 'gemini', at: x.e.at })));
    await finish(x.c, 'filed', how);
  };

  // No call possible: the free title match, else Unsorted 'budget'.
  const fallBack = async () => {
    out.act = 'local';
    rows = await db.rowsSince(since);
    for (const x of live) {
      const hit = localMatch(x.e.raw_text, cands);
      await apply(x, hit || { project: null, sub: null, items: [], unsorted: 'budget' }, 'local');
    }
    return out;
  };

  // Not this time: back to waiting, counting a try unless Google only asked us to slow down.
  const later = async (why: string, counts: boolean) => {
    out.act = 'retry';
    out.why = why;
    for (const x of live) {
      const tries = x.c.tries + (counts ? 1 : 0);
      if (tries >= FILE_MAX_TRIES) await finish(x.c, 'unsorted', 'no-answer', tries);
      else { await db.release(x.c.entry_rid, d.runId, tries); out.retry += 1; }
    }
    return out;
  };

  const day = usageDay(now);
  const slot = await takeCall(db.sb, d.owner, day, d.cap, GEMINI_PACE_MS);
  if (slot === 0) return fallBack();
  if (slot < 0) {
    for (const x of live) await db.release(x.c.entry_rid, d.runId, x.c.tries);
    return { ok: true, act: 'waiting', why: 'pace' };
  }

  const items = await db.items(cands.list.map((c: any) => c.node.id));
  const itemsByNode: Record<string, unknown[]> = {};
  items.forEach((it: { node_id: string }) => {
    const list = itemsByNode[it.node_id] = itemsByNode[it.node_id] || [];
    if (list.length < ITEMS_PER_NODE) list.push(it);
  });

  out.calls = 1;
  out.model = d.model;
  const g = await askGemini(d.key, d.model, classifyPrompt(live.map((x) => x.e.raw_text), cands, itemsByNode));
  if (!g.ok) {
    if (g.quota === 'day') {
      await spendDay(db.sb, d.owner, day, d.cap);
      return fallBack();
    }
    return later(g.error, g.quota !== 'minute');
  }
  const got = parseAnswer(g.text);
  const wrong = misaligned(got, live.length);
  if (wrong) return later(wrong, true);

  rows = await db.rowsSince(since);

  for (let i = 0; i < live.length; i++) await apply(live[i], readAnswer(got[i], cands), 'gemini');
  return out;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  const secret = (Deno.env.get('CRON_SECRET') || '').trim();
  if (!secret) return reply(403, { ok: false, error: 'CRON_SECRET is not set on this function' });
  if (!sameSecret(req.headers.get('x-cron-secret') || '', secret)) {
    return reply(401, { ok: false, error: 'not the scheduler' });
  }
  const owner = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (!owner) return reply(403, { ok: false, error: 'set the ALLOWED_USER_ID secret first' });
  const key = Deno.env.get('GEMINI_API_KEY') || '';
  if (!key) return reply(503, { ok: false, error: 'GEMINI_API_KEY is not set on this function' });

  const sb = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
                          { auth: { persistSession: false } });
  try {
    const out = await classifyRun({
      db: store(sb, owner), owner, now: Date.now, key,
      model: Deno.env.get('GEMINI_MODEL') || 'gemini-flash-lite-latest',
      cap: envCount(Deno.env.get('GEMINI_DAILY'), GEMINI_DAILY_DEFAULT),
      waitMin: envCount(Deno.env.get('FILE_WAIT_MIN'), FILE_WAIT_MIN_DEFAULT),
      runId: crypto.randomUUID()
    });
    return reply(200, out);
  } catch (e) {
    // Claimed rows free themselves when the lease runs out.
    return reply(500, { ok: false, error: scrub((e as Error)?.message || e) });
  }
});
