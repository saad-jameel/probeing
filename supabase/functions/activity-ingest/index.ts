// ProBeing — the `activity-ingest` Edge Function (Stage 18b).
//
// The laptop watcher (watcher/windows/watch.ps1) calls it every 5 minutes with
// its device token (x-device-token; Settings shows it once, the table keeps its
// sha256):
//   {op: 'config', from}   -> his lists, keyword rules, projects, and the spans
//                             he was working since `from` (the laptop sends
//                             nothing outside them)
//   {op: 'ingest', blocks} -> time blocks; cut to working time again here,
//                             stored one per device and start, then the
//                             distraction check runs (nudgeStep)
//   {op: 'classify', items} -> unclear window titles, ONE Gemini call for the
//                             batch, counted in gemini_usage; a title is used
//                             for that call and never stored
// and a distraction push's buttons call it with {answer: {id, nonce, choice}},
// the nonce standing in for a sign-in as wrapup's check does.
//
// No cron: the laptop's own 5-minute run is the clock. A push goes out when a
// distraction has run 10 minutes; 5 minutes later, with no answer and still on
// it, a break is written back to when it started (or, when another device shows
// work across the same span, a question waits for the catch-up popup). Back in a
// work app, a resume is written where the work began.
//
// Deployed by hand (verify_jwt stays on; the laptop sends the anon key):
//   npx supabase functions deploy activity-ingest --project-ref <ref> --use-api
// Secrets: ALLOWED_USER_ID, GEMINI_API_KEY, GEMINI_MODEL, VAPID_PRIVATE_KEY (set
// for the other functions); GEMINI_DAILY optional. Needs the "stage 18b" part of
// docs/supabase_schema.sql.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/activity.js';
import { pushAll } from '../_shared/push.ts';
import { usageDay, takeCall, spendDay } from '../_shared/usage.ts';

// activity.js is a classic script, so it hands its functions over on globalThis.
const A = (globalThis as unknown as { ProBeingActivity: Record<string, any> }).ProBeingActivity;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-device-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/* ── The pure part: no clock, database or network. Plain JS with `var`, so
 *    claudeWorkingDocs/tests/stage18b_*.js can lift it. A is activity.js. ── */

var MIN_MS = 60000;
var NUDGE_AFTER_MS = 10 * MIN_MS;      // a distraction this long gets a push
var NUDGE_IGNORE_MS = 5 * MIN_MS;      // no answer this long after it: a break
var NUDGE_LIVE_MS = 7 * MIN_MS;        // the newest block must be this recent to be "still on it"
var NUDGE_STALE_MS = 30 * MIN_MS;      // no news this long after a push: let it go
var STREAK_GAP_MS = 2 * MIN_MS;        // a gap this small does not end a distraction
var OTHER_COVER = 0.8;                 // another device working this much of the span: ask, no break
var RESUME_WORK_MS = MIN_MS;           // back in a work app this long ends an auto break
var RESUME_UNCLEAR_MS = 3 * MIN_MS;    // ... or this long in something unclear
var READ_BACK_MS = 48 * 3600000;       // event rows read for the clock, as day.js LEAD_MAX_MS
var CONFIG_BACK_MS = 24 * 3600000;     // spans handed to the laptop reach back at most this far
var INGEST_MAX = 500;                  // blocks in one request
var CLASSIFY_MAX = 20;                 // titles in one Gemini call
var GEMINI_DAILY_DEFAULT = 18;
var ACT_GEMINI_RESERVE = 6;            // the watcher stops this many calls short of the cap, for filing
var GEMINI_PACE_MS = 15000;
var GEMINI_RPM = 4;
var PROJECTS_MAX = 60;

/* Rows that mean he responded after a push. Not M or a prayer: they do not say
 * he stopped scrolling. Not the server's own rows or the popup's backdated ones. */
var RESPONSE_TYPES = ['work', 'voice', 'resume', 'break', 'off', 'sleep', 'done', 'subdone', 'subdrop', 'substop',
                      'pin', 'unpin', 'actanswer'];
var SERVER_RIDS = /^(ab|ar|aw|an|aq|qb|qr|kb|kr|as)-|^wrapup-/;
var STATE_TYPES = ['work', 'voice', 'resume', 'break', 'off', 'sleep', 'done', 'awake', 'subdone', 'subdrop',
                   'substop', 'pin', 'unpin', 'actanswer'];

