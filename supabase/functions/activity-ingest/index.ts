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
//                             for that call and never stored, and only the
//                             project comes back (no keyword from a title)
//   {op: 'glance'}         -> item 27, the laptop tray: the state word (working,
//                             break, asleep, off) and the glance row's words.
//                             Read-only; does not mark the device seen
// and a distraction push's buttons call it with {answer: {id, nonce, choice}},
// the nonce standing in for a sign-in as wrapup's check does.
//
// Item 23 (11 Oct): asleep or on a break, the devices still send blocks, kept
// bare (time, category, project; mode 'sleep' or 'break'). Asleep and in use 5
// minutes after Fajr (any time, in a nap): a push "awake?" whose I'm awake writes
// a wake back to when the use began. Before Fajr: no push, the minutes are kept
// as a disturbed night (activity_nights). On a break and in a work app 5 minutes:
// a push "back to work?" whose Resume writes a resume back to when the work began.
// Unanswered, they wait for the app's catch-up sheet. Every authenticated call
// marks the device as seen (Settings: "connected · last checked").
//
// Item 26 (12 Oct): a sleep or break of any age counts. The clock reads the newest
// state rows from before its window too, and a sleep days old asks about use after
// the latest Fajr (never between midnight and Fajr).
//
// Item 28 (12 Oct): awake with the day not started (or after End day), blocks are kept
// bare too (mode 'off'). A work app 10 minutes in a row there: "didn't mark it — start?"
// (Start writes a resume back to when the work began; Not work: quiet 30 min). Asleep
// and in a work app 5 minutes after Fajr asks "Up and working?" instead of "awake?"
// (Start day writes a wake and a resume back to the work; Just awake, the wake only).
//
// Item 29 (12 Oct): an unsorted app or site (unclear, in working-time blocks, so it has a
// name) at 15 minutes in a day, all devices together, is asked about: "What is <app>?",
// one question at a time, answered in the app's sheet with Teach's choices. At most two
// pushes a day, none asleep or between midnight and Fajr; the rest wait in the sheet.
// Its own switch (activity_teach). Once the name is sorted (any route: the sheet, Teach,
// Lists) the question closes and today's unclear blocks are filed again by name. No name
// is kept from sleep, a break or the day off: those blocks stay bare (items 23, 28).
// Item 29 fix: a sorted question closes on any call (config, glance, ingest); a name made
// private is blanked on its question rows; and a label never reaches back: a block's new
// category counts for the checks only from when the server first saw it (became_at).
//
// Item 30a (13 Oct): a work run (work and meetings, any device) goes on through gaps under 15
// minutes; "start?" asks once it holds 10 work minutes (not 10 in a row), and Start, Resume and
// Start day write each distraction of 2 minutes or more inside it as a break (nd-/ne- rows; the
// spans are kept on the question, `run`, so the app's sheet writes the same rows). A helper
// (terminal, Notepad, localhost...) takes the project of the nearest work within 10 minutes.
// Distractions while working are kept as slips (2-5 min) and focus losses (5-15 min) in
// activity_focus with each day's longest unbroken stretch; names only as a word (YouTube, X).
// An unsorted site is asked about at 10 minutes a day, an app still at 15.
//
// Item 30b (13 Oct): a laptop block may carry its virtual desktop's name (`desktop`, stored on
// the block). A desktop named after a project, or paired with one in Settings
// (user_settings.activity_desktops), is that block's project ahead of any keyword; helpers take it
// first too. config hands the pairs to the laptop. And "auto-detected Working on": while the
// clock runs, 10 minutes or more of work on a project that is not in Working on (and was not
// named since) is kept as a question (kind 'auto', run.project) that the app's Home shows with
// Accept / Reject; no push. "start?" and "Up and working?" (the day not started) carry the run's
// project too when it is half the work or more, and Start then writes a work row for it (ns-, type
// work, project set) instead of a bare resume. "back to work?" does not: once back, a project not in
// Working on is the auto question's.
//
// Item 31a (16 Oct): every device's blocks become one line of signals (activity.js actSignals) and the
// gaps between work are judged: earned rest, slips, distractions, distraction breaks (deserved when
// earned), LOW and HIGH focus loss, idle and away breaks (activity.js actJudge; claudeWorkingDocs/
// plan-item31.md R1-R8). The records go to activity_focus (runJudge). An idle gap of 15 minutes is
// asked "Why?" (kind 'idle', state 'pending': the v41 app never reads it); a prayer logged in it
// answers itself. At End day (20 minutes after the off row, so the phone has reported) every
// unanswered recommendation is applied: the break rows (jb-/jr-), the idle reason (jw-...-auto),
// and a run question still open when the day closed (state 'applied'). "Up and working?" is
// pushed again every hour while work goes on, three times at most; then it is applied (R6).
// A distraction is pushed at 15 minutes (R3), and not at all while another device works (R7).
//
// No cron: the laptop's own 5-minute run is the clock. A push goes out when a
// distraction has run 15 minutes; 5 minutes later, with no answer and still on
// it, a break is written back to when it started (or, when another device shows
// work across the same span, a question waits for the catch-up popup). Back in a
// work app, a resume is written where the work began.
//
// Deployed by hand (verify_jwt stays on; the laptop sends the anon key):
//   npx supabase functions deploy activity-ingest --project-ref <ref> --use-api
// Secrets: ALLOWED_USER_ID, GEMINI_API_KEY, GEMINI_MODEL, VAPID_PRIVATE_KEY (set
// for the other functions); GEMINI_DAILY optional. Needs the "stage 18b", "item 23",
// "item 28", "item 29", "item 30a", "item 30b" and "item 31ab" parts of supabase/sql/supabase_schema.sql.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/day.js';
import '../_shared/activity.js';
import { pushAll } from '../_shared/push.ts';
import { usageDay, takeCall, spendDay } from '../_shared/usage.ts';

// activity.js is a classic script, so it hands its functions over on globalThis.
const A = (globalThis as unknown as { ProBeingActivity: Record<string, any> }).ProBeingActivity;
const Day = (globalThis as unknown as { ProBeingDay: Record<string, any> }).ProBeingDay;

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
var NUDGE_AFTER_MS = 10 * MIN_MS;      // a distraction or private app this long gets a push (item 36; was 15, R3)
var NUDGE_IGNORE_MS = 5 * MIN_MS;      // no answer this long after it: a break
var NUDGE_LIVE_MS = 7 * MIN_MS;        // the newest block must be this recent to be "still on it"
var NUDGE_STALE_MS = 30 * MIN_MS;      // no news this long after a push: let it go
var STREAK_GAP_MS = 2 * MIN_MS;        // a gap this small does not end a distraction
var OTHER_COVER = 0.8;                 // another device working this much of the span: ask, no break
var RESUME_WORK_MS = MIN_MS;           // back in a work app this long ends an auto break
var RESUME_UNCLEAR_MS = 3 * MIN_MS;    // ... or this long in something unclear
var READ_BACK_MS = 48 * 3600000;       // event rows read for the clock, as day.js LEAD_MAX_MS
var CARRY_ROWS = 12;                   // ...plus this many state rows from before (app.js `carry`)
var CARRY_TYPES = ['work', 'voice', 'resume', 'break', 'off', 'sleep', 'wake'];
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
var SERVER_RIDS = /^(ab|ar|aw|an|aq|qb|qr|kb|kr|as|nw|nr|ns|na|nd|ne|jb|jr|jw)-|^wrapup-/;
var STATE_TYPES = ['work', 'voice', 'resume', 'break', 'off', 'sleep', 'wake', 'done', 'awake', 'subdone', 'subdrop',
                   'substop', 'pin', 'unpin', 'actanswer'];

/* Item 23. */
var USE_GAP_MS = MIN_MS;               // a gap this small does not end a run of use
var USE_MIN_MS = 5 * MIN_MS;           // a shorter run is a brief check: it never counts
var USE_FRESH_MS = 25 * MIN_MS;        // a run must reach this close to now to be pushed (the phone sends every 15-20 min)
var NIGHT_FROM_H = 21;                 // a sleep from 9 pm (the Sleep button's line) or after midnight is a night
var QUIET_BACK_MS = 40 * 3600000;      // blocks read for the asleep/break checks and the nights
var NIGHTS_BACK_MS = 36 * 3600000;     // nights recounted on each run
var ASK_KINDS = ['awake', 'resume', 'upwork', 'start'];
var NIGHT_LAPTOP_MS = 15 * MIN_MS;     // item 36: the laptop this long after Sleep, before Fajr: "asleep or working?"
var NIGHT_PICKUPS = 3;                 // ...the phone picked up this many times is a disturbed night,
var NIGHT_LONG_MS = 10 * MIN_MS;       // ...or once for longer than this
var RUN_KINDS = ['resume', 'upwork', 'start'];        // item 30a: the questions about a work run
var ASK_QUIET_MS = 30 * MIN_MS;        // after "Still asleep", "It was a break" or "Not work", not asked again this long
var START_MIN_MS = 10 * MIN_MS;        // item 28: work this long in a row, day not started, asks "start?"
var TEACH_MIN_MS = 15 * MIN_MS;        // item 29: an unsorted app this long today is asked about
var TEACH_SITE_MIN_MS = 10 * MIN_MS;   // item 30a: ...a site this long
var RUN_GAP_MS = 15 * MIN_MS;          // item 30a: a work run goes on through gaps shorter than this
var AUTO_MIN_MS = 10 * MIN_MS;         // item 30b: work on a project not in Working on this long is shown
var AUTO_PUSH_MIN = 30;                // item 36: ...and pushed to the laptop at this many minutes
var HELPER_BACK_MS = 6 * 3600000;      // helpers given a project again on each run
var FOCUS_BACK_MS = 24 * 3600000;      // focus recounted from the counter day this long ago
var UPWORK_REPEAT_MS = 60 * MIN_MS;       // item 31a, R6: "Up and working?" again after this long,
var UPWORK_PUSHES = 3;                 // ...this many times in all; then it is applied
var APPLY_DELAY_MS = 20 * MIN_MS;         // item 31a: End day's recommendations wait for the phone's last report
var APPLY_BACK_MS = 26 * 3600000;      // ...and reach back over the day it closed
var IDLE_SEEN_MS = 2 * 3600000;        // an idle gap is asked once every device seen this recently has reported past it
var IDLE_FRESH_MS = 60 * MIN_MS;          // ...and only pushed while this recent
var IDLE_PUSH_MAX = 3;                  // ...at most this many "Why?" pushes a counter day
var TEACH_PUSH_MAX = 2;                // ...pushed at most this many times a day; the rest wait in the sheet
var TEACH_FIX_CHUNK = 100;             // block ids per update when today's blocks are filed again
/* What an na- answer (the second button) leaves a question as; and each kind's two answers. */
var NA_STATE = { awake: 'asleep', upwork: 'asleep', resume: 'break', start: 'notwork' };
var ASK_CHOICES = { awake: ['awake', 'asleep'], resume: ['resume', 'break'], upwork: ['start', 'awake'], start: ['start', 'notwork'] };
/* A row of his of these types after the use a question is about ends the question (activity.js). */
var ASK_ENDS = A.ACT_ASK_ENDS;

/** sha256 is taken of this: letters and digits, upper case (as app.js watchTokenHash). */
function tokenText(t) {
  return String(t || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/** The distraction one device is on now: {start, end, what, private, music, phone}, or null. Item 36: a
 *  private app (WhatsApp...) is one too, asked "work or not?"; music: every block is music on the phone. */
function streakOf(blocks) {
  var s = (blocks || []).slice().sort(function (a, b) { return a.start - b.start; });
  function off(b) { return b.category === 'distraction' || b.category === 'private'; }
  if (!s.length || !off(s[s.length - 1])) return null;
  var last = s[s.length - 1];
  var start = last.start;
  var time = {};
  var priv = 0;
  var all = 0;
  var music = true;
  var phone = true;
  function add(b) {
    var w = A.actDistractName(b);
    if (w === 'distraction') w = b.domain || b.app || (b.category === 'private' ? 'a private app' : 'a distraction');
    time['w' + w] = (time['w' + w] || 0) + (b.end - b.start);
    all += b.end - b.start;
    if (b.category === 'private') priv += b.end - b.start;
    if (!A.actIsMusic(b)) music = false;
    if (b.kind !== 'phone') phone = false;
  }
  add(last);
  for (var i = s.length - 2; i >= 0; i--) {
    if (!off(s[i]) || start - s[i].end > STREAK_GAP_MS) break;
    start = Math.min(start, s[i].start);
    add(s[i]);
  }
  var what = Object.keys(time).sort(function (a, b) { return time[b] - time[a]; })[0].slice(1);
  return { start: start, end: last.end, what: what, private: priv * 2 > all, music: music, phone: phone };
}

/**
 * How much of [a, b] other devices spent in a work app or a meeting, and on what.
 * Each device reports on its own 5-minute clock, so the others may not have
 * sent the end of the span yet: it is measured up to the last minute any other
 * device has reported, and only once that covers half the span.
 */
function otherCover(blocks, device, a, b) {
  var spans = [];
  var time = {};
  var seen = -Infinity;
  (blocks || []).forEach(function (x) {
    if (x.device_id === device) return;
    if (x.end > seen) seen = x.end;
    if (x.category !== 'work' && x.category !== 'meeting') return;
    A.actIntersect(x.start, x.end, [[a, b]]).forEach(function (p) {
      spans.push(p);
      var w = [x.app, x.project].filter(Boolean).join(' · ') || x.category;
      time['w' + w] = (time['w' + w] || 0) + (p[1] - p[0]);
    });
  });
  var upTo = Math.min(b, seen);
  if (!(upTo - a >= (b - a) / 2)) return { ratio: 0, what: '' };
  var ms = A.actSpansMs(A.actMergeSpans(spans));
  var top = Object.keys(time).sort(function (x, y) { return time[y] - time[x]; })[0];
  return { ratio: ms / (upTo - a), what: top ? top.slice(1) : '' };
}

/** Item 36: a distraction or private streak he answered "I'm working" (or "Work") counts as work in the
 *  judgement. said: [{device_id, start}]; the streak runs on through gaps under STREAK_GAP_MS. */
function workedThrough(blocks, said) {
  var out = (blocks || []).slice();
  (said || []).forEach(function (n) {
    var mine = out.map(function (b, i) { return { b: b, i: i }; })
      .filter(function (x) { return x.b.device_id === n.device_id && x.b.end > n.start - STREAK_GAP_MS; })
      .sort(function (x, y) { return x.b.start - y.b.start; });
    var at = n.start;
    for (var k = 0; k < mine.length; k++) {
      var b = mine[k].b;
      if (b.category !== 'distraction' && b.category !== 'private') { if (b.start >= at) break; continue; }
      if (b.start - at > STREAK_GAP_MS) break;
      out[mine[k].i] = Object.assign({}, b, { category: 'work' });
      at = Math.max(at, b.end);
    }
  });
  return out;
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
      // Unclear counts only on a laptop: a phone's browser is unclear while he scrolls.
      return b.start >= ab.at && ((b.category === 'work' || b.category === 'meeting') ? long >= RESUME_WORK_MS
             : b.category === 'unclear' && b.kind !== 'phone' && long >= RESUME_UNCLEAR_MS);
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
    // Item 36: a phone distraction (not music) while the laptop works is not excused by it.
    var cover = s.music || !s.phone ? otherCover(d.blocks, n.device_id, n.streak_start, s.end) : { ratio: 0, what: '' };
    if (cover.ratio >= OTHER_COVER) {
      out.decide.push({ id: n.id, state: 'question', span_end: s.end, other: cover.what });
      return;
    }
    // Item 36 (Saad, 28 Oct): a distraction is never a deserved break.
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
    // R7, narrowed by item 36: music on the phone while the laptop works is work; no push.
    if ((s.music || !s.phone) && otherCover(d.blocks, dev, s.start, s.end).ratio >= OTHER_COVER) return;
    if (!known) out.push.push({ device_id: dev, start: s.start, end: s.end, what: s.what, private: s.private });
  });
  return out;
}

