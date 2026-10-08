// ProBeing — the `prayer-remind` Edge Function (Saad, 29 Sep).
//
// For each of the five prayers, at his saved place: a push when its time begins,
// and, while it is not logged, pushes 60, 30 and 15 minutes before its time ends
// (Fajr -> sunrise, Dhuhr -> Asr, Asr -> Maghrib, Maghrib -> Isha, Isha -> next
// Fajr). Each is sent at most once, through reminders_sent. When a reminded
// prayer is logged, a quiet push under the same tag replaces the reminder on
// every device.
//
// Its own function rather than a branch of wrapup: wrapup is live and stays untouched.
// pg_cron calls it every minute, and an insert trigger when a prayer is logged
// (docs/prayer_remind.sql).
//
// Feedback 1 (6 Oct): it also pushes "<task>: 30 min left (by 4:30 PM)" once per
// task and expected finish (remindTasks), on its own toggle, user_settings.task_reminders.
// With nothing due that costs one more small read, of task_plans.
// Stage 18a (8 Oct): three pushes per deadline, as the colours change: 1 h left,
// 30 min left, and once it has passed. Plain pushes, no buttons.
//
// Stage 17 (7 Oct): the morning push, "Today: N due, M carried over, P planned" (remindPlan),
// once per counter day at user_settings.plan_push_time, on its own toggle plan_push.
// Idle, it reads nothing: the time is checked before any read. Edit queue 4: plus
// "S stopped", the stopped tasks Home's Upcoming card shows. A Qaza prayer row is a
// prayer row, so it ends that prayer's reminders like any other.
// Stage 18a (Saad, 8 Oct): it counts Home's new card instead: "Today: N planned ·
// N in Backlog" when something is planned for today, else "Plan your day: N in
// Backlog, N stopped" (or just "Plan your day").
//
// Deployed by hand:
//   npx supabase functions deploy prayer-remind --project-ref <ref> --use-api
// Secrets: none new — CRON_SECRET, ALLOWED_USER_ID and VAPID_PRIVATE_KEY are wrapup's.
// Needs the reminders_sent table and user_settings.prayer_reminders (docs/supabase_schema.sql).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/day.js';
import '../_shared/tree.js';
import { pushAll } from '../_shared/push.ts';

// tree.js, for "finished in ProBeing" exactly as tasks-sync reads it.
const Tree = (globalThis as unknown as { ProBeingTree: Record<string, any> }).ProBeingTree;

// day.js is a classic script, so it hands its functions over on globalThis.
const Day = (globalThis as unknown as { ProBeingDay: {
  setPrayerPlace: (p: unknown) => { zone: string };
  zoneOffsetMin: (zone: string, ms: number, fallback: number) => number;
  prayerTimes: (date: unknown, offsetMin?: number) => Record<string, number>;
  counterDayStart: (t: number, offsetMin?: number) => number;
  counterDate: (t: number, offsetMin?: number) => string;
  prayerDate: (t: number, offsetMin?: number) => string;
  sessionLead: (rows: unknown[], beforeMs: number) => unknown[];
  LEAD_MAX_MS: number;
  LEAD_TYPES: string[];
  dayFigures: (log: unknown[], prayers: unknown[], endMs?: number, carry?: unknown[] | null,
               lead?: unknown[], tree?: unknown) => { day: { runningSubtasks?: string[] } };
} }).ProBeingDay;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/* ── The decision. Pure: no clock, database or environment. Plain JS with
 *    `var`, so claudeWorkingDocs/tests/remind_*.js can lift it. ────────── */

var REMIND_PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

/** Where each prayer's time ends: a time of the same date, or the next date's Fajr. */
var PRAYER_ENDS = { Fajr: 'Sunrise', Dhuhr: 'Asr', Asr: 'Maghrib', Maghrib: 'Isha', Isha: 'nextFajr' };

/** Minutes before the end at which a prayer not yet logged is reminded. */
var REMIND_LEFT_MIN = [60, 30, 15];

/** Due this early: absorbs clock skew between the database and the function. */
var REMIND_GRACE_MS = 30000;

/* Dropped when this late: "30 min left" sent 10 minutes late is wrong. Four
 * minutes of retries with the every-minute cron; a 5-minute cron would need more. */
var REMIND_LATE_MS = 4 * 60000;

/** 'YYYY-MM-DD' of a {y, m, d}. */
function ymd(date) {
  return date.y + '-' + (date.m < 10 ? '0' : '') + date.m + '-' + (date.d < 10 ? '0' : '') + date.d;
}