/* Words that never make a rule: they name an app or a page, not a project. */
var KEY_STOP = ['chrome', 'google', 'microsoft', 'windows', 'visual', 'studio', 'code', 'explorer', 'edge',
                'firefox', 'browser', 'untitled', 'document', 'documents', 'file', 'files', 'folder', 'home',
                'page', 'search', 'settings', 'window', 'desktop', 'download', 'downloads', 'youtube', 'github',
                'mail', 'inbox', 'terminal', 'powershell', 'notepad', 'word', 'excel'];

/** sha256 is taken of this: letters and digits, upper case (as app.js watchTokenHash). */
function tokenText(t) {
  return String(t || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/** The distraction one device is on now: {start, end, what}, or null. */
function streakOf(blocks) {
  var s = (blocks || []).slice().sort(function (a, b) { return a.start - b.start; });
  if (!s.length || s[s.length - 1].category !== 'distraction') return null;
  var last = s[s.length - 1];
  var start = last.start;
  var time = {};
  function add(b) {
    var w = b.domain || b.app || 'a distraction';
    time['w' + w] = (time['w' + w] || 0) + (b.end - b.start);
  }
  add(last);
  for (var i = s.length - 2; i >= 0; i--) {
    if (s[i].category !== 'distraction' || start - s[i].end > STREAK_GAP_MS) break;
    start = Math.min(start, s[i].start);
    add(s[i]);
  }
  var what = Object.keys(time).sort(function (a, b) { return time[b] - time[a]; })[0].slice(1);
  return { start: start, end: last.end, what: what };
}

/** How much of [a, b] other devices spent in a work app or a meeting, and on what. */
function otherCover(blocks, device, a, b) {
  var spans = [];
  var time = {};
  (blocks || []).forEach(function (x) {
    if (x.device_id === device || (x.category !== 'work' && x.category !== 'meeting')) return;
    A.actIntersect(x.start, x.end, [[a, b]]).forEach(function (p) {
      spans.push(p);
      var w = [x.app, x.project].filter(Boolean).join(' · ') || x.category;
      time['w' + w] = (time['w' + w] || 0) + (p[1] - p[0]);
    });
  });
  var ms = A.actSpansMs(A.actMergeSpans(spans));
  var top = Object.keys(time).sort(function (x, y) { return time[y] - time[x]; })[0];
  return { ratio: b > a ? ms / (b - a) : 0, what: top ? top.slice(1) : '' };
}

function hasRid(rows, rid) {
  return (rows || []).some(function (r) { return r.rid === rid; });
}

/**
 * The distraction check. d: {now, on, walk (activity.js actWalk of the rows),
 * blocks [{device_id, start, end, category, project, app, domain}], nudges
 * [{id, device_id, streak_start, pushed_at, state}] (ms), rows [{at (ms), type, rid}]}.
 * Returns {push: [{device_id, start, end, what}], decide: [{id, state, span_end, other}],
 * write: [{type, at, rid, text, nudge}]}.
 */
function nudgeStep(d) {
  var out = { push: [], decide: [], write: [] };
  var byDevice = {};
  (d.blocks || []).forEach(function (b) {
    if (!b.device_id) return;
    (byDevice['d' + b.device_id] = byDevice['d' + b.device_id] || []).push(b);
  });
  var rows = d.rows || [];

  // Back in a work app after the watcher's own break: resume where the work began.
  var ab = d.walk && d.walk.autoBreak;
  if (ab) {
    var back = (d.blocks || []).filter(function (b) {
      var long = b.end - b.start;
      return b.start >= ab.at && ((b.category === 'work' || b.category === 'meeting') ? long >= RESUME_WORK_MS
             : b.category === 'unclear' && long >= RESUME_UNCLEAR_MS);
    }).sort(function (a, b) { return a.start - b.start; })[0];
    if (back) {
      out.write.push({ type: 'resume', at: Math.max(back.start, ab.at + 1000), rid: 'ar-' + ab.rid.slice(3),
                       text: 'Resume (auto — back at work)' });
    }
  }

  (d.nudges || []).forEach(function (n) {
    if (n.state === 'question') {
      if (hasRid(rows, 'aq-' + n.id) || hasRid(rows, 'qb-' + n.id)) out.decide.push({ id: n.id, state: 'answered' });
      return;
    }
    if (n.state !== 'sent') return;
    if (hasRid(rows, 'an-' + n.id)) { out.decide.push({ id: n.id, state: 'working' }); return; }
    if (hasRid(rows, 'ab-' + n.id)) { out.decide.push({ id: n.id, state: 'break' }); return; }
    var answered = rows.some(function (r) {
      return r.at > n.pushed_at && RESPONSE_TYPES.indexOf(r.type) !== -1 && !SERVER_RIDS.test(String(r.rid || ''));
    });
    if (answered) { out.decide.push({ id: n.id, state: 'answered' }); return; }
    if (!d.walk || !d.walk.working) { out.decide.push({ id: n.id, state: 'closed' }); return; }
    if (d.now < n.pushed_at + NUDGE_IGNORE_MS) return;
    var s = streakOf(byDevice['d' + n.device_id]);
    var same = s && s.start <= n.streak_start + MIN_MS && s.end > n.streak_start;
    if (!same) { out.decide.push({ id: n.id, state: 'left' }); return; }
    var fresh = s.end >= n.pushed_at + NUDGE_IGNORE_MS - MIN_MS && s.end >= d.now - NUDGE_LIVE_MS;
    if (!fresh) {
      if (d.now - n.pushed_at >= NUDGE_STALE_MS) out.decide.push({ id: n.id, state: 'stale' });
      return;
    }
    var cover = otherCover(d.blocks, n.device_id, n.streak_start, s.end);
    if (cover.ratio >= OTHER_COVER) {
      out.decide.push({ id: n.id, state: 'question', span_end: s.end, other: cover.what });
      return;
    }
    out.write.push({ type: 'break', at: n.streak_start, rid: 'ab-' + n.id, text: 'Distraction (auto)', nudge: n.id });
    out.decide.push({ id: n.id, state: 'autobreak' });
  });

  // No new push on a break, or in the run that just wrote one.
  var broke = out.write.some(function (w) { return w.type === 'break'; });
  if (d.on === false || !d.walk || !d.walk.working || ab || broke) return out;
  Object.keys(byDevice).forEach(function (k) {
    var dev = k.slice(1);
    var s = streakOf(byDevice[k]);
    if (!s || s.end - s.start < NUDGE_AFTER_MS || s.end < d.now - NUDGE_LIVE_MS) return;
    var known = (d.nudges || []).some(function (n) {
      return n.device_id === dev && (n.state === 'sent' || Math.abs(n.streak_start - s.start) < MIN_MS);
    });
    if (!known) out.push.push({ device_id: dev, start: s.start, end: s.end, what: s.what });
  });
  return out;
}

/** "6:12 pm" at `offsetMin`. */
function clock12(ms, offsetMin) {
  var mins = Math.floor(ms / 60000) + offsetMin;
  var m = ((mins % 1440) + 1440) % 1440;
  var h = Math.floor(m / 60);
  var mm = m % 60;
  return ((h % 12) || 12) + ':' + (mm < 10 ? '0' : '') + mm + (h < 12 ? ' am' : ' pm');
}

/** The push. sw.js shows it with Take a break / I'm working under one tag. */
function nudgePayload(p, nudgeId, nonce, url, key, offsetMin) {
  var mins = Math.max(10, Math.round((p.end - p.start) / 60000));
  return { kind: 'distract', tag: 'probeing-distract', nudge: nudgeId, nonce: nonce, url: url, key: key, goto: 'home',
           title: 'You\'ve been on ' + A.actCut(p.what, 60) + ' for ' + mins + ' min — take a break?',
           body: 'No answer in 5 min and it counts as a break from ' + clock12(p.start, offsetMin) + '.' };
}

/** The rows an answer writes, by the nudge's state. choice: 'break' or 'working'. */
function answerRows(n, choice, now) {
  if (choice === 'break') {
    if (n.state === 'question' && n.span_end > n.streak_start) {
      return [{ type: 'break', at: n.streak_start, rid: 'qb-' + n.id, text: 'Break (checked later)' },
              { type: 'resume', at: n.span_end, rid: 'qr-' + n.id, text: 'Resume (checked later)' }];
    }
    return [{ type: 'break', at: n.streak_start, rid: 'ab-' + n.id, text: 'Distraction' }];
  }
  var out = [];
  if (n.state === 'autobreak') out.push({ type: 'resume', at: n.streak_start + 1000, rid: 'aw-' + n.id, text: 'Resume (I was working)' });
  out.push({ type: 'actanswer', at: now, rid: (n.state === 'question' ? 'aq-' : 'an-') + n.id,
             text: 'Working — answered the distraction check', detail: 'working' });
  return out;
}

/** The Gemini prompt for one batch of unclear titles. */
function classifyPrompt(items, projects) {
  var lines = ['COMPUTER ACTIVITY. File each activity under one of this person\'s projects.',
               'Projects (use a name exactly as written, or "" when none clearly fits):'];
  projects.forEach(function (p, i) { lines.push((i + 1) + '. ' + JSON.stringify(String(p))); });
  lines.push('');
  lines.push('Activities (window title · app · website):');
  items.forEach(function (it, i) {
    lines.push((i + 1) + '. ' + JSON.stringify(String(it.title)) + ' · ' + JSON.stringify(String(it.app || '')) +
               ' · ' + JSON.stringify(String(it.domain || '')));
  });
  lines.push('');
  lines.push('Answer a JSON array with one object per activity, in order: {"n": its number, "project": a ' +
             'project name from the list or "", "keyword": one word copied from that activity\'s title that ' +
             'shows the project, or ""}. Pick a project only when the title clearly belongs to it; never ' +
             'guess from the app or website alone.');
  return lines.join('\n');
}

var CLASSIFY_SCHEMA = {
  type: 'ARRAY',
  items: { type: 'OBJECT', properties: { n: { type: 'INTEGER' }, project: { type: 'STRING' }, keyword: { type: 'STRING' } },
           required: ['n', 'project'] }
};

/** Gemini's answer -> [{key, project, keyword}] for items it placed. Names are
 *  checked against the list; a keyword must be in the title and not a stop word. */
function readClassify(text, items, projects, lists) {
  var got;
  try { got = JSON.parse(String(text || '')); } catch (e) { return []; }
  if (!Array.isArray(got)) return [];
  var canon = {};
  projects.forEach(function (p) { canon['p' + String(p).trim().toLowerCase()] = p; });
  var out = [];
  got.forEach(function (g) {
    var it = g && items[Number(g.n) - 1];
    var project = g && canon['p' + String(g.project || '').trim().toLowerCase()];
    if (!it || !project) return;
    var k = A.actNorm(g.keyword);
    var ok = k.length >= A.ACT_KEY_MIN && k.length <= A.ACT_KEY_MAX && A.actNorm(it.title).indexOf(k) !== -1 &&
             KEY_STOP.indexOf(k) === -1 && k !== A.actNorm(String(it.app || '').replace(/\.exe$/i, '')) &&
             !A.actListHit(A.actLists(lists)['private'], { app: k, host: '', title: k }, true);
    out.push({ key: it.key, project: project, keyword: ok ? k : '' });
  });
  return out;
}

/** Items fit to send: private ones dropped, titles scrubbed, at most CLASSIFY_MAX. */
function classifyItems(items, lists) {
  var priv = A.actLists(lists)['private'];
  var out = [];
  (Array.isArray(items) ? items : []).forEach(function (it) {
    if (!it || typeof it !== 'object' || out.length >= CLASSIFY_MAX) return;
    var title = A.actScrubTitle(it.title);
    var app = A.actCleanApp(it.app);
    var domain = A.actCleanDomain(it.domain);
    if (!title || A.actListHit(priv, { app: app, host: domain, title: title }, true)) return;
    var blocks = (Array.isArray(it.blocks) ? it.blocks : []).map(function (x) { return Date.parse(String(x)); })
      .filter(function (t) { return isFinite(t); }).slice(0, 200);
    out.push({ key: String(it.key || '').slice(0, 300), title: title, app: app, domain: domain, blocks: blocks });
  });
  return out;
}

/** An earlier copy of a block that Gemini or a rule already placed is not put back to unclear. */
function keepPlaced(fresh, had) {
  if (!had || fresh.category !== 'unclear' || had.category !== 'work' || !had.project) return fresh;
  if (had.app !== fresh.app || had.domain !== fresh.domain) return fresh;
  return Object.assign({}, fresh, { category: 'work', project: had.project, key: had.rule_key || '' });
}

function isDailyRefusal(msg) {
  var s = String(msg || '');
  if (!/quota|rate.?limit|RESOURCE_EXHAUSTED|exceeded/i.test(s)) return false;
  if (/per.?minute|PerMinute/i.test(s)) return false;
  var lim = /limit:\s*([0-9]+)/i.exec(s);
  return !!lim && Number(lim[1]) > GEMINI_RPM + 2;
}

/* ─────────────────────────────────────────────────── end of the pure part */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
                      { auth: { persistSession: false } });
}
type Sb = ReturnType<typeof admin>;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function scrub(text: unknown): string {
  return String(text ?? '').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]');
}