/* ── Item 23: asleep or on a break ─────────────────────────────────────── */

/** The Fajr that ends the night a sleep at `at` began, or null for a nap. A night starts
 *  at 9 pm or after midnight, or is any sleep still going past midnight (`until`: its end,
 *  or now). fajrAfter(t): the first Fajr after t. */
function nightEnd(at, fajrAfter, offsetMin, until) {
  var f = fajrAfter(at);
  if (!isFinite(f) || !(f > at)) return null;
  var local = at + offsetMin * MIN_MS;
  var hour = Math.floor((((local % 86400000) + 86400000) % 86400000) / 3600000);
  var sameDate = Math.floor(local / 86400000) === Math.floor((f + offsetMin * MIN_MS) / 86400000);
  var midnight = (Math.floor(local / 86400000) + 1) * 86400000 - offsetMin * MIN_MS;
  return hour >= NIGHT_FROM_H || sameDate || until > midnight ? f : null;
}

/** Item 26: the latest Fajr at or before `now`, stepping on from a night's first Fajr. */
function latestFajr(first, now, fajrAfter) {
  var f = first;
  for (var i = 0; i < 400; i++) {
    var n = fajrAfter(f);
    if (!isFinite(n) || !(n > f) || n > now) break;
    f = n;
  }
  return f;
}

/** The local midnight after t. */
function midnightAfter(t, offsetMin) {
  return (Math.floor((t + offsetMin * MIN_MS) / 86400000) + 1) * 86400000 - offsetMin * MIN_MS;
}

/** Blocks by device, each cut to [from, to]; `keep` picks which. */
function cutByDevice(blocks, from, to, keep) {
  var by = {};
  (blocks || []).forEach(function (b) {
    if (!b.device_id || (keep && !keep(b))) return;
    var a = Math.max(b.start, from);
    var z = Math.min(b.end, to);
    if (!(z > a)) return;
    (by['d' + b.device_id] = by['d' + b.device_id] || []).push(Object.assign({}, b, { start: a, end: z }));
  });
  return by;
}

/** One device's time in use within [a, z], as spans. */
function inUseSpans(list, a, z) {
  return A.actIntersect(a, z, A.actMergeSpans(list.map(function (b) { return [b.start, b.end]; })));
}

/** Is a watch question still about the state he is in? activity.js actAskOpen, which the
 *  app's catch-up sheet uses too. */
function askOpen(n, walk, rows) {
  return A.actAskOpen(n, walk, rows);
}

/** Work for the checks: a meeting is work time too (item 30a: Discord is a work meeting). */
function isWorkBlock(b) {
  return b.category === 'work' || b.category === 'meeting';
}

/** `spans` with `cut` taken out. Both sorted and merged. */
function minusSpans(spans, cut) {
  var out = [];
  spans.forEach(function (s) {
    var at = s[0];
    cut.forEach(function (c) {
      if (c[1] <= at || c[0] >= s[1]) return;
      if (c[0] > at) out.push([at, c[0]]);
      at = Math.max(at, c[1]);
    });
    if (s[1] > at) out.push([at, s[1]]);
  });
  return out;
}

/** Spans whose gaps are at most `gapMs` joined, as [start, end, ms in them]. */
function joinSpans(spans, gapMs) {
  var out = [];
  A.actMergeSpans(spans).forEach(function (s) {
    var last = out[out.length - 1];
    if (last && s[0] - last[1] <= gapMs) { last[1] = s[1]; last[2] += s[1] - s[0]; }
    else out.push([s[0], s[1], s[1] - s[0]]);
  });
  return out;
}

/** The most-time word among distraction blocks over `spans`: YouTube, X..., else 'distraction'. */
function distractWhat(dist, spans) {
  var time = {};
  dist.forEach(function (b) {
    var ms = 0;
    spans.forEach(function (s) { ms += A.actSpansMs(A.actIntersect(b.start, b.end, [[s[0], s[1]]])); });
    if (ms > 0) {
      var w = A.actDistractWord(b);
      time['w' + w] = (time['w' + w] || 0) + ms;
    }
  });
  var top = Object.keys(time).sort(function (x, y) { return (time[y] - time[x]) || (x < y ? -1 : 1); })[0];
  return top ? top.slice(1) : 'distraction';
}

/**
 * Item 30a: runs of work (work and meetings, every device together) that go on through gaps
 * under RUN_GAP_MS; work under a minute is left out. blocks: already cut to the window. Each run:
 * {start, end, work (spans), workMs, device_id, dev, gaps: the distractions inside it that no
 * work overlaps, joined across a minute, each 2 minutes or more; distMs (theirs), what}.
 */
function workRuns(blocks) {
  var list = (blocks || []).filter(function (b) { return b && b.end > b.start; });
  var work = list.filter(isWorkBlock);
  var dist = list.filter(function (b) { return b.category === 'distraction'; });
  var workAll = A.actMergeSpans(work.map(function (b) { return [b.start, b.end]; }));
  var runs = [];
  workAll.filter(function (s) { return s[1] - s[0] >= MIN_MS; }).forEach(function (s) {
    var last = runs[runs.length - 1];
    if (last && s[0] - last.end < RUN_GAP_MS) { last.end = s[1]; last.work.push(s); }
    else runs.push({ start: s[0], end: s[1], work: [s] });
  });
  return runs.map(function (r) {
    var first = work.filter(function (b) { return b.end > r.start; }).sort(function (x, y) { return x.start - y.start; })[0];
    var inside = [];
    dist.forEach(function (b) { A.actIntersect(b.start, b.end, [[r.start, r.end]]).forEach(function (p) { inside.push(p); }); });
    var gaps = joinSpans(minusSpans(A.actMergeSpans(inside), workAll), USE_GAP_MS)
      .filter(function (g) { return g[2] >= A.ACT_GLANCE_MS; });
    return { start: r.start, end: r.end, work: r.work, workMs: A.actSpansMs(r.work),
             device_id: first ? first.device_id : '', dev: (first && first.kind) || 'laptop',
             gaps: gaps.map(function (g) { return [g[0], g[1]]; }),
             distMs: gaps.reduce(function (n, g) { return n + g[2]; }, 0), what: distractWhat(dist, gaps) };
  });
}

/** What a question keeps (activity_nudges.run): the run's minutes and word, for the words; and
 *  the plan its answer writes from (activity.js actRunPlan over every block since the run began).
 *  Item 30b: the project Start names (runProject), '' for none. */
function runInfo(r, plan, project, projects) {
  var list = projects && projects.length ? projects : project ? [{ name: project, at: r.start }] : [];
  return { work_min: Math.round(r.workMs / MIN_MS), dist_min: Math.round(r.distMs / MIN_MS), what: r.what,
           gaps: (plan ? plan.gaps : r.gaps).map(function (g) { return g.length > 2 ? [g[0], g[1], g[2]] : [g[0], g[1]]; }),
           last: plan && isFinite(plan.last) ? plan.last : null, tail: plan && plan.tail ? plan.tail : null,
           project: list.length ? list[0].name : project || '', projects: list };
}

/** Item 36 (Saad, 27 Oct): every project a run held 10 minutes or more, not already in Working on, by
 *  when it first came up: [{name, at}]. The answer starts them all. */
function runProjects(blocks, r, active) {
  var time = Object.create(null);
  var first = Object.create(null);
  var names = Object.create(null);
  (blocks || []).forEach(function (b) {
    if (!isWorkBlock(b) || !b.project) return;
    var k = A.actNorm(b.project);
    var parts = r.work.reduce(function (all, s) { return all.concat(A.actIntersect(b.start, b.end, [s])); }, []);
    var ms = A.actSpansMs(A.actMergeSpans(parts));
    if (!k || !(ms > 0)) return;
    time[k] = (time[k] || 0) + ms;
    first[k] = Math.min(first[k] === undefined ? Infinity : first[k], parts[0][0]);
    var by = names[k] = names[k] || Object.create(null);
    by[b.project] = (by[b.project] || 0) + ms;
  });
  return Object.keys(time).filter(function (k) { return time[k] >= AUTO_MIN_MS; }).map(function (k) {
    var name = Object.keys(names[k]).sort(function (x, y) { return (names[k][y] - names[k][x]) || (x < y ? -1 : 1); })[0];
    return { name: name, at: first[k] };
  }).filter(function (p) { return !isActive(p.name, active); }).sort(function (x, y) { return (x.at - y.at) || (x.name < y.name ? -1 : 1); });
}

/** Is `name` in Working on (names as replayDay keys them; case, spaces and punctuation ignored)? */
function isActive(name, active) {
  var k = A.actNorm(name);
  return Boolean(k) && (active || []).some(function (a) { return A.actNorm(a) === k; });
}

/** Item 30b: the project a run is mostly about (half its work time or more), by the name it had
 *  most; '' when none is, or when it is already in Working on. blocks: cut as the run's. */
function runProject(blocks, r, active) {
  var time = Object.create(null);
  var names = Object.create(null);
  (blocks || []).forEach(function (b) {
    if (!isWorkBlock(b) || !b.project) return;
    var k = A.actNorm(b.project);
    var ms = A.actSpansMs(A.actMergeSpans(r.work.reduce(function (all, s) { return all.concat(A.actIntersect(b.start, b.end, [s])); }, [])));
    if (!k || !(ms > 0)) return;
    time[k] = (time[k] || 0) + ms;
    var by = names[k] = names[k] || Object.create(null);
    by[b.project] = (by[b.project] || 0) + ms;
  });
  var top = Object.keys(time).sort(function (x, y) { return (time[y] - time[x]) || (x < y ? -1 : 1); })[0];
  if (!top || time[top] * 2 < r.workMs) return '';
  var name = Object.keys(names[top]).sort(function (x, y) { return (names[top][y] - names[top][x]) || (x < y ? -1 : 1); })[0];
  return isActive(name, active) ? '' : name;
}

/**
 * Asleep, on a break or awake with the day off (item 28). d: {now, walk (actWalk), blocks
 * [{device_id, kind, start, end, category}] (any mode), nudges [{id, kind, device_id, streak_start, pushed_at, decided_at,
 * state, ref_at}] (ms), rows [{at, type, rid}], nightEnd(at, until) -> Fajr or null,
 * fajrAfter(t), offsetAt(t) (minutes east of UTC), checks (his switch; false: no
 * questions, open ones closed; nights still kept), active (item 30b: Working on's names)}.
 * Returns {push: [{kind, device_id, dev, start, end, ref, push, run}], decide: [{id, state}],
 * nights: [{sleep_at, woke_at, fajr_at, first_at, last_at, minutes, kinds}], runs: [{id, run}]
 * (item 30a: an open question's run, when it changed; a nudge may carry `run`, gaps in ms),
 * write: rows an applied recommendation writes, repush: [{id, pushes, p}] (item 31a, R6)}.
 * Item 31a: a nudge may carry `pushes` (how many times it went out) and `what` (its device's kind).
 */