/** The local calendar date of `ms` at `offsetMin`, moved `plusDays`, as {y, m, d}. */
function localDate(ms, offsetMin, plusDays) {
  var d = new Date(ms + offsetMin * 60000);
  var u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (plusDays || 0)));
  return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate() };
}

/**
 * Every reminder of one date's prayers: {kind, day, prayer, left, at, start, end}.
 * `left` is 0 for "has begun". An offset whose moment is at or before the
 * prayer's start is skipped — the "has begun" push already covers it.
 */
function remindersOfDay(day, times, nextFajr) {
  var out = [];
  REMIND_PRAYERS.forEach(function (name) {
    var start = times[name];
    var end = PRAYER_ENDS[name] === 'nextFajr' ? nextFajr : times[PRAYER_ENDS[name]];
    if (!(end > start)) return;             // an unreadable window sends nothing
    out.push({ kind: name + '-begin', day: day, prayer: name, left: 0,
               at: start, start: start, end: end });
    REMIND_LEFT_MIN.forEach(function (m) {
      var at = end - m * 60000;
      if (at <= start) return;
      out.push({ kind: name + '-' + m, day: day, prayer: name, left: m,
                 at: at, start: start, end: end });
    });
  });
  return out;
}

/** Yesterday's and today's reminders — yesterday's Isha runs until this
 *  morning's Fajr. `timesOf(date)` is day.js's prayerTimes at the saved place. */
function remindersAround(now, offsetMin, timesOf) {
  var out = [];
  [-1, 0].forEach(function (k) {
    var date = localDate(now, offsetMin, k);
    var next = localDate(now, offsetMin, k + 1);
    out = out.concat(remindersOfDay(ymd(date), timesOf(date), timesOf(next).Fajr));
  });
  return out;
}

function sentKey(kind, day) {
  return kind + '|' + day;
}

/**
 * The reminders to send at `now`.
 * logged: {'YYYY-MM-DD': {Asr: true}} by counter day; sent: {sentKey: true};
 * on: the Settings toggle (only `false` turns it off).
 */
function dueReminders(list, now, logged, sent, on) {
  if (on === false) return [];
  return list.filter(function (r) {
    if (r.at > now + REMIND_GRACE_MS) return false;      // not yet
    if (now - r.at > REMIND_LATE_MS) return false;       // missed: its words would be wrong
    if (now >= r.end) return false;                      // the prayer's time is over
    if (logged[r.day] && logged[r.day][r.prayer]) return false;
    return !sent[sentKey(r.kind, r.day)];
  });
}

