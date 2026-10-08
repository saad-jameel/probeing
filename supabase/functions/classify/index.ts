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
// Edit queue 2: Gemini knows the project but no sub-task fits -> it also gives a
// short title, and a sub-task is made under that project in his chosen list,
// mirrored into task_nodes and the entry filed there. Once per entry: the plan
// is saved on entry_filing BEFORE tasks.insert, and a retry looks in Google for
// it first. A refusal -> Unsorted as before; no answer -> pending, finished on
// the next run without Gemini. Tasks closed in ProBeing are not offered.
//
// Edit queue 4: one entry listing several pieces of work under a project may make
// up to NEW_SUBS_MAX new sub-tasks (more_subtasks), each with its own items, in the
// same one call per batch. The entry is filed under the main one (new_subtask, or
// the sub-task it chose, else the first listed). Every one is in the plan
// (new_more) before the first insert, so a retry makes none twice. A retry that
// cannot find a sent insert in Google (updated and whole-list look-ups) waits
// rather than inserting again; after FILE_MAX_TRIES the main one goes to
// Unsorted and another is let go. Only a 429 (nothing made) is inserted again.
//
// Secrets: CRON_SECRET, ALLOWED_USER_ID, GEMINI_API_KEY and GEMINI_MODEL (all
// already set for the other functions); GEMINI_DAILY and FILE_WAIT_MIN optional.
// The Google three (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_KEY)
// for making sub-tasks; without them an entry goes to Unsorted as before.
// Needs the "filing (14a)" tables of docs/supabase_schema.sql, and its edit
// queue 2 columns on entry_filing for making sub-tasks.
//
// Deployed by hand:
//   npx supabase functions deploy classify --project-ref <ref> --use-api

import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/day.js';
import '../_shared/tree.js';
import '../_shared/google.js';
import { usageDay, takeCall, spendDay } from '../_shared/usage.ts';

// Classic scripts, so they hand their functions over on globalThis.
const Day = (globalThis as unknown as { ProBeingDay: Record<string, any> }).ProBeingDay;
const Tree = (globalThis as unknown as { ProBeingTree: Record<string, any> }).ProBeingTree;
const G = (globalThis as unknown as { ProBeingGoogle: Record<string, any> }).ProBeingGoogle;

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
var NEW_TITLE_MAX = 80;              // a new sub-task's title, in characters
var NEW_SUBS_MAX = 5;                // new sub-tasks one entry may make (edit queue 4)
var TASKS_LISTS_URL = 'https://tasks.googleapis.com/tasks/v1/lists/';
var FIND_SLACK_MS = 10 * 60000;      // the look-up reaches this far before the plan
var FIND_PAGES = 5;
var SCAN_PAGES = 50;                 // the whole-list look-up: 5,000 tasks
var INSERT_TIMEOUT_MS = 30000;
// A plan younger than this may belong to a run still waiting on its insert
// (lease, plus that insert's timeout): left alone, not inserted again.
var PLAN_SETTLE_MS = CLAIM_LEASE_MS + 2 * 60000;
// An entry's plan for a new sub-task, cleared when it ends Unsorted.
var NO_PLAN = { new_title: null, new_parent: null, new_google_id: null, new_at: null };

var CLASSIFY_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      n: { type: 'INTEGER' },
      subtask: { type: 'STRING' },
      project: { type: 'STRING' },
      items: { type: 'ARRAY', items: { type: 'STRING' } },
      same_as: { type: 'ARRAY', items: { type: 'STRING' } },
      new_subtask: { type: 'STRING' },
      more_subtasks: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { title: { type: 'STRING' }, items: { type: 'ARRAY', items: { type: 'STRING' } } },
          required: ['title']
        }
      }
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
 * place to file (correction C3). `closed` (node id -> true) are closed in
 * ProBeing by their own Done or Drop: left out. {list, byId}.
 */