function quietStep(d) {
  var out = { push: [], decide: [], nights: [], runs: [], write: [], repush: [] };
  var walk = d.walk || {};
  var rows = d.rows || [];
  var nudges = (d.nudges || []).filter(function (n) { return ASK_KINDS.indexOf(n.kind) !== -1; });
  var now = d.now;
  var state = {};
  nudges.forEach(function (n) {
    state[n.id] = n.state;
    if (n.state !== 'sent') return;
    var to = hasRid(rows, 'ns-' + n.id) ? 'started' : hasRid(rows, 'nw-' + n.id) ? 'awake'
           : hasRid(rows, 'nr-' + n.id) ? 'resumed' : hasRid(rows, 'na-' + n.id) ? NA_STATE[n.kind]
           : d.checks !== false && askOpen(n, walk, rows) ? '' : 'closed';
    // Item 31a: still open when he ended the day, so its recommendation is applied (marked auto).
    var close = to === 'closed' && d.checks !== false ? dayClosedOn(n, rows) : null;
    if (close && close.at >= now - APPLY_BACK_MS) {
      askRows(n, APPLY_CHOICE[n.kind], close.at).forEach(function (w) { out.write.push(w); });
      to = 'applied';
    }
    if (to) { out.decide.push({ id: n.id, state: to }); state[n.id] = to; }
  });

  // One open question per sleep, break or day-off stretch; a run that began before the last push
  // or answer is not asked about again, nor anything for 30 minutes after a "no" (Still asleep,
  // It was a break, Not work; for "start?" also Just awake, passed as `also`). Returns the
  // instant a run must begin after, or null while a question is open or quiet.
  function since(kinds, ref, also) {
    var mine = nudges.filter(function (n) { return kinds.indexOf(n.kind) !== -1 && n.ref_at === ref; });
    if (mine.some(function (n) { return state[n.id] === 'sent'; })) return null;
    var all = mine.concat(also || []);
    if (all.some(function (n) {
      var no = n.state === 'asleep' || n.state === 'break' || n.state === 'notwork' || (also || []).indexOf(n) !== -1;
      return no && now < n.decided_at + ASK_QUIET_MS;
    })) return null;
    var after = -Infinity;
    all.forEach(function (n) {
      after = Math.max(after, n.streak_start, isFinite(n.pushed_at) ? n.pushed_at : -Infinity,
                       isFinite(n.decided_at) ? n.decided_at : -Infinity);
      if (state[n.id] !== n.state) after = Math.max(after, now);
    });
    return after;
  }
  // The first run of use on one device (`keep`'s blocks) that began after `after` with `min` in
  // use past `thr`; pushed only when some such run is recent (a late phone run: the sheet only).
  function find(after, from, thr, keep, min, kind, ref) {
    var by = cutByDevice(d.blocks, from, now, keep);
    var best = null;
    var fresh = false;
    Object.keys(by).forEach(function (k) {
      A.actUseRuns(by[k], USE_GAP_MS).forEach(function (r) {
        if (r.start <= after) return;
        if (A.actSpansMs(inUseSpans(by[k], Math.max(thr, r.start), r.end)) < min) return;
        if (r.end >= now - USE_FRESH_MS) fresh = true;
        if (!best || r.start < best.start) {
          best = { kind: kind, device_id: k.slice(1), dev: by[k][0].kind || 'laptop', start: r.start, end: r.end, ref: ref };
        }
      });
    });
    return best ? Object.assign(best, { push: fresh }) : null;
  }
  // Item 30a: a work run (every device together) that began after `after`, with `min` of work past `thr`.
  function findRun(after, from, thr, min, kind, ref, keep) {
    var best = null;
    var fresh = false;
    workRuns(cutAll(from, keep)).forEach(function (r) {
      if (r.start <= after) return;
      var past = 0;
      r.work.forEach(function (s) { past += A.actSpansMs(A.actIntersect(s[0], s[1], [[thr, r.end]])); });
      if (past < min) return;
      if (r.end >= now - USE_FRESH_MS) fresh = true;
      if (!best || r.start < best.start) {
        best = { kind: kind, device_id: r.device_id, dev: r.dev, start: r.start, end: r.end, ref: ref,
                 run: runInfo(r, A.actRunPlan(cutAll(from), r.start, now), kind === 'resume' ? '' : runProject(cutAll(from), r, d.active),
                              kind === 'resume' ? [] : runProjects(cutAll(from), r, d.active)) };
      }
    });
    return best ? Object.assign(best, { push: fresh }) : null;
  }
  function cutAll(from, keep) {
    var cut = [];
    (d.blocks || []).forEach(function (b) {
      var a = Math.max(b.start, from);
      var z = Math.min(b.end, now);
      if (b.device_id && z > a && (!keep || keep(b))) cut.push(Object.assign({}, b, { start: a, end: z }));
    });
    return cut;
  }
  function add(p) { if (p) out.push.push(p); }
  // Item 28: runs count from after his newest state row in the stretch (a second Sleep, a chip),
  // so an answer never lands on or before one, and no question is over as soon as it is asked.
  function afterMine(ref) {
    var t = ref + 1000;
    rows.forEach(function (r) { if (ASK_ENDS.indexOf(r.type) !== -1 && r.at >= ref) t = Math.max(t, r.at + 1000); });
    return t;
  }
  if (walk.asleep && d.checks !== false) {
    var f = d.nightEnd(walk.asleep.at, now);
    var thr = f === null ? walk.asleep.at : f;
    var night = false;
    // Item 26: past a Fajr, use counts from the latest one (a Wake forgotten days ago asks
    // about today), and from the midnight after it to the next Fajr nothing is asked.
    if (f !== null && f <= now) {
      thr = latestFajr(f, now, d.fajrAfter);
      night = now >= midnightAfter(thr, d.offsetAt(thr));
    }
    var sa = night ? null : since(['awake', 'upwork'], walk.asleep.at);
    if (f !== null && f > now && sa !== null) {
      // Item 36 (Saad, 28 Oct): before Fajr, the laptop in use 15 minutes after Sleep asks "asleep or
      // working?" (the phone never does: phone use in bed is never work, it is a disturbed night).
      var nfrom = afterMine(walk.asleep.at);
      var lap = function (b) { return b.kind !== 'phone'; };
      var np = findRun(sa, nfrom, nfrom, NIGHT_LAPTOP_MS, 'upwork', walk.asleep.at, lap) ||
               find(sa, nfrom, nfrom, lap, NIGHT_LAPTOP_MS, 'awake', walk.asleep.at);
      if (np) np.night = true;
      add(np);
      sa = null;
    }
    // Item 28: work is "Up and working?"; any other use the plain "awake?".
    if (sa !== null) {
      var afrom = afterMine(walk.asleep.at);
      add(findRun(sa, afrom, thr, USE_MIN_MS, 'upwork', walk.asleep.at) ||
          find(sa, afrom, thr, null, USE_MIN_MS, 'awake', walk.asleep.at));
    }
  }
  if (walk.onBreak && d.checks !== false) {
    var sr = since(['resume'], walk.onBreak.at);
    var rfrom = Math.max(walk.onBreak.since, afterMine(walk.onBreak.at));
    if (sr !== null) add(findRun(sr, rfrom, rfrom, USE_MIN_MS, 'resume', walk.onBreak.at));
  }
  // Item 28: awake, the day not started or ended.
  if (walk.offSince && d.checks !== false) {
    var oref = walk.offSince.at;
    var ofrom = afterMine(oref);
    var just = nudges.filter(function (n) {
      return n.kind === 'upwork' && state[n.id] === 'awake' && (state[n.id] !== n.state ? now : n.decided_at) >= oref;
    });
    var so = since(['start'], oref, just);
    if (so !== null) add(findRun(so, ofrom, ofrom, START_MIN_MS, 'start', oref));
  }

  // Item 30a: an open question's plan follows every block since it began (later runs and long gaps too).
  nudges.forEach(function (n) {
    if (state[n.id] !== 'sent' || RUN_KINDS.indexOf(n.kind) === -1 || !isFinite(n.streak_start)) return;
    var r = workRuns(cutAll(n.streak_start))[0];
    if (!r || r.start >= n.streak_start + MIN_MS) return;
    var info = runInfo(r, A.actRunPlan(cutAll(n.streak_start), r.start, now),
                       n.kind === 'resume' ? '' : runProject(cutAll(n.streak_start), r, d.active),
                       n.kind === 'resume' ? [] : runProjects(cutAll(n.streak_start), r, d.active));
    if (JSON.stringify(info) !== JSON.stringify(n.run || null)) out.runs.push({ id: n.id, run: info });
    n.run = info;
  });

  // Item 31a, R6: "Up and working?" unanswered and the work going on: asked again every hour, three
  // times in all; an hour after the third, applied (wake and work from the first work minute).
  nudges.forEach(function (n) {
    if (n.kind !== 'upwork' || state[n.id] !== 'sent' || !isFinite(n.pushes) || !isFinite(n.pushed_at)) return;
    if (now < n.pushed_at + UPWORK_REPEAT_MS) return;
    var last = n.run && isFinite(n.run.last) && n.run.last !== null ? n.run.last : NaN;
    if (!(last >= now - USE_FRESH_MS)) return;
    if (n.pushes < UPWORK_PUSHES) {
      out.repush.push({ id: n.id, pushes: n.pushes, p: { kind: n.kind, device_id: n.device_id, dev: n.what === 'phone' ? 'phone' : 'laptop',
                                                         start: n.streak_start, end: last, ref: n.ref_at, run: n.run, push: true } });
      return;
    }
    askRows(n, 'start', now).forEach(function (w) { out.write.push(w); });
    out.decide.push({ id: n.id, state: 'applied' });
    state[n.id] = 'applied';
  });

  // Disturbed nights (item 36, Saad 28 Oct): the phone picked up NIGHT_PICKUPS times or more (any
  // length), or once for more than NIGHT_LONG_MS, before Fajr while asleep. The laptop is never a
  // disturbance: it is asked about ("asleep or working?").
  (walk.sleeps || []).forEach(function (s) {
    var fajr = d.nightEnd(s.at, s.end === null ? now : s.end);
    if (fajr === null || s.at < now - NIGHTS_BACK_MS) return;
    var end = Math.min(fajr, s.end === null ? now : s.end, now);
    var spans = [];
    var kinds = [];
    var by = cutByDevice(d.blocks, s.at, end, function (b) { return b.kind === 'phone'; });
    Object.keys(by).forEach(function (k) {
      var runs = A.actUseRuns(by[k], USE_GAP_MS);
      var long = runs.some(function (r) { return r.ms > NIGHT_LONG_MS; });
      if (!long && runs.length < NIGHT_PICKUPS) return;
      runs.forEach(function (r) { inUseSpans(by[k], r.start, r.end).forEach(function (p) { spans.push(p); }); });
      if (kinds.indexOf('phone') === -1) kinds.push('phone');
    });
    var merged = A.actMergeSpans(spans);
    out.nights.push({ sleep_at: s.at, woke_at: s.end, fajr_at: fajr, first_at: merged.length ? merged[0][0] : null,
                      last_at: merged.length ? merged[merged.length - 1][1] : null,
                      minutes: Math.round(A.actSpansMs(merged) / MIN_MS), kinds: kinds.sort().join(',') });
  });
  return out;
}

/* Item 31a: the answer an open question gets when the day closes on it. "awake?" has none: not his day. */
var APPLY_CHOICE = { start: 'start', resume: 'resume', upwork: 'start' };

/** The row of his that closed the day on a question still open just before it: his first state row
 *  after the use (its own answer rows aside) when it is End day ('off'), or for "start?" (the day was
 *  never on) a Sleep; else null. rows: [{at (ms), type, rid}]. */
function dayClosedOn(n, rows) {
  if (!APPLY_CHOICE[n.kind]) return null;
  var own = ['nw-', 'nr-', 'ns-', 'na-'].map(function (x) { return x + n.id; });
  var pairs = new RegExp('^n[de]-' + String(n.id).replace(/[^0-9a-zA-Z-]/g, '') + '-[0-9a-z]+$');
  var first = null;
  (rows || []).forEach(function (r) {
    var rid = String(r.rid || '');
    if (!(r.at > n.streak_start) || ASK_ENDS.indexOf(r.type) === -1 || own.indexOf(rid) !== -1 || pairs.test(rid)) return;
    if (!first || r.at < first.at) first = r;
  });
  if (!first || !(first.type === 'off' || (first.type === 'sleep' && n.kind === 'start'))) return null;
  // Open just before it: the same stretch, nothing of his in between.
  var before = (rows || []).filter(function (r) { return r.at < first.at; })
    .map(function (r) { return { at: new Date(r.at).toISOString(), type: r.type, rid: r.rid }; });
  var walk = A.actWalk(before, first.at - READ_BACK_MS, first.at - 1);
  return askOpen(n, walk, (rows || []).filter(function (r) { return r.at < first.at; })) ? first : null;
}

/** The backdated instant an answer writes: the use, never before the sleep or break row. */
function askAt(n) {
  return Math.max(n.streak_start, n.ref_at + 1000);
}

/** The rows an answer writes. choice: awake/asleep, resume/break, start/awake (upwork) or
 *  start/notwork (start). Start day's resume is a second after its wake, so the two never tie.
 *  n.run (item 30a): the run's distractions, each then a break and a resume. */
function askRows(n, choice, now) {
  // Item 30a: the run's distractions as breaks, after the resume it starts with.
  function pairs(from) { return A.actRunSteps(n.id, n.run, from, now); }
  if (n.kind === 'upwork') {
    var w = { type: 'wake', at: askAt(n), rid: 'nw-' + n.id, text: 'Wake up (I was awake — answered the check)' };
    return choice === 'start'
      ? [w, projectRow(n, { type: 'resume', at: askAt(n) + 1000, rid: 'ns-' + n.id, text: 'Day started (up and working — answered the check)' })]
        .concat(moreProjects(n, askAt(n) + 1000), pairs(askAt(n) + 1000))
      : [w];
  }
  if (n.kind === 'start') {
    return choice === 'start'
      ? [projectRow(n, { type: 'resume', at: askAt(n), rid: 'ns-' + n.id, text: 'Day started (I was working — answered the check)' })]
        .concat(moreProjects(n, askAt(n)), pairs(askAt(n)))
      : [{ type: 'actanswer', at: now, rid: 'na-' + n.id, text: 'Not work — answered the check', detail: 'notwork' }];
  }
  if (n.kind === 'awake') {
    return choice === 'awake'
      ? [{ type: 'wake', at: askAt(n), rid: 'nw-' + n.id, text: 'Wake up (I was awake — answered the check)' }]
      : [{ type: 'actanswer', at: now, rid: 'na-' + n.id, text: 'Still asleep — answered the check', detail: 'asleep' }];
  }
  return choice === 'resume'
    ? [{ type: 'resume', at: askAt(n), rid: 'nr-' + n.id, text: 'Resume (back at work — answered the check)' }]
      .concat(pairs(askAt(n)))
    : [{ type: 'actanswer', at: now, rid: 'na-' + n.id, text: 'Still on a break — answered the check', detail: 'break' }];
}

/** Item 30b: "start?" about a project starts it: its resume becomes a work row naming it. */
function projectRow(n, row) {
  var p = n.run && n.run.project ? A.actCut(String(n.run.project).trim(), A.ACT_PROJECT_MAX) : '';
  return p ? Object.assign({}, row, { type: 'work', project: p }) : row;
}

/** Item 36: the run's other projects, each a work row from when it first came up (after `from`). */
function moreProjects(n, from) {
  var list = n.run && Array.isArray(n.run.projects) ? n.run.projects.slice(1) : [];
  return list.map(function (p, k) {
    var name = A.actCut(String(p.name || '').trim(), A.ACT_PROJECT_MAX);
    var at = Math.max(Number(p.at) || 0, from + 1000 * (k + 1));
    return name ? { type: 'work', at: at, rid: 'ns-' + n.id + '-p' + (k + 1), text: name, project: name } : null;
  }).filter(Boolean);
}

/* ── Item 30b: auto-detected Working on ────────────────────────────────── */

/**
 * d: {now, walk (actWalk), blocks [{device_id, kind, start, end, category, project}] (watched),
 * nudges [{id, kind 'auto', streak_start, decided_at, state, ref_at, run}] (ms), rows [{at, type,
 * rid}], named [{at, name}] (his work, voice and done rows: project or text), active (Working
 * on), checks}. While the clock runs, a project's work in the current working stretch, after his
 * newest row naming it, joined across gaps under RUN_GAP_MS, of AUTO_MIN_MS or more: one open at a
 * time, the most time first. A stretch he rejected is not shown again; a later one may be.
 * Returns {decide: [{id, state}], ask: {device_id, dev, start, end, ref, run} or null, runs: [{id, run}]}.
 */