/** Prayers to clear from the shade: logged, reminded at least once, not yet cleared. */
function clearsDue(list, logged, sent, on) {
  if (on === false) return [];
  var out = [];
  list.forEach(function (r) {
    if (r.left !== 0) return;                            // one per prayer and day
    if (!(logged[r.day] && logged[r.day][r.prayer])) return;
    if (sent[sentKey(r.prayer + '-clear', r.day)]) return;
    var reminded = list.some(function (x) {
      return x.day === r.day && x.prayer === r.prayer && sent[sentKey(x.kind, x.day)];
    });
    if (reminded) out.push({ kind: r.prayer + '-clear', day: r.day, prayer: r.prayer, end: r.end });
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

/** The push's JSON. sw.js shows it under `tag`, one line per prayer. */
function reminderPayload(r, offsetMin) {
  var tag = 'probeing-prayer-' + r.prayer;
  if (/-clear$/.test(r.kind)) {
    return { kind: 'prayer-logged', tag: tag, title: r.prayer + ' logged',
             body: 'No more reminders for it.' };
  }
  return { kind: 'prayer', tag: tag,
           title: r.left ? r.prayer + ': ' + r.left + ' min left — not logged yet'
                         : r.prayer + ' has begun',
           body: 'Its time ends at ' + clock12(r.end, offsetMin) + '.' };
}

/** Prayer rows -> {prayer day: {name: true}}. `day` is day.js (ProBeingDay). The
 *  prayer day turns at Fajr, so an Isha logged just before Fajr is that night's. */
function loggedByDay(rows, offsetMin, day) {
  var out = {};
  (rows || []).forEach(function (row) {
    var t = Date.parse(String(row.at));
    var name = String(row.project || '');
    if (!isFinite(t) || REMIND_PRAYERS.indexOf(name) === -1) return;
    var ymd = day.prayerDate(t, offsetMin);
    out[ymd] = out[ymd] || {};
    out[ymd][name] = true;
  });
  return out;
}

/* ── Feedback 1: a task's deadline, 30 minutes ahead. Here and not in a
 *    sibling function, so the one minute cron and one settings read serve both.
 *    Stage 18a: also 1 h ahead (orange) and when it passes (blinking). */

var TASK_LEFT_MIN = 30;
var TASK_MARKS_MIN = [60, 30, 0];

/** expected_at values that could be due at `now`, as [from, to] in ms. */
function taskWindow(now) {
  var marks = TASK_MARKS_MIN;
  return { from: now + marks[marks.length - 1] * 60000 - REMIND_LATE_MS,
           to: now + marks[0] * 60000 + REMIND_GRACE_MS };
}

/** One reminder per task, expected_at and mark: a moved deadline is a new kind.
 *  The 30-minute one keeps its feedback 1 name, so one already sent is not sent again. */
function taskKind(nodeId, expectedMs, mark) {
  return 'task-' + (mark === undefined ? TASK_LEFT_MIN : mark) + '-' + nodeId + '-' + expectedMs;
}

/** A Web Push Topic is at most 32 URL-safe characters. */
function taskTopic(nodeId) {
  return ('task' + String(nodeId).replace(/[^A-Za-z0-9]/g, '')).slice(0, 32);
}

/**
 * Deadline reminders to send at `now`: [{kind, day, node, up, expected, mark}],
 * mark 60, 30 or 0 (minutes left; 0 = passed).
 * plans: task_plans rows; nodes: id -> task_nodes row; ups: list|google_id ->
 * project row; finished: id -> true when finished in ProBeing; sent: {sentKey:
 * true}; on: the toggle (only `false` turns it off); listId: the list shown.
 * A finish set or moved after a mark (expected_set_at; updated_at before that
 * column exists) was never that far away: no push for that mark.
 */
function dueTaskReminders(plans, nodes, ups, finished, sent, now, on, listId, offsetMin) {
  if (on === false) return [];
  var out = [];
  (plans || []).forEach(function (p) {
    var t = Date.parse(String((p && p.expected_at) || ''));
    if (!isFinite(t)) return;
    // The latest mark that is due now; an earlier one missed is not sent late.
    var mark = null;
    TASK_MARKS_MIN.forEach(function (m) {
      var at = t - m * 60000;
      if (!(at > now + REMIND_GRACE_MS || now - at > REMIND_LATE_MS)) mark = m;
    });
    if (mark === null) return;
    // When the finish itself was set (a trigger keeps it); updated_at moves on a Planned toggle too.
    var set = Date.parse(String(p.expected_set_at || p.updated_at || ''));
    if (isFinite(set) && set > t - mark * 60000) return;
    var n = nodes[p.node_id];
    if (!n || n.gone_at || n.g_status === 'completed' || finished[n.id]) return;
    if (listId && String(n.list_id) !== String(listId)) return;
    var up = n.kind === 'subtask' ? ups[(n.list_id || '') + '|' + n.parent_google_id] || null : null;
    if (up && up.gone_at) return;
    var kind = taskKind(n.id, t, mark);
    var day = ymd(localDate(t, offsetMin, 0));
    if (sent[sentKey(kind, day)]) return;
    out.push({ kind: kind, day: day, node: n, up: up, expected: t, mark: mark });
  });
  return out;
}

/** The push's JSON for a deadline. sw.js opens the Tasks tab on a tap. One tag
 *  per task, so each push replaces the one before it. */
function taskPayload(r, offsetMin) {
  var title = Array.from(String(r.node.title || '').trim() || '(untitled)').slice(0, 120).join('');
  var clock = clock12(r.expected, offsetMin).toUpperCase();
  var mark = r.mark === undefined ? TASK_LEFT_MIN : r.mark;
  var words = mark === 0 ? ': past its deadline (' + clock + ')'
            : mark === 60 ? ': 1 h left (by ' + clock + ')'
            : ': ' + mark + ' min left (by ' + clock + ')';
  return { kind: 'task', tag: 'probeing-task-' + r.node.id, goto: 'tasks', title: title + words,
           body: r.up ? String(r.up.title || '').trim().slice(0, 120) : '' };
}

/* ── Stage 17: the morning push (Stage 18a: "Today: N planned · N in Backlog" or
 *    "Plan your day: N in Backlog, N stopped"), once per
 *    counter day at user_settings.plan_push_time on his saved zone's clock. */

var PLAN_DEFAULT_MIN = 9 * 60;

/* Still sent this late: the counts are worked out when it is sent, so a late
 * one is still true. Also how far back a time just changed to fires at once. */
var PLAN_LATE_MS = 30 * 60000;

/** Minutes after midnight of a 'HH:MM[:SS]' time; 09:00 when unreadable. */
function planMinutes(text) {
  var m = /^(\d{1,2}):(\d{2})/.exec(String(text || ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return PLAN_DEFAULT_MIN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The morning push due at `now`: {kind: 'plan', day, at} or null. `day` is the
 * counter date (day.js's counterDate) of the push time, so a time before the
 * Fajr - 10 turn belongs to the day before, as on Home. on: only `false` is off.
 */
function planDue(now, offsetMin, timeText, on, day) {
  if (on === false) return null;
  var mins = planMinutes(timeText);
  for (var k = 0; k >= -1; k--) {            // yesterday's: a late window across midnight
    var date = localDate(now, offsetMin, k);
    var at = Date.UTC(date.y, date.m - 1, date.d, 0, mins) - offsetMin * 60000;
    if (at > now + REMIND_GRACE_MS || now - at > PLAN_LATE_MS) continue;
    return { kind: 'plan', day: day.counterDate(at, offsetMin), at: at };
  }
  return null;
}

/** The day a plan is for: planned_for, else the counter date of updated_at (as app.js planDay). */
function planDayOf(p, dayOf) {
  if (!p) return '';
  if (p.planned_for) return String(p.planned_for).slice(0, 10);
  var t = Date.parse(String(p.updated_at || ''));
  return isFinite(t) ? dayOf(t) : '';
}

/**
 * Home's Upcoming card and its Backlog, counted (Stage 18a, app.js upcomingLeaves).
 * Leaves (sub-tasks, or projects with no sub-task left) open in Google, project not
 * deleted, not finished or dropped in ProBeing (done: id -> true), not running now
 * (running: id -> true). Planned for `today` (a plan with no known day counts as
 * today's): planned. Else stopped (tree.js stoppedTasks: id -> ms): stopped. Else
 * planned on an earlier day: backlog. The card shows planned + stopped, then the
 * Backlog. dayOf(ms) is the counter date. Returns {planned, stopped, backlog, ids, named}.
 */
function planCounts(nodes, plans, done, today, stopped, running, dayOf) {
  var paused = stopped || {};
  var busy = running || {};
  var byGoogle = {};
  var hasKids = {};
  (nodes || []).forEach(function (n) {
    byGoogle[n.google_id] = n;
    if (n.kind === 'subtask' && !n.gone_at) hasKids[n.parent_google_id] = true;
  });
  var out = { planned: 0, stopped: 0, backlog: 0, ids: [], named: { planned: [], stopped: [], backlog: [] } };
  (nodes || []).forEach(function (n) {
    if (!(n.kind === 'subtask' || (n.kind === 'project' && !hasKids[n.google_id]))) return;
    var up = n.kind === 'subtask' ? byGoogle[n.parent_google_id] : null;
    if (n.gone_at || n.g_status === 'completed' || (up && up.gone_at) || done[n.id] || busy[n.id]) return;
    var p = plans[n.id];
    var on = Boolean(p && p.planned);
    var day = on ? planDayOf(p, dayOf) : '';
    var when = on && (!day || day === today) ? 'planned'
      : paused.hasOwnProperty(n.id) && isFinite(paused[n.id]) ? 'stopped'
      : on && day && day < today ? 'backlog' : '';
    if (!when) return;
    out[when]++;
    out.ids.push(n.id);
    out.named[when].push(String(n.title || '').trim() || '(untitled)');
  });
  return out;
}

/** Up to three task names, each clipped, then "+N more". Never empty: an empty
 *  body reads as the night check's "Are you still awake?" on an old sw.js. */
function planBody(names) {
  var clip = function (t) {
    var a = Array.from(String(t));
    return a.length > 40 ? a.slice(0, 39).join('') + '…' : a.join('');
  };
  var out = names.slice(0, 3).map(clip).join(', ');
  if (names.length > 3) out += ' +' + (names.length - 3) + ' more';
  return out || 'Open ProBeing to plan it.';
}

/**
 * The push's JSON (Stage 18a): "Today: 2 planned · 1 in Backlog" when something is
 * planned for today, else "Plan your day: 1 in Backlog, 2 stopped"; zero parts left
 * out, both zero is "Plan your day". kind 'prayer' and a probeing-prayer- tag so a
 * v19/v20 sw.js shows it as a plain notification that opens Home; `plan` lets v21
 * show it under its own tag.
 */
function planPayload(c) {
  var named = c.named || { planned: [], stopped: [], backlog: [] };
  var parts = [];
  var title, names;
  if (c.planned) {
    parts.push(c.planned + ' planned');
    if (c.backlog) parts.push(c.backlog + ' in Backlog');
    title = 'Today: ' + parts.join(' · ');
    names = named.planned.concat(named.backlog);
  } else {
    if (c.backlog) parts.push(c.backlog + ' in Backlog');
    if (c.stopped) parts.push(c.stopped + ' stopped');
    title = parts.length ? 'Plan your day: ' + parts.join(', ') : 'Plan your day';
    names = named.backlog.concat(named.stopped);
  }
  return { kind: 'prayer', plan: true, tag: 'probeing-prayer-Plan', goto: 'home',
           title: title, body: planBody(names) };
}

/* ─────────────────────────────────────────────────── end of the pure part */

/** Constant-time compare, as in wrapup and glance-refresh. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] || 0) ^ (y[i % (y.length || 1)] || 0);
  return diff === 0 && x.length > 0;
}

/** The service client. It bypasses row level security, so writes name user_id. */
function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    { auth: { persistSession: false } }
  );
}

/** His settings row, place adopted. `*` so a database without the
 *  prayer_reminders column still reads the place (and reminders stay on).
 *  Only an absent row means the defaults; a failed read returns `error`, because
 *  guessing Karachi and "on" would send the wrong prayer and burn its slot. */
async function readSettings(sb: ReturnType<typeof admin>, owner: string, now: number) {
  let row: Record<string, unknown> | null = null;
  try {
    const got = await sb.from('user_settings').select('*').eq('user_id', owner).limit(1);
    if (got.error) return { error: String(got.error.message || 'the settings read failed') };
    row = (got.data || [])[0] || null;
  } catch (e) {
    return { error: String((e && (e as Error).message) || e) };
  }
  const place = Day.setPrayerPlace(row ? { lat: row.lat, lng: row.lng, zone: row.time_zone,
                                           method: row.method, asr: row.asr_school } : null);
  const off = Day.zoneOffsetMin(place.zone, now, NaN);
  return { zone: isNaN(off) ? 'Asia/Karachi' : place.zone, offset: isNaN(off) ? 300 : off,
           on: !(row && row.prayer_reminders === false),
           tasksOn: !(row && row.task_reminders === false),
           planOn: !(row && row.plan_push === false),
           planTime: row ? row.plan_push_time : null };
}

/** Feedback 1: send any "30 min left" due now. One small read when none is. */
async function remindTasks(sb: ReturnType<typeof admin>, owner: string, now: number, offset: number) {
  const w = taskWindow(now);
  const iso = (ms: number) => new Date(ms).toISOString();
  // `*`, so a database without expected_set_at still reads (and falls back to updated_at).
  const plansRes = await sb.from('task_plans').select('*')
    .eq('user_id', owner).gte('expected_at', iso(w.from)).lte('expected_at', iso(w.to)).limit(50);
  if (plansRes.error) return { act: 'error', error: String(plansRes.error.message || 'the plans read failed') };
  const plans = plansRes.data || [];
  if (!plans.length) return { act: 'nothing' };

  const ids = plans.map((p: { node_id: string }) => p.node_id);
  const must = (r: { data: unknown; error: { message?: string } | null }) => {
    if (r.error) throw new Error(String(r.error.message || 'a read failed'));
    return (r.data || []) as Record<string, any>[];
  };
  try {
    const nodeRows = must(await sb.from('task_nodes').select('*').eq('user_id', owner).in('id', ids).limit(100));
    const nodes: Record<string, any> = {};
    nodeRows.forEach((n) => { nodes[n.id] = n; });
    const parents = nodeRows.filter((n) => n.kind === 'subtask').map((n) => String(n.parent_google_id));
    const ups: Record<string, any> = {};
    if (parents.length) {
      must(await sb.from('task_nodes').select('*').eq('user_id', owner).in('google_id', parents).limit(200))
        .forEach((u) => { ups[(u.list_id || '') + '|' + u.google_id] = u; });
    }
    const sync = must(await sb.from('sync_state').select('list_id').eq('user_id', owner).limit(1));
    const listId = (sync[0] || {}).list_id || '';
    // Finished in ProBeing (items, or its own Done) counts as done, as tasks-sync reads it.
    const items = must(await sb.from('items').select('rid, node_id').eq('user_id', owner).in('node_id', ids).limit(1000));
    const newest: Record<string, any> = {};
    if (items.length) {
      must(await sb.from('item_mark_latest').select('item_rid, mark, at').eq('user_id', owner)
        .in('item_rid', items.map((i) => i.rid)).limit(1000)).forEach((m) => { newest[m.item_rid] = m; });
    }
    const direct = Tree.directMarks(must(await sb.from('events').select('type, rid, node_id, at')
      .eq('user_id', owner).in('type', Tree.DIRECT_TYPES).in('node_id', ids).limit(1000)));
    const ridsOf: Record<string, string[]> = {};
    items.forEach((i) => { (ridsOf[i.node_id] = ridsOf[i.node_id] || []).push(i.rid); });
    const finished: Record<string, boolean> = {};
    // Dropped in ProBeing (edit queue 2): off the lists, so no reminder either.
    const dropped = Tree.directDropped(direct);
    nodeRows.forEach((n) => {
      if (dropped[n.id] || Tree.finishedAt(n, ridsOf[n.id] || [], newest, direct[n.id]) !== null) finished[n.id] = true;
    });
    const kinds: string[] = [];
    plans.forEach((p: { node_id: string; expected_at: string }) => {
      TASK_MARKS_MIN.forEach((m) => kinds.push(taskKind(p.node_id, Date.parse(p.expected_at), m)));
    });
    const already: Record<string, boolean> = {};
    must(await sb.from('reminders_sent').select('kind, day').eq('user_id', owner).in('kind', kinds).limit(500))
      .forEach((r) => { already[sentKey(r.kind, String(r.day).slice(0, 10))] = true; });

    const todo = dueTaskReminders(plans, nodes, ups, finished, already, now, true, listId, offset);
    const report: Record<string, unknown>[] = [];
    for (const r of todo) {
      const claim = await sb.from('reminders_sent').insert({ user_id: owner, kind: r.kind, day: r.day });
      if (claim.error) {
        report.push({ kind: r.kind, skipped: claim.error.code === '23505' ? 'already sent' : claim.error.message });
        continue;
      }
      const out = await pushAll(sb, owner, JSON.stringify(taskPayload(r, offset)), {
        ttl: Math.max(60, Math.floor((r.expected - now) / 1000)), topic: taskTopic(r.node.id), urgency: 'high'
      });
      // Delivered nowhere: release the claim so the next minute tries again.
      if (!out.sent) await sb.from('reminders_sent').delete().eq('user_id', owner).eq('kind', r.kind).eq('day', r.day);
      report.push({ kind: r.kind, ...out });
    }
    return { act: todo.length ? 'sent' : 'nothing', reminders: report };
  } catch (e) {
    return { act: 'error', error: String((e && (e as Error).message) || e) };
  }
}

/** Edit queue 4: tasks stopped and not picked up since (tree.js stoppedTasks), as the
 *  browser reads them: the Stops, then Done/Drop/Reopen and starts under those tasks. */
async function stoppedNow(sb: ReturnType<typeof admin>, owner: string,
                          must: (r: { data: unknown; error: { message?: string } | null }) => Record<string, any>[]) {
  const stops = must(await sb.from('events').select('type, rid, node_id, at').eq('user_id', owner)
    .eq('type', Tree.STOP_TYPE).order('at', { ascending: false }).limit(1000));
  if (!stops.length) return {};
  const ids = Object.keys(Tree.stoppedTasks(stops, [], {})).slice(0, 200);
  const direct = Tree.directMarks(must(await sb.from('events').select('type, rid, node_id, at')
    .eq('user_id', owner).in('type', Tree.DIRECT_TYPES).in('node_id', ids).limit(1000)));
  const cand = Tree.stoppedTasks(stops, [], direct);
  const left = Object.keys(cand);
  if (!left.length) return {};
  const starts = must(await sb.from('events').select('type, rid, node_id, at').eq('user_id', owner)
    .in('type', Tree.START_TYPES).in('node_id', left).gte('at', Tree.stoppedSince(cand))
    .order('at', { ascending: false }).limit(1000));
  return Tree.stoppedTasks(stops, starts, direct);
}

/** Stage 18a: node id -> true for each task running now, as Home's replay sees it:
 *  today's rows plus the session left open from before the turn (glance-refresh's reads). */
async function runningNow(sb: ReturnType<typeof admin>, owner: string, now: number, start: number,
                          nodes: Record<string, any>[],
                          must: (r: { data: unknown; error: { message?: string } | null }) => Record<string, any>[]) {
  const cols = 'at, local_time, type, raw_text, project, detail, node_id';
  const startIso = new Date(start).toISOString();
  const shape = (r: Record<string, any>) => {
    const row: Record<string, any> = { at: r.at, local: r.local_time || '', type: r.type, raw_text: r.raw_text || '',
                                       project: r.project || '', detail: r.detail || '' };
    if (r.node_id) row.node_id = r.node_id;
    return row;
  };
  const today = must(await sb.from('events').select(cols).eq('user_id', owner).gte('at', startIso)
    .order('at', { ascending: false }).order('created_at', { ascending: false }).limit(1000))
    .filter((r) => r.type !== 'prayer').map(shape);
  const before = must(await sb.from('events').select(cols).eq('user_id', owner).lt('at', startIso)
    .gte('at', new Date(start - Day.LEAD_MAX_MS).toISOString()).in('type', Day.LEAD_TYPES)
    .order('at', { ascending: false }).order('created_at', { ascending: false }).limit(1000)).map(shape);
  const lead = Day.sessionLead(before, start);
  const day = Day.dayFigures(today, [], now, null, lead, { nodes: nodes, items: [], marks: [] }).day;
  const out: Record<string, boolean> = {};
  (day.runningSubtasks || []).forEach((id) => { out[id] = true; });
  return out;
}

/** Stage 17: send the morning push if it is due now. Reads nothing outside its time. */
async function remindPlan(sb: ReturnType<typeof admin>, owner: string, now: number, offset: number,
                          on: boolean, time: unknown) {
  const due = planDue(now, offset, time, on, Day);
  if (!due) return { act: on ? 'nothing' : 'off' };
  const must = (r: { data: unknown; error: { message?: string } | null }) => {
    if (r.error) throw new Error(String(r.error.message || 'a read failed'));
    return (r.data || []) as Record<string, any>[];
  };
  try {
    if (must(await sb.from('reminders_sent').select('kind').eq('user_id', owner)
      .eq('kind', due.kind).eq('day', due.day).limit(1)).length) return { act: 'nothing', day: due.day };

    // Home's card: the list tasks-sync reads, and only while Google is connected.
    const start = Day.counterDayStart(due.at, offset);
    const dayOf = (t: number) => Day.counterDate(t, offset);
    const sync = must(await sb.from('sync_state').select('*').eq('user_id', owner).limit(1))[0] || {};
    const linked = Boolean(sync.connected && sync.list_title && sync.list_id);
    let c: Record<string, any> = { planned: 0, stopped: 0, backlog: 0, ids: [], named: { planned: [], stopped: [], backlog: [] } };
    if (linked) {
      const nodes = must(await sb.from('task_nodes').select('*').eq('user_id', owner)
        .eq('list_id', sync.list_id).limit(1000));
      const plans: Record<string, any> = {};
      must(await sb.from('task_plans').select('node_id, planned, planned_for, updated_at, expected_at')
        .eq('user_id', owner).eq('planned', true).limit(2000))
        .forEach((p) => { plans[p.node_id] = p; });
      const stopped = await stoppedNow(sb, owner, must);
      const running = await runningNow(sb, owner, now, start, nodes, must);
      c = planCounts(nodes, plans, {}, due.day, stopped, running, dayOf);
      if (c.ids.length) {
        // Finished or dropped in ProBeing: off the card, so out of the count (closedHere).
        const items = must(await sb.from('items').select('rid, node_id').eq('user_id', owner)
          .in('node_id', c.ids).limit(1000));
        const newest: Record<string, any> = {};
        if (items.length) {
          must(await sb.from('item_mark_latest').select('item_rid, mark, at').eq('user_id', owner)
            .in('item_rid', items.map((i) => i.rid)).limit(1000)).forEach((m) => { newest[m.item_rid] = m; });
        }
        const direct = Tree.directMarks(must(await sb.from('events').select('type, rid, node_id, at')
          .eq('user_id', owner).in('type', Tree.DIRECT_TYPES).in('node_id', c.ids).limit(1000)));
        const done = Object.assign(Tree.directDone(nodes.filter((n) => c.ids.indexOf(n.id) !== -1), items, newest, direct),
                                   Tree.directDropped(direct));
        c = planCounts(nodes, plans, done, due.day, stopped, running, dayOf);
      }
    }

    // Claimed even when there is nothing to say, so the rest of the window reads one row.
    const claim = await sb.from('reminders_sent').insert({ user_id: owner, kind: due.kind, day: due.day });
    if (claim.error) {
      return { act: 'nothing', day: due.day,
               skipped: claim.error.code === '23505' ? 'already sent' : claim.error.message };
    }
    // No task list, no card: nothing to say. With one, an empty plan still says "Plan your day".
    if (!linked) return { act: 'empty', day: due.day };
    const end = Day.counterDayStart(start + 30 * 3600000, offset);
    const out = await pushAll(sb, owner, JSON.stringify(planPayload(c)), {
      ttl: Math.max(60, Math.floor((end - now) / 1000)), topic: 'probeing-plan', urgency: 'normal'
    });
    // Delivered nowhere: release the claim so the next minute tries again.
    if (!out.sent) await sb.from('reminders_sent').delete().eq('user_id', owner).eq('kind', due.kind).eq('day', due.day);
    return { act: out.sent ? 'sent' : 'failed', day: due.day, planned: c.planned, backlog: c.backlog,
             stopped: c.stopped, ...out };
  } catch (e) {
    return { act: 'error', error: String((e && (e as Error).message) || e) };
  }
}

type Reminder = { kind: string; day: string; prayer: string; left?: number; end: number };

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  const secret = (Deno.env.get('CRON_SECRET') || '').trim();
  if (!secret) return reply(403, { ok: false, error: 'CRON_SECRET is not set on this function' });
  if (!sameSecret(req.headers.get('x-cron-secret') || '', secret)) {
    return reply(401, { ok: false, error: 'not the scheduler' });
  }

  const owner = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (!owner) {
    return reply(403, { ok: false,
      error: 'this function is not pinned to an owner yet: set ALLOWED_USER_ID' });
  }

  let sent: Record<string, unknown> = {};
  try {
    sent = await req.json();
  } catch (_e) { /* the cron's empty body */ }

  // `now` may be overridden only here, behind the secret, to test a prayer time by hand.
  let now = Date.now();
  if (sent && sent.now) {
    const t = Date.parse(String(sent.now));
    if (isNaN(t)) return reply(400, { ok: false, error: 'now is not a date' });
    now = t;
  }
  // The insert trigger's call: a prayer was just logged, so look for reminders to clear.
  const logged = Boolean(sent && sent.logged);

  const sb = admin();
  const place = await readSettings(sb, owner, now);
  // Settings unreadable: skip this minute; the next run tries again.
  if ('error' in place) return reply(503, { ok: false, act: 'skipped', error: place.error });
  // Deadlines first and on their own toggle; the prayer insert trigger's call skips them.
  const tasks = logged ? { act: 'skipped' } : place.tasksOn
    ? await remindTasks(sb, owner, now, place.offset) : { act: 'off' };
  // Stage 17: likewise on its own toggle and skipped by the insert trigger's call.
  const plan = logged ? { act: 'skipped' }
    : await remindPlan(sb, owner, now, place.offset, place.planOn, place.planTime);
  if (!place.on) return reply(200, { ok: true, act: 'off', why: 'prayer reminders are turned off', tasks, plan });

  const list = remindersAround(now, place.offset, (d: unknown) => Day.prayerTimes(d, place.offset));
  // The cheap gate: nothing could be due, so nothing more is read.
  if (!logged && dueReminders(list, now, {}, {}, true).length === 0) {
    return reply(200, { ok: true, act: 'nothing', zone: place.zone, tasks, plan });
  }

  const days = [list[0].day, list[list.length - 1].day];
  const since = Day.counterDayStart(list[0].start, place.offset);
  const prayRes = await sb.from('events').select('at, project')
    .eq('user_id', owner).eq('type', 'prayer').gte('at', new Date(since).toISOString())
    .limit(200);
  if (prayRes.error) return reply(500, { ok: false, error: prayRes.error.message });
  const sentRes = await sb.from('reminders_sent').select('kind, day')
    .eq('user_id', owner).in('day', days).limit(500);
  if (sentRes.error) return reply(500, { ok: false, error: sentRes.error.message });

  const done = loggedByDay(prayRes.data || [], place.offset, Day);
  const already: Record<string, boolean> = {};
  (sentRes.data || []).forEach((r: { kind: string; day: string }) => {
    already[sentKey(r.kind, String(r.day).slice(0, 10))] = true;
  });

  const todo: Reminder[] = (dueReminders(list, now, done, already, place.on) as Reminder[])
    .concat(clearsDue(list, done, already, place.on) as Reminder[]);
  const report: Record<string, unknown>[] = [];
  for (const r of todo) {
    // Claimed before sending: a second run in the same minute hits the primary key and skips.
    const claim = await sb.from('reminders_sent').insert({ user_id: owner, kind: r.kind, day: r.day });
    if (claim.error) {
      report.push({ kind: r.kind, day: r.day, skipped: claim.error.code === '23505'
        ? 'already sent' : claim.error.message });
      continue;
    }
    const clear = /-clear$/.test(r.kind);
    const out = await pushAll(sb, owner, JSON.stringify(reminderPayload(r, place.offset)), {
      // A reminder is stale once the prayer's time is over; a clear, after an hour.
      ttl: clear ? 3600 : Math.max(60, Math.floor((r.end - now) / 1000)),
      topic: 'probeing-prayer-' + r.prayer,
      urgency: clear ? 'normal' : 'high'
    });
    // Delivered nowhere: release the claim so the next minute tries again. Clears are best effort.
    if (!out.sent && !clear) {
      await sb.from('reminders_sent').delete()
        .eq('user_id', owner).eq('kind', r.kind).eq('day', r.day);
    }
    report.push({ kind: r.kind, day: r.day, ...out });
  }

  return reply(200, { ok: true, act: todo.length ? 'sent' : 'nothing', zone: place.zone,
                      offset: place.offset, reminders: report, tasks, plan });
});