function must(r: { data: unknown; error: { message?: string } | null }) {
  if (r.error) throw new Error(String(r.error.message || 'a read failed'));
  return (r.data || []) as Record<string, any>[];
}

const ms = (v: unknown) => Date.parse(String(v));
const iso = (t: number) => new Date(t).toISOString();

/** His settings: lists, the push switch, and the zone for clocks and stamps. */
async function readSettings(sb: Sb, owner: string, now: number) {
  const row = must(await sb.from('user_settings').select('*').eq('user_id', owner).limit(1))[0] || null;
  const zone = row && typeof row.time_zone === 'string' && row.time_zone ? row.time_zone : 'Asia/Karachi';
  let offset = 300;
  try {
    const parts: Record<string, string> = {};
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(now))
      .forEach((x) => { parts[x.type] = x.value; });
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24,
                           Number(parts.minute));
    const off = Math.round((asUtc - Math.floor(now / 60000) * 60000) / 60000);
    if (isFinite(off)) offset = off;
  } catch (_e) { /* Karachi */ }
  return { lists: A.actLists(row && row.activity_lists), on: !(row && row.activity_nudge === false), zone, offset };
}

/** Rows that move the clock or answer a push, oldest first, from `from`. */
async function readRows(sb: Sb, owner: string, from: number) {
  return must(await sb.from('events').select('at, type, rid, created_at').eq('user_id', owner)
    .gte('at', iso(from)).in('type', STATE_TYPES).order('at', { ascending: true })
    .order('created_at', { ascending: true }).limit(3000));
}