function autoStep(d) {
  var out = { decide: [], ask: null, runs: [] };
  var walk = d.walk || {};
  var rows = d.rows || [];
  var now = d.now;
  var nudges = (d.nudges || []).filter(function (n) { return n.kind === 'auto'; });
  var open = null;
  nudges.forEach(function (n) {
    if (n.state !== 'sent') return;
    var to = hasRid(rows, 'ns-' + n.id) ? 'started' : hasRid(rows, 'na-' + n.id) ? 'rejected'
           : d.checks !== false && A.actAutoOpen(n, walk, rows, d.active) ? '' : 'closed';
    if (to) out.decide.push({ id: n.id, state: to });
    else open = n;
  });
  var spans = walk.work || [];
  if (d.checks === false || !walk.working || !spans.length) return out;
  var spanStart = spans[spans.length - 1][0];
  function lastNamed(k) {
    var t = -Infinity;
    (d.named || []).forEach(function (r) { if (A.actNorm(r.name) === k && r.at > t) t = r.at; });
    return t;
  }
  // A project's stretches from `from`: [{start, end, ms, device_id, dev, name}].
  function stretches(k, from) {
    var mine = [];
    var names = Object.create(null);
    (d.blocks || []).forEach(function (b) {
      if (!isWorkBlock(b) || A.actNorm(b.project) !== k) return;
      var a = Math.max(b.start, from);
      var z = Math.min(b.end, now);
      if (!(z > a)) return;
      mine.push({ a: a, z: z, b: b });
      names[b.project] = (names[b.project] || 0) + (z - a);
    });
    var name = Object.keys(names).sort(function (x, y) { return (names[y] - names[x]) || (x < y ? -1 : 1); })[0] || '';
    var out2 = [];
    joinSpans(mine.map(function (m) { return [m.a, m.z]; }), RUN_GAP_MS - 1).forEach(function (g) {
      var first = mine.filter(function (m) { return m.z > g[0]; }).sort(function (x, y) { return x.a - y.a; })[0];
      out2.push({ start: g[0], end: g[1], ms: g[2], device_id: first ? first.b.device_id : '', dev: (first && first.b.kind) || 'laptop', name: name });
    });
    return out2;
  }
  function info(r) {
    return { work_min: Math.round(r.ms / MIN_MS), dist_min: 0, what: '', gaps: [], last: r.end, project: r.name };
  }
  if (open) {
    var ok = A.actNorm(open.run && open.run.project);
    var cur = stretches(ok, open.ref_at).filter(function (r) { return r.start < open.streak_start + MIN_MS; })[0];
    if (cur) {
      var was = open.run || {};
      var now2 = info(Object.assign({}, cur, { name: was.project || cur.name }));
      if (now2.work_min !== was.work_min || now2.last !== was.last) out.runs.push({ id: open.id, run: now2 });
    }
    return out;
  }
  var keys = Object.create(null);
  (d.blocks || []).forEach(function (b) {
    if (isWorkBlock(b) && b.project && b.end > spanStart && !isActive(b.project, d.active)) keys[A.actNorm(b.project)] = 1;
  });
  var best = null;
  Object.keys(keys).forEach(function (k) {
    if (!k) return;
    var from = Math.max(spanStart, lastNamed(k) + 1000);
    stretches(k, from).forEach(function (r) {
      if (r.ms < AUTO_MIN_MS) return;
      var said = nudges.some(function (n) {
        if (n.state !== 'rejected' || A.actNorm(n.run && n.run.project) !== k) return false;
        var last = n.run && isFinite(n.run.last) && n.run.last !== null ? n.run.last : -Infinity;
        return r.start <= Math.max(n.streak_start, last);
      });
      if (said) return;
      if (!best || r.ms > best.r.ms || (r.ms === best.r.ms && r.start < best.r.start)) best = { r: r, ref: from };
    });
  });
  if (best) {
    out.ask = { device_id: best.r.device_id, dev: best.r.dev, start: best.r.start, end: best.r.end, ref: best.ref, run: info(best.r) };
  }
  return out;
}

/** Item 36: the laptop push about a desktop that is not Working on's project. A tap opens the sheet. */
function autoPayload(run, active) {
  var p = A.actCut(String((run && run.project) || ''), 40);
  var on = (active || []).slice(0, 2).join(', ');
  return { kind: 'watch-teach', goto: 'home', title: 'On ' + p + ' for ' + run.work_min + ' min — working on ' + p + '?',
           body: (on ? 'Working on says ' + A.actCut(on, 60) + '. ' : '') + 'Tap to answer in ProBeing.' };
}

/** "6:12 pm" at `offsetMin`. */
function clock12(ms, offsetMin) {
  var mins = Math.floor(ms / 60000) + offsetMin;
  var m = ((mins % 1440) + 1440) % 1440;
  var h = Math.floor(m / 60);
  var mm = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;         // item 37: 24-hour
}

/** The push. sw.js shows it with Take a break / I'm working under one tag. */
function nudgePayload(p, nudgeId, nonce, url, key, offsetMin) {
  var mins = Math.max(10, Math.round((p.end - p.start) / 60000));
  if (p.private) {
    // Item 36 (Saad, 28 Oct): a private app while working is asked, by name.
    return { kind: 'distract', tag: 'probeing-distract', nudge: nudgeId, nonce: nonce, url: url, key: key, goto: 'home', private: true,
             title: A.actCut(p.what, 60) + ' for ' + mins + ' min — work (a call) or not?',
             body: 'No answer in 5 min and it counts as a distraction from ' + clock12(p.start, offsetMin) + '.' };
  }
  return { kind: 'distract', tag: 'probeing-distract', nudge: nudgeId, nonce: nonce, url: url, key: key, goto: 'home',
           title: 'You\'ve been on ' + A.actCut(p.what, 60) + ' for ' + mins + ' min — take a break?',
           body: 'No answer in 5 min and it counts as a distraction from ' + clock12(p.start, offsetMin) + '.' };
}

/** The awake or back-to-work push. sw.js shows it with two buttons under one tag. */
function askPayload(p, nudgeId, nonce, url, key, offsetMin) {
  var at = clock12(Math.max(p.start, p.ref + 1000), offsetMin);
  var dev = p.dev === 'laptop' ? 'laptop' : 'phone';
  var base = { kind: 'watch-ask', ask: p.kind, tag: 'probeing-watch-ask', nudge: nudgeId, nonce: nonce, url: url, key: key,
               goto: 'home' };
  if (p.night) {
    // Item 36 (Saad, 28 Oct): Sleep pressed, then the laptop.
    return Object.assign(base, { title: 'You marked sleep — asleep or working?',
                                 body: 'Your laptop is in use since ' + at + '. ' + (p.kind === 'upwork' ? 'Start day records work from then.'
                                                                                         : 'I\'m awake records waking then.') });
  }
  if (p.kind === 'awake') {
    return Object.assign(base, { title: 'You\'re marked asleep but using your ' + dev + ' — awake?',
                                 body: 'I\'m awake records waking at ' + at + '.' });
  }
  if (p.kind === 'upwork') {
    return Object.assign(base, { title: 'Up and working? Start your day?',
                                 body: 'Your ' + dev + ' shows work from ' + at + '. Start day records waking and work from then.' });
  }
  var run = p.run || null;
  var dist = run && run.dist_min > 0 && run.gaps && run.gaps.length ? run.dist_min + ' min ' + A.actCut(run.what || 'distraction', 20) : '';
  if (p.kind === 'start') {
    // Item 30a (Saad, 13 Oct): "Working since 13:02 · 18 min work · 12 min YouTube in between — start?"
    var mins = Math.max(10, run ? run.work_min : Math.round((p.end - p.start) / 60000));
    var names = run && Array.isArray(run.projects) && run.projects.length ? run.projects.map(function (x) { return x.name; }) : [];
    var proj = names.length > 1 ? A.actCut(names.join(' + '), 60) : run && run.project ? A.actCut(String(run.project), 40) : '';
    return Object.assign(base, { title: (proj ? proj + ' since ' : 'Working since ') + at + ' · ' + mins + ' min work' +
                                        (dist ? ' · ' + dist + ' in between' : '') + ' — start?',
                                 body: 'Start records ' + (proj || 'work') + ' from ' + at + (dist ? ', and the ' + dist + ' as a break' : '') + '.' });
  }
  return Object.assign(base, { title: 'Still on break but you look like you\'re working — back to work?',
                               body: 'Resume records you back at ' + at + (dist ? ', and the ' + dist + ' as a break' : '') + '.' });
}

var ANSWER_OPEN_MS = 30 * MIN_MS;

/** Is a push still open to its buttons? A question until answered; a push or an auto
 *  break for 30 minutes, and only while no state row of his came after it. */
function answerOpen(n, now, rows) {
  if (n.state === 'question') return true;
  if (n.state !== 'sent' && n.state !== 'autobreak') return false;
  if (!(now - n.pushed_at <= ANSWER_OPEN_MS)) return false;
  return !(rows || []).some(function (r) {
    return r.at > n.pushed_at && RESPONSE_TYPES.indexOf(r.type) !== -1 && !SERVER_RIDS.test(String(r.rid || ''));
  });
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
             'project name from the list or ""}. Pick a project only when the title clearly belongs to it; never ' +
             'guess from the app or website alone.');
  return lines.join('\n');
}

var CLASSIFY_SCHEMA = {
  type: 'ARRAY',
  items: { type: 'OBJECT', properties: { n: { type: 'INTEGER' }, project: { type: 'STRING' } }, required: ['n', 'project'] }
};

/** Gemini's answer -> [{key, project}] for items it placed, names checked against
 *  the list. Nothing from a title is kept (Saad, 9 Oct): no keyword comes back. */
function readClassify(text, items, projects) {
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
    out.push({ key: it.key, project: project });
  });
  return out;
}

/** Items fit to send: private ones, terminals, file windows, path-like titles and helpers
 *  (item 30a: their project comes from the work around them) dropped, titles scrubbed, at most CLASSIFY_MAX. */