function candidateTasks(nodes, listId, closed) {
  var shut = closed || {};
  var mine = (nodes || []).filter(function (n) {
    return n && n.list_id === listId && Tree.nodeState(n) === 'open' && !shut[n.id];
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
  lines.push('new_subtask: only when project is a p-id that has sub-tasks and none of them fits the line ' +
             '(so subtask is ""): a short title for a new sub-task of that project, 2 to 6 words, in the ' +
             'line\'s own words. Otherwise "".');
  lines.push('more_subtasks: only when project is a p-id that has sub-tasks and the line lists OTHER, ' +
             'separate pieces of work for that project that no sub-task above covers: one object per ' +
             'piece, at most ' + (NEW_SUBS_MAX - 1) + ', each {"title": 2 to 6 words in the line\'s own ' +
             'words, "items": that piece\'s small jobs}. The piece the line is mainly about goes in ' +
             'subtask or new_subtask, never here. Otherwise [].');
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

/** A new sub-task's title: one line, at most NEW_TITLE_MAX characters; '' for
 *  none, or for one with no letter or digit in it. */
function tidyTitle(raw) {
  if (typeof raw !== 'string') return '';
  var t = raw.replace(/\s+/g, ' ').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  if (Array.from(t).length > NEW_TITLE_MAX) t = Array.from(t).slice(0, NEW_TITLE_MAX - 1).join('').trim() + '…';
  return t;
}

/** more_subtasks tidied: [{title, items}], distinct titles, none without a letter or digit. */
function tidyMore(raw) {
  if (!Array.isArray(raw)) return [];
  var seen = Object.create(null);
  var out = [];
  raw.forEach(function (x) {
    var t = tidyTitle(x && typeof x === 'object' ? x.title : x);
    var k = normTitle(t);
    if (!t || seen[k]) return;
    seen[k] = 1;
    out.push({ title: t, items: tidyItems(x && typeof x === 'object' ? x.items : []) });
  });
  return out;
}

/** The other places one answer names under project `proj` (a node): an open
 *  sub-task already so called, else one to make. Never the main one
 *  (`mainTitle`); at most NEW_SUBS_MAX made, the main one counted when it is
 *  made (`making`). [{title, sub, items}]. */
function extraPlaces(more, cands, proj, mainTitle, making) {
  var out = [];
  var made = making ? 1 : 0;
  more.forEach(function (m) {
    if (normTitle(m.title) === normTitle(mainTitle) || out.length >= NEW_SUBS_MAX) return;
    var same = existingSub(cands, proj, m.title);
    if (!same) {
      if (made >= NEW_SUBS_MAX) return;
      made += 1;
    }
    out.push({ title: same ? String(same.title || m.title) : m.title, sub: same, items: m.items });
  });
  return out;
}

/** Gemini said something, but nothing usable as a title. */
function junkTitle(raw) {
  return typeof raw === 'string' && raw.trim() !== '' && !tidyTitle(raw);
}

/** A title as compared: case, spacing and an end full stop do not count. */
function normTitle(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().replace(/\.$/, '').toLowerCase();
}

/** An open sub-task of `proj` (a candidate) already called `title`, or null. */
function existingSub(cands, proj, title) {
  var want = normTitle(title);
  var hit = cands.list.filter(function (c) {
    return c.parent && c.project.id === proj.id && normTitle(c.node.title) === want;
  })[0];
  return hit ? hit.node : null;
}

/** In tasks Google returned, the live one under `parent` called `title`, or null. */
function madeIn(tasks, parent, title) {
  var want = normTitle(title);
  return (tasks || []).filter(function (t) {
    return t && t.id && !t.deleted && t.parent === parent && normTitle(t.title) === want;
  })[0] || null;
}

/** Google's answer to tasks.insert: 'made', 'refused' (nothing was made: say so
 *  and stop), 'later' (Google asked to slow down: nothing was made, insert next
 *  run) or 'unsure' (it may have been made: keep the plan, look next run). */
function insertVerdict(status, body) {
  if (status >= 200 && status < 300) return body && typeof body.id === 'string' && body.id ? 'made' : 'unsure';
  if (status === 429 || /rateLimit|RATE_LIMIT|quota/i.test(JSON.stringify(body || {}))) return 'later';
  if (status >= 400 && status < 500) return 'refused';
  return 'unsure';
}

/**
 * Where one answer files its line: {project, sub, items} with sub null for a
 * project of its own, or {unsorted: reason, items}. An id not in the list,
 * or a sub-task under another project than the one named, is Unsorted. A
 * project with sub-tasks, none chosen, and a new title: {project, sub: null,
 * create: title, items}, or that sub-task when one already has the title.
 * Edit queue 4: `more` lists the other pieces of work (extraPlaces); with no
 * main title, the first of them is the main one.
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
  var more = tidyMore(ans && ans.more_subtasks);
  var place;
  if (sub) {
    if (proj && proj.id !== sub.parent) return { unsorted: 'no-match', items: items };
    place = { project: sub.project, sub: sub.node, items: items };
    var also = extraPlaces(more, cands, sub.project, sub.node.title, false);
    if (also.length) place.more = also;
    return place;
  }
  if (proj && !proj.subs.length) return { project: proj.node, sub: null, items: items };
  var title = proj ? tidyTitle(ans && ans.new_subtask) : '';
  if (proj && !title && more.length) {
    var first = more.shift();
    title = first.title;
    items = tidyItems(items.concat(first.items));
  }
  // A title with no letter or digit: filed on the project itself, nothing made.
  if (proj && !title && junkTitle(ans && ans.new_subtask)) return { project: proj.node, sub: null, items: items };
  if (title) {
    var same = existingSub(cands, proj.node, title);
    place = same ? { project: proj.node, sub: same, items: items }
                 : { project: proj.node, sub: null, create: title, items: items };
    var extra = extraPlaces(more, cands, proj.node, title, !same);
    if (extra.length) place.more = extra;
    return place;
  }
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

/** An item of the entry's j-th other new sub-task (edit queue 4): as fixed as itemRid. */
function moreItemRid(entryRid, j, k) {
  return entryRid + '-n' + j + '-i' + k;
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

/* ── Edit queue 2: a new sub-task in his chosen list ───────────────────── */

/** `g`: {d, grant, listId}, google.js's context with his grant for that list. */
async function insertSub(g: any, parentId: string, title: string) {
  const url = TASKS_LISTS_URL + encodeURIComponent(g.listId) + '/tasks?parent=' + encodeURIComponent(parentId);
  let token: string;
  try {
    token = await G.accessToken(g.d, g.grant, false);
  } catch (e) {
    return { verdict: 'refused', why: G.scrub((e as Error)?.message || e) };    // nothing was sent
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INSERT_TIMEOUT_MS);
  const send = (t: string) => g.d.fetch(url, {
    method: 'POST', body: JSON.stringify({ title }), signal: ctrl.signal,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }
  });
  try {
    let res = await send(token);
    if (res.status === 401) {
      try {
        res = await send(await G.accessToken(g.d, g.grant, true));
      } catch (e) {
        return { verdict: 'refused', why: G.scrub((e as Error)?.message || e) };
      }
    }
    const body = await res.json().catch(() => null);
    const verdict = insertVerdict(res.status, body);
    return { verdict, task: verdict === 'made' ? body : null,
             why: verdict === 'made' ? '' : 'Google Tasks answered ' + res.status + ': ' +
                  G.scrub(body && body.error && body.error.message) };
  } catch (e) {
    return { verdict: 'unsure', why: 'could not reach Google Tasks: ' + G.scrub((e as Error)?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** One look-up: pages of `query` until `parentId`/`title` turns up. {task} (null
 *  when none), or {unsure: why} when Google could not be read whole. */
async function lookIn(g: any, query: string, pages: number, parentId: string, title: string) {
  let page = '';
  try {
    for (let i = 0; i < pages; i++) {
      const body = await G.tasksGet(g.d, g.grant, TASKS_LISTS_URL + encodeURIComponent(g.listId) + '/tasks?' + query +
        (page ? '&pageToken=' + encodeURIComponent(page) : ''));
      const hit = madeIn(body.items, parentId, title);
      if (hit) return { task: hit };
      page = body.nextPageToken || '';
      if (!page) return { task: null };
    }
  } catch (e) {
    return { unsure: G.scrub((e as Error)?.message || e) };
  }
  return { unsure: 'too many tasks to look through' };
}

/** Was it made after all? First the tasks updated since the plan, then the whole
 *  list (Google's change listing can lag behind a new task). */
async function findMade(g: any, parentId: string, title: string, sinceIso: string) {
  const since = new Date((Date.parse(sinceIso) || 0) - FIND_SLACK_MS).toISOString();
  const all = 'showCompleted=true&showHidden=true&maxResults=100';
  const recent = await lookIn(g, all + '&updatedMin=' + encodeURIComponent(since), FIND_PAGES, parentId, title);
  if (recent.task || recent.unsure) return recent;
  return lookIn(g, all, SCAN_PAGES, parentId, title);
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
    finish: async (rid: string, runId: string, state: string, reason: string, tries: number,
                   extra?: Record<string, unknown>) => {
      must(await sb.from('entry_filing').update(Object.assign({ state, reason, tries, claimed_until: null,
                                                                claim_id: null, updated_at: stamp() }, extra || {}))
        .eq('user_id', owner).eq('entry_rid', rid).eq('claim_id', runId));
    },
    // Edit queue 2. The plans of these entries; null when the columns are not there yet.
    // Edit queue 4: with new_more, the other new sub-tasks; `more` false before that column.
    plans: async (rids: string[]) => {
      const cols = 'entry_rid,new_title,new_parent,new_google_id,new_at';
      let r = await sb.from('entry_filing').select(cols + ',new_more').eq('user_id', owner).in('entry_rid', rids);
      if (!r.error) return { rows: r.data || [], more: true };
      r = await sb.from('entry_filing').select(cols).eq('user_id', owner).in('entry_rid', rids);
      return r.error ? null : { rows: r.data || [], more: false };
    },
    // Save to the plan, only while this run holds the entry. False when it does not.
    plan: async (rid: string, runId: string, fields: Record<string, unknown>) => (must(await sb.from('entry_filing')
      .update(fields).eq('user_id', owner).eq('entry_rid', rid).eq('claim_id', runId).select('entry_rid')) || [])
      .length === 1,
    // Tasks closed by their own Done or Drop (tree.js directMarks). Unreadable: none.
    closed: async () => {
      const r = await sb.from('events').select('type,rid,node_id,at').eq('user_id', owner)
        .in('type', Tree.DIRECT_TYPES).not('node_id', 'is', null).order('at', { ascending: false }).limit(5000);
      const out: Record<string, boolean> = {};
      if (r.error) return out;
      const marks = Tree.directMarks(r.data || []);
      Object.keys(marks).forEach((id) => { if (marks[id].mark !== 'open') out[id] = true; });
      return out;
    },
    // A new sub-task's mirror row, kept if a sync wrote it first; then read back.
    putNode: async (row: Record<string, unknown>) => {
      must(await sb.from('task_nodes').upsert(Object.assign({ user_id: owner }, row),
        { onConflict: 'user_id,google_id', ignoreDuplicates: true }));
      return (must(await sb.from('task_nodes')
        .select('id,google_id,list_id,parent_google_id,kind,title,position,g_status,gone_at')
        .eq('user_id', owner).eq('google_id', row.google_id).limit(1)) || [])[0] || null;
    },
    // The entry's items, kept unfiled while the sub-task was being made.
    adoptItems: async (rid: string, nodeId: string) => {
      must(await sb.from('items').update({ node_id: nodeId })
        .eq('user_id', owner).eq('source_rid', rid).is('node_id', null));
    },
    grant: async () => (must(await sb.from('google_grants').select('*').eq('user_id', owner).limit(1)) || [])[0] || null,
    patchGrant: async (userId: string, fields: Record<string, unknown>) => {
      must(await sb.from('google_grants').update(fields).eq('user_id', userId));
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
    // Open items only (14b): one Done or Dropped is not offered to Gemini as a match.
    // Marks unreadable: all of them, as before item_marks existed.
    items: async (nodeIds: string[]) => {
      if (!nodeIds.length) return [];
      const rows = must(await sb.from('items')
        .select('rid,node_id,title').eq('user_id', owner).in('node_id', nodeIds)
        .order('created_at', { ascending: false }).limit(500)) || [];
      if (!rows.length) return rows;
      // The newest mark of each, a hundred items a request; item_marks before the view exists.
      const marks: unknown[] = [];
      for (let i = 0; i < rows.length; i += 100) {
        const rids = rows.slice(i, i + 100).map((r: { rid: string }) => r.rid);
        let got = await sb.from('item_mark_latest').select('rid,item_rid,mark,at,created_at')
          .eq('user_id', owner).in('item_rid', rids);
        if (got.error) {
          got = await sb.from('item_marks').select('rid,item_rid,mark,at,created_at')
            .eq('user_id', owner).in('item_rid', rids).order('at', { ascending: false }).limit(1000);
        }
        if (got.error) return rows;
        marks.push(...(got.data || []));
      }
      const state = Day.itemStates(marks);
      return rows.filter((r: { rid: string }) => (state[r.rid] || 'open') === 'open');
    },
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

type Claim = { entry_rid: string; tries: number; created_at: string; plan?: any };
type Entry = { rid: string; at: string; raw_text: string; project: string; node_id: string | null };
type Place = { project: any; sub: any; items: string[]; unsorted?: string; create?: string;
               more?: { title: string; sub: any; items: string[] }[] };
// One sub-task an entry is filed or makes (edit queue 4): j 0 is the one the entry goes under.
type Slot = { j: number; title: string; items: string[]; node: any; google_id: string | null;
              at: string | null; skip?: boolean };

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

  const out = { ok: true, act: 'filed', filed: 0, unsorted: 0, retry: 0, calls: 0, made: 0 } as Record<string, any>;
  const finish = async (c: Claim, state: string, reason: string, tries?: number, extra?: Record<string, unknown>) => {
    await db.finish(c.entry_rid, d.runId, state, reason, tries === undefined ? c.tries : tries, extra);
    out[state === 'filed' ? 'filed' : 'unsorted'] += 1;
  };

  // Edit queue 2: plans for a new sub-task. Unreadable (no columns yet): none is made.
  const plans = await db.plans(claimed.map((c) => c.entry_rid));
  const canMake = Boolean(plans);
  const canMore = Boolean(plans && plans.more);          // edit queue 4: several per entry
  const noPlan = canMore ? Object.assign({ new_more: null }, NO_PLAN) : NO_PLAN;
  ((plans && plans.rows) || []).forEach((p: any) => {
    const c = claimed.filter((x) => x.entry_rid === p.entry_rid)[0];
    if (c && p.new_title && p.new_parent) c.plan = p;
  });

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

  const nodes = await db.nodes(sync.list_id);
  const cands = candidateTasks(nodes, sync.list_id, await db.closed());
  if (!cands.list.length) {
    for (const x of live) await finish(x.c, 'unsorted', 'no-tasks', undefined, x.c.plan ? noPlan : undefined);
    return out;
  }

  // The rename check's rows, read just before deciding: a Stop pressed while
  // Gemini was answering must be seen.
  const oldest = Math.min(...live.map((x) => ms(x.e.at)).filter(isFinite));
  const since = new Date((isFinite(oldest) ? oldest : now) - Day.LEAD_MAX_MS).toISOString();
  let rows: unknown[] = [];

  // His grant for this list, read once; null when a sub-task cannot be made.
  let google: any;
  const googleFor = async () => {
    if (google === undefined) {
      google = null;
      try { google = canMake && d.google ? await d.google(db, sync.list_id) : null; } catch (_e) { google = null; }
    }
    return google;
  };

  // Not answered this time: back to waiting with its plan, or Unsorted after the last try.
  const hold = async (x: { c: Claim; e: Entry }, why: string) => {
    out.why = why;
    const tries = x.c.tries + 1;
    if (tries >= FILE_MAX_TRIES) await finish(x.c, 'unsorted', 'no-sub-task', tries, x.c.plan ? noPlan : undefined);
    else { await db.release(x.c.entry_rid, d.runId, tries); out.retry += 1; }
  };

  /* Sub-task `slot` under project `proj`, made at most once per entry: this
   * run's own, an open one already so called, the one an earlier run made (its
   * plan), or a new insert with the plan saved first. `save` writes the plan.
   * {node} | {refused: why} | {unsure: why} | {wait: true} | {lost: true}. */
  // A key whose insert got no clear answer this run: others with it wait for the next run's look-up.
  const UNSURE = 'unsure';
  const made: Record<string, any> = {};
  const makeSub = async (proj: any, slot: Slot, save: () => Promise<boolean>) => {
    const key = proj.google_id + '|' + normTitle(slot.title);
    if (made[key] === UNSURE) {
      if (!slot.at) {
        slot.at = new Date(d.now()).toISOString();
        if (!(await save())) return { lost: true };
      }
      return { unsure: 'the same title is waiting for Google' };
    }
    if (made[key]) return { node: made[key] };
    const same = existingSub(cands, proj, slot.title);
    if (same) return { node: same };
    if (!proj.google_id || proj.kind !== 'project' || proj.list_id !== sync.list_id || proj.gone_at) {
      return { refused: 'not a project of this list' };              // never a project, never another list
    }
    const g = await googleFor();
    if (!g) return { refused: 'Google Tasks cannot be written' };
    let task: any = null;
    if (slot.google_id) {
      task = { id: slot.google_id, title: slot.title, position: '' };
    } else if (slot.at) {
      if (d.now() - Date.parse(slot.at) < PLAN_SETTLE_MS) return { wait: true };
      const found = await findMade(g, proj.google_id, slot.title, slot.at);
      if (found.unsure) { made[key] = UNSURE; return { unsure: found.unsure }; }
      // Not found by either look-up: an insert may still be lagging in Google's
      // listing. Never insert twice; wait, and after the last try let it go.
      if (!found.task) { made[key] = UNSURE; return { unsure: 'not in Google yet: waiting, not inserting again' }; }
      task = found.task;
    }
    if (!task) {
      slot.at = new Date(d.now()).toISOString();
      if (!(await save())) return { lost: true };
      const ins = await insertSub(g, proj.google_id, slot.title);
      if (ins.verdict === 'refused') return { refused: ins.why };
      if (ins.verdict === 'later') {                          // nothing made: the next run inserts
        slot.at = null;
        await save();
        made[key] = UNSURE;
        return { unsure: ins.why };
      }
      if (ins.verdict !== 'made') { made[key] = UNSURE; return { unsure: ins.why }; }
      task = ins.task;
      out.made += 1;
      slot.google_id = String(task.id);
      await save();
    }
    const node = await db.putNode({
      google_id: String(task.id), list_id: sync.list_id, parent_google_id: proj.google_id, kind: 'subtask',
      title: String(task.title || slot.title), position: String(task.position || ''), g_status: 'needsAction',
      g_updated: task.updated || null, synced_at: new Date(d.now()).toISOString()
    });
    if (!node || node.list_id !== sync.list_id) return { unsure: 'the new sub-task was not saved' };
    made[key] = node;
    return { node };
  };

  // The plan's columns for `slots` under `proj`. new_more only once that column exists.
  const planFields = (proj: any, slots: Slot[]) => {
    const f: Record<string, unknown> = { new_title: slots[0].title, new_parent: proj.google_id,
                                         new_google_id: slots[0].google_id, new_at: slots[0].at };
    if (canMore) {
      f.new_more = slots.slice(1).map((s) => ({ j: s.j, title: s.title, items: s.items,
                                                google_id: s.google_id, at: s.at }));
    }
    return f;
  };

  // The slots a saved plan holds: the main one, then the others (their items kept in the plan).
  const planSlots = (plan: any): Slot[] => {
    const slots: Slot[] = [{ j: 0, title: plan.new_title, items: [], node: null,
                             google_id: plan.new_google_id || null, at: plan.new_at || null }];
    (Array.isArray(plan.new_more) ? plan.new_more : []).forEach((m: any, i: number) => {
      if (!m || !tidyTitle(m.title)) return;
      slots.push({ j: Number(m.j) || i + 1, title: tidyTitle(m.title), items: tidyItems(m.items), node: null,
                   google_id: m.google_id ? String(m.google_id) : null, at: m.at || null });
    });
    return slots;
  };

  /* Files an entry under slots[0], making whichever sub-tasks do not exist yet;
   * the others get their own items. The main one refused: Unsorted, as before.
   * Another refused, or still unclear on the last try: let go, the rest file. */
  const fileMany = async (x: { c: Claim; e: Entry }, proj: any, slots: Slot[]) => {
    const main = slots[0];
    // Before the new_more column: only the main one is made, existing others still get items.
    if (!canMore) slots.slice(1).forEach((s) => { if (!s.node) s.skip = true; });
    const save = async () => {
      const f = planFields(proj, slots);
      if (!(await db.plan(x.c.entry_rid, d.runId, f))) return false;
      x.c.plan = Object.assign({}, x.c.plan || {}, f);
      return true;
    };
    if (main.items.length) {
      await db.putItems(main.items.map((t, k) => ({ user_id: d.owner, rid: itemRid(x.e.rid, k + 1),
        node_id: null, source_rid: x.e.rid, title: t, made_by: 'gemini', at: x.e.at })));
    }
    for (const s of slots) {
      if (s.node || s.skip) continue;
      const got: any = await makeSub(proj, s, save);
      if (got.lost) return;                                  // another run holds it now
      if (got.wait) {                                        // not a try: nobody has asked Google yet
        await db.release(x.c.entry_rid, d.runId, x.c.tries);
        out.retry += 1;
        return;
      }
      if (s.j > 0 && (got.refused || (got.unsure && x.c.tries + 1 >= FILE_MAX_TRIES))) {
        s.skip = true;
        out.why = got.refused || got.unsure;
        continue;
      }
      if (got.unsure) return hold(x, got.unsure);
      if (got.refused) {
        await finish(x.c, 'unsorted', 'no-sub-task', undefined, x.c.plan ? noPlan : undefined);
        return;
      }
      s.node = got.node;
    }
    const fields = filingFields(rows, x.e, { project: proj, sub: main.node }) as { node_id: string };
    if (!(await db.file(x.e.rid, fields)) && (await db.nodeOf(x.e.rid)) !== fields.node_id) {
      await finish(x.c, 'filed', 'labelled');
      return;
    }
    await db.adoptItems(x.e.rid, fields.node_id);
    for (const s of slots.slice(1)) {
      if (!s.node || s.skip || !s.items.length) continue;
      await db.putItems(s.items.map((t, k) => ({ user_id: d.owner, rid: moreItemRid(x.e.rid, s.j, k + 1),
        node_id: s.node.id, source_rid: x.e.rid, title: t, made_by: 'gemini', at: x.e.at })));
    }
    await finish(x.c, 'filed', 'new-sub-task');
  };

  // A Place with something to make, as slots: the main one, then the others.
  const placeSlots = (place: Place): Slot[] => {
    const main = place.sub;
    const slots: Slot[] = [{ j: 0, title: main ? String(main.title || '') : String(place.create), items: place.items,
                             node: main || null, google_id: main ? String(main.google_id) : null, at: null }];
    (place.more || []).forEach((m, i) => {
      slots.push({ j: i + 1, title: m.title, items: m.items, node: m.sub || null,
                   google_id: m.sub ? String(m.sub.google_id) : null, at: null });
    });
    return slots;
  };

  // Writes one entry's filing: the row first, then its items, then its state.
  const apply = async (x: { c: Claim; e: Entry }, place: Place, how: string) => {
    // Something to make: a new sub-task, or others besides an existing one (edit queue 4).
    if (place.create || (place.more && place.more.length)) return fileMany(x, place.project, placeSlots(place));
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

  // An entry whose sub-task an earlier run began making is finished first, without Gemini.
  const owed = live.filter((x) => x.c.plan);
  if (owed.length) {
    rows = await db.rowsSince(since);
    for (const x of owed) {
      const proj = nodes.filter((n: any) => n.google_id === x.c.plan.new_parent)[0];
      if (!proj) await finish(x.c, 'unsorted', 'no-sub-task', undefined, noPlan);
      else await fileMany(x, proj, planSlots(x.c.plan));
    }
    for (let i = live.length - 1; i >= 0; i--) if (live[i].c.plan) live.splice(i, 1);
    if (!live.length) return out;
  }

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
  // His Google grant, when the list it names is the one being filed into.
  const google = async (db: any, listId: string) => {
    const cfg = G.googleConfig((name: string) => Deno.env.get(name));
    if (!cfg.configured) return null;
    const grant = await db.grant();
    if (!grant || !grant.list_id || grant.list_id !== listId) return null;
    const tokenKey = await G.importTokenKey(cfg.tokenKey);
    return { grant, listId, d: { cfg, key: tokenKey, userId: owner, fetch, now: Date.now,
                                 store: { patchGrant: db.patchGrant, setSync: async () => {} } } };
  };
  try {
    const out = await classifyRun({
      db: store(sb, owner), owner, now: Date.now, key, google,
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