/** His projects: the chosen Google list's open projects, then names logged in two weeks, then rule targets. */
async function readProjects(sb: Sb, owner: string, now: number) {
  const out: string[] = [];
  const add = (p: unknown) => {
    const t = A.actCut(String(p || '').trim(), A.ACT_PROJECT_MAX);
    if (t && out.length < PROJECTS_MAX && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  const sync = must(await sb.from('sync_state').select('*').eq('user_id', owner).limit(1))[0] || {};
  if (sync.connected && sync.list_id) {
    must(await sb.from('task_nodes').select('title, g_status, gone_at, position').eq('user_id', owner)
      .eq('list_id', sync.list_id).eq('kind', 'project').limit(500))
      .filter((n) => !n.gone_at && n.g_status !== 'completed')
      .sort((a, b) => String(a.position || '').localeCompare(String(b.position || '')))
      .forEach((n) => add(n.title));
  }
  must(await sb.from('events').select('project').eq('user_id', owner).in('type', ['work', 'voice'])
    .gte('at', iso(now - 14 * 86400000)).neq('project', '').order('at', { ascending: false }).limit(500))
    .forEach((r) => add(r.project));
  const rules = must(await sb.from('activity_rules').select('keyword, project, source').eq('user_id', owner).limit(500));
  rules.forEach((r) => add(r.project));
  return { projects: out, rules };
}

function humanLocal(t: number, zone: string): string {
  try {
    return new Date(t).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit',
                                                 minute: '2-digit', hour12: true, timeZone: zone });
  } catch (_e) {
    return iso(t);
  }
}