function classifyItems(items, lists) {
  var priv = A.actLists(lists)['private'];
  var helper = A.actLists(lists).helpers;
  var out = [];
  (Array.isArray(items) ? items : []).forEach(function (it) {
    if (!it || typeof it !== 'object' || out.length >= CLASSIFY_MAX) return;
    var title = A.actScrubTitle(it.title);
    var app = A.actCleanApp(it.app);
    var domain = A.actCleanDomain(it.domain);
    var raw = String(it.title == null ? '' : it.title);
    // A browser window with no site is one the extension did not see: its title is never sent.
    if (!title || !A.actTitleSendable(app, raw) || A.ACT_PRIVATE_TITLE.test(raw) || (A.actIsBrowser(app) && !domain) ||
        A.actListHit(priv, { app: app, host: domain, title: raw }, true) || A.actHelperHit(helper, { app: app, host: domain })) return;
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

/** Clean blocks cut to when they may be kept: whole while watched (mode work), bare while
 *  asleep, on a break (item 23: time, category, a work project) or awake with the day off
 *  (item 28); the rest dropped. */
function keptPieces(clean, walk) {
  var full = A.actClip(clean, walk.watch || []).map(function (b) { return Object.assign({}, b, { mode: 'work' }); });
  function bare(spans, mode) {
    return A.actClip(clean, spans || []).map(function (b) {
      var named = b.category === 'work' || b.category === 'meeting';
      return Object.assign({}, b, { app: '', domain: '', key: '', desktop: '', project: named ? b.project : '', mode: mode });
    });
  }
  // Item 36 (Saad, 28 Oct): awake with the day off (a weekend) is kept whole, so its distraction is named.
  var off = A.actClip(clean, walk.awakeOff || []).map(function (b) { return Object.assign({}, b, { mode: 'off' }); });
  return full.concat(bare(walk.sleep, 'sleep'), bare(walk.rest, 'break'), off);
}

/** What the watchers are told about now: work, sleep, break or off. */
function modeOf(walk) {
  return walk.working ? 'work' : walk.asleep ? 'sleep' : (walk.onBreak || walk.autoBreak) ? 'break' : 'off';
}

/* ── Item 29: "What is <app>?" ─────────────────────────────────────────── */

/**
 * d: {dayStart, on (his switch), canPush, list (activity.js actTeachList of today's blocks:
 * unsorted names, most time first), nudges [{id, entry, state, streak_start, pushed_at}] (ms;
 * kind teach: every open one, and all of today's)}. Returns {decide: [{id, state}], ask:
 * {entry, label, ms} or null, push: 'new', an open question's id, or null}.
 */
function teachStep(d) {
  var out = { decide: [], ask: null, push: null };
  var unsorted = Object.create(null);
  (d.list || []).forEach(function (r) { unsorted[r.entry] = r; });
  var asked = Object.create(null);
  var pushed = 0;
  var open = null;
  (d.nudges || []).forEach(function (n) {
    var today = n.streak_start >= d.dayStart;
    if (today) {
      asked[n.entry] = 1;
      if (isFinite(n.pushed_at)) pushed += 1;
    }
    if (n.state !== 'asking') return;
    // Sorted by any route (the sheet, Teach, Lists, a rule): its name is no longer unsorted.
    var to = !today ? 'stale' : d.on === false ? 'closed' : !unsorted[n.entry] ? 'answered' : open ? 'closed' : '';
    if (to) out.decide.push({ id: n.id, state: to });
    else open = n;
  });
  if (d.on === false) return out;
  if (!open) {
    var next = (d.list || []).filter(function (r) { return r.ms >= (r.site ? TEACH_SITE_MIN_MS : TEACH_MIN_MS) && !asked[r.entry]; })[0];
    if (next) out.ask = { entry: next.entry, label: next.label, ms: next.ms, site: next.site === true };
  }
  if (d.canPush && pushed < TEACH_PUSH_MAX) {
    if (out.ask) out.push = 'new';
    else if (open && !isFinite(open.pushed_at)) out.push = open.id;
  }
  return out;
}

/** Today's unclear blocks that the lists and rules now place, as updates: [{ids, category,
 *  project, key}]. By app and site only, as the server has no title. */
function teachFixes(blocks, cfg) {
  var by = Object.create(null);
  (blocks || []).forEach(function (b) {
    if (b.category !== 'unclear' || (b.mode && b.mode !== 'work') || !b.id) return;
    var c = A.actClassify({ app: b.app, host: b.domain || '', path: '', title: '', phone: b.kind === 'phone' }, cfg);
    if (c.category === 'unclear') return;
    var k = [c.category, c.project, c.key].join('|');
    if (!by[k]) {
      by[k] = { ids: [], category: c.category, project: c.category === 'private' ? '' : c.project,
                key: c.category === 'private' ? '' : c.key };
    }
    by[k].ids.push(b.id);
  });
  return Object.keys(by).map(function (k) { return by[k]; });
}

/** A label never reaches back (item 29 fix): a block whose category arrived later (became, ms), or
 *  whose name he answered a "what is" question about (labelled: entry -> when the server saw the
 *  answer), is unclear before then, for the distraction, break and day checks. */
function labelClip(blocks, labelled) {
  var out = [];
  (blocks || []).forEach(function (b) {
    var t = isFinite(b.became) ? b.became : -Infinity;
    var n = labelled ? A.actTeachName(b) : null;
    if (n && isFinite(labelled[n.entry])) t = Math.max(t, labelled[n.entry]);
    if (!(t > b.start) || b.category === 'unclear') { out.push(b); return; }
    if (t >= b.end) { out.push(Object.assign({}, b, { category: 'unclear', project: '' })); return; }
    out.push(Object.assign({}, b, { end: t, category: 'unclear', project: '' }));
    out.push(Object.assign({}, b, { start: t }));
  });
  return out;
}

/** Is a teach question's name now on his private list? Its rows are blanked then. */
function teachPrivate(n, cfg) {
  return Boolean(n && n.entry) && A.actClassify(A.actTeachSeg(n), cfg).category === 'private';
}

/** Between local midnight and the Fajr after it. fajrAfter(t): the first Fajr after t. */
function nightNow(now, offsetMin, fajrAfter) {
  var midnight = midnightAfter(now, offsetMin) - 86400000;
  var f = fajrAfter(midnight);
  return isFinite(f) && now >= midnight && now < f;
}

/** The push. sw.js shows it with no buttons; a tap opens the sheet, which asks it. */
function teachPayload(label, ms, site) {
  var mins = Math.max(site ? 10 : 15, Math.round(ms / 60000));
  return { kind: 'watch-teach', tag: 'probeing-watch-teach', goto: 'home',
           title: 'What is ' + A.actCut(label, 60) + '?',
           body: mins + ' min today and not sorted yet. Tap to say: Work, Meeting, Distraction, Private or Ignore.' };
}

/* ── Item 30a: helpers and focus ───────────────────────────────────────── */

/**
 * Helpers' projects: a helper block (work, no keyword of its own) takes the project of the nearest
 * work on its device within ACT_NEAR_MS, before or after (the earlier on a tie), else none.
 * blocks: [{id, device_id, kind, start, end, category, project, app, domain, rule_key}] (watched
 * ones); lists: actLists. Returns [{id, project}] for those whose project changes.
 */
function helperFills(blocks, lists, desk) {
  var helper = A.actLists(lists).helpers;
  function isHelper(b) {
    return b.category === 'work' && !b.rule_key &&
           A.actHelperHit(helper, { app: b.app, host: b.domain || '', phone: b.kind === 'phone' }) !== '';
  }
  var list = (blocks || []).filter(function (b) { return b && b.end > b.start && b.id; });
  var real = list.filter(function (b) { return isWorkBlock(b) && b.project && !isHelper(b); });
  var out = [];
  list.filter(isHelper).forEach(function (h) {
    var best = null;
    real.forEach(function (b) {
      if (b.device_id !== h.device_id) return;
      var gap = Math.max(0, b.start - h.end, h.start - b.end);
      if (gap > A.ACT_NEAR_MS) return;
      if (!best || gap < best.gap || (gap === best.gap && b.start < best.b.start)) best = { gap: gap, b: b };
    });
    // Item 30b: the desktop's project first (Terminal on the NeuraVue desktop is NeuraVue).
    var want = A.actPickProject({ desktop: h.desktop ? A.actDeskProject(h.desktop, desk) : '', near: best ? best.b.project : '' }).project;
    if (want !== (h.project || '')) out.push({ id: h.id, project: want });
  });
  return out;
}

/**
 * Item 30b: watched work and meeting blocks whose desktop stands for a project they do not carry yet
 * (a pair he added since, a project made since): [{id, project, category, was}]. Unclear, private
 * and distraction blocks are left alone. desk: {desktops, projects}.
 */
function desktopFills(blocks, desk) {
  var out = [];
  (blocks || []).forEach(function (b) {
    if (!b || !b.id || !b.desktop || (b.mode && b.mode !== 'work')) return;
    if (b.category !== 'work' && b.category !== 'meeting') return;
    var p = A.actDeskProject(b.desktop, desk);
    if (!p || p === b.project) return;
    out.push({ id: b.id, project: p, category: b.category, was: b.category });
  });
  return out;
}

/* ── Item 31a: the idle "Why?" and End day ───────────────────────────────── */

/** Does a question (kind 'idle', streak_start = its gap's start) stand for this gap? Later blocks may
 *  move a gap's start a little. */
function idleMatch(n, g) {
  return n.streak_start >= g.start - A.ACT_GLANCE_MS && n.streak_start < g.end;
}

/**
 * The idle questions and End day. d: {now, gaps (activity.js actJudge), nudges [{id, streak_start,
 * span_end, state}] (kind 'idle', ms), reasons (actIdleReasons), reported (every device seen lately has
 * reported up to here), ask (his switch), canPush, pushedToday ("Why?" pushes so far today, IDLE_PUSH_MAX), closes: his End-day rows (ms) at least APPLY_DELAY_MS
 * old, whether or not the day was started again since}. An idle gap of 15 minutes or more, over and
 * reported, is asked "Why?" (a prayer logged in it answers itself: no push); answered by any route, the
 * question closes; a gap later blocks filled is closed. Every gap before an End day is applied: a break
 * of 15 minutes or more is written (actJudgeSteps), an idle one unexplained is kept as "Idle" (or
 * "Prayer"), and its question is 'applied'. Returns {create: [{start, end, what, push}], decide: [{id,
 * state}], spans: [{id, end}], write: [{type, at, rid, text, detail}]}.
 */
function judgeStep(d) {
  var out = { create: [], decide: [], spans: [], write: [] };
  var gaps = d.gaps || [];
  var idle = gaps.filter(function (g) { return g.kind === 'idle' && g.ms >= A.ACT_BREAK_MS; });
  var nudges = d.nudges || [];
  var closes = d.closes || [];
  function inClose(g) { return closes.some(function (c) { return g.end <= c && g.start >= c - APPLY_BACK_MS; }); }
  nudges.forEach(function (n) {
    if (n.state !== 'pending') return;
    var g = idle.filter(function (x) { return idleMatch(n, x); })[0];
    if (!g) { out.decide.push({ id: n.id, state: 'closed' }); return; }
    if (A.actGapReason(g, d.reasons)) { out.decide.push({ id: n.id, state: 'answered' }); return; }
    if (inClose(g)) { out.decide.push({ id: n.id, state: 'applied' }); return; }
    if (g.end !== n.span_end) out.spans.push({ id: n.id, end: g.end });
  });
  if (d.ask !== false) {
    var budget = IDLE_PUSH_MAX - (Number(d.pushedToday) || 0);   // the rest wait in the sheet
    idle.forEach(function (g) {
      if (g.tail || g.end > d.reported || nudges.some(function (n) { return idleMatch(n, g); })) return;
      if (inClose(g)) return;                       // End day came first: applied below, nothing to ask
      var push = d.canPush === true && !g.prayer && g.end >= d.now - IDLE_FRESH_MS && budget > 0;
      if (push) budget -= 1;
      out.create.push({ start: g.start, end: g.end, what: g.prayer ? 'Prayer' : '', push: push });
    });
  }
  if (closes.length) {
    gaps.filter(inClose).forEach(function (g) {
      var r = g.kind === 'idle' ? A.actGapReason(g, d.reasons) : null;
      A.actJudgeSteps(g, r ? r.reason : '').forEach(function (w) { out.write.push(w); });
      if (g.kind === 'idle' && g.ms >= A.ACT_BREAK_MS && !r) {
        var why = g.prayer ? 'Prayer' : A.ACT_IDLE_DEFAULT;
        out.write.push({ type: 'actanswer', at: d.now, rid: 'jw-' + g.key + '-auto', detail: why,
                         text: 'Idle ' + Math.round(g.ms / MIN_MS) + ' min: ' + A.actIdleWord(why) + ' (auto — End day)' });
      }
    });
  }
  return out;
}

/** The End-day rows (type 'off': his, Sleep's at night, or the 11:30 check's) in [from, upTo], as ms. */
function dayCloses(rows, from, upTo) {
  return (rows || []).filter(function (r) { return r.type === 'off' && r.at >= from && r.at <= upTo; })
    .map(function (r) { return r.at; });
}

/** Item 31a: the "Why?" push. sw.js shows a watch-teach push with no buttons; a tap opens the sheet. */
function idlePayload(g, offsetMin) {
  return { kind: 'watch-teach', tag: 'probeing-watch-idle', goto: 'home',
           title: 'Away ' + Math.round((g.end - g.start) / MIN_MS) + ' min (' + clock12(g.start, offsetMin) + '–' +
                  clock12(g.end, offsetMin) + ') — why?',
           body: 'Tap to say: Prayer, Washroom, Walk, Chit-chat, Food or Other. No answer: "Idle (break)" at End day.' };
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
  const place = row ? { lat: row.lat, lng: row.lng, zone, method: row.method, asr: row.asr_school } : null;
  return { lists: A.actLists(row && row.activity_lists), on: !(row && row.activity_nudge === false),
           checks: !(row && row.activity_checks === false), zone, offset, place,
           teach: !(row && row.activity_teach === false),
           ignore: Array.isArray(row && row.activity_ignore) ? row.activity_ignore : [],
           desktops: A.actDeskPairs(row && row.activity_desktops) };
}

/** The first Fajr after t at his saved place (day.js: Isha's time ends at the next Fajr). */
function fajrAfterFn(set: Record<string, any>) {
  Day.setPrayerPlace(set.place);
  return (t: number) => {
    const off = Day.zoneOffsetMin(set.zone, t, set.offset);
    return Day.prayerEndOf('Isha', Day.prayerDate(t, off), off);
  };
}

/** Rows that move the clock or answer a push, oldest first, from `from`; led by the newest
 *  state rows before it (item 26), so a sleep or break older than the window is still known. */
async function readRows(sb: Sb, owner: string, from: number) {
  const before = must(await sb.from('events').select('at, type, rid, created_at').eq('user_id', owner)
    .lt('at', iso(from)).in('type', CARRY_TYPES).order('at', { ascending: false })
    .order('created_at', { ascending: false }).limit(CARRY_ROWS));
  const rows = must(await sb.from('events').select('at, type, rid, created_at').eq('user_id', owner)
    .gte('at', iso(from)).in('type', STATE_TYPES).order('at', { ascending: true })
    .order('created_at', { ascending: true }).limit(3000));
  return before.reverse().concat(rows);
}

/** Item 30b: Working on as the app has it (day.js replayDay over the session's rows), and his rows
 *  naming a project ({at, name}: work, voice, done), from `from`. */
async function readActive(sb: Sb, owner: string, from: number) {
  const rows = must(await sb.from('events').select('at, type, raw_text, project, detail, node_id, rid, created_at').eq('user_id', owner)
    .gte('at', iso(from)).in('type', Day.LEAD_TYPES).order('at', { ascending: false })
    .order('created_at', { ascending: false }).limit(3000));
  const active = (Day.replayDay(rows).activeProjects || []) as string[];
  const named = rows.filter((r) => r.type === 'work' || r.type === 'voice' || r.type === 'done')
    .map((r) => ({ at: ms(r.at), name: String(r.project || r.raw_text || '').trim() }));
  return { active, named };
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
                                                 minute: '2-digit', hour12: false, timeZone: zone });   // item 37
  } catch (_e) {
    return iso(t);
  }
}

/** One events row with a fixed rid; a repeat is the same row (23505). */
async function writeRow(sb: Sb, owner: string, zone: string, w: Record<string, any>) {
  const res = await sb.from('events').insert({
    user_id: owner, at: iso(w.at), local_time: humanLocal(w.at, zone), tz: zone, type: w.type,
    raw_text: w.text, project: w.project || '', detail: w.detail || '', rid: w.rid
  });
  if (res.error && res.error.code !== '23505') throw new Error(res.error.message);
  return !res.error;
}

function blockOf(r: Record<string, any>, kinds?: Record<string, string>) {
  return { id: r.id, device_id: r.device_id, start: ms(r.started_at), end: ms(r.ended_at), category: r.category,
           project: r.project || '', app: r.app || '', domain: r.domain || '', rule_key: r.rule_key || '',
           kind: (kinds && kinds[r.device_id]) || 'laptop', mode: r.mode || 'work', became: ms(r.became_at),
           desktop: r.desktop || '' };
}

/** Item 30a: a question's run as stored (gaps as ISO pairs) and back (ms). */
function runJson(r: Record<string, any>) {
  const parts = (p: unknown) => Array.isArray(p) ? p.map((x: any[]) => [iso(x[0]), String(x[1])]) : null;
  return { work_min: r.work_min, dist_min: r.dist_min, what: r.what,
           gaps: (r.gaps || []).map((g: any[]) => g.length > 2 && g[2] ? [iso(g[0]), iso(g[1]), parts(g[2])] : [iso(g[0]), iso(g[1])]),
           last: isFinite(r.last) && r.last !== null ? iso(r.last) : null, tail: parts(r.tail),
           project: String(r.project || ''), projects: (r.projects || []).map((p: any) => ({ name: String(p.name || ''), at: iso(p.at) })) };
}
function runOf(v: unknown) {
  const r = v && typeof v === 'object' ? v as Record<string, any> : null;
  if (!r) return null;
  const parts = (p: unknown) => Array.isArray(p) ? p.map((x: any) => [ms(x && x[0]), String((x && x[1]) || '')])
    .filter((x: any[]) => isFinite(x[0] as number)) : null;
  const gaps = (Array.isArray(r.gaps) ? r.gaps : []).map((g: any[]) => {
    const a = ms(g && g[0]);
    const z = ms(g && g[1]);
    const p = g && g.length > 2 ? parts(g[2]) : null;
    return p ? [a, z, p] : [a, z];
  }).filter((g: any[]) => isFinite(g[0]) && isFinite(g[1]) && g[1] > g[0]);
  const last = r.last ? ms(r.last) : NaN;
  const projects = (Array.isArray(r.projects) ? r.projects : []).map((p: any) => ({
    name: A.actCut(String((p && p.name) || '').trim(), A.ACT_PROJECT_MAX), at: ms(p && p.at) })).filter((p: any) => p.name && isFinite(p.at));
  return { work_min: Number(r.work_min) || 0, dist_min: Number(r.dist_min) || 0, what: String(r.what || 'distraction'), gaps,
           last: isFinite(last) ? last : null, tail: parts(r.tail), project: A.actCut(String(r.project || '').trim(), A.ACT_PROJECT_MAX),
           projects };
}

async function deviceKinds(sb: Sb, owner: string) {
  const kinds: Record<string, string> = {};
  must(await sb.from('watch_devices').select('id, kind').eq('user_id', owner).limit(50)).forEach((d) => { kinds[d.id] = d.kind; });
  return kinds;
}

function newNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fnUrl(req: Request): string {
  return String(Deno.env.get('SUPABASE_URL') || new URL(req.url).origin).replace(/\/+$/, '') + '/functions/v1/activity-ingest';
}

/** Item 23: the awake and back-to-work checks, and the disturbed nights, after an ingest. */
async function runQuiet(sb: Sb, owner: string, now: number, set: Record<string, any>, req: Request) {
  const rows = await readRows(sb, owner, now - READ_BACK_MS);
  const walk = A.actWalk(rows, now - READ_BACK_MS, now);
  const kinds = await deviceKinds(sb, owner);
  const blocks = must(await sb.from('activity_blocks').select('*').eq('user_id', owner)
    .gte('ended_at', iso(now - QUIET_BACK_MS)).order('started_at', { ascending: true }).limit(5000))
    .map((r) => blockOf(r, kinds));
  const clipped = labelClip(blocks, await teachLabelled(sb, owner, now - QUIET_BACK_MS));
  // Item 30a: before its SQL there is no `run` column; the checks run without it.
  // Item 31a: `pushes` (R6) comes with its SQL; before it "Up and working?" is asked once, as before.
  let cols = 'id, kind, device_id, streak_start, pushed_at, decided_at, state, ref_at, run, what, pushes';
  let probe = await sb.from('activity_nudges').select(cols).eq('user_id', owner).in('kind', ASK_KINDS)
    .gte('streak_start', iso(now - QUIET_BACK_MS)).limit(500);
  const hasPushes = !probe.error;
  if (!hasPushes) {
    cols = 'id, kind, device_id, streak_start, pushed_at, decided_at, state, ref_at, run, what';
    probe = await sb.from('activity_nudges').select(cols).eq('user_id', owner).in('kind', ASK_KINDS)
      .gte('streak_start', iso(now - QUIET_BACK_MS)).limit(500);
  }
  const hasRun = !(probe.error && /\brun\b|42703/.test(String(probe.error.message || '') + String(probe.error.code || '')));
  if (!hasRun) {
    cols = 'id, kind, device_id, streak_start, pushed_at, decided_at, state, ref_at, what';
    probe = await sb.from('activity_nudges').select(cols).eq('user_id', owner).in('kind', ASK_KINDS)
      .gte('streak_start', iso(now - QUIET_BACK_MS)).limit(500);
  }
  const recent = must(probe);
  // Item 26: a question still open, however old: it blocks a second one and is closed when he moves.
  const older = must(await sb.from('activity_nudges').select(cols)
    .eq('user_id', owner).in('kind', ASK_KINDS).eq('state', 'sent').limit(50));
  const seen: Record<string, boolean> = {};
  const nudges = recent.concat(older).filter((n) => !seen[n.id] && (seen[n.id] = true))
    .map((n) => ({ id: n.id, kind: n.kind, device_id: n.device_id, streak_start: ms(n.streak_start), pushed_at: ms(n.pushed_at),
                   decided_at: ms(n.decided_at), state: n.state, ref_at: ms(n.ref_at), run: runOf(n.run), what: n.what || '',
                   pushes: hasPushes ? Number(n.pushes) || 1 : NaN }));
  const fajrAfter = fajrAfterFn(set);
  // Item 30b: a run question names its project only when it is not in Working on.
  let active: string[] = [];
  try { active = (await readActive(sb, owner, now - READ_BACK_MS)).active; } catch (_e) { /* no project named */ }
  const step = quietStep({ now, walk, blocks: clipped, nudges, checks: set.checks, active,
                           rows: rows.map((r) => ({ at: ms(r.at), type: r.type, rid: r.rid || '' })),
                           nightEnd: (t: number, until: number) => nightEnd(t, fajrAfter, Day.zoneOffsetMin(set.zone, t, set.offset), until),
                           fajrAfter, offsetAt: (t: number) => Day.zoneOffsetMin(set.zone, t, set.offset) });
  const report: Record<string, unknown> = { decided: step.decide.length, pushed: [], nights: 0, wrote: step.write.length };
  // Item 31a: an applied recommendation's rows first, then the question is marked.
  for (const w of A.actSkipTies(step.write, rows)) await writeRow(sb, owner, set.zone, w);
  for (const d of step.decide) {
    await sb.from('activity_nudges').update({ state: d.state, decided_at: iso(now) }).eq('id', d.id).eq('user_id', owner);
  }
  // Item 31c: a closed question is not retired by a push ("Noted" showed as a new notification); the app closes it.
  // Item 30a: an open question's run, as it grew.
  for (const r of (hasRun ? step.runs : [])) {
    await sb.from('activity_nudges').update({ run: runJson(r.run) }).eq('id', r.id).eq('user_id', owner).eq('state', 'sent');
  }
  const anon = Deno.env.get('SUPABASE_ANON_KEY') || '';
  for (const p of step.push) {
    const nonce = newNonce();
    const claim = await sb.from('activity_nudges').insert({
      user_id: owner, device_id: p.device_id, kind: p.kind, ref_at: iso(p.ref), streak_start: iso(p.start), what: p.dev,
      pushed_at: iso(now), nonce_sha256: await sha256Hex(nonce), state: 'sent', ...(hasRun ? { run: p.run ? runJson(p.run) : null } : {})
    }).select('id');
    if (claim.error) continue;                       // another run claimed this one (one open per sleep or break)
    const id = String((claim.data || [])[0]?.id || '');
    // A use that ended long ago is asked in the app's sheet only; one no device got waits there too.
    if (!p.push) { (report.pushed as unknown[]).push({ kind: p.kind, sheetOnly: true }); continue; }
    const sent = await pushAll(sb, owner, JSON.stringify(askPayload(p, id, nonce, fnUrl(req), anon, set.offset)),
                               { ttl: 1800, topic: 'probeing-watch-ask', urgency: 'high' });
    (report.pushed as unknown[]).push({ kind: p.kind, ...sent });
  }
  // Item 31a, R6: "Up and working?" again, claimed first so two devices' runs push it once.
  for (const r of (hasPushes ? step.repush : [])) {
    const nonce = newNonce();
    const mark = await sb.from('activity_nudges').update({ pushes: r.pushes + 1, pushed_at: iso(now), nonce_sha256: await sha256Hex(nonce) })
      .eq('id', r.id).eq('user_id', owner).eq('state', 'sent').eq('pushes', r.pushes).select('id');
    if (mark.error || !(mark.data || []).length) continue;
    const sent = await pushAll(sb, owner, JSON.stringify(askPayload(r.p, r.id, nonce, fnUrl(req), anon, set.offset)),
                               { ttl: 1800, topic: 'probeing-watch-ask', urgency: 'high' });
    (report.pushed as unknown[]).push({ kind: 'upwork', again: r.pushes + 1, ...sent });
  }
  for (const n of step.nights) {
    if (n.minutes > 0) {
      const up = await sb.from('activity_nights').upsert({
        user_id: owner, sleep_at: iso(n.sleep_at), woke_at: n.woke_at === null ? null : iso(n.woke_at), fajr_at: iso(n.fajr_at),
        first_at: iso(n.first_at), last_at: iso(n.last_at), minutes: n.minutes, kinds: n.kinds, updated_at: iso(now)
      }, { onConflict: 'user_id,sleep_at' });
      if (up.error) throw new Error(up.error.message);
      report.nights = Number(report.nights) + 1;
    } else {
      // A wake moved earlier, or a run now counts as brief: the night is not disturbed after all.
      await sb.from('activity_nights').delete().eq('user_id', owner).eq('sleep_at', iso(n.sleep_at));
    }
  }
  return report;
}

/** Item 29: today's unsorted names, the question about one, its push; today's blocks filed
 *  again by name once the lists or rules place them. */
async function runTeach(sb: Sb, owner: string, now: number, set: Record<string, any>) {
  const fajrAfter = fajrAfterFn(set);
  const off = Day.zoneOffsetMin(set.zone, now, set.offset);
  const dayStart = Day.counterDayStart(now, off);
  const kinds = await deviceKinds(sb, owner);
  const blocks = must(await sb.from('activity_blocks').select('id, device_id, started_at, ended_at, app, domain, category, mode')
    .eq('user_id', owner).eq('mode', 'work').eq('category', 'unclear').gte('ended_at', iso(dayStart))
    .order('started_at', { ascending: true }).limit(5000))
    .map((r) => ({ id: r.id, start: Math.max(ms(r.started_at), dayStart), end: ms(r.ended_at), app: r.app || '',
                   domain: r.domain || '', category: r.category, project: '', mode: r.mode, kind: kinds[r.device_id] || 'laptop' }));
  const fixRows = must(await sb.from('events').select('at, type, detail, project').eq('user_id', owner)
    .eq('type', A.ACT_FIX_TYPE).gte('at', iso(dayStart - 86400000)).order('at', { ascending: true }).limit(2000));
  const { projects, rules } = await readProjects(sb, owner, now);
  const cfg = { lists: set.lists, rules: rules.map((r) => ({ keyword: r.keyword, project: r.project })), projects };
  const report: Record<string, unknown> = { filed: 0 };
  // Filed again by name: an answer, Teach or a Lists edit counts from today's first minute.
  for (const f of teachFixes(blocks, cfg)) {
    // became_at: the checks count the new label from now, never back (item 29 fix).
    const patch: Record<string, unknown> = { category: f.category, project: f.project, rule_key: f.key, updated_at: iso(now),
                                            became_at: iso(now) };
    if (f.category === 'private') patch.domain = '';
    for (let i = 0; i < f.ids.length; i += TEACH_FIX_CHUNK) {
      const up = await sb.from('activity_blocks').update(patch).eq('user_id', owner).eq('category', 'unclear')
        .in('id', f.ids.slice(i, i + TEACH_FIX_CHUNK));
      if (up.error) throw new Error(up.error.message);
    }
    report.filed = Number(report.filed) + f.ids.length;
  }
  const list = A.actTeachList(blocks, A.actFixMap(fixRows), cfg, set.ignore);
  const cols = 'id, entry, what, state, streak_start, pushed_at';
  const open = must(await sb.from('activity_nudges').select(cols).eq('user_id', owner).eq('kind', 'teach')
    .eq('state', 'asking').limit(10));
  const today = must(await sb.from('activity_nudges').select(cols).eq('user_id', owner).eq('kind', 'teach')
    .gte('streak_start', iso(dayStart)).limit(200));
  const seen: Record<string, boolean> = {};
  const nudges = open.concat(today).filter((n) => !seen[n.id] && (seen[n.id] = true))
    .map((n) => ({ id: n.id, entry: String(n.entry || ''), what: String(n.what || ''), state: n.state,
                   streak_start: ms(n.streak_start), pushed_at: ms(n.pushed_at) }));
  const walk = A.actWalk(await readRows(sb, owner, now - READ_BACK_MS), now - READ_BACK_MS, now);
  const canPush = !walk.asleep && !nightNow(now, off, fajrAfter);
  const step = teachStep({ dayStart, on: set.teach, canPush, list, nudges });
  for (const d of step.decide) {
    await sb.from('activity_nudges').update({ state: d.state, decided_at: iso(now) }).eq('id', d.id).eq('user_id', owner);
  }
  await blankPrivate(sb, owner, nudges, cfg);
  let id = step.push && step.push !== 'new' ? step.push : '';
  let ask = null as { label: string; ms: number; site: boolean } | null;
  if (step.ask) {
    // One open question (activity_nudges_open_teach_idx) and one per name a day: a second run loses here.
    const claim = await sb.from('activity_nudges').insert({
      user_id: owner, device_id: null, kind: 'teach', ref_at: iso(dayStart), streak_start: iso(dayStart),
      what: A.actCut(step.ask.label, 80), entry: step.ask.entry, entry_min: Math.round(step.ask.ms / MIN_MS), state: 'asking'
    }).select('id');
    if (claim.error) return Object.assign(report, { asked: false });
    report.asked = true;
    if (step.push === 'new') id = String((claim.data || [])[0]?.id || '');
    ask = { label: step.ask.label, ms: step.ask.ms, site: step.ask.site };
  } else if (id) {
    const o = nudges.filter((n) => n.id === id)[0];
    const l = list.filter((r: Record<string, any>) => o && r.entry === o.entry)[0];
    if (l) ask = { label: l.label, ms: l.ms, site: l.site === true };
  }
  if (id && ask) {
    // Claimed before it is sent, so two devices' runs cannot both push it.
    const mark = await sb.from('activity_nudges').update({ pushed_at: iso(now) }).eq('id', id).eq('user_id', owner)
      .is('pushed_at', null).select('id');
    if (!mark.error && (mark.data || []).length) {
      const sent = await pushAll(sb, owner, JSON.stringify(teachPayload(ask.label, ask.ms, ask.site)),
                                 { ttl: 3600, topic: 'probeing-watch-teach', urgency: 'normal' });
      // Delivered nowhere: not counted, so a later run may try again.
      if (!sent.sent) await sb.from('activity_nudges').update({ pushed_at: null }).eq('id', id).eq('user_id', owner);
      report.pushed = sent.sent;
    }
  }
  return report;
}

/** Item 29 fix: entry -> when the server saw the answer, for the "what is" questions answered since `from`. */
async function teachLabelled(sb: Sb, owner: string, from: number) {
  const out: Record<string, number> = Object.create(null);
  must(await sb.from('activity_nudges').select('entry, decided_at').eq('user_id', owner).eq('kind', 'teach')
    .eq('state', 'answered').gte('decided_at', iso(from)).limit(500))
    .forEach((n) => { if (n.entry) out[n.entry] = Math.max(out[n.entry] || 0, ms(n.decided_at)); });
  return out;
}

/** Item 29 fix: a name now on his private list leaves no trace on its question rows, any day. */
async function blankPrivate(sb: Sb, owner: string, rows: Record<string, any>[], cfg: Record<string, any>) {
  const done: Record<string, boolean> = {};
  for (const n of rows) {
    if (!teachPrivate(n, cfg) || done[n.entry]) continue;
    done[n.entry] = true;
    await sb.from('activity_nudges').update({ what: '', entry: '' }).eq('user_id', owner).eq('kind', 'teach').eq('entry', n.entry);
  }
}

/** Item 29 fix: an open question whose name he has sorted (the sheet, Teach, Lists) closes on any
 *  call, so no device asks it again. One read when nothing is open. */