/** One events row with a fixed rid; a repeat is the same row (23505). */
async function writeRow(sb: Sb, owner: string, zone: string, w: Record<string, any>) {
  const res = await sb.from('events').insert({
    user_id: owner, at: iso(w.at), local_time: humanLocal(w.at, zone), tz: zone, type: w.type,
    raw_text: w.text, project: '', detail: w.detail || '', rid: w.rid
  });
  if (res.error && res.error.code !== '23505') throw new Error(res.error.message);
  return !res.error;
}

function blockOf(r: Record<string, any>) {
  return { id: r.id, device_id: r.device_id, start: ms(r.started_at), end: ms(r.ended_at), category: r.category,
           project: r.project || '', app: r.app || '', domain: r.domain || '', rule_key: r.rule_key || '' };
}

/** The distraction check after an ingest: decisions, rows, pushes. */
async function runNudges(sb: Sb, owner: string, now: number, set: Record<string, any>, req: Request) {
  const rows = (await readRows(sb, owner, now - READ_BACK_MS));
  const walk = A.actWalk(rows, now - READ_BACK_MS, now);
  const blocks = must(await sb.from('activity_blocks').select('*').eq('user_id', owner)
    .gte('ended_at', iso(now - 6 * 3600000)).order('started_at', { ascending: true }).limit(2000)).map(blockOf);
  const nudgeRows = must(await sb.from('activity_nudges').select('id, device_id, streak_start, pushed_at, state, span_end')
    .eq('user_id', owner).gte('streak_start', iso(now - 12 * 3600000)).limit(500));
  const nudges = nudgeRows.map((n) => ({ id: n.id, device_id: n.device_id, streak_start: ms(n.streak_start),
                                         pushed_at: ms(n.pushed_at), state: n.state }));
  const step = nudgeStep({ now, on: set.on, walk, blocks, nudges,
                           rows: rows.map((r) => ({ at: ms(r.at), type: r.type, rid: r.rid || '' })) });
  const report: Record<string, unknown> = { decided: step.decide.length, wrote: [], pushed: [] };

  for (const w of step.write) {
    await writeRow(sb, owner, set.zone, w);
    (report.wrote as string[]).push(w.rid);
  }
  for (const d of step.decide) {
    const patch: Record<string, unknown> = { state: d.state, decided_at: iso(now) };
    if (d.span_end) patch.span_end = iso(d.span_end);
    if (d.other) patch.other_work = A.actCut(d.other, 160);
    await sb.from('activity_nudges').update(patch).eq('id', d.id).eq('user_id', owner);
  }
  const base = String(Deno.env.get('SUPABASE_URL') || new URL(req.url).origin).replace(/\/+$/, '');
  const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
  for (const p of step.push) {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const claim = await sb.from('activity_nudges').insert({
      user_id: owner, device_id: p.device_id, streak_start: iso(p.start), what: A.actCut(p.what, 80),
      pushed_at: iso(now), nonce_sha256: await sha256Hex(nonce), state: 'sent'
    }).select('id');
    if (claim.error) continue;                       // another run claimed this streak
    const id = String((claim.data || [])[0]?.id || '');
    const sent = await pushAll(sb, owner, JSON.stringify(nudgePayload(p, id, nonce, base + '/functions/v1/activity-ingest',
                                                                      anon, set.offset)),
                               { ttl: 300, topic: 'probeing-distract', urgency: 'high' });
    // Delivered nowhere: no push, so no auto break either; the next run tries again.
    if (!sent.sent) await sb.from('activity_nudges').delete().eq('id', id);
    (report.pushed as unknown[]).push({ what: p.what, ...sent });
  }
  return report;
}

/** The working spans the laptop may watch, from `from` to now. */
async function watchSpans(sb: Sb, owner: string, from: number, now: number) {
  const rows = await readRows(sb, owner, from - READ_BACK_MS);
  const walk = A.actWalk(rows, from, now);
  return { walk, spans: walk.watch as number[][] };
}

async function opConfig(sb: Sb, dev: Record<string, any>, body: Record<string, any>, now: number) {
  const set = await readSettings(sb, dev.user_id, now);
  let from = ms(body.from);
  if (!isFinite(from) || from < now - CONFIG_BACK_MS) from = now - CONFIG_BACK_MS;
  const { walk, spans } = await watchSpans(sb, dev.user_id, Math.min(from, now), now);
  const { projects, rules } = await readProjects(sb, dev.user_id, now);
  return reply(200, { ok: true, device: dev.label, now: iso(now), lists: set.lists, projects,
                      rules: rules.map((r) => ({ keyword: r.keyword, project: r.project })),
                      spans: spans.map((s) => [iso(s[0]), iso(s[1])]), working: walk.working,
                      autoBreak: Boolean(walk.autoBreak) });
}

async function opIngest(sb: Sb, dev: Record<string, any>, body: Record<string, any>, now: number, req: Request) {
  const list = Array.isArray(body.blocks) ? body.blocks : [];
  if (list.length > INGEST_MAX) return reply(413, { ok: false, error: 'at most ' + INGEST_MAX + ' blocks a call' });
  const set = await readSettings(sb, dev.user_id, now);
  const clean = list.map((b: unknown) => A.actSanitize(b, set.lists, now)).filter(Boolean);
  let stored = 0;
  if (clean.length) {
    const from = Math.min(...clean.map((b: any) => b.start));
    const { spans } = await watchSpans(sb, dev.user_id, from, now);
    const pieces = A.actClip(clean, spans);
    if (pieces.length) {
      const had: Record<string, any> = {};
      must(await sb.from('activity_blocks').select('*').eq('device_id', dev.id)
        .in('started_at', pieces.map((p: any) => iso(p.start))).limit(1000))
        .forEach((r) => { had[String(ms(r.started_at))] = blockOf(r); });
      const rows = pieces.map((p: any) => {
        const b = keepPlaced(p, had[String(p.start)]);
        return { user_id: dev.user_id, device_id: dev.id, started_at: iso(b.start), ended_at: iso(b.end), app: b.app,
                 domain: b.domain, category: b.category, project: b.project, rule_key: b.key, updated_at: iso(now) };
      });
      const up = await sb.from('activity_blocks').upsert(rows, { onConflict: 'device_id,started_at' });
      if (up.error) return reply(500, { ok: false, error: up.error.message });
      stored = rows.length;
    }
  }
  await sb.from('watch_devices').update({ last_seen_at: iso(now) }).eq('id', dev.id);
  let nudges: Record<string, unknown> = {};
  try {
    nudges = await runNudges(sb, dev.user_id, now, set, req);
  } catch (e) {
    nudges = { error: String((e as Error)?.message || e) };
  }
  return reply(200, { ok: true, stored, skipped: list.length - clean.length, nudges });
}