async function closeSortedTeach(sb: Sb, owner: string, now: number, set?: Record<string, any>) {
  const open = must(await sb.from('activity_nudges').select('id, entry, what').eq('user_id', owner).eq('kind', 'teach')
    .eq('state', 'asking').limit(10));
  if (!open.length) return 0;
  const s = set || await readSettings(sb, owner, now);
  const { projects, rules } = await readProjects(sb, owner, now);
  const cfg = { lists: s.lists, rules: rules.map((r) => ({ keyword: r.keyword, project: r.project })), projects };
  let closed = 0;
  for (const q of open) {
    if (!A.actTeachSorted(q, cfg, s.ignore)) continue;
    await sb.from('activity_nudges').update({ state: 'answered', decided_at: iso(now) }).eq('id', q.id).eq('user_id', owner)
      .eq('state', 'asking');
    closed += 1;
  }
  await blankPrivate(sb, owner, open, cfg);
  return closed;
}

/** Item 30a: helpers take the project of the work around them; the last HELPER_BACK_MS, filed again each run.
 *  Item 30b: first, blocks take their desktop's project (a pair or a project made since they came). */
async function runHelpers(sb: Sb, owner: string, now: number, set: Record<string, any>) {
  const kinds = await deviceKinds(sb, owner);
  // '*': before the item 30b SQL there is no desktop column, and nothing to file by it.
  const blocks = must(await sb.from('activity_blocks').select('*')
    .eq('user_id', owner).eq('mode', 'work').gte('ended_at', iso(now - HELPER_BACK_MS))
    .order('started_at', { ascending: true }).limit(2000)).map((r) => blockOf(r, kinds));
  let desk = { desktops: set.desktops || [], projects: [] as string[] };
  let moved = 0;
  if (blocks.some((b) => b.desktop)) {
    desk = { desktops: set.desktops || [], projects: (await readProjects(sb, owner, now)).projects };
    for (const f of desktopFills(blocks, desk)) {
      // A category it did not have counts from now (item 29 fix: a label never reaches back).
      const patch: Record<string, unknown> = { project: f.project, updated_at: iso(now) };
      if (f.category !== f.was) { patch.category = f.category; patch.became_at = iso(now); }
      const up = await sb.from('activity_blocks').update(patch).eq('id', f.id).eq('user_id', owner).eq('category', f.was);
      if (up.error) throw new Error(up.error.message);
      blocks.forEach((b) => { if (b.id === f.id) { b.project = f.project; b.category = f.category; } });
      moved += 1;
    }
  }
  const fills = helperFills(blocks, set.lists, desk);
  for (const f of fills) {
    const up = await sb.from('activity_blocks').update({ project: f.project, updated_at: iso(now) })
      .eq('id', f.id).eq('user_id', owner).eq('category', 'work').eq('rule_key', '');
    if (up.error) throw new Error(up.error.message);
  }
  return { filled: fills.length, desktops: moved };
}

/** Item 30b: auto-detected Working on. Questions only (kind 'auto'), never a push or a row of his. */
async function runAuto(sb: Sb, owner: string, now: number, set: Record<string, any>) {
  const cols = 'id, kind, device_id, streak_start, pushed_at, decided_at, state, ref_at, run';
  const nudges = must(await sb.from('activity_nudges').select(cols).eq('user_id', owner).eq('kind', 'auto')
    .gte('streak_start', iso(now - READ_BACK_MS)).limit(300))
    .map((n) => ({ id: n.id, kind: n.kind, device_id: n.device_id, streak_start: ms(n.streak_start), pushed_at: ms(n.pushed_at),
                   decided_at: ms(n.decided_at), state: n.state, ref_at: ms(n.ref_at), run: runOf(n.run) }));
  const rows = await readRows(sb, owner, now - READ_BACK_MS);
  const walk = A.actWalk(rows, now - READ_BACK_MS, now);
  if (!walk.working && !nudges.some((n) => n.state === 'sent')) return { asked: false };
  const { active, named } = await readActive(sb, owner, now - READ_BACK_MS);
  const kinds = await deviceKinds(sb, owner);
  const blocks = must(await sb.from('activity_blocks').select('*').eq('user_id', owner).eq('mode', 'work')
    .gte('ended_at', iso(now - READ_BACK_MS)).order('started_at', { ascending: true }).limit(5000)).map((r) => blockOf(r, kinds));
  const clipped = labelClip(blocks, await teachLabelled(sb, owner, now - READ_BACK_MS));
  const step = autoStep({ now, walk, blocks: clipped, nudges, named, active, checks: set.checks,
                          rows: rows.map((r) => ({ at: ms(r.at), type: r.type, rid: r.rid || '' })) });
  for (const d of step.decide) {
    await sb.from('activity_nudges').update({ state: d.state, decided_at: iso(now) }).eq('id', d.id).eq('user_id', owner).eq('state', 'sent');
  }
  for (const r of step.runs) {
    await sb.from('activity_nudges').update({ run: runJson(r.run) }).eq('id', r.id).eq('user_id', owner).eq('state', 'sent');
  }
  // Item 36 (Saad, 28 Oct): an open one 30 minutes on is pushed once, to the laptop only.
  for (const n of nudges) {
    if (n.state !== 'sent' || isFinite(n.pushed_at) || !n.run || !(n.run.work_min >= AUTO_PUSH_MIN) || set.checks === false) continue;
    const mark = await sb.from('activity_nudges').update({ pushed_at: iso(now) }).eq('id', n.id).eq('user_id', owner)
      .eq('state', 'sent').is('pushed_at', null).select('id');
    if (mark.error || !(mark.data || []).length) continue;
    await pushAll(sb, owner, JSON.stringify(autoPayload(n.run, active)), { ttl: 3600, topic: 'probeing-watch-teach', urgency: 'normal' }, '', 'Laptop');
  }
  let asked = false;
  if (step.ask) {
    // One open at a time (activity_nudges_open_auto_idx): a second run loses here.
    const claim = await sb.from('activity_nudges').insert({
      user_id: owner, device_id: step.ask.device_id || null, kind: 'auto', ref_at: iso(step.ask.ref), streak_start: iso(step.ask.start),
      what: step.ask.dev, state: 'sent', run: runJson(step.ask.run)
    }).select('id');
    asked = !claim.error;
  }
  return { decided: step.decide.length, asked };
}

/** Item 31a: the day judged (activity.js actSignals -> actJudge), recounted from yesterday's counter day:
 *  the records (activity_focus), the idle "Why?" questions and their push, and End day's applied
 *  recommendations. Replaces item 30a's slips and focus losses. */
async function runJudge(sb: Sb, owner: string, now: number, set: Record<string, any>) {
  const offAt = (t: number) => Day.zoneOffsetMin(set.zone, t, set.offset);
  const keepFrom = Day.counterDayStart(now - FOCUS_BACK_MS, offAt(now - FOCUS_BACK_MS));
  const from = keepFrom - 2 * 3600000;
  const rows = await readRows(sb, owner, from);
  const mine = rows.map((r) => ({ at: ms(r.at), type: r.type, rid: r.rid || '' }));
  const walk = A.actWalk(rows, from, now);
  const domain = A.actJudgeDomain(rows, from, now);
  const kinds = await deviceKinds(sb, owner);
  // Every mode: a bare block (written after a break of his began, item 23) still says what the time was.
  const blocks = must(await sb.from('activity_blocks').select('*').eq('user_id', owner)
    .gte('ended_at', iso(from)).order('started_at', { ascending: true }).limit(5000)).map((r) => blockOf(r, kinds));
  // As the blocks are now: the judgement looks back (End day, the records), so a label given later counts
  // from the start (unlike the live checks' labelClip, which never act on time before a label).
  const extra = must(await sb.from('events').select('at, type, rid, detail, project').eq('user_id', owner)
    .in('type', ['prayer', 'actanswer', 'actfix']).gte('at', iso(from - 86400000)).order('at', { ascending: true }).limit(3000));
  // His corrections in the sheet (actfix) count here as they do in the sheet.
  const fixes = A.actFixMap(extra.filter((r) => r.type === 'actfix'));
  // Item 36: a distraction or private app he said was work.
  const said = must(await sb.from('activity_nudges').select('device_id, streak_start').eq('user_id', owner).eq('kind', 'distract')
    .eq('state', 'working').gte('streak_start', iso(from)).limit(300)).map((n) => ({ device_id: n.device_id, start: ms(n.streak_start) }));
  const clipped = A.actClip(workedThrough(blocks.map((b) => A.actFixed(b, fixes)), said), domain);
  const prayers = extra.filter((r) => r.type === 'prayer').map((r) => ms(r.at));
  const reasons = A.actIdleReasons(extra.filter((r) => /^jw-/.test(String(r.rid || ''))));
  const signals = A.actSignals(clipped, domain);
  const gaps = A.actJudge({ signals, spans: domain, work: walk.work, prayers, rows });
  const recs = A.actJudgeRecords(gaps, { dayOf: (t: number) => Day.counterDate(t, offAt(t)), keepFrom, reasons, signals });
  const report: Record<string, unknown> = { kept: recs.length, dropped: 0 };
  const want: Record<string, boolean> = {};
  if (recs.length) {
    const toRow = (r: Record<string, any>) => ({ user_id: owner, tier: r.tier, start_at: iso(r.start), end_at: iso(r.end), day: r.day,
                                                 minutes: r.minutes, what: r.what, updated_at: iso(now) });
    let kept = recs;
    let up = await sb.from('activity_focus').upsert(kept.map(toRow), { onConflict: 'user_id,tier,start_at' });
    // Before the item 31ab SQL only item 30a's tiers are allowed: keep those.
    if (up.error && /23514|check/i.test(String(up.error.code || '') + String(up.error.message || ''))) {
      kept = recs.filter((r: Record<string, any>) => ['slip', 'loss', 'stretch'].indexOf(r.tier) !== -1);
      up = kept.length ? await sb.from('activity_focus').upsert(kept.map(toRow), { onConflict: 'user_id,tier,start_at' }) : up;
      if (!kept.length) up = { error: null } as typeof up;
    }
    if (up.error) throw new Error(up.error.message);
    kept.forEach((r: Record<string, any>) => { want[r.tier + '|' + r.start] = true; });
    report.kept = kept.length;
  }
  // A record the gaps no longer make (a later block, a label, an applied break): gone.
  const have = must(await sb.from('activity_focus').select('tier, start_at').eq('user_id', owner).gte('start_at', iso(keepFrom)).limit(2000));
  for (const h of have) {
    if (want[h.tier + '|' + ms(h.start_at)]) continue;
    await sb.from('activity_focus').delete().eq('user_id', owner).eq('tier', h.tier).eq('start_at', h.start_at);
    report.dropped = Number(report.dropped) + 1;
  }

  // The idle questions; before the item 31ab SQL kind 'idle' is refused and nothing is asked.
  const probe = await sb.from('activity_nudges').select('id, streak_start, span_end, state, pushed_at').eq('user_id', owner).eq('kind', 'idle')
    .gte('streak_start', iso(from)).limit(300);
  if (probe.error) return Object.assign(report, { idle: 'no table' });
  const nudges = must(probe).map((n) => ({ id: n.id, streak_start: ms(n.streak_start), span_end: ms(n.span_end), state: n.state }));
  const dayFrom = Day.counterDayStart(now, offAt(now));
  const pushedToday = must(probe).filter((n) => ms(n.pushed_at) >= dayFrom).length;
  const seen = must(await sb.from('watch_devices').select('last_seen_at').eq('user_id', owner).limit(50))
    .map((x) => ms(x.last_seen_at)).filter((t) => isFinite(t) && t >= now - IDLE_SEEN_MS);
  const reported = seen.length ? Math.min(...seen) - 2 * MIN_MS : -Infinity;
  const fajrAfter = fajrAfterFn(set);
  const canPush = !walk.asleep && !nightNow(now, offAt(now), fajrAfter);
  const closes = dayCloses(mine, from, now - APPLY_DELAY_MS);
  const step = judgeStep({ now, gaps, nudges, reasons, reported, ask: set.checks, canPush, closes, pushedToday });
  // A rid already in the table is never written again: applied once per gap part.
  const written = new Set(rows.map((r) => String(r.rid || '')));
  for (const w of A.actSkipTies(step.write, rows)) if (!written.has(w.rid)) await writeRow(sb, owner, set.zone, w);
  for (const dd of step.decide) {
    await sb.from('activity_nudges').update({ state: dd.state, decided_at: iso(now) }).eq('id', dd.id).eq('user_id', owner).eq('state', 'pending');
  }
  for (const sp of step.spans) {
    await sb.from('activity_nudges').update({ span_end: iso(sp.end) }).eq('id', sp.id).eq('user_id', owner).eq('state', 'pending');
  }
  let pushed = 0;
  for (const c of step.create) {
    // One question per gap (activity_nudges_idle_gap_idx): a second run loses here.
    const claim = await sb.from('activity_nudges').insert({
      user_id: owner, device_id: null, kind: 'idle', ref_at: iso(c.start), streak_start: iso(c.start), span_end: iso(c.end),
      what: c.what, state: 'pending', pushed_at: c.push ? iso(now) : null
    }).select('id');
    // A refusal other than "already asked" (23505) is said in the reply; the next run tries again.
    if (claim.error && claim.error.code !== '23505') report.idleError = String(claim.error.message || claim.error.code);
    if (claim.error || !c.push) continue;
    const sent = await pushAll(sb, owner, JSON.stringify(idlePayload(c, offAt(c.start))),
                               { ttl: 3600, topic: 'probeing-watch-teach', urgency: 'normal' });
    pushed += sent.sent ? 1 : 0;
  }
  return Object.assign(report, { asked: step.create.length, pushed, wrote: step.write.length, closes: closes.length });
}