async function askGemini(key: string, model: string, prompt: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(GEMINI_URL + model + ':generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: ctrl.signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
                             generationConfig: { responseMimeType: 'application/json', responseSchema: CLASSIFY_SCHEMA } })
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const why = scrub((body && body.error && body.error.message) || res.status);
      return { ok: false, day: res.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(why) ? isDailyRefusal(why) : false,
               error: 'gemini (' + model + ') refused: ' + why };
    }
    const parts = body?.candidates?.[0]?.content?.parts || [];
    return { ok: true, text: parts.map((p: { text?: string }) => p.text || '').join('') };
  } catch (e) {
    return { ok: false, day: false, error: 'could not reach gemini: ' + scrub((e as Error)?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function opClassify(sb: Sb, dev: Record<string, any>, body: Record<string, any>, now: number) {
  const owner = dev.user_id;
  const set = await readSettings(sb, owner, now);
  const items = classifyItems(body.items, set.lists);
  if (!items.length) return reply(200, { ok: true, act: 'nothing', results: [] });
  const { projects } = await readProjects(sb, owner, now);
  if (!projects.length) return reply(200, { ok: true, act: 'no-projects', results: [] });
  const key = Deno.env.get('GEMINI_API_KEY') || '';
  if (!key) return reply(503, { ok: false, error: 'GEMINI_API_KEY is not set on this function' });
  const capAll = Math.floor(Number(Deno.env.get('GEMINI_DAILY'))) > 0 ? Math.floor(Number(Deno.env.get('GEMINI_DAILY')))
                                                                    : GEMINI_DAILY_DEFAULT;
  const day = usageDay(now);
  const slot = await takeCall(sb, owner, day, Math.max(0, capAll - ACT_GEMINI_RESERVE), GEMINI_PACE_MS);
  if (slot === 0) return reply(200, { ok: true, act: 'budget', results: [] });
  if (slot < 0) return reply(200, { ok: true, act: 'wait', results: [] });
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-flash-lite-latest';
  const g = await askGemini(key, model, classifyPrompt(items, projects));
  if (!g.ok) {
    if (g.day) await spendDay(sb, owner, day, capAll);
    return reply(200, { ok: true, act: g.day ? 'budget' : 'failed', error: g.error, results: [] });
  }
  const results = readClassify(g.text, items, projects, set.lists);
  for (const r of results) {
    const it = items.filter((x) => x.key === r.key)[0];
    if (it && it.blocks.length) {
      await sb.from('activity_blocks').update({ category: 'work', project: r.project, rule_key: r.keyword, updated_at: iso(now) })
        .eq('device_id', dev.id).eq('category', 'unclear').in('started_at', it.blocks.map(iso));
    }
    if (r.keyword) {
      // A rule he made or corrected is never replaced by Gemini's.
      await sb.from('activity_rules').upsert({ user_id: owner, keyword: r.keyword, project: r.project, source: 'gemini' },
                                             { onConflict: 'user_id,keyword', ignoreDuplicates: true });
    }
  }
  return reply(200, { ok: true, act: 'filed', calls: 1, model,
                      results: results.map((r) => ({ key: r.key, project: r.project, keyword: r.keyword })) });
}

/** A push's button, from sw.js. The nonce is the credential. */
async function opAnswer(sb: Sb, ans: Record<string, any>, now: number) {
  const id = String(ans.id || '');
  const nonce = String(ans.nonce || '');
  const choice = ans.choice === 'break' ? 'break' : ans.choice === 'working' ? 'working' : '';
  if (!UUID.test(id) || !nonce || !choice) return reply(401, { ok: false, error: 'not a check of yours' });
  const n = must(await sb.from('activity_nudges').select('*').eq('id', id).limit(1))[0];
  if (!n || !n.nonce_sha256 || (await sha256Hex(nonce)) !== n.nonce_sha256) {
    return reply(401, { ok: false, error: 'not a check of yours' });
  }
  const pinned = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (pinned && pinned !== n.user_id) return reply(403, { ok: false, error: 'not this account' });
  const set = await readSettings(sb, n.user_id, now);
  const nudge = { id: n.id, state: n.state, streak_start: ms(n.streak_start), span_end: ms(n.span_end) };
  for (const w of answerRows(nudge, choice, now)) await writeRow(sb, n.user_id, set.zone, w);
  await sb.from('activity_nudges').update({ state: choice, decided_at: iso(now) }).eq('id', id);
  // Retire it on the other devices, quietly, under the same tag.
  await pushAll(sb, n.user_id, JSON.stringify({ kind: 'distract-answered', tag: 'probeing-distract',
    title: choice === 'break' ? 'Break from ' + clock12(nudge.streak_start, set.offset) : 'Noted: you were working', body: '' }),
    { ttl: 300, topic: 'probeing-distract', urgency: 'normal' }, String(ans.from || ''));
  return reply(200, { ok: true, state: choice });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  let body: Record<string, any> = {};
  try {
    body = await req.json();
  } catch (_e) {
    return reply(400, { ok: false, error: 'send JSON' });
  }
  const sb = admin();
  const now = Date.now();
  try {
    if (body && body.answer && typeof body.answer === 'object') return await opAnswer(sb, body.answer, now);

    const token = tokenText(req.headers.get('x-device-token') || '');
    if (token.length < 24) return reply(401, { ok: false, error: 'pair this laptop in Settings first' });
    const dev = must(await sb.from('watch_devices').select('id, user_id, label, kind')
      .eq('secret_sha256', await sha256Hex(token)).limit(1))[0];
    if (!dev) return reply(401, { ok: false, error: 'this token is not paired (revoked?)' });
    const pinned = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
    if (pinned && pinned !== dev.user_id) return reply(403, { ok: false, error: 'not this account' });

    if (body.op === 'config') return await opConfig(sb, dev, body, now);
    if (body.op === 'ingest') return await opIngest(sb, dev, body, now, req);
    if (body.op === 'classify') return await opClassify(sb, dev, body, now);
    return reply(400, { ok: false, error: 'op must be config, ingest or classify' });
  } catch (e) {
    return reply(500, { ok: false, error: scrub((e as Error)?.message || e) });
  }
});