/** The distraction check after an ingest: decisions, rows, pushes. */
async function runNudges(sb: Sb, owner: string, now: number, set: Record<string, any>, req: Request) {
  const rows = (await readRows(sb, owner, now - READ_BACK_MS));
  const walk = A.actWalk(rows, now - READ_BACK_MS, now);
  const kinds = await deviceKinds(sb, owner);
  // Only fully watched blocks: a bare one (asleep, a break) is item 23's.
  const blocks = must(await sb.from('activity_blocks').select('*').eq('user_id', owner)
    .gte('ended_at', iso(now - 6 * 3600000)).order('started_at', { ascending: true }).limit(2000))
    .map((r) => blockOf(r, kinds)).filter((b) => b.mode === 'work');
  const clipped = labelClip(blocks, await teachLabelled(sb, owner, now - 6 * 3600000));
  const nudgeRows = must(await sb.from('activity_nudges').select('id, device_id, streak_start, pushed_at, state, span_end')
    .eq('user_id', owner).eq('kind', 'distract').gte('streak_start', iso(now - 12 * 3600000)).limit(500));
  const nudges = nudgeRows.map((n) => ({ id: n.id, device_id: n.device_id, streak_start: ms(n.streak_start),
                                         pushed_at: ms(n.pushed_at), state: n.state }));
  const step = nudgeStep({ now, on: set.on, walk, blocks: clipped, nudges,
                           rows: rows.map((r) => ({ at: ms(r.at), type: r.type, rid: r.rid || '' })) });
  const report: Record<string, unknown> = { decided: step.decide.length, wrote: [], pushed: [] };

  // A backdated row never lands on an instant one of his own state rows already decides.
  for (const w of A.actSkipTies(step.write, rows)) {
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

/** The spans the devices may watch, from `from` to now: watch (whole) and quiet (bare: asleep,
 *  a break, item 23; awake with the day off, item 28). */
async function watchSpans(sb: Sb, owner: string, from: number, now: number) {
  const rows = await readRows(sb, owner, from - READ_BACK_MS);
  const walk = A.actWalk(rows, from, now);
  // Item 36: awake with the day off is watched whole (named); asleep and breaks stay bare.
  const quiet = (walk.sleep || []).concat(walk.rest || []);
  return { walk, spans: A.actMergeSpans((walk.watch || []).concat(walk.awakeOff || [])) as number[][], quiet: A.actMergeSpans(quiet) as number[][] };
}

async function opConfig(sb: Sb, dev: Record<string, any>, body: Record<string, any>, now: number) {
  const set = await readSettings(sb, dev.user_id, now);
  let from = ms(body.from);
  if (!isFinite(from) || from < now - CONFIG_BACK_MS) from = now - CONFIG_BACK_MS;
  const { walk, spans, quiet } = await watchSpans(sb, dev.user_id, Math.min(from, now), now);
  // The day is over (End day, Sleep): a distraction push still waiting is closed, never turned into a break.
  if (walk.closed) {
    await sb.from('activity_nudges').update({ state: 'closed', decided_at: iso(now) })
      .eq('user_id', dev.user_id).eq('kind', 'distract').eq('state', 'sent');
  }
  const { projects, rules } = await readProjects(sb, dev.user_id, now);
  try { await closeSortedTeach(sb, dev.user_id, now, set); } catch (_e) { /* the next call tries again */ }
  return reply(200, { ok: true, device: dev.label, now: iso(now), lists: set.lists, projects, desktops: set.desktops,
                      rules: rules.filter((r) => r.source !== 'gemini').map((r) => ({ keyword: r.keyword, project: r.project })),
                      spans: spans.map((s) => [iso(s[0]), iso(s[1])]), working: walk.working,
                      quiet: quiet.map((s) => [iso(s[0]), iso(s[1])]), mode: modeOf(walk),
                      autoBreak: Boolean(walk.autoBreak) });
}

/** Item 27: the tray's dot and tooltip; the words are glance-refresh's. Its only write: closing a
 *  "what is" question he has sorted (item 29 fix). */
async function opGlance(sb: Sb, dev: Record<string, any>, now: number) {
  try { await closeSortedTeach(sb, dev.user_id, now); } catch (_e) { /* the next call tries again */ }
  const { walk } = await watchSpans(sb, dev.user_id, now, now);
  const g = must(await sb.from('glance').select('title, body, as_of').eq('user_id', dev.user_id).limit(1))[0] || null;
  const word: Record<string, string> = { work: 'working', sleep: 'asleep', break: 'break', off: 'off' };
  return reply(200, { ok: true, state: word[modeOf(walk)] || 'off', title: g ? String(g.title || '') : '',
                      body: g ? String(g.body || '') : '', as_of: g ? g.as_of : null });
}

async function opIngest(sb: Sb, dev: Record<string, any>, body: Record<string, any>, now: number, req: Request) {
  const list = Array.isArray(body.blocks) ? body.blocks : [];
  if (list.length > INGEST_MAX) return reply(413, { ok: false, error: 'at most ' + INGEST_MAX + ' blocks a call' });
  const set = await readSettings(sb, dev.user_id, now);
  const clean = list.map((b: unknown) => A.actSanitize(b, set.lists, now)).filter(Boolean);
  let stored = 0;
  if (clean.length) {
    const from = Math.min(...clean.map((b: any) => b.start));
    const { walk } = await watchSpans(sb, dev.user_id, from, now);
    // Cut again here by the server's own clock: whole while watched, bare asleep or on a break.
    const pieces = keptPieces(clean, walk);
    if (pieces.length) {
      const had: Record<string, any> = {};
      must(await sb.from('activity_blocks').select('*').eq('device_id', dev.id)
        .in('started_at', pieces.map((p: any) => iso(p.start))).limit(1000))
        .forEach((r) => { had[String(ms(r.started_at))] = blockOf(r); });
      // Item 30b: before its SQL there is no desktop column; the blocks are stored without it.
      const deskCol = !(await sb.from('activity_blocks').select('desktop').limit(1)).error;
      const rows = pieces.map((p: any) => {
        const b = p.mode === 'work' || p.mode === 'off' ? keepPlaced(p, had[String(p.start)]) : p;
        // A category it did not have before counts from now (item 29 fix): kept while it stays.
        const h = had[String(p.start)];
        const became = h && h.category !== b.category ? now : h && isFinite(h.became) ? h.became : NaN;
        return { user_id: dev.user_id, device_id: dev.id, started_at: iso(b.start), ended_at: iso(b.end), app: b.app,
                 domain: b.domain, category: b.category, project: b.project, rule_key: b.key, mode: p.mode,
                 updated_at: iso(now), became_at: isFinite(became) ? iso(became) : null,
                 ...(deskCol ? { desktop: (p.mode === 'work' || p.mode === 'off') && b.category !== 'private' ? (b.desktop || '') : '' } : {}) };
      });
      const up = await sb.from('activity_blocks').upsert(rows, { onConflict: 'device_id,started_at' });
      if (up.error) return reply(500, { ok: false, error: up.error.message });
      stored = rows.length;
    }
  }
  // Item 29 first: today's blocks it files again count for the checks below.
  let teach: Record<string, unknown> = {};
  try {
    teach = await runTeach(sb, dev.user_id, now, set);
  } catch (e) {
    teach = { error: String((e as Error)?.message || e) };
  }
  // Item 30a: helpers' projects, before anything reads the blocks.
  let helpers: Record<string, unknown> = {};
  try {
    helpers = await runHelpers(sb, dev.user_id, now, set);
  } catch (e) {
    helpers = { error: String((e as Error)?.message || e) };
  }
  let nudges: Record<string, unknown> = {};
  try {
    nudges = await runNudges(sb, dev.user_id, now, set, req);
  } catch (e) {
    nudges = { error: String((e as Error)?.message || e) };
  }
  let quiet: Record<string, unknown> = {};
  try {
    quiet = await runQuiet(sb, dev.user_id, now, set, req);
  } catch (e) {
    quiet = { error: String((e as Error)?.message || e) };
  }
  let focus: Record<string, unknown> = {};
  try {
    focus = await runJudge(sb, dev.user_id, now, set);
  } catch (e) {
    focus = { error: String((e as Error)?.message || e) };
  }
  // Item 30b: before its SQL the kind 'auto' is refused, so nothing is asked; the rest ran.
  let auto: Record<string, unknown> = {};
  try {
    auto = await runAuto(sb, dev.user_id, now, set);
  } catch (e) {
    auto = { error: String((e as Error)?.message || e) };
  }
  return reply(200, { ok: true, stored, skipped: list.length - clean.length, nudges, quiet, teach, helpers, focus, auto });
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
  // A title goes to Gemini only while he is working now (item 23): never asleep, on a break or after End day.
  if (!(await watchSpans(sb, owner, now, now)).walk.working) return reply(200, { ok: true, act: 'paused', results: [] });
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
  const results = readClassify(g.text, items, projects);
  for (const r of results) {
    const it = items.filter((x) => x.key === r.key)[0];
    if (it && it.blocks.length) {
      await sb.from('activity_blocks').update({ category: 'work', project: r.project, rule_key: '', updated_at: iso(now) })
        .eq('device_id', dev.id).eq('category', 'unclear').in('started_at', it.blocks.map(iso));
    }
  }
  return reply(200, { ok: true, act: 'filed', calls: 1, model,
                      results: results.map((r) => ({ key: r.key, project: r.project })) });
}

/** Item 23: I'm awake / Still asleep, Resume / It was a break; item 28: Start day / Just awake,
 *  Start / Not work. Open only while he is still in the state it asked about; late, "That one's over". */
/** Item 30a fix: the plan an answer writes, from every device's blocks since the use began. */
async function answerPlan(sb: Sb, owner: string, ask: Record<string, any>, choice: string, now: number) {
  const kinds = await deviceKinds(sb, owner);
  const blocks = must(await sb.from('activity_blocks').select('*').eq('user_id', owner).gte('ended_at', iso(ask.streak_start))
    .order('started_at', { ascending: true }).limit(5000)).map((r) => blockOf(r, kinds));
  const clipped = labelClip(blocks, await teachLabelled(sb, owner, ask.streak_start));
  const from = ask.kind === 'upwork' && choice === 'start' ? askAt(ask) + 1000 : askAt(ask);
  return A.actRunPlan(clipped, from, now);
}

async function answerAsk(sb: Sb, n: Record<string, any>, choice: string, set: Record<string, any>, now: number) {
  const ok = ASK_CHOICES[n.kind] || [];
  if (ok.indexOf(choice) === -1) return reply(400, { ok: false, error: 'not an answer to this check' });
  const ask = { id: n.id, kind: n.kind, streak_start: ms(n.streak_start), ref_at: ms(n.ref_at), run: runOf(n.run) };
  const rows = await readRows(sb, n.user_id, now - READ_BACK_MS);
  const walk = A.actWalk(rows, now - READ_BACK_MS, now);
  const mine = rows.map((r) => ({ at: ms(r.at), type: r.type, rid: r.rid || '' }));
  if (n.state !== 'sent' || !askOpen(ask, walk, mine)) return reply(200, { ok: true, over: true, message: 'That one\'s over' });
  // Item 30a fix: the breaks from every block known now, not the run as it was when last stored.
  if (choice === 'start' || choice === 'resume') {
    // Item 30b: the project the question named stays named.
    const project = ask.run ? ask.run.project : '';
    const projects = ask.run ? ask.run.projects : [];         // item 36: every project it named
    try { ask.run = Object.assign(await answerPlan(sb, n.user_id, ask, choice, now), { project, projects }); } catch (_e) { /* the stored plan */ }
  }
  for (const w of A.actSkipTies(askRows(ask, choice, now), rows)) await writeRow(sb, n.user_id, set.zone, w);
  const state = choice === 'start' ? 'started' : choice === 'resume' ? 'resumed' : choice === 'awake' ? 'awake'
              : NA_STATE[n.kind];
  await sb.from('activity_nudges').update({ state, decided_at: iso(now) }).eq('id', n.id);
  // Item 31c: no "Noted" push to the other devices; each app closes its copy when it next opens.
  return reply(200, { ok: true, state });
}

/** A push's button, from sw.js. The nonce is the credential. */
async function opAnswer(sb: Sb, ans: Record<string, any>, now: number) {
  const id = String(ans.id || '');
  const nonce = String(ans.nonce || '');
  const said = ['break', 'working', 'awake', 'asleep', 'resume', 'start', 'notwork'].indexOf(String(ans.choice)) !== -1
    ? String(ans.choice) : '';
  if (!UUID.test(id) || !nonce || !said) return reply(401, { ok: false, error: 'not a check of yours' });
  const n = must(await sb.from('activity_nudges').select('*').eq('id', id).limit(1))[0];
  if (!n || !n.nonce_sha256 || (await sha256Hex(nonce)) !== n.nonce_sha256) {
    return reply(401, { ok: false, error: 'not a check of yours' });
  }
  const pinned = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (pinned && pinned !== n.user_id) return reply(403, { ok: false, error: 'not this account' });
  const set = await readSettings(sb, n.user_id, now);
  if (ASK_KINDS.indexOf(n.kind) !== -1) return await answerAsk(sb, n, said, set, now);
  const choice = said === 'break' || said === 'working' ? said : '';
  if (!choice) return reply(400, { ok: false, error: 'not an answer to this check' });
  const nudge = { id: n.id, state: n.state, streak_start: ms(n.streak_start), span_end: ms(n.span_end), pushed_at: ms(n.pushed_at) };
  const rows = await readRows(sb, n.user_id, Math.min(nudge.streak_start, now) - 60000);
  if (!answerOpen(nudge, now, rows.map((r) => ({ at: ms(r.at), type: r.type, rid: r.rid || '' })))) {
    return reply(200, { ok: true, over: true, message: 'That one\'s over' });
  }
  for (const w of A.actSkipTies(answerRows(nudge, choice, now), rows)) await writeRow(sb, n.user_id, set.zone, w);
  await sb.from('activity_nudges').update({ state: choice, decided_at: iso(now) }).eq('id', id);
  // Item 31c: no "Noted" push to the other devices; each app closes its copy when it next opens.
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, error: 'send a JSON object' });
  const sb = admin();
  const now = Date.now();
  try {
    if (body && body.answer && typeof body.answer === 'object') return await opAnswer(sb, body.answer, now);

    const token = tokenText(req.headers.get('x-device-token') || '');
    if (token.length < 24) return reply(401, { ok: false, error: 'pair this device in Settings first' });
    const dev = must(await sb.from('watch_devices').select('id, user_id, label, kind')
      .eq('secret_sha256', await sha256Hex(token)).limit(1))[0];
    if (!dev) return reply(401, { ok: false, error: 'this token is not paired (revoked?)' });
    const pinned = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
    if (pinned && pinned !== dev.user_id) return reply(403, { ok: false, error: 'not this account' });
    // Item 27: the tray asks every minute; it is not the watcher, so it must not say "connected".
    if (body.op === 'glance') return await opGlance(sb, dev, now);
    // Item 22: any call it makes says it is connected, working or not.
    await sb.from('watch_devices').update({ last_seen_at: iso(now) }).eq('id', dev.id);

    if (body.op === 'config') return await opConfig(sb, dev, body, now);
    if (body.op === 'ingest') return await opIngest(sb, dev, body, now, req);
    if (body.op === 'classify') return await opClassify(sb, dev, body, now);
    return reply(400, { ok: false, error: 'op must be config, ingest, classify or glance' });
  } catch (e) {
    return reply(500, { ok: false, error: scrub((e as Error)?.message || e) });
  }
});
