/* ProBeing PWA — four screens, two mandatory buttons, two state toggles.
 *
 * Home     : M / Prayer / Sleep-Wake / Break-Work, prayer ticks, current project
 * Today    : the tracker input and today's raw log
 * Review   : the weekly report (layout final, numbers land with the backend)
 * Board    : the fourth tab is a link out to whatever taskboard you already use
 *
 * Everything writes through api() below — with one deliberate exception, the
 * Gemini call in extractProject(), which must not queue behind it.
 */

'use strict';

/* SHIPPED ON PURPOSE, and safe to.
 *
 * These two identify the project; they do not grant access to it. Row level
 * security plus the GitHub sign-in are what protect the rows — an anon key with
 * no session can read nothing and write nothing, which was verified against the
 * live project in both directions.
 *
 * They are here so that reinstalling the app, or clearing site data, does not
 * mean retyping a 209-character key on a phone. Recovery is: open the app, sign
 * in with GitHub. That is the whole point — the only credential a person should
 * ever handle is the one they already have.
 *
 * The SERVICE key is the opposite in every way and must never appear here;
 * scripts/secret_scan.sh blocks it by value and by shape. */
var DEFAULT_SUPABASE_URL = 'https://whxgzdrowvkpzpgfilof.supabase.co';
var DEFAULT_SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndoeGd6ZHJvd3ZrcHpwZ2ZpbG9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4NDEzNDQsImV4cCI6MjEwMzQxNzM0NH0.qJyTdirLFpOu5uBsLwOWAnwWUp4lU1Ka0ZwM6Vsz3mE';

var CFG_KEY = 'probeing.config';
var TOGGLE_KEY = 'probeing.toggles';        // current sleep/work state, per device
var CHIP_STATS_KEY = 'probeing.chipstats';  // how often each status gets logged
var PROJECT_NAMES_KEY = 'probeing.projects'; // project names seen lately, reused for free
var GEMINI_DAY_KEY = 'probeing.geminiday';   // today's Gemini call count, against the free tier

// Kept in step with the same two lists in Code.gs, which validates them server-side.
var PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
var PRAYER_MODES = ['Takbeer-e-oola', 'Partial Jamat', 'Individual'];

/* The chips are BREAK REASONS, not notes.
 *
 * They used to write a `status` row, which was a point in time with no end — so
 * "Lunch" could never become a duration, and tapping "Prayer-break" left the
 * work clock running, which says you were praying and working at once. Now a
 * chip writes the `break` edge itself, carrying its reason, and the next
 * `resume` closes it. That is what lets the review say "Lunch 45m". */
var DEFAULT_CHIPS = ['Prayer-break', 'Lunch', 'Coffee'];

/** What the plain Break button writes. Never counted as a chip. */
var PLAIN_BREAK = 'Break';

/* Several reasons can apply at once — dinner AND tea — so a break row carries
 * the whole current set, joined. Reason names have the separator stripped when
 * they are added, so this can never be ambiguous. */
var REASON_SEP = ' + ';

/**
 * What a break row DOES to the current set of reasons.
 *
 * Posting the resulting list was a mistake: a device working from a view even a
 * few seconds old overwrites what the other one added. Press Dinner on the
 * laptop, then Tea on a phone that has not caught up, and the phone writes
 * "Tea" — erasing Dinner, permanently, with nothing on screen to say so.
 *
 * A delta cannot do that. "+ Tea" and "+ Dinner" from two devices merge no
 * matter what order they land in or what either device believed at the time.
 * A row with no sign is still read as the whole set, so every row written
 * before this change still replays correctly.
 */
function parseBreakOp(text, detail) {
  var d = String(detail || '').trim();
  if (d === 'add' || d === 'drop') return { op: d, names: parseReasons(text) };

  /* Rows written on 27 Aug carried the sign in the text itself — which Google
   * Sheets ate, because a cell starting with + or - is a FORMULA. "+ Tea"
   * became #NAME?, Sheets saying there is no function called Tea. The operation
   * lives in its own column now; this reads the handful written before that. */
  var t = String(text || '').trim();
  if (t.charAt(0) === '+') return { op: 'add', names: parseReasons(t.slice(1)) };
  if (t.charAt(0) === '-') return { op: 'drop', names: parseReasons(t.slice(1)) };

  /* A cell Sheets turned into an error says nothing about which reasons apply,
   * so it must not be read as "clear them all" — the row was a real break, and
   * the ones already running should survive it. Reading these as `set` would
   * mean the #NAME? rows sitting in the Sheet right now silently wipe the
   * reason you are on every time the day replays. */
  if (isSheetError(t)) return { op: 'keep', names: [] };

  return { op: 'set', names: parseReasons(t) };
}

/** Anything Sheets produced rather than the user: #NAME?, #REF!, #VALUE! … */
function isSheetError(name) {
  return name.charAt(0) === '#';
}

function parseReasons(text) {
  return String(text || '').split('+').map(function (x) {
    return x.trim();
  }).filter(function (x) {
    return x && x !== PLAIN_BREAK && !isSheetError(x);
  });
}

/* 9 PM is the line between "a nap in the middle of the day" and "winding up".
 * Only one press is ever silent — on a break after 9 PM, which is unambiguously
 * bedtime. Everything else asks, because every one of those presses closes a
 * session the weekly review has to measure. */
var NIGHT_STARTS_HOUR = 21;
var DAY_STARTS_HOUR = 5;

// ------------------------------------------------------------------- config
// The API URL and token live ONLY in this device's localStorage. They are never
// committed, because GitHub Pages requires a public repo.

function loadConfig() {
  var saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(CFG_KEY)) || {};
  } catch (e) { /* corrupt storage must not wedge the app */ }

  // Supabase is the backend now, not merely an option — and it comes ready to
  // sign in to. Anything saved on this device still wins.
  if (!saved.backend) saved.backend = 'supabase';
  if (!saved.supaUrl) saved.supaUrl = DEFAULT_SUPABASE_URL;
  if (!saved.supaKey) saved.supaKey = DEFAULT_SUPABASE_ANON;
  return saved;
}

function saveConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

var cfg = loadConfig();
var isConfigured = function () {
  if (cfg.backend === 'supabase') return Boolean(cfg.supaUrl && cfg.supaKey && sbUser);
  return Boolean(cfg.apiUrl && cfg.token);
};

// ----------------------------------------------------------------- supabase
/* The second backend, and the one that fixes what Apps Script could not: taps
 * in ~0.35s instead of 2-30s, and a live feed so the two devices correct each
 * other without anyone pressing refresh.
 *
 * It answers the SAME action names and the same response shapes, so everything
 * downstream — the serialised queue, the retry rules, the shape guard, the
 * optimistic rows, the day replay — is untouched by the move.
 *
 * The rows keep their meanings from the Sheet. Prayers are not a separate
 * table: they are events of type 'prayer' carrying the name in `project` and
 * the mode in `detail`, which is what the Sheet's extra tab was really for. */

var sb = null;                 // the Supabase client, once configured
var sbUser = null;             // the signed-in user, or null

function usingSupabase() {
  return cfg.backend === 'supabase';
}

function supabaseReady() {
  return Boolean(sb && sbUser);
}

/** Build (or rebuild) the client from whatever is in Settings. */
function initSupabase() {
  sb = null;
  sbUser = null;
  if (!cfg.supaUrl || !cfg.supaKey) return;
  if (typeof supabase === 'undefined' || !supabase.createClient) return;

  sb = supabase.createClient(cfg.supaUrl.trim().replace(/\/+$/, ''), cfg.supaKey.trim(), {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  sb.auth.getSession().then(function (res) {
    adoptSession(res && res.data ? res.data.session : null);
  });

  // Covers the return trip from GitHub, and a token refreshing in the background.
  sb.auth.onAuthStateChange(function (_event, session) {
    adoptSession(session);
  });
}

function adoptSession(session) {
  var before = sbUser && sbUser.id;
  sbUser = session ? session.user : null;
  paintAccount();

  if (!usingSupabase()) return;
  if (sbUser && sbUser.id !== before) {
    signInDlg.close();
    watchLive();
    refresh();
  } else if (!sbUser) {
    stopLive();
    askSignIn();
  }
}

/** Midnight this morning, where the device is, as an instant the database can
 *  compare against. "Today" has to roll over where the user actually is. */
function localDayStartIso() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function sbRow(r) {
  return {
    at: r.at, local: r.local_time || '', type: r.type,
    raw_text: r.raw_text || '', project: r.project || '', detail: r.detail || ''
  };
}

async function sbInsert(payload) {
  var row = {
    at: new Date().toISOString(),
    local_time: humanLocal(),
    tz: deviceTz(),
    type: payload.type || 'work',
    raw_text: String(payload.raw_text || ''),
    project: String(payload.project || ''),
    detail: String(payload.detail || ''),
    rid: payload.rid || null
  };

  var res = await sb.from('events').insert(row);
  if (res.error) {
    /* 23505 is the unique index on (user_id, rid): this exact write already
     * landed and only its answer was lost. That is a success, not a failure —
     * it is the whole reason a retry is safe here. */
    if (res.error.code === '23505') return { duplicate: true };
    throw errorFrom(res.error);
  }
  return { duplicate: false };
}

function errorFrom(e) {
  var err = new Error(e.message || 'request failed');
  // A refusal from the database will refuse again; do not spend retries on it.
  if (e.code && e.code !== 'PGRST301') err.fatal = true;
  return err;
}

/** "Wed 27 Aug, 04:58 PM" — the same readable stamp the Sheet carried. */
function humanLocal() {
  try {
    return new Date().toLocaleString(undefined, {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (e) {
    return '';
  }
}

async function callSupabase(action, payload) {
  if (!sb) throw new Error('Add your Supabase details in Settings.');
  if (!sbUser) throw new Error('Sign in to keep logging.');
  payload = payload || {};

  if (action === 'ping') {
    var p = await sb.from('events').select('id').limit(1);
    if (p.error) throw errorFrom(p.error);
    return { ok: true, pong: true, tz: deviceTz() };
  }

  if (action === 'today') {
    var res = await sb.from('events').select('*')
      .gte('at', localDayStartIso())
      .order('at', { ascending: false })
      .limit(1000);
    if (res.error) throw errorFrom(res.error);

    var rows = res.data || [];
    var log = [];
    var prayers = [];

    rows.forEach(function (r) {
      if (r.type === 'prayer') {
        prayers.push({ at: r.at, local: r.local_time || '',
                       prayer: r.project || '', mode: r.detail || '' });
      } else {
        log.push(sbRow(r));
      }
    });

    return {
      ok: true,
      date: localDayStartIso().slice(0, 10),
      log: log,
      prayers: prayers,
      m_count: log.filter(function (x) { return x.type === 'M'; }).length,
      now: { text: '', updated: '' }
    };
  }

  if (action === 'log') {
    if (!String(payload.raw_text || '').trim() && payload.type !== 'M') {
      var empty = new Error('empty_text');
      empty.fatal = true;
      throw empty;
    }
    await sbInsert(payload);
    return { ok: true, type: payload.type || 'work', raw_text: payload.raw_text || '' };
  }

  if (action === 'label') {
    /* THE ONE THING IN THIS APP THAT CHANGES A ROW THAT IS ALREADY WRITTEN, and
     * it may only ever fill in a blank. `rid` names the row — it is unique per
     * user, which is why it can be used as an address — and the database refuses
     * anything wider: the policy in docs/supabase_schema.sql matches only a row
     * of this user's whose `project` is still empty, and the column grant beside
     * it means `raw_text`, `at` and `type` cannot be touched from the browser at
     * all. So the human record stays exactly as typed, whatever this code does.
     *
     * `labelled` is observed, not assumed. If that policy has not been run yet
     * the update quietly matches no rows rather than failing, and the caller must
     * be able to tell the difference — an unlabelled row is fine, a screen that
     * claims a label the database never took is not. */
    var lab = await sb.from('events')
      .update({ project: String(payload.project || ''),
                detail: String(payload.detail || '') })
      .eq('rid', payload.rid)
      .select('id');
    if (lab.error) throw errorFrom(lab.error);
    return { ok: true, labelled: (lab.data || []).length > 0 };
  }

  if (action === 'm') {
    await sbInsert({ type: 'M', raw_text: '', rid: payload.rid });
    var c = await sb.from('events').select('id', { count: 'exact', head: true })
      .eq('type', 'M').gte('at', localDayStartIso());
    if (c.error) throw errorFrom(c.error);
    return { ok: true, m_count: c.count || 0 };
  }

  if (action === 'prayer') {
    var name = String(payload.prayer || '').trim();
    var mode = String(payload.mode || '').trim();
    if (PRAYER_NAMES.indexOf(name) === -1 || PRAYER_MODES.indexOf(mode) === -1) {
      var bad = new Error('bad_prayer');
      bad.fatal = true;
      throw bad;
    }
    await sbInsert({ type: 'prayer', raw_text: name + ' · ' + mode,
                     project: name, detail: mode, rid: payload.rid });
    return { ok: true, prayer: name, mode: mode };
  }

  if (action === 'review') return { ok: true, stub: true, text: 'Review arrives in Stage 5.' };
  /* DEAD ON PURPOSE, and not a Stage 4 gap. The plan's step 2 was a one-line
   * "what am I doing right now", written by a model after every log. The two
   * state pills under the logo replaced it: they say the same thing, they are
   * computed from the rows rather than asserted by an LLM, and they cannot go
   * stale. Nothing in the app calls these two; they answer only because the
   * Apps Script fallback still has the tab. Deleting them is a separate job. */
  if (action === 'now_get' || action === 'now_set') return { ok: true, now: { text: '', updated: '' } };

  var unknown = new Error('unknown_action');
  unknown.fatal = true;
  throw unknown;
}

/**
 * Every row between two instants, oldest first — the `today` read widened to a
 * date range, and the only new read Stage 5 needs.
 *
 * NOT AN ACTION, and not through api(). It sits outside the ACTIONS map for the
 * same reason earliestEventAt() does: reviews run on Supabase only, so there is
 * no Apps Script half to keep in step, and inventing one would mean an
 * ANSWER_FIELD entry and a Code.gs branch for a backend that will never serve
 * this screen. Rule 0's serialised queue is about Apps Script under a burst;
 * this is one Postgres select that nobody is mid-tap behind.
 *
 * PRAYERS ARE KEPT. The `today` branch splits them into their own list because
 * the Today tab draws them separately; the review counts them out of the same
 * stream as everything else, so splitting here would only mean rejoining later.
 *
 * The second `order` is the tie-break. `at` carries milliseconds, so two rows
 * sharing one instant is rare — but when it happens, Postgres is free to return
 * them in any order, and replayDay() reads position as append order. created_at
 * is the row's actual arrival, so ordering on it makes that assumption true
 * rather than lucky.
 */
async function rangeEvents(startIso, endIso) {
  if (!sb || !sbUser) throw new Error('Sign in to read your rows.');

  var res = await sb.from('events').select('*')
    .gte('at', startIso)
    .lte('at', endIso)
    .order('at', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(5000);
  if (res.error) throw errorFrom(res.error);

  /* `lte` can pick up a row stamped exactly at the closing midnight, which
   * belongs to the next day. Harmless: the day windows below drop it, because
   * a day is [midnight, next midnight) — closed at the start, open at the end,
   * so no instant can land in two days or in none. */
  return (res.data || []).map(sbRow);
}

// ---------------------------------------------------------------------- api

/** This device's IANA timezone, e.g. "Asia/Karachi". The backend stamps rows
 *  with it, so logs read in local time and "today" rolls over where you are. */
function deviceTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (e) {
    return '';
  }
}

/**
 * Call the backend.
 *
 * The Content-Type MUST stay text/plain. Sending application/json makes the
 * browser fire a preflight OPTIONS request, which Apps Script web apps cannot
 * answer — the call would fail with an opaque CORS error before reaching us.
 * Apps Script also 302-redirects to googleusercontent.com, hence redirect:follow.
 */
/* A field only that action's own reply carries. Apps Script's redirect hop
 * intermittently serves the doGet body instead — {ok:true, service:'probeing'}
 * — which passes an `ok` check and then blanks the screen, because data.log is
 * undefined and the whole day renders empty behind a green dot. An `ok` alone
 * is not proof the answer belongs to the question. */
var ANSWER_FIELD = {
  ping: 'pong',
  today: 'log',
  m: 'm_count',
  log: 'type',
  prayer: 'prayer',
  now_get: 'now',
  now_set: 'now',
  review: 'text',         // unused until Stage 5, but it is already in IDEMPOTENT
  // Supabase only. The Apps Script fallback has no `label` action, and nothing
  // asks it for one: extraction is switched off entirely on that backend.
  label: 'labelled'
};

/* Measured against the live backend: a HEALTHY call answers in 1.7s. The bad
 * ones do not answer slowly — they hang for 30-40 seconds and then return an
 * HTML error page, the wrong body, or nothing at all. So a call that has not
 * answered in this long is not slow, it is already lost; abandoning it and
 * trying again is far quicker than waiting for it to fail.
 *
 * Set below some genuine successes, which would once have been a bad trade. The
 * rid changed that: abandoning a call that actually landed now costs nothing,
 * because the retry replays the stored answer instead of appending a second row.
 *
 * Raised from 5s: the backend has since degraded to 4-7s on a GOOD run, so 5s
 * had drifted inside the normal range and the app was retrying healthy calls,
 * doubling traffic against something already struggling. This number tracks the
 * platform, and the platform is being replaced. */
var REQUEST_TIMEOUT_MS = 9000;

async function callBackend(action, payload) {
  if (usingSupabase()) return callSupabase(action, payload);
  return callAppsScript(action, payload);
}

async function callAppsScript(action, payload) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : 0;

  var res;
  try {
    res = await fetch(cfg.apiUrl, {
      method: 'POST',
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({
        action: action,
        token: cfg.token,
        tz: deviceTz()
      }, payload || {}))
    });
  } catch (netErr) {
    clearTimeout(timer);
    if (netErr && netErr.name === 'AbortError') {
      // Retryable: the next attempt usually lands in under two seconds.
      throw new Error('The Sheet took too long to answer.');
    }
    throw netErr;
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error('HTTP ' + res.status);

  var data;
  try {
    data = await res.json();
  } catch (parseErr) {
    // Apps Script hands back its own HTML shell under load. Saying so beats
    // showing the user `Unexpected token '<', "<!DOCTYPE "...`.
    throw new Error('The Sheet did not answer properly.');
  }

  if (!data.ok) {
    // The backend answered and said no. Repeating it will not change its mind.
    var refusal = new Error(data.error || 'request failed');
    refusal.fatal = true;
    throw refusal;
  }

  var field = ANSWER_FIELD[action];
  if (field && data[field] === undefined) {
    throw new Error('The Sheet answered a different question.');
  }

  // Learn once, from any reply, whether this deployment deduplicates by rid.
  if (data.rid_ok) backendDedupes = true;
  return data;
}

/* Apps Script under a burst is genuinely flaky. Fire a few requests back to
 * back and some come back HTTP 404 — not from doPost, but from the
 * googleusercontent.com host it 302-redirects to. Measured: 4 of 12 parallel
 * pings 404'd, and calls took up to 58s, because doPost takes a script lock on
 * EVERY action, so a read queues behind a write. Sequentially, 12 of 12 were
 * clean. So: one request at a time, through a promise chain — this device never
 * competes with itself for that lock.
 *
 * WHY WRITES MAY NOW BE RETRIED:
 *
 * A lost reply usually means the request DID reach doPost and the row WAS
 * written. Retrying blind would append it twice, and the Sheet is append-only —
 * a doubled M cannot be undone. So every write carries a `rid`, generated once
 * here and reused across all attempts; `Code.gs` replays the original answer
 * rather than doing the work again. That is what makes giving up after 7
 * seconds safe, and it is why the rid is added in api() and not in
 * attemptCall() — a retry with a fresh rid would defeat the whole thing. */

/* Retrying a write is only safe against a backend that deduplicates by rid, and
 * the two halves deploy separately — a git push for the app, a manual
 * re-version for Apps Script. So this is not assumed, it is observed: every
 * reply from the new Code.gs carries `rid_ok`, and until one has been seen a
 * write gets a single attempt. That way the app is correct whichever order the
 * two deployments happen in, instead of depending on the user doing them in
 * the right order. */
var backendDedupes = false;

var IDEMPOTENT = { ping: 1, today: 1, now_get: 1, review: 1 };
var MAX_TRIES = 3;
var RETRY_DELAY_MS = 500;
var apiChain = Promise.resolve();

/** Enough entropy that two devices cannot collide within the backend's memory
 *  of the last 20 requests. */
function newRid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function attemptCall(action, payload, opts) {
  var last;
  var tries = (IDEMPOTENT[action] || backendDedupes) ? MAX_TRIES : 1;
  if (opts && opts.tries) tries = Math.min(tries, opts.tries);

  for (var i = 0; i < tries; i++) {
    try {
      return await callBackend(action, payload);
    } catch (err) {
      last = err;
      if (err && err.fatal) throw err;          // a real refusal, not a hiccup
      if (i === tries - 1) throw err;
      await wait(RETRY_DELAY_MS);
    }
  }
  throw last;
}

var inFlight = 0;

async function trackedCall(action, payload, opts) {
  /* Both lines inside the try: if setConn ever threw, the finally would not run,
   * inFlight would leak upward for the session, and the poll — which refuses to
   * fire while anything is in flight — would be silently dead forever. */
  var startedAt = Date.now();
  try {
    inFlight += 1;
    setConn('busy');
    var data = await attemptCall(action, payload, opts);
    lastCallMs = Date.now() - startedAt;
    setConn('ok');
    return data;
  } catch (err) {
    setConn('bad');
    throw err;
  } finally {
    inFlight -= 1;
  }
}

/** Call the backend. Serialised — see the note above. */
function api(action, payload, opts) {
  if (!isConfigured()) return Promise.reject(new Error('Not configured — open Settings.'));

  // One rid per logical write, fixed before the first attempt so every retry
  // carries the same one. Reads need none.
  if (!IDEMPOTENT[action]) {
    payload = Object.assign({ rid: newRid() }, payload || {});
  }

  var run = apiChain.then(
    function () { return trackedCall(action, payload, opts); },
    function () { return trackedCall(action, payload, opts); }  // a failure must not wedge the queue
  );
  apiChain = run.then(function () {}, function () {});
  return run;
}

// -------------------------------------------------------------- live updates

/* What polling was a stand-in for. The database tells us the moment a row
 * appears — from this device or the other one — so the two stay in step without
 * anybody pressing refresh, and without the guessing that let one device
 * overwrite the other's break reasons.
 *
 * It still only triggers a reconcile rather than trusting the payload: the
 * database is the truth, and one code path reading it is easier to keep honest
 * than two. */
var liveChannel = null;

function watchLive() {
  if (!sb || !sbUser || liveChannel) return;
  liveChannel = sb.channel('probeing-events')
    /* '*', not 'INSERT': a project label is an UPDATE to a row that already
     * exists, so an INSERT-only subscription never hears it and the other
     * device keeps showing the raw sentence until its next 45s poll. Postgres
     * does broadcast the update; the gap was purely on this side. */
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'events' },
        function () { scheduleRefresh(400); })
    .subscribe();
}

function stopLive() {
  if (!liveChannel) return;
  try { sb.removeChannel(liveChannel); } catch (e) { /* already gone */ }
  liveChannel = null;
}

// ------------------------------------------------------------------ helpers

var $ = function (id) { return document.getElementById(id); };
var bannerTimer;

/* The dot beside the cog. Green = the last call to the Sheet worked, red = it
 * did not, amber = one is in flight. Small on purpose: a status light, not an
 * alarm. It is the honest answer to "is it just slow, or is it broken?" */
var connState = '';
var CONN_TITLES = {
  ok: 'Connected — the Sheet answered',
  bad: 'Not reaching the Sheet. Tap the cog to check Settings.',
  busy: 'Talking to the Sheet…'
};

function setConn(state) {
  if (state === connState) return;
  connState = state;
  var el = $('connDot');
  if (!el) return;
  el.className = 'dot ' + state;
  el.title = CONN_TITLES[state] || 'Not connected';
}

function flash(message, kind) {
  var el = $('banner');
  el.textContent = message;
  el.className = 'banner' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(function () { el.hidden = true; }, 2600);
}

/** Acknowledge a write on the control that was pressed. The banner is a
 *  backstop; this is what you see if you tap and immediately look away. */
function confirmPulse(el) {
  el.classList.remove('confirm');
  void el.offsetWidth;                       // forces a reflow so a fast second tap replays it
  el.classList.add('confirm');
  setTimeout(function () { el.classList.remove('confirm'); }, 550);
}

/* The in-flight disable below covers the round trip, but if the backend answers
 * almost instantly a second tap can still land and write the reversing row
 * (sleep then wake, or two Ms). A short cooldown after a successful press closes
 * that gap; it is far shorter than any deliberate second press. */
var TAP_COOLDOWN_MS = 400;

/** Keep `btn` disabled a moment longer after a write that actually happened. */
function coolDown(btn) {
  btn.disabled = true;
  setTimeout(function () { btn.disabled = false; }, TAP_COOLDOWN_MS);
}

/** "2026-08-23T14:05:00+05:00" -> "14:05". Falls back to the raw string. */
function clockOf(entry) {
  var m = /T(\d{2}:\d{2})/.exec(entry.at || '');
  if (m) return m[1];
  var h = /(\d{1,2}:\d{2}\s*[AaPp][Mm])/.exec(entry.local || '');
  return h ? h[1] : '';
}

/** ISO timestamp -> milliseconds since epoch, or NaN if it cannot be read. */
function instantOf(at) {
  return Date.parse(String(at));
}

/** 8_100_000 -> "2h 15m". Minutes only under an hour; never "0h". */
function humanDuration(ms) {
  var mins = Math.max(0, Math.round(ms / 60000));
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  if (!h) return m + 'm';
  return h + 'h ' + m + 'm';
}

/**
 * The same duration, but honest below a minute. THE REVIEW USES THIS; the
 * Today tab deliberately does not.
 *
 * Rounded to the minute, a 17-second entry reads "0m" — and a zero on a review
 * screen is a claim that no time was spent on something Saad really did spend
 * time on. Same rule as the date floor and the sleep line: refuse to state a
 * confident nothing. Dropping the row instead would hide it altogether, and a
 * minimum threshold would be a made-up number.
 *
 * Today keeps whole minutes because its figures are live and a seconds field
 * that ticks is noise while you are working; a review is a record being read
 * once, so the small true number is worth the extra character.
 */
function reviewDuration(ms) {
  var n = Math.max(0, Math.round(Number(ms) || 0));
  var secs = Math.round(n / 1000);
  // 0 is reserved for nothing at all: any real span shows at least 1s.
  if (n > 0 && secs < 60) return Math.max(1, secs) + 's';
  return humanDuration(n);
}

/** Point one <use> element at a different sprite symbol. */
function setIcon(el, id) {
  el.setAttribute('href', '#' + id);
}

/** Replace the log list with a single muted message. Built as a node, never
 *  as an HTML string, so this path can never become an injection point. */
function showEmpty(message) {
  var list = $('logList');
  list.textContent = '';
  var li = document.createElement('li');
  li.className = 'empty';
  li.textContent = message;
  list.appendChild(li);
}

// ------------------------------------------------------------------- screens

var currentScreen = 'home';

function showScreen(name) {
  currentScreen = name;

  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) {
    screens[i].hidden = screens[i].dataset.screen !== name;
  }

  var tabs = document.querySelectorAll('.tab');
  for (var j = 0; j < tabs.length; j++) {
    tabs[j].classList.toggle('is-on', tabs[j].dataset.goto === name);
  }

  window.scrollTo(0, 0);
  if (name === 'today') renderDaySummary();     // catch up the clock on arrival
  if (name === 'review') openReview();
}

/* Only tabs that name a screen switch screens. The taskboard tab is also a
 * .tab but carries no data-goto — without this guard it would call
 * showScreen(undefined), which matches no screen and hides all of them. */
(function wireTabs() {
  var tabs = document.querySelectorAll('.tab[data-goto]');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () { showScreen(this.dataset.goto); });
  }
})();

/** The device's clock in the backend's own format, so a row we add locally
 *  sorts and displays exactly like the real one that replaces it. */
function localIso(d) {
  d = d || new Date();
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var off = -d.getTimezoneOffset();
  var sign = off < 0 ? '-' : '+';
  off = Math.abs(off);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
         'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
         sign + pad(Math.floor(off / 60)) + ':' + pad(off % 60);
}

/* Showing the row we just wrote, instead of asking the Sheet to read it back,
 * is what takes a tap from two round trips down to one — and two round trips
 * per tap is what was producing the 404s. The Sheet still wins: the reconcile
 * below replaces this list wholesale a few seconds later.
 *
 * Rows go in newest-first, matching today(), because replayDay() breaks
 * same-second ties on that order. */
function noteLocalRow(type, text, project, detail) {
  var row = {
    at: localIso(), local: '', type: type,
    raw_text: text || '', project: project || '', detail: detail || ''
  };
  lastLog.unshift(row);
  renderProject();
  renderDaySummary();
  renderLogList();
  renderChips();                 // the active break reason may have changed
  scheduleRefresh();
  /* Handed back so a caller that learns something a moment later can correct
   * this row rather than adding a second one. Only the tracker does that, and
   * only to fill in the project Gemini extracted; every other caller ignores it. */
  return row;
}

var refreshTimer;
var BACKGROUND_REFRESH_MS = 9000;
var FAILED_WRITE_REFRESH_MS = 4000;

/* POLLING, and why it is only half an answer.
 *
 * The two devices cannot tell each other anything: Apps Script only speaks when
 * spoken to. So the app asks, on a timer, whenever it is on screen. That closes
 * the "nothing changes until I refresh" gap to about a minute.
 *
 * It does NOT close the race underneath it. A break row carries the whole
 * current set, so a device working from a stale view overwrites what the other
 * one added — press Dinner on the laptop, then Tea on a phone that has not
 * caught up, and Dinner is gone. Polling narrows that window; only a backend
 * that pushes closes it, which is what the move to Supabase is for. */
var POLL_MS = 45000;
var lastReconcileAt = 0;

/* THE POLL MUST NOT MAKE THINGS WORSE.
 *
 * Measured: against a backend answering in 20-30s, a fixed 45s poll turns one
 * request an hour into 239, and a single idle device then demands more than the
 * whole available lock-hour — so the other device's taps queue behind it. That
 * is a route to the very 404 bursts the rest of this file exists to survive.
 *
 * So the interval tracks how slow the backend actually is. A healthy 1.7s call
 * keeps the 45s default; a 7s call stretches it to ~84s; a 30s call to six
 * minutes. The poll stands back exactly when standing back is what helps. */
var lastCallMs = 0;
var LIVE_HEARTBEAT_MS = 300000;      // 5 minutes, purely a dead-socket check
var POLL_DUTY = 12;                  // never spend more than ~1/12th of the time polling

function pollInterval() {
  return Math.max(POLL_MS, Math.round(lastCallMs * POLL_DUTY));
}

/**
 * A write failed. Say so — and reconcile shortly after, because this is the
 * other half of the no-retry decision above.
 *
 * An Apps Script 404 usually means the row DID land and only the answer was
 * lost. Reporting the failure and then leaving the screen alone is the worst of
 * both worlds: it shows a number the Sheet contradicts, and the natural
 * response is to tap again — creating by hand exactly the duplicate that not
 * retrying was meant to prevent. So the Sheet gets the last word, quickly.
 */
function writeFailed(err) {
  flash(String(err.message || err), 'err');
  scheduleRefresh(FAILED_WRITE_REFRESH_MS);
}

/**
 * Run a sequence of writes in the background.
 *
 * THE TRADE, stated plainly: the screen updates on the tap and the request
 * drains behind it. A healthy call is 1.7s and a sick one hangs for 40, so
 * making the button wait for the network meant the button was sometimes dead
 * for half a minute — against a project rule that says every logging action
 * stays under five seconds. Showing the result first and correcting it if the
 * write fails is the better of the two wrongs, because writeFailed() reconciles
 * against the Sheet and the Sheet always wins.
 *
 * Sequential on purpose: a chain means step 2 does not run if step 1 failed, so
 * a `resume` can never be written without the `wake` that had to precede it.
 *
 * It resolves with true only if every step landed. Nothing has to look — the
 * failure is already reported and reconciled here — but the tracker does, because
 * asking the database to label a row that was never written is a wasted call
 * against a backend this app is careful not to talk to twice.
 */
function runWrites(steps, undo) {
  var chain = Promise.resolve();
  steps.forEach(function (step) {
    chain = chain.then(function () { return api('log', step); });
  });
  return chain.then(function () {
    return true;
  }, function (err) {
    if (undo) restoreToggles(undo);
    writeFailed(err);
    return false;
  }).then(function (wrote) {
    if (undo) endToggleWrite();          // release the baseline once drained
    return wrote;
  });
}

/** The same idea for the one write that is not a `log` row. */
function runWrite(action, payload) {
  return api(action, payload).catch(function (err) { writeFailed(err); });
}

/** Reconcile with the Sheet soon, but never on the tap itself. Repeated taps
 *  coalesce into one call instead of firing one each. */
function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(function () { refresh(); },
    typeof delay === 'number' ? delay : BACKGROUND_REFRESH_MS);
}

// ------------------------------------------------------------------- render

/** Prayers live in their own Sheet tab, so the Today list is the two streams
 *  merged, newest first. Rows are stamped with the posting device's timezone
 *  offset, so text comparison would mis-order anything logged from a different
 *  offset; compare the real instants instead. */
function todayEntries(data) {
  var entries = (data.log || []).slice();

  (data.prayers || []).forEach(function (p) {
    entries.push({
      at: p.at,
      local: p.local,
      type: 'prayer',
      raw_text: p.prayer + ' · ' + p.mode
    });
  });

  // A row with an unparseable timestamp sinks to the bottom instead of poisoning
  // the whole ordering (NaN comparisons are neither < nor >, which some sort
  // implementations turn into arbitrary output).
  entries.sort(function (a, b) {
    var ta = instantOf(a.at);
    var tb = instantOf(b.at);
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return tb - ta;
  });
  return entries;
}

var lastLog = [];        // today's rows from the last successful refresh
var todayPrayers = [];   // today's prayer rows; drives the ticks and the picker

function renderToday(data) {
  $('mCount').textContent = data.m_count + ' today';

  lastLog = data.log || [];

  // Today's rows are the shared truth between devices: they correct the toggles
  // and they teach the chip order.
  reconcileToggles(lastLog);
  absorbChipStats(lastLog);
  renderProject();

  // The picker's checkmarks and the Home ticks are both driven by this.
  todayPrayers = data.prayers || [];
  renderPrayerTicks();
  if (prayerDlg.open) renderPrayerPicks();

  renderDaySummary();
  renderLogList();
}

/** The Today tab's list, drawn from whatever is currently in memory — the last
 *  refresh, plus anything written since. */
function renderLogList() {
  var entries = todayEntries({ log: lastLog, prayers: todayPrayers });
  var list = $('logList');
  list.textContent = '';

  if (!entries.length) {
    showEmpty('No entries yet today.');
    return;
  }

  entries.forEach(function (entry) {
    var li = document.createElement('li');

    var when = document.createElement('span');
    when.className = 'when';
    when.textContent = clockOf(entry);

    var what = document.createElement('span');
    what.className = 'what';
    // textContent, not markup — log text is user input and must never be parsed as HTML.
    what.textContent = entry.raw_text || (entry.type === 'M' ? '—' : '');

    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = entry.type;

    li.append(when, what, tag);
    list.appendChild(li);
  });
}

async function refresh(opts) {
  clearTimeout(refreshTimer);
  lastReconcileAt = Date.now();
  lastVisibleRefresh = Date.now();      // one shared clock, so the two paths cannot double up
  if (!isConfigured()) {
    showEmpty('Open Settings to connect.');
    return;
  }
  try {
    renderToday(await api('today', null, opts));
    if (opts && opts.announce) flash('Up to date', 'ok');
  } catch (err) {
    flash(String(err.message || err), 'err');
  }
}

/* A map whose KEYS ARE THINGS THE USER TYPED — a project, a break reason, a
 * task, a prayer mode.
 *
 * `Object.create(null)`, never `{}`, and only for this kind of map. On a plain
 * object the one key `__proto__` is not a key at all: it is an accessor
 * inherited from Object.prototype, so `map['__proto__'] = ms` runs a SETTER,
 * changes nothing, and reads back as the prototype object. A project called
 * `__proto__` therefore loses its hours silently — not misfiled, gone — while
 * still counting in the day's total, so the figures stop adding up and nothing
 * says why. Every other awkward name (`constructor`, `toString`, `valueOf`)
 * already worked, which is how this one stayed hidden.
 *
 * A map with no prototype has no setter to fall through to, and no inherited
 * members either — which is the same reason the reads around here go through
 * hasOwnProperty and Array.isArray. Nothing else changes: Object.keys, delete
 * and JSON.stringify all behave exactly as before. */
function userMap() {
  return Object.create(null);
}

// -------------------------------------------------------- the current project

/* Point 6: the project comes from what you typed, not from a picker. Walk
 * today's rows in order and replay the day: a tracker entry names the project
 * and starts the clock, break/off/sleep stop it, resume starts it again.
 *
 * A break does not change the project — you come back to the same thing — it
 * only pauses the clock, because "hours worked" must not include the coffee. */
/**
 * @param log    the day's rows, NEWEST FIRST (see the tie-break note below).
 * @param endMs  where the day stops, in milliseconds. Omit it for today, which
 *               stops now.
 *
 * `endMs` is what makes this reusable for the review, and leaving it out was
 * the single most expensive thing the range code could have inherited. An open
 * clock runs to the ceiling: 31 Aug has two work rows and nothing closing them,
 * so replaying that day with today's ceiling reports about 2.9 DAYS worked
 * instead of seven hours. The review passes the end of each day; nothing else
 * passes anything, so today is unchanged.
 */
function replayDay(log, endMs) {
  /* Sheet timestamps are second-precision, so two rows written inside the same
   * second tie. A stable sort would then keep the input order — and today()
   * hands rows back NEWEST FIRST, which replays a same-second pair backwards
   * (End the day, Start the day -> looks like Start then End). The Sheet's own
   * row order is append order, i.e. chronological, so the later a row sits in
   * this array the older it is: break the tie on that. */
  var rows = (log || []).map(function (r, i) {
    return { r: r, i: i };
  }).filter(function (x) {
    return !isNaN(instantOf(x.r.at));
  }).sort(function (a, b) {
    return (instantOf(a.r.at) - instantOf(b.r.at)) || (b.i - a.i);
  }).map(function (x) {
    return x.r;
  });

  /* SEVERAL THINGS CAN BE TRUE AT ONCE.
   *
   * You can be on two projects, and at dinner having tea. So the day is walked
   * as a set of ACTIVE things rather than a single current one: at every event
   * the span since the last event is credited to everything that was active
   * across it.
   *
   * That makes the totals overlap on purpose. `worked` is wall-clock time with
   * the clock running, so it is still a real number of hours in your day;
   * sum(byProject) can EXCEED it, because two hours spent on two projects at
   * once is two hours of your life and two hours of each project. Same for
   * `paused` against byReason. Anything else would either invent hours or
   * quietly halve the time you spent on something. */
  var active = userMap();                   // project -> 1, currently being worked on
  var reasons = userMap();                  // break reason -> 1, currently applying
  var byProject = userMap();
  var byReason = userMap();
  var worked = 0;
  var paused = 0;
  /* The clock keeps running after the last Done — you are still at work, just
   * not on anything named. "Worked 9h / Projects: A 3h" would leave six hours
   * silently missing, so they are counted here as they happen rather than
   * derived afterwards: with projects run one after another rather than at the
   * same time, no arithmetic on the totals can tell the difference. */
  var unattributed = 0;

  var clock = false;                        // is the work clock running
  var underWay = false;                     // is there time worth counting yet
  var dayClosed = false;                    // ended for the night, or asleep
  var lastT = 0;
  var order = [];                           // projects, most recently started last

  /* Never credit past this instant. A device clock running behind the server
   * makes real rows look like the future, and the day would inflate until the
   * clock was corrected — 14 hours "worked" at 5pm, from one row stamped 23:00.
   * The old code guarded only negative spans, so this is an old hole, closed.
   *
   * Math.min, so a caller can only ever pull the ceiling BACK. A past day stops
   * at its own midnight; today's window asks for midnight tonight and still
   * stops now. That keeps the future guard above where it belongs — inside this
   * function — rather than making every caller remember it. */
  var now = Date.now();
  var ceiling = (typeof endMs === 'number' && isFinite(endMs)) ? Math.min(endMs, now) : now;

  /** Credit everything active up to `t`, then move the cursor there. */
  function advance(t) {
    if (t > ceiling) t = ceiling;
    if (lastT && t > lastT) {
      var span = t - lastT;
      if (clock) {
        worked += span;
        var names = Object.keys(active);
        if (!names.length) unattributed += span;
        names.forEach(function (p) {
          byProject[p] = (byProject[p] || 0) + span;
        });
      } else if (underWay) {
        paused += span;
        Object.keys(reasons).forEach(function (r) {
          byReason[r] = (byReason[r] || 0) + span;
        });
      }
    }
    if (t > lastT) lastT = t;
  }

  function remember(name) {
    var at = order.indexOf(name);
    if (at !== -1) order.splice(at, 1);
    order.push(name);
  }

  rows.forEach(function (row) {
    var t = instantOf(row.at);
    advance(t);

    var text = String(row.raw_text || '').trim();

    if (row.type === 'work' || row.type === 'voice') {
      // Adds, never replaces — that is the whole point of multitasking.
      var name = String(row.project || text).trim();
      if (name) { active[name] = 1; remember(name); }
      clock = true;
      underWay = true;
      dayClosed = false;
      reasons = userMap();
    } else if (row.type === 'done') {
      var finished = String(row.project || text).trim();
      delete active[finished];
      var idx = order.indexOf(finished);
      if (idx !== -1) order.splice(idx, 1);
    } else if (row.type === 'resume') {
      clock = true;
      underWay = true;
      dayClosed = false;
      reasons = userMap();
    } else if (row.type === 'break') {
      /* A chip STARTS the day if nothing else has.
       *
       * This used to require the day to be already under way, which made a chip
       * tapped as the first action of the morning do nothing at all — no light,
       * no break, though the row was written. Saying "I am at lunch" is itself a
       * statement that you are up and your day has begun; you are simply not
       * working this minute.
       *
       * The guard that matters is narrower than the one it replaces: a chip is
       * ignored only when the day has been explicitly CLOSED — after `off`, or
       * while asleep. That is what stops a stray tap booking the whole night as
       * coffee, without stopping the ordinary case. */
      if (!dayClosed) {
        clock = false;
        underWay = true;
        var move = parseBreakOp(text, row.detail);
        if (move.op === 'set') reasons = userMap();
        if (move.op !== 'keep') {
          move.names.forEach(function (r) {
            if (move.op === 'drop') delete reasons[r]; else reasons[r] = 1;
          });
        }
      }
    } else if (row.type === 'off' || row.type === 'sleep') {
      // The day being over is not "on break": nothing accrues after it.
      clock = false;
      reasons = userMap();
      underWay = false;
      dayClosed = true;
    }
    // wake / M / prayer do not move the work clock
  });

  advance(ceiling);                         // bring everything up to now

  var activeProjects = order.filter(function (p) { return active[p]; });
  var current = activeProjects.length ? activeProjects[activeProjects.length - 1] : '';

  return {
    project: current,                       // the most recent one, for a one-line readout
    ms: byProject[current] || 0,
    running: clock,
    activeProjects: activeProjects,
    byProject: byProject,
    worked: worked,
    unattributed: unattributed,
    paused: paused,
    breakReason: Object.keys(reasons).join(REASON_SEP),
    activeReasons: Object.keys(reasons),
    byReason: byReason
  };
}

/* The Today tab's header. Everything here is derived from the same rows the
 * list below shows — one source of truth, nothing stored, and it is right the
 * instant a row is written rather than after a round trip. */
function renderDaySummary() {
  var day = replayDay(lastLog);

  $('sumWorked').textContent = humanDuration(day.worked);
  $('sumBreak').textContent = humanDuration(day.paused);

  var done = PRAYER_NAMES.filter(function (n) { return loggedToday(n); }).length;
  $('sumPrayers').textContent = done + '/5';

  $('sumM').textContent = lastLog.filter(function (r) { return r.type === 'M'; }).length;

  var box = $('sumProjects');
  box.textContent = '';

  /** One "name .... 1h 20m" line. `muted` marks it as a break, not work;
   *  `finished` ticks a project you have pressed Done on. */
  function line(name, ms, muted, finished) {
    var li = document.createElement('li');

    var n = document.createElement('span');
    n.className = 'p-name' + (muted ? ' p-why' : '');

    if (finished) {
      var tick = document.createElement('span');
      tick.className = 'p-done';
      tick.textContent = '✓';
      n.appendChild(tick);
    }

    // textContent on a text node, never markup — this is user input.
    n.appendChild(document.createTextNode(name));

    var t = document.createElement('span');
    t.className = 'p-time';
    t.textContent = humanDuration(ms);

    li.append(n, t);
    box.appendChild(li);
  }

  var byTime = function (map) {
    return function (a, b) { return map[b] - map[a]; };
  };

  /* A project leaves `activeProjects` only by being pressed Done — `off` and
   * `sleep` stop the clock without closing anything — so "not active" is
   * exactly "finished", and earns the tick. */
  var open = userMap();                     // project names again — see userMap()
  day.activeProjects.forEach(function (p) { open[p] = 1; });

  Object.keys(day.byProject)
    .filter(function (name) { return name && day.byProject[name] > 0; })
    .sort(byTime(day.byProject))
    .forEach(function (name) {
      line(name, day.byProject[name], false, !open[name]);
    });

  // Where the break time actually went — Lunch 45m, Prayer-break 20m.
  if (day.unattributed > 0) line('Not on a named project', day.unattributed, true);

  Object.keys(day.byReason)
    .filter(function (why) { return why && day.byReason[why] > 0; })
    .sort(byTime(day.byReason))
    .forEach(function (why) { line(why, day.byReason[why], true); });
}

/* The sub-tasks logged against one project today, in the order they were said.
 *
 * The extraction splits a line into a project and what is being done to it, and
 * until now only the project half was ever shown — so "Working on NeuraVue,
 * resolving FPS jitter, model latency and fall modelling" appeared on screen as
 * the single word "NeuraVue", which reads exactly like the rest was thrown away.
 * It never was: raw_text keeps the sentence verbatim and `detail` holds the task.
 * This is what puts the second half back on the screen.
 *
 * Keyed the same way replayDay() keys a project — `project || raw_text` — because
 * two different answers to "which tile is this row on" is how tiles go missing.
 */
function projectTasks(rows, name) {
  var seen = {};
  var out = [];
  (rows || []).forEach(function (row) {
    if (row.type !== 'work' && row.type !== 'voice') return;
    var text = String(row.raw_text || '').trim();
    if (String(row.project || text).trim() !== name) return;

    /* No detail means the line was never split — either Gemini has not answered
     * yet, or it had nothing to add. The tile is already named after the whole
     * sentence in that case, so repeating it underneath says nothing twice. */
    String(row.detail || '').split(TASK_SEP).forEach(function (part) {
      var task = part.trim();
      if (!task || task === name) return;

      var key = task.toLowerCase();
      if (seen[key]) return;                // the same task logged twice is one line
      seen[key] = 1;
      out.push(task);
    });
  });
  return out;
}

function renderProject() {
  var day = replayDay(lastLog);
  var list = $('projList');
  var empty = $('projEmpty');

  list.textContent = '';
  empty.hidden = day.activeProjects.length > 0;

  if (!day.activeProjects.length) {
    empty.textContent = day.worked
      ? 'Nothing open. ' + humanDuration(day.worked) + ' worked today.'
      : 'Nothing yet — say what you are on below.';
    return;
  }

  // Most recently started first: that is the one you are most likely to finish.
  day.activeProjects.slice().reverse().forEach(function (name) {
    var li = document.createElement('li');

    var main = document.createElement('div');
    main.className = 'proj-main';

    var n = document.createElement('div');
    n.className = 'proj-name';
    n.textContent = name;                   // user input — textContent only

    var t = document.createElement('div');
    t.className = 'proj-time' + (day.running ? '' : ' paused');
    t.textContent = humanDuration(day.byProject[name] || 0) + ' today' +
                    (day.running ? '' : ' · paused');

    main.append(n, t);

    /* The sub-tasks, under their heading. Every one is either the user's own
     * words or a model's reading of them, so textContent throughout. */
    var tasks = projectTasks(lastLog, name);
    if (tasks.length) {
      var ul = document.createElement('ul');
      ul.className = 'proj-tasks';
      tasks.forEach(function (task) {
        var item = document.createElement('li');
        item.textContent = task;
        ul.appendChild(item);
      });
      main.appendChild(ul);
    }

    var done = document.createElement('button');
    done.type = 'button';
    done.className = 'done-btn';
    done.textContent = 'Done';
    done.addEventListener('click', function () { finishProject(done, name); });

    li.append(main, done);
    list.appendChild(li);
  });
}

/* Write the row that closes one project, without touching the others or the
 * work clock. Separate from the button handler because the tracker needs the
 * same row: closing a project is how an append-only store takes something back,
 * and a rename that reopens one has to be able to close it again. */
function closeProject(name) {
  noteLocalRow('done', name, name);
  runWrites([{ type: 'done', raw_text: name, project: name }]);
}

function finishProject(btn, name) {
  if (btn.disabled) return;
  coolDown(btn);
  closeProject(name);
  flash(name + ' — done', 'ok');
}

// The clock on screen should move without a round trip. Cheap: it only re-reads
// rows already in memory.
setInterval(function () {
  if (currentScreen === 'home') renderProject();
  if (currentScreen === 'today') renderDaySummary();
}, 30000);

// ----------------------------------------------------------------- M button

var mBtn = $('mBtn');

/* Disabled for the whole round trip: on a phone a double tap is a slip, not two
 * Ms, and the backend is append-only so a stray second row cannot be undone. */
var pendingWrites = 0;

mBtn.addEventListener('click', function () {
  if (mBtn.disabled) return;
  coolDown(mBtn);                    // 400ms against a slip, not the round trip

  $('mCount').textContent = ((parseInt($('mCount').textContent, 10) || 0) + 1) + ' today';
  confirmPulse(mBtn);
  noteLocalRow('M', '');

  pendingWrites += 1;
  api('m').then(function (res) {
    // The Sheet's number wins — but only once nothing else is still in flight,
    // or a reply computed three taps ago would undo the two taps after it.
    if (pendingWrites === 1) $('mCount').textContent = res.m_count + ' today';
  }).catch(function (err) {
    writeFailed(err);                // reconciles, which puts the real count back
  }).then(function () {
    pendingWrites -= 1;
  });
});

// ------------------------------------------------------ sleep / work toggles

/* Two tiles that swap identity. Each press writes ONE row whose type says which
 * edge of the pair it is, so a later stage can pair them into durations.
 *
 * The work side has THREE states, not two:
 *   working  — the clock runs
 *   break    — a pause you will come back from       (break -> resume)
 *   off      — the working day is over                (resume/break -> off)
 * Off is what going to bed does. A daytime nap only writes a break, because a
 * nap is not the end of the day; an evening Sleep writes 'off' and closes it.
 *
 * Where the state lives: localStorage is the primary store, because state has to
 * survive midnight — asleep at 23:30 is still asleep at 07:00, and today() only
 * ever returns today's rows. It is then reconciled against those rows, and any
 * row newer than the stored change wins, because the Sheet always wins.
 *
 * Known limit: localStorage is per device, so a sleep logged on the phone before
 * midnight leaves the laptop's toggle stale the next morning until a matching
 * row appears in today's log. Fixing that needs the backend to report state. */

var sleepBtn = $('sleepBtn');
var workBtn = $('workBtn');

// row type -> which toggle it moves, and to which state
var STATE_ROWS = {
  sleep: { kind: 'sleep', state: 'asleep' },
  wake: { kind: 'sleep', state: 'awake' },
  'break': { kind: 'work', state: 'break' },
  off: { kind: 'work', state: 'off' },
  resume: { kind: 'work', state: 'working' },
  work: { kind: 'work', state: 'working' },  // typing an entry means you are working
  voice: { kind: 'work', state: 'working' }  // and so does speaking one
};

var WORK_STATES = { working: 1, 'break': 1, off: 1 };

function loadToggles() {
  var out = { sleep: { state: 'awake', at: 0 }, work: { state: 'working', at: 0 } };
  try {
    var s = JSON.parse(localStorage.getItem(TOGGLE_KEY)) || {};
    // Only known states are accepted; a corrupt value must not wedge the UI.
    if (s.sleep && (s.sleep.state === 'awake' || s.sleep.state === 'asleep')) {
      out.sleep = { state: s.sleep.state, at: Number(s.sleep.at) || 0 };
    }
    if (s.work && WORK_STATES[s.work.state]) {
      out.work = { state: s.work.state, at: Number(s.work.at) || 0 };
    }
  } catch (e) { /* fall back to awake + working */ }
  return out;
}

var toggles = loadToggles();

/* Optimistic toggles need an undo, and reconcileToggles cannot be it.
 *
 * That function is monotonic on purpose — it only adopts a row NEWER than the
 * local change — which is what stops an old row from resurrecting a stale state.
 * But an optimistic setToggle stamps Date.now(), so no real row can ever be
 * newer than it, and a toggle moved for a write that then failed would be stuck
 * wrong forever. Worse than a wrong label: the button's meaning flips with the
 * state, so the next tap does the opposite of what the user intends.
 *
 * So a failed write puts the toggles back exactly as they were. That restores
 * the OLD timestamps too, which is the point — any row that did land is once
 * again newer, so the reconcile a moment later re-adopts it. A half-failed pair
 * (`wake` landed, `resume` did not) therefore ends up correct without this code
 * having to know which half it was. */
function toggleSnapshot() {
  return {
    sleep: { state: toggles.sleep.state, at: toggles.sleep.at },
    work: { state: toggles.work.state, at: toggles.work.at }
  };
}

/* Copies out, never aliases. Two failed taps in a burst restore from the SAME
 * snapshot object, and assigning it directly would let the next setToggle
 * mutate the thing the second undo still needs. */
function restoreToggles(snap) {
  toggles = {
    sleep: { state: snap.sleep.state, at: snap.sleep.at },
    work: { state: snap.work.state, at: snap.work.at }
  };
  localStorage.setItem(TOGGLE_KEY, JSON.stringify(toggles));
  paintToggles();
}

/* THE BASELINE IS THE LAST CONFIRMED STATE, NOT THE LAST SEEN ONE.
 *
 * Snapshotting the live toggles works for one tap and breaks for two. Tap Break
 * (optimistic), then tap Work three seconds later: the second snapshot records
 * "break", which the Sheet never held. If both writes then fail, the undos run
 * oldest-first and the last one wins — leaving the app in a state that never
 * existed, with an empty Sheet and nothing for the reconcile to correct it
 * from. The next tap then means the opposite of its label, which is how an
 * unpaired `wake` gets written.
 *
 * So the snapshot is taken only when nothing is in flight. Every failure in a
 * burst restores to that same confirmed baseline, and any row that DID land is
 * newer than its timestamps, so the reconcile puts those back. */
var togglesInFlight = 0;
var confirmedToggles = null;

function beginToggleWrite() {
  if (togglesInFlight === 0) confirmedToggles = toggleSnapshot();
  togglesInFlight += 1;
  return confirmedToggles;
}

function endToggleWrite() {
  togglesInFlight = Math.max(0, togglesInFlight - 1);
  if (togglesInFlight === 0) confirmedToggles = null;
}

function setToggle(kind, state, at) {
  toggles[kind] = { state: state, at: at || Date.now() };
  localStorage.setItem(TOGGLE_KEY, JSON.stringify(toggles));
  paintToggles();
}

/** Past 9 PM (or before 5 AM) — the same window both Sleep rules use, so "it
 *  warned me" and "it ended my day" can never disagree about the time. */
function isNight() {
  var hour = new Date().getHours();
  return hour >= NIGHT_STARTS_HOUR || hour < DAY_STARTS_HOUR;
}

/** "since 23:10", or '' if we never saw the change happen. */
function sinceLabel(at) {
  if (!at) return ' ';
  var d = new Date(at);
  return 'since ' + String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0');
}

/** Labels, icons, the two pills and the page tint all follow the state. */
function paintToggles() {
  var asleep = toggles.sleep.state === 'asleep';
  var work = toggles.work.state;

  // --- Sleep tile shows the ACTION; the pill shows the STATE.
  $('sleepLabel').textContent = asleep ? 'Wake up' : 'Sleep';
  setIcon($('sleepIco'), asleep ? 'i-sun' : 'i-moon');
  $('sleepSub').textContent = asleep ? sinceLabel(toggles.sleep.at) : ' ';
  sleepBtn.classList.toggle('on', asleep);

  $('workLabel').textContent = work === 'working' ? 'Break' : 'Work';
  setIcon($('workIco'), work === 'working' ? 'i-break' : 'i-work');
  $('workSub').textContent = work === 'working' ? ' ' : sinceLabel(toggles.work.at);
  workBtn.classList.toggle('on', work !== 'working');

  // --- the two pills under the logo
  var sp = $('sleepPill');
  $('sleepPillText').textContent = asleep ? 'Asleep' : 'Awake';
  setIcon(sp.querySelector('use'), asleep ? 'i-moon' : 'i-sun');
  sp.className = 'pill' + (asleep ? ' lit' : '');

  var wp = $('workPill');
  var WORK_PILL = {
    working: { text: 'Working', icon: 'i-work', cls: ' lit' },
    'break': { text: 'On break', icon: 'i-break', cls: ' warn' },
    off: { text: 'Day done', icon: 'i-off', cls: ' dim' }
  };
  var w = WORK_PILL[work] || WORK_PILL.working;
  $('workPillText').textContent = w.text;
  setIcon(wp.querySelector('use'), w.icon);
  wp.className = 'pill' + w.cls;

  paintDayBtn();

  // --- the page tint
  document.body.classList.toggle('state-asleep', asleep);
  document.body.classList.toggle('state-break', !asleep && work === 'break');
  document.body.classList.toggle('state-off', !asleep && work === 'off');
}

/** The Sheet wins: adopt any state row from today that is newer than what this
 *  device remembers. Rows can arrive in any order, so scan them all. */
function reconcileToggles(log) {
  (log || []).forEach(function (row) {
    var move = STATE_ROWS[row.type];
    if (!move) return;
    var t = instantOf(row.at);
    if (isNaN(t) || t <= toggles[move.kind].at) return;
    setToggle(move.kind, move.state, t);
  });
  paintToggles();
}

/**
 * The question to ask before going to sleep, or '' to write it silently.
 *
 * The wording has to name the state it actually found, because a message
 * describing a situation you are not in reads as a bug and trains you to tap
 * through it. Four cases, one per row of the table:
 *
 *   after 9 PM, on a break   -> silent. This is bedtime; the day ends.
 *   after 9 PM, working      -> ask. Then the day ends.
 *   before 9 PM, working     -> ask. Then it is only a break, not the day.
 *   before 9 PM, not working -> ask. The break (or closed day) stays as it is.
 */
function sleepConfirmQuestion(work, night) {
  if (night) {
    if (work === 'working') {
      return "You're still working. Sleep and wind up the day for good?";
    }
    return '';                                   // on a break at night — just bed
  }

  if (work === 'working') {
    return "You're working. Are you going to sleep?";
  }
  if (work === 'break') {
    return "You're on a break. Are you going to sleep in the middle of work?";
  }
  return "It's the middle of the day. Are you sure you're going to sleep?";
}

/**
 * What pressing Sleep must do to the WORK side first, or null for nothing.
 *
 *   at night   -> the day is over: close it as 'off', whatever it was
 *   in the day -> this is a nap: only pause a running session as 'break'
 *
 * Either way you can never be recorded as working while asleep, and the review
 * always gets a closing edge to measure the session against. Pure on purpose —
 * this is the rule the whole interlock rests on, so it has to be testable.
 */
function sleepClosingRow(work, night) {
  if (night) {
    if (work === 'off') return null;                 // already closed
    return { type: 'off', state: 'off', text: 'Day over (auto — going to sleep)' };
  }
  if (work === 'working') {
    return { type: 'break', state: 'break', text: 'Break (auto — going to sleep)' };
  }
  return null;                                       // a nap while already paused
}

/**
 * Close the night before anything that means "I am working now".
 *
 * THREE controls can start work — the Break/Work tile, the End/Start day button
 * and typing an entry — and every one of them has to write a `wake` row first if
 * the app still thinks you are asleep. A `sleep` with no `wake` is not a short
 * night, it is an unmeasurable one, and the pills would contradict each other
 * on top of that. Living in one function is the point: this used to be inlined
 * in the tile handler alone, and the other two silently skipped it.
 *
 * It returns the STEP rather than writing it, because runWrites() chains the
 * steps — which is what guarantees the `wake` lands before whatever follows it,
 * and that nothing follows it if it failed.
 */
function wakeSteps(startingWork) {
  if (!startingWork || toggles.sleep.state !== 'asleep') return [];
  var text = 'Wake up (auto — back to work)';
  setToggle('sleep', 'awake');
  noteLocalRow('wake', text);
  return [{ type: 'wake', raw_text: text }];
}

sleepBtn.addEventListener('click', async function () {
  if (sleepBtn.disabled) return;
  var toSleep = toggles.sleep.state === 'awake';
  // One reading of the clock for both decisions, so they can never straddle
  // 9 PM and disagree about which side of it this press is on.
  var night = isNight();
  var closing = toSleep ? sleepClosingRow(toggles.work.state, night) : null;

  // Declining must leave the Sheet untouched, so this runs before any write.
  var question = toSleep ? sleepConfirmQuestion(toggles.work.state, night) : '';
  if (question && !window.confirm(question)) return;

  coolDown(sleepBtn);
  var undo = beginToggleWrite();       // before the first optimistic change

  var steps = [];
  if (closing) {
    steps.push({ type: closing.type, raw_text: closing.text });
    setToggle('work', closing.state);
    noteLocalRow(closing.type, closing.text);
  }

  var edge = toSleep ? 'sleep' : 'wake';
  var text = toSleep ? 'Sleep' : 'Wake up';
  steps.push({ type: edge, raw_text: text });
  setToggle('sleep', toSleep ? 'asleep' : 'awake');
  noteLocalRow(edge, text);

  confirmPulse(sleepBtn);
  flash(toSleep ? 'Sleep logged' : 'Awake', 'ok');
  runWrites(steps, undo);
});

workBtn.addEventListener('click', async function () {
  if (workBtn.disabled) return;
  var toBreak = toggles.work.state === 'working';

  coolDown(workBtn);
  var undo = beginToggleWrite();

  // Mirror of the Sleep path: you cannot be asleep and working at once, so
  // starting work ends the night first, and without asking — one tap, and the
  // review still sees a wake row to close the sleep against.
  var steps = wakeSteps(!toBreak);

  var edge = toBreak ? 'break' : 'resume';
  var text = toBreak ? 'Break' : 'Back to work';
  steps.push({ type: edge, raw_text: text });
  setToggle('work', toBreak ? 'break' : 'working');
  noteLocalRow(edge, text);

  confirmPulse(workBtn);
  flash(toBreak ? 'Break started' : 'Back to work', 'ok');
  runWrites(steps, undo);
  if (!toBreak) maybeAskProject();
});

paintToggles();

// ------------------------------------------------------------ end of the day

/* Point 3: 'off' used to have only one way in — pressing Sleep at night. That
 * made "I have stopped for the day but I am not going to bed" unrecordable, and
 * every hours-worked figure depends on the day having a closing edge. This is
 * that edge, on its own button. */

var dayBtn = $('dayBtn');

function paintDayBtn() {
  if (!dayBtn) return;
  var off = toggles.work.state === 'off';
  $('dayBtnLabel').textContent = off ? 'Start the day' : 'End the day';
}

dayBtn.addEventListener('click', async function () {
  if (dayBtn.disabled) return;
  var off = toggles.work.state === 'off';

  coolDown(dayBtn);
  var undo = beginToggleWrite();

  var steps = wakeSteps(off);              // starting the day ends the night
  var edge = off ? 'resume' : 'off';
  var text = off ? 'Day started' : 'Day over';
  steps.push({ type: edge, raw_text: text });

  setToggle('work', off ? 'working' : 'off');
  noteLocalRow(edge, text);
  confirmPulse(dayBtn);
  flash(off ? 'Day started' : 'Day closed', 'ok');
  runWrites(steps, undo);
  if (off) maybeAskProject();
});

// -------------------------------------------------------------------- chips

/** The chip labels come from Settings on this device, i.e. they are user input. */
function parseChips(text) {
  return String(text)
    .split(',')
    .map(function (x) { return x.trim(); })
    .filter(function (x) { return x.length > 0; });
}

/* '+' separates reasons inside a break row, so a chip name cannot contain one.
 * The dialog strips it now, but a name saved before that rule would be split
 * into two junk reasons ("C++ work" -> "C", "work") for good, with nothing on
 * screen to explain it. Clean the saved list on the way out instead. */
function safeChipName(label) {
  return String(label).replace(/[+]/g, ' ').replace(/\s+/g, ' ').trim();
}

function chipLabels() {
  // Separators-only input (", , ") parses to nothing, which would leave the row
  // blank with no explanation; treat that the same as an empty box.
  var parts = parseChips(cfg.chips === undefined ? DEFAULT_CHIPS.join(', ') : cfg.chips)
    .map(safeChipName)
    .filter(function (x) { return x.length > 0 && x !== PLAIN_BREAK; });
  return parts.length ? parts : DEFAULT_CHIPS.slice();
}

/* Chips learn, like keyboard suggestions. The Settings list still decides which
 * chips exist — the tally only decides their order, so a hand-edited list is
 * never overruled.
 *
 * Known limit: the tally starts empty and grows from today's rows forward. It
 * cannot see last month's statuses, because today() only returns today. Mining
 * the full history needs a backend change. */

function loadChipStats() {
  try {
    var s = JSON.parse(localStorage.getItem(CHIP_STATS_KEY)) || {};
    return {
      items: (s.items && typeof s.items === 'object') ? s.items : {},
      seen: Number(s.seen) || 0
    };
  } catch (e) {
    return { items: {}, seen: 0 };
  }
}

var chipStats = loadChipStats();

/** Frequency, nudged by recency so a habit that just started can climb without
 *  having to out-count a year of tea. */
function chipScore(label) {
  var rec = chipStats.items[label];
  if (!rec) return 0;
  var days = Math.max(0, (Date.now() - rec.last) / 86400000);
  return rec.n + 3 / (1 + days);
}

/* Counting happens from the Sheet's own status rows, not from the tap. That way
 * a chip tapped on the phone teaches the laptop too, and `seen` (the newest row
 * already counted) stops refresh() from counting the same row over and over. */
function absorbChipStats(log) {
  var newest = chipStats.seen;
  var changed = false;
  var known = {};
  chipLabels().forEach(function (l) { known[l] = 1; });

  (log || []).forEach(function (row) {
    // Chips write `break` rows now. The plain Break button writes one too, so
    // only names that are actually on the chip list are counted.
    if (row.type !== 'break') return;

    var t = instantOf(row.at);
    if (isNaN(t) || t <= chipStats.seen) return;

    // A row can name several reasons at once; each one earns its own tick.
    // Only a start counts — removing a reason is not using it again.
    var move = parseBreakOp(row.raw_text, row.detail);
    if (move.op === 'drop' || move.op === 'keep') return;
    move.names.forEach(function (label) {
      if (!known[label]) return;
      var rec = chipStats.items[label] || { n: 0, last: 0 };
      rec.n += 1;
      rec.last = Math.max(rec.last, t);
      chipStats.items[label] = rec;
      changed = true;
    });

    if (t > newest) newest = t;
  });

  if (!changed) return;
  chipStats.seen = newest;
  localStorage.setItem(CHIP_STATS_KEY, JSON.stringify(chipStats));
  renderChips();
}

/** Most-used first; ties keep the order typed in Settings. */
function orderedChipLabels() {
  return chipLabels().map(function (label, i) {
    return { label: label, i: i, score: chipScore(label) };
  }).sort(function (a, b) {
    return (b.score - a.score) || (a.i - b.i);
  }).map(function (x) {
    return x.label;
  });
}

var renderedChipOrder = null;

/* A tap teaches the tally, and the refresh a second later can re-rank the row —
 * right when a finger is still hovering over the neighbouring chips. Hold the
 * current order for a few seconds after any tap; the next render after that
 * picks the new one up, so nothing is unlearned, only delayed. */
var CHIP_FREEZE_MS = 4000;
var chipFreezeUntil = 0;
var chipFreezeTimer;

function renderChips() {
  var row = $('chipRow');

  if (row.childElementCount && Date.now() < chipFreezeUntil) {
    // Re-render when the freeze lifts, in case nothing else asks by then.
    clearTimeout(chipFreezeTimer);
    chipFreezeTimer = setTimeout(renderChips, (chipFreezeUntil - Date.now()) + 50);
    return;
  }

  var labels = orderedChipLabels();
  var lit = {};
  replayDay(lastLog).activeReasons.forEach(function (r) { lit[r] = 1; });
  var active = Object.keys(lit).sort().join('\u0001');
  // The active reason is part of what is drawn, so it has to be part of the key
  // — otherwise tapping the chip that is already first never lights it up.
  var order = labels.join('\n') + '\u0000' + active;

  // Rebuilding on every refresh would move a chip out from under a finger that
  // is already on its way down; only redraw when the order actually changed.
  if (order === renderedChipOrder && row.childElementCount) return;
  renderedChipOrder = order;
  row.textContent = '';

  labels.forEach(function (label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (lit[label] ? ' on' : '');
    b.textContent = label;            // textContent, never markup — this is user input
    b.addEventListener('click', function () { logChip(b, label); });
    row.appendChild(b);
  });

  var add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip chip-add';
  add.textContent = '+';
  add.setAttribute('aria-label', 'Add a break reason');
  add.addEventListener('click', openStatusDialog);
  row.appendChild(add);
}

// ------------------------------------------------------ adding a break reason

var statusDlg = $('statusDlg');

function openStatusDialog() {
  $('statusName').value = '';
  statusDlg.showModal();
}

$('statusCancelBtn').addEventListener('click', function () { statusDlg.close(); });

$('statusSaveBtn').addEventListener('click', function () {
  // The comma is the separator in the stored list, so a name cannot contain one.
  // The comma separates the stored list and the + separates reasons in a row,
  // so a name can contain neither.
  var name = $('statusName').value.replace(/[,+]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) { flash('Give it a name first.', 'err'); return; }

  /* "Break" is what the plain Break button writes. A chip by that name would be
   * counted from the button's own rows, and could never be attributed a
   * duration, so the one name that looks most natural is the one to refuse. */
  if (name.toLowerCase() === PLAIN_BREAK.toLowerCase()) {
    flash('The Break button already covers that. Name the reason instead.', 'err');
    return;
  }

  var labels = chipLabels();
  var isNew = labels.indexOf(name) === -1;
  if (isNew) labels.push(name);

  cfg.chips = labels.join(', ');
  saveConfig(cfg);
  renderedChipOrder = null;          // the list changed, so force a redraw
  chipFreezeUntil = 0;
  renderChips();
  statusDlg.close();
  // "added" would be a lie for a name that collapsed onto one already there.
  flash(isNew ? name + ' added' : name + ' is already there', 'ok');
});

/** One tap, one status row, no confirmation dialog — that is the whole point.
 *  The tally is not touched here; the refresh below brings the row back and
 *  absorbChipStats() counts it once. */
/**
 * Tap a chip to add that reason, tap it again to drop it — several can apply at
 * once. Each tap writes ONE break row carrying the whole resulting set, so the
 * Sheet always states the full picture and a row can be read on its own.
 *
 * Tapping the same chip repeatedly used to append an identical row every time.
 * Now the second tap means something different from the first, so a row per tap
 * is a row per change.
 */
function logChip(btn, label) {
  if (btn.disabled) return;
  coolDown(btn);
  chipFreezeUntil = Date.now() + CHIP_FREEZE_MS;   // set before the write, not after

  /* Already on it? Then there is nothing to say.
   *
   * This used to toggle off, which meant a second press wrote a second row —
   * the exact "I keep pressing it and it keeps logging" complaint. A break ends
   * when you go back to Work, not when you tap its reason again. */
  if (replayDay(lastLog).activeReasons.indexOf(label) !== -1) {
    confirmPulse(btn);
    flash('Already on ' + label);
    return;
  }

  /* A delta, so two devices adding different reasons merge instead of racing.
   * It goes in the `detail` column, NOT the text: a cell beginning with + or -
   * is a formula to Google Sheets, and "+ Tea" was being stored as #NAME?. */
  var undo = beginToggleWrite();
  setToggle('work', 'break');
  // Not fed to the chip tally here — the reconcile brings the row back and
  // absorbChipStats() counts it exactly once, from the Sheet.
  noteLocalRow('break', label, '', 'add');
  confirmPulse(btn);
  flash(label + ' — on a break', 'ok');
  runWrites([{ type: 'break', raw_text: label, detail: 'add' }], undo);
}

renderChips();

// ------------------------------------------------------------ prayer picker

var prayerDlg = $('prayerDlg');
var pickedPrayer = null;
var pickedMode = null;

function loggedToday(name) {
  return todayPrayers.some(function (p) { return p.prayer === name; });
}

/** Point 6: Home shows the five prayers as ticks, not as log lines. Read-only —
 *  logging still goes through the picker, so a tick cannot be set by a mis-tap. */
function renderPrayerTicks() {
  var box = $('prayerTicks');
  box.textContent = '';
  var done = 0;

  PRAYER_NAMES.forEach(function (name) {
    var isDone = loggedToday(name);
    if (isDone) done += 1;

    var el = document.createElement('span');
    el.className = 'tick' + (isDone ? ' done' : '');

    var mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = isDone ? '✓' : '○';

    var label = document.createElement('span');
    label.textContent = name;

    el.append(mark, label);
    box.appendChild(el);
  });

  $('prayerSub').textContent = done + ' of 5';
}

/** One picker button. `done` adds the "already logged today" tick. */
function pickButton(label, isPicked, done, onPick) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'pick';
  b.setAttribute('aria-pressed', isPicked ? 'true' : 'false');
  b.textContent = label;

  if (done) {
    var tick = document.createElement('span');
    tick.className = 'done';
    tick.textContent = '✓';
    b.appendChild(tick);
  }

  b.addEventListener('click', onPick);
  return b;
}

function renderPrayerPicks() {
  var box = $('prayerList');
  box.textContent = '';

  PRAYER_NAMES.forEach(function (name) {
    box.appendChild(pickButton(name, pickedPrayer === name, loggedToday(name), function () {
      pickedPrayer = name;
      pickedMode = null;
      $('modeWrap').hidden = false;
      $('prayerSaveBtn').disabled = true;
      renderPrayerPicks();
      renderModePicks();
    }));
  });
}

function renderModePicks() {
  var box = $('modeList');
  box.textContent = '';

  PRAYER_MODES.forEach(function (mode) {
    box.appendChild(pickButton(mode, pickedMode === mode, false, function () {
      pickedMode = mode;
      $('prayerSaveBtn').disabled = false;
      renderModePicks();
    }));
  });
}

$('prayerBtn').addEventListener('click', function () {
  pickedPrayer = null;
  pickedMode = null;
  $('modeWrap').hidden = true;
  $('prayerSaveBtn').disabled = true;
  renderPrayerPicks();
  renderModePicks();
  prayerDlg.showModal();
  scheduleRefresh(1200);              // opens instantly on cached ticks, then corrects them
});

$('prayerCancelBtn').addEventListener('click', function () { prayerDlg.close(); });

$('prayerSaveBtn').addEventListener('click', function () {
  if (!pickedPrayer || !pickedMode) return;

  // Append-only by design: a duplicate is warned about, never overwritten.
  if (loggedToday(pickedPrayer) &&
      !window.confirm(pickedPrayer + ' is already logged today. Log it again?')) return;

  var name = pickedPrayer;
  var mode = pickedMode;

  // Tick it and get out of the way; the write drains behind the closed dialog.
  prayerDlg.close();
  flash(name + ' logged', 'ok');
  todayPrayers.push({ at: localIso(), local: '', prayer: name, mode: mode });
  renderPrayerTicks();
  renderDaySummary();
  renderLogList();
  scheduleRefresh();

  runWrite('prayer', { prayer: name, mode: mode });
});

// ------------------------------------------------- what are you working on?

/* Pressing Work in the morning resumes... nothing. `resume` carries on with the
 * day's current project, and on the first press of the day there isn't one, so
 * the clock would run against a blank name. Ask once, only when there is
 * genuinely nothing to carry on with, and let it be skipped. */

var projectDlg = $('projectDlg');

function maybeAskProject() {
  if (projectDlg.open) return;
  if (replayDay(lastLog).activeProjects.length) return;   // already on something
  $('projectName').value = '';
  projectDlg.showModal();
}

$('projectSkipBtn').addEventListener('click', function () { projectDlg.close(); });

$('projectSaveBtn').addEventListener('click', function () {
  var text = $('projectName').value.trim();
  projectDlg.close();
  if (!text) return;                           // Start with an empty box = Skip

  var undo = beginToggleWrite();
  if (toggles.work.state !== 'working') setToggle('work', 'working');
  noteLocalRow('work', text);
  flash('Logged', 'ok');
  runWrites([{ type: 'work', raw_text: text }], undo);
});

// ------------------------------------------------------------------ tracker

/* WHERE THE PROJECT COMES FROM, AND WHY THE ROW IS WRITTEN BEFORE IT ARRIVES.
 *
 * THE ROW IS WRITTEN ON THE TAP. Nothing waits for the model. Read the rest only
 * if you are tempted to move that write behind the extraction again; it was
 * there for one round of this stage and every problem below is one it caused.
 *
 * Holding the row back until Gemini answers looks like it costs a few seconds of
 * latency on a write nobody is watching. What it actually costs is the user's
 * next action. Four seconds is long enough to press Break, or End the day, or
 * Sleep — and the held-back row then lands with a LATER timestamp than the
 * button that was pressed after it. replayDay() reads it as "started working
 * again", so the break silently evaporates; reconcileToggles() sees a newer row
 * and flips the pill back to Working. The app overwrites a deliberate action
 * with an inference. It is also a row that simply does not exist if the phone is
 * locked or the tab is closed inside those four seconds.
 *
 * So the label has to arrive afterwards, and it does — as an UPDATE that fills
 * in `project` on the row we already wrote (action `label`, and the narrow
 * policy that permits it in docs/supabase_schema.sql).
 *
 * THE ONE HARD PART, because the previous round's comment was right about it:
 * replayDay() keys a project on `row.project || row.raw_text`, so filling in
 * `project` RENAMES the tile. Press Done in the gap and the `done` row names the
 * sentence while the work row now names the project, and nothing closes. Three
 * things keep that safe, in this order:
 *
 *   1. the label is skipped entirely if the tile is no longer open — a Done
 *      already pressed means the row stays unlabelled and the two names agree;
 *   2. the tile is renamed on screen only AFTER the database has taken the
 *      label, so a Done pressed while it is in flight still writes the old name;
 *   3. and if that happened, the rename is followed by a second `done` row under
 *      the new name. An append-only store takes something back by appending.
 *
 * Rejected on the way here, so nobody re-treads it:
 *   - extract first with a short (~800ms) deadline: still defers the row, still
 *     loses it if the tab closes, and a cold Edge Function plus a model call
 *     overruns 800ms often enough that most entries would land unlabelled;
 *   - stamp `at` at tap time and keep the deferred insert: fixes the ordering
 *     and nothing else — Done still closes a name that never opened;
 *   - never label at all: the tile stays named after the whole sentence, which
 *     is the feature this stage exists to remove.
 *
 * THE TRADE that remains: labelling needs an UPDATE policy the user has to run
 * once in the Supabase SQL editor. Until they do, the update matches no rows,
 * `labelled` comes back false, and every entry keeps the sentence as its name —
 * which is exactly the behaviour that shipped before this existed, not a broken
 * state. The row itself is never at risk either way.
 */
/* Nothing on screen waits for this any more, so it is no longer a latency
 * budget: it is how long a label may take before the entry simply keeps the
 * sentence as its name. Still bounded, because an abandoned request must not
 * still be open when the next entry starts its own. */
/* 15s, not the original 4s. That 4 was chosen while the ROW waited for the
 * label, where every extra second was a second the entry could be lost — and
 * that design is gone: the row is written on the tap now, and only its NAME is
 * still outstanding. So the deadline stopped being a data-safety limit and
 * became a patience limit, and 4s was simply too impatient: the first real
 * extraction came back correct at 28.6s and was thrown away.
 *
 * It is still bounded, because a sentence whose label is in flight is held out
 * of the next entry's prompt, and holding that open for a minute is how two
 * tiles appear for one project. With deliberation off this should be about a
 * second; 15 is the allowance for a cold function, not the expectation.
 *
 * It bounds ONE call, not one entry. An entry that arrives while a call is out
 * waits for that call and then goes in the next one, so its own label can be up
 * to two deadlines away — and, if the minute is already full, up to a further
 * minute on top of that while the pacer holds the batch. That is deliberate on
 * both counts: the batching is what keeps the day inside 20 Gemini calls and
 * the pacing is what keeps it inside 5 a minute. It costs nothing on screen,
 * because the row was written on the tap and only its name is outstanding. */
var EXTRACT_DEADLINE_MS = 15000;

/** Nothing understood. A fresh object every time, because callers read from it
 *  and one shared instance is a bug waiting for a careless assignment. */
function noExtraction() {
  return { project: '', detail: '' };
}

/* Gemini answers in a fixed shape because the Edge Function asks for one. This
 * is that shape, in the API's own schema vocabulary.
 *
 * `n` IS THE LINE NUMBER, and it is here for the batch. Several lines share one
 * prompt now, and the answers are matched back to them by POSITION — so a model
 * that returns the right NUMBER of objects in the wrong ORDER would file every
 * row in that batch under somebody else's project, silently and permanently, in
 * an append-only store. Counting the answers cannot see a reorder; making each
 * answer say which line it belongs to can. askGeminiMany() checks it and throws
 * the WHOLE batch away when it does not line up.
 *
 * The one-line path asks for `n` as well, because the schema is shared, and then
 * ignores what comes back: with a single entry there is only one position, so
 * there is nothing to misalign, and discarding a correct name because the model
 * wrote 0 where we wanted 1 would cost a call and buy nothing. */
/* `tasks` is a LIST, and that is the whole difference between "NeuraVue" and
 * "NeuraVue, and here is what you did to it". One sentence often carries several
 * jobs — "resolving FPS jitter, model latency, and fall modelling" is three —
 * and asking for one string got one run-on line that read like the rest had been
 * thrown away. It never was: raw_text keeps the sentence exactly as typed.
 *
 * Stored joined by TASK_SEP into the existing `detail` column rather than in a
 * new one, because a schema change means a migration and this does not earn one.
 * Rows written before this still read correctly: no separator, so one task. */
var EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    n: { type: 'INTEGER' },
    project: { type: 'STRING' },
    tasks: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['n', 'project', 'tasks']
};

/* Not a comma: commas appear inside a task ("fixing the login bug, which broke
 * yesterday") and splitting on them would cut it in half. This does not occur in
 * ordinary typing. */
var TASK_SEP = ' \u00b7 ';

/* WHY THE MODEL IS TOLD ABOUT SPEECH. A dictated line arrives already mangled:
 * "NeuraVue" as "my review", "OneNet" as "one night", "NMEA" as "anemia". The
 * app is handed the wrong words, so the repair has to happen where the real
 * names are known — in the prompt, against the list below it.
 *
 * Bounded deliberately. The model may only pick a name that is already on the
 * list; it may not invent a correction. And `raw_text` keeps what was actually
 * heard whatever happens, so a wrong match shows up as a tile whose sentence
 * plainly does not fit it, rather than as a record quietly rewritten. */
var SOUNDALIKE =
  'These lines are often dictated, and speech-to-text mangles unusual names: ' +
  '"NeuraVue" arrives as "my review", "OneNet" as "one night". If a phrase ' +
  'sounds like one of the names above, use that name instead. Only when the ' +
  'sounds plainly match — if you are unsure, go with what was written.';

/* THE OPEN PROJECTS GO IN THE PROMPT, and that is a correctness requirement
 * rather than a nicety. A project is identified by its exact string, so
 * "Sauda Kifyaha", "sauda kifyaha" and "Sauda" are three separate tiles on Home,
 * three separate rows in the review, and three separate things to press Done on.
 * Telling the model what is already open is what keeps one project one project. */
function extractPrompt(text, known) {
  var lines = [
    'You are labelling one line from a personal activity log. Answer with JSON only.',
    '',
    'The line: ' + JSON.stringify(text),
    '',
    // Asked for so the required field means something; the answer is not read.
    'n: the number 1. There is only this one line.',
    'project: the short name of the thing being worked on, two or three words at most.',
    'tasks: a list of the things being done to it, each a few words. A line that ' +
    'mentions several jobs becomes several entries. Use [] if the line does not say, ' +
    'and never invent one the line does not mention.'
  ];

  if (known && known.length) {
    lines.push('');
    lines.push('Project names already in use: ' + known.map(function (n) {
      return JSON.stringify(String(n));
    }).join(', '));
    lines.push('If this line is about one of those, copy that name EXACTLY, character ' +
               'for character, including its capitals.');
    lines.push(SOUNDALIKE);
  }

  lines.push('');
  lines.push('If no project is named or implied, return "" for both fields.');
  lines.push('Apart from matching a name from that list, never reword, translate, ' +
             'expand or correct what was written.');
  return lines.join('\n');
}

/* The function is asked for structured output, but the two halves of this app
 * deploy separately — a git push here, a hand paste into the Supabase dashboard
 * there — so a deployment that predates that change will answer with prose, and
 * prose asked for JSON arrives inside ``` fences often enough to matter. Reading
 * the fenced form costs three lines and is the difference between a labelled row
 * and a silently unlabelled one. */
function parseExtraction(text) {
  var body = String(text || '').trim();
  var fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  try {
    return JSON.parse(body);
  } catch (e) {
    return null;
  }
}

/* A project name becomes a tile, a key in byProject, and the text of the `done`
 * row that eventually closes it — and the store is append-only, so a model that
 * runs on leaves a permanent mess. Trim it, cap it, and snap a case-only
 * difference back onto the project that is already open: asking for an exact
 * match is not the same as getting one. */
var PROJECT_MAX = 60;
var DETAIL_MAX = 120;

function tidyExtraction(got, known) {
  var squash = function (v) {
    return String((got && got[v]) || '').replace(/\s+/g, ' ').trim();
  };
  var project = squash('project');

  /* A list if the model sent one, a string if it sent that instead — and it will
   * sometimes, whatever the schema says. Both end up as one joined string, so
   * everything downstream sees exactly what it saw before. */
  var raw = got && got.tasks;
  var detail;
  if (Object.prototype.toString.call(raw) === '[object Array]') {
    detail = raw.map(function (t) { return String(t || '').replace(/\s+/g, ' ').trim(); })
                .filter(Boolean).join(TASK_SEP);
  } else {
    detail = squash('tasks') || squash('detail');
  }
  detail = detail.slice(0, DETAIL_MAX);

  /* Match against the open projects BEFORE capping, and skip the cap on a hit.
   * Every tile logged before this feature existed is named after a whole
   * sentence, which is longer than PROJECT_MAX — so truncating a name the model
   * copied correctly would split the very tile the matching is here to keep
   * whole. The cap exists to contain a model that runs on, not to rename a
   * project the user already has. */
  var matched = '';
  (known || []).forEach(function (name) {
    if (project && project.toLowerCase() === String(name).toLowerCase()) matched = name;
  });

  return { project: matched || project.slice(0, PROJECT_MAX), detail: detail };
}

/* ---------------------------------------------------------------------------
 * NAMING AN ENTRY WITHOUT SPENDING A GEMINI CALL.
 *
 * The free tier allows 5 requests a minute and TWENTY A DAY. Saad logs 30-40
 * entries on a normal day, so the shape this stage first shipped with — one
 * Gemini call per entry — ran out somewhere after lunch, and every entry after
 * that stayed unnamed. Measured off Google's own dashboard on the day it
 * happened: RPD 21/20, against TPM 375 of 250,000.
 *
 * Read those two numbers together, because they are the whole design. Tokens
 * are not the scarce thing; CALLS are. One prompt covering ten entries costs
 * exactly what one covering a single entry costs. Bigger prompts are free;
 * extra calls are not. So:
 *
 *   1. reuse a name we already know, on the device, for nothing. Once
 *      "NeuraVue" has been named once, every later line that says NeuraVue is
 *      free — today, and tomorrow too, because the names are remembered.
 *   2. coalesce whatever is left DURING FLIGHT. An entry arriving while no call
 *      is out goes on its own, at once, so an unhurried day feels exactly as it
 *      does now; entries arriving while a call IS out wait for it and then go
 *      together, as one call.
 *   3. pace what is left at 4 calls a minute, holding rather than sending the
 *      one that would be refused (see the pacer, below).
 *   4. stop at a self-imposed 18 rather than let Google refuse the 21st.
 *
 * WHAT THIS ACTUALLY COSTS, measured rather than hoped for. 40 entries across 5
 * projects, typed one at a time through a day, varying only how many of those
 * lines literally contain the project's name — because step 1 is a plain
 * word-for-word match and cannot read anything else:
 *
 *     lines naming the project | Gemini calls | named | left unnamed
 *          100%                       5           40         0
 *           75%                      14           40         0
 *           50%                      18           35         5   <- budget gone
 *           25%                      18           26        14
 *            0%                      18           18        22
 *
 * READ THE FIRST ROW AS THE CEILING OF THE SAVING, NOT AS THE DAY. It needs
 * every single line to spell the name out, and real log lines often do not:
 * "fixed the login bug", "finished the invoice" and "called him back" name
 * nothing a matcher can see, and lines like those are precisely why Gemini is
 * here at all. Somewhere below half, the budget runs out during the day and
 * every entry after that keeps its own sentence as its project name — saved,
 * complete, just not tidied. That is a real outcome, not a fault, and it is the
 * behaviour that shipped before any of this existed.
 *
 * The old shape cost 40 calls and hit Google's refusal every day, so all five
 * rows are an improvement on it. Only the first is a triumph.
 * ------------------------------------------------------------------------- */

/* Names are remembered across reloads because "tomorrow's lines about it are
 * free too" is most of the saving. Most-recent-first and capped: a list that
 * grows for ever is a list where a name used once in March can still capture a
 * line in September. */
var PROJECT_NAMES_MAX = 60;

function loadProjectNames() {
  var saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PROJECT_NAMES_KEY));
  } catch (e) { /* corrupt storage is an empty memory, not a broken app */ }
  if (!Array.isArray(saved)) return [];
  return saved.filter(function (n) {
    return typeof n === 'string' && n.trim();
  }).slice(0, PROJECT_NAMES_MAX);
}

var recentProjects = loadProjectNames();

/* NAMES YOU TYPE IN SETTINGS, and the reason they are a second list rather than
 * seeds for the one above: SPEECH is what makes them necessary. Android's
 * recogniser hears "NeuraVue" as "my review", "OneNet" as "one night", "NMEA"
 * as "anemia" — the real word is gone before a line of this file runs, and no
 * rule about strings can bring back a sound the microphone never delivered.
 * What can is a model holding the list of real spellings.
 *
 * The remembered list cannot be that vocabulary on its own. It only ever holds
 * names the app has ALREADY got right once, so a project speech has never
 * transcribed correctly can never get into it — precisely the projects that
 * need the help. These are typed with a keyboard, so they are right by
 * construction, and they are never evicted: a name stays nameable for as long
 * as it is left in the box. */
var PINNED_NAMES_KEY = 'probeing.pinned';
var PINNED_NAMES_MAX = 60;

function loadPinnedNames() {
  var saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PINNED_NAMES_KEY));
  } catch (e) { /* corrupt storage is an empty list, not a broken app */ }
  if (!Array.isArray(saved)) return [];
  return saved.filter(function (n) {
    return typeof n === 'string' && n.trim();
  }).slice(0, PINNED_NAMES_MAX);
}

var pinnedNames = loadPinnedNames();

/** Read the Settings box: one name per line, or separated by commas. */
function parsePinned(text) {
  var seen = {};
  var out = [];
  String(text == null ? '' : text).split(/[\n,]/).forEach(function (part) {
    var clean = part.replace(/\s+/g, ' ').trim().slice(0, PROJECT_MAX);
    /* `=== 1`, not truthiness — see knownNames(): a project may be called
     * "constructor" and would otherwise be swallowed by the prototype. */
    if (!clean || seen[clean.toLowerCase()] === 1 || out.length >= PINNED_NAMES_MAX) return;
    seen[clean.toLowerCase()] = 1;
    out.push(clean);
  });
  return out;
}

function savePinnedNames(list) {
  pinnedNames = list;
  try {
    localStorage.setItem(PINNED_NAMES_KEY, JSON.stringify(pinnedNames));
  } catch (e) { /* a full store costs the list, never a row */ }
}

/* WHICH KIND OF WORK A PROJECT IS. The review groups its hours under these, and
 * nothing in the rows can work them out: only Saad knows that OneNet is office
 * work and ProBeing is not. So it is asked once per project and remembered.
 *
 * Same shape as the vocabulary above — localStorage, its own key, keyed
 * case-insensitively on the name, never evicted. Never evicted matters here for
 * a different reason: a project you stopped working on in March is still office
 * work in December, and its hours still have to land somewhere in a review of
 * March.
 *
 * ONE STORE, TWO PLACES TO EDIT IT: a dialog at review time that only ever asks
 * about names it has not seen, and a list in Settings for the day a personal
 * project becomes office work. They are the same mechanism seen twice, not two
 * features, and they share one renderer below for exactly that reason. */
var PROJECT_CATEGORY_KEY = 'probeing.categories';

var PROJECT_CATEGORIES = [
  { id: 'office',   label: 'Office Projects' },
  { id: 'personal', label: 'Personal Projects' },
  { id: 'phd',      label: 'PhD Working' },
  { id: 'life',     label: 'Personal working' }
];

/* A fifth answer, and a real one: "none of these". Stored like any other choice,
 * so the dialog stops asking — which is the whole difference between a project
 * that was skipped and one that has never been put in front of anybody. */
var CATEGORY_SKIP = 'skip';

/** The label for one of the four, or '' for anything else — including the
 *  functions a plain object inherits, which is why every read of the store goes
 *  through this rather than trusting whatever came back. */
function categoryLabel(id) {
  var found = '';
  PROJECT_CATEGORIES.forEach(function (c) { if (c.id === id) found = c.label; });
  return found;
}

/** The key a project is filed under. Case and stray spacing must not make two
 *  entries out of "NeuraVue" and "neuravue ". */
function catKey(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function loadProjectCategories() {
  var saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PROJECT_CATEGORY_KEY));
  } catch (e) { /* corrupt storage is an empty memory, not a broken app */ }
  if (!saved || typeof saved !== 'object') return userMap();

  /* Rebuilt rather than handed straight back, so a value that is not one of the
   * five answers — a category renamed, storage edited by hand — is dropped here
   * instead of becoming a group with no name further down. */
  var out = userMap();                      // keyed by project name — see userMap()
  Object.keys(saved).forEach(function (name) {
    var id = saved[name];
    if (id === CATEGORY_SKIP || categoryLabel(id)) out[catKey(name)] = id;
  });
  return out;
}

var projectCategories = loadProjectCategories();

function saveProjectCategories(map) {
  projectCategories = map;
  try {
    localStorage.setItem(PROJECT_CATEGORY_KEY, JSON.stringify(map));
  } catch (e) { /* a full store costs the grouping, never a row */ }
}

/** Put `name` at the front of the remembered list. Called for every name the
 *  app settles on, including one it recognised locally — using a name is what
 *  keeps it near the front, so a project you have stopped working on falls off
 *  the end by itself rather than needing to be forgotten on purpose. */
function rememberProject(name) {
  var clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;

  var keep = [clean];
  recentProjects.forEach(function (n) {
    if (n.toLowerCase() === clean.toLowerCase()) return;   // moved, not duplicated
    if (keep.length < PROJECT_NAMES_MAX) keep.push(n);
  });
  recentProjects = keep;

  try {
    localStorage.setItem(PROJECT_NAMES_KEY, JSON.stringify(recentProjects));
  } catch (e) { /* a full store costs a remembered name, never a row */ }
}

/** Every project name this device could recognise: the ones on today's rows
 *  that already carry one, then the remembered set. */
function knownNames() {
  var seen = {};
  var out = [];

  function add(name) {
    var clean = String(name || '').replace(/\s+/g, ' ').trim();
    var key = clean.toLowerCase();
    /* `=== 1`, not truthiness: a plain object inherits `constructor` and
     * `toString` from its prototype, and a project may fairly be called either
     * of those. */
    if (!clean || seen[key] === 1) return;
    seen[key] = 1;
    out.push(clean);
  }

  (lastLog || []).forEach(function (row) {
    /* The type check is load-bearing: a PRAYER row carries the prayer's name in
     * `project`. Without it "Asr" and "Isha" become matchable project names and
     * the next line that mentions one gets filed under it. */
    if (row.type !== 'work' && row.type !== 'voice' && row.type !== 'done') return;
    add(row.project);
  });
  pinnedNames.forEach(add);
  recentProjects.forEach(add);
  return out;
}

/** The project vocabulary a prompt is shown: today's OPEN projects first, then
 *  every other name this device knows. Open ones lead because a line that could
 *  belong to either should join the one already running, and because the model
 *  reads a list in order. */
function promptNames(open) {
  var seen = {};
  var out = [];
  (open || []).concat(knownNames()).forEach(function (name) {
    var clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean || seen[clean.toLowerCase()] === 1) return;
    seen[clean.toLowerCase()] = 1;
    out.push(clean);
  });
  return out;
}

/* WORD FOR WORD, NEVER SUBSTRING. "auth" must not match inside "author": a
 * wrong name is worse than no name, because it silently merges two projects'
 * hours and `raw_text` is the only record that would ever show it. So both
 * sides are cut into words, and the name has to appear as a run of whole ones.
 *
 * Everything that is not a digit or an ASCII letter separates words — except
 * characters above ASCII, which are kept as word content so a non-English name
 * stays in one piece instead of shattering into letters. */
var NAME_WORD_SPLIT = /[^0-9a-z\u0080-\uffff]+/;

/** Below this many letters a name is too easy to hit by accident, so the line
 *  goes to Gemini rather than being guessed at. */
var NAME_MIN_CHARS = 3;

function nameWords(s) {
  return String(s == null ? '' : s).toLowerCase().split(NAME_WORD_SPLIT)
    .filter(function (w) { return w; });
}

/** Does `words` contain `want` as a run of consecutive whole words? */
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

/** The known project this line plainly names, or ''. The LONGEST match wins, so
 *  a line about "NeuraVue API" is not filed under "NeuraVue". */
function localProjectName(text) {
  var words = nameWords(text);
  if (!words.length) return '';

  var best = '';
  var bestWords = 0;
  knownNames().forEach(function (name) {
    var want = nameWords(name);
    if (want.join('').length < NAME_MIN_CHARS) return;
    if (!saysName(words, want)) return;
    if (want.length > bestWords || (want.length === bestWords && name.length > best.length)) {
      best = name;
      bestWords = want.length;
    }
  });
  return best;
}

/* THE DAILY BUDGET.
 *
 * Google's free tier allows a fixed number of requests a day and refuses the
 * next with a message that reads like a bill and is not one. Stopping ourselves
 * a little short means that message is never seen: the spare absorbs a
 * Settings -> Test Gemini tap made after the budget is gone.
 *
 * How many is a SETTING, because the allowance is per model and they differ
 * enormously — gemini-3.6-flash gives 20 a day, the Lite models far more. A
 * constant would silently become the real limit the day the model changed.
 *
 * Counted per LOCAL day, which is not exactly Google's day — their window
 * almost certainly turns over on Pacific time, so a heavy morning and a heavy
 * evening either side of THEIR midnight could in principle add up past 20
 * inside one of their days. Named rather than solved: a real day spends about
 * five calls now, and the alternative is guessing at a reset time we cannot
 * observe. If Google ever refuses despite this counter, this is the reason. */
/* 18 was chosen against a model allowing 20 a day. The free tier's limits are PER
 * MODEL and differ by more than an order of magnitude — the Lite models allow far
 * more — so a constant here would become the binding limit the moment the model
 * changes, and would do it silently: names would simply stop, exactly as if the
 * feature were broken. It is a setting, defaulting to the cautious number. */
var GEMINI_DAILY_DEFAULT = 18;
function geminiDailyBudget() {
  var n = Math.floor(Number(cfg.geminiDaily));
  return (isFinite(n) && n > 0) ? n : GEMINI_DAILY_DEFAULT;
}

/** What `lastExtractError` is set to when WE stopped the call rather than
 *  Google. quotaWait() turns it into a sentence; nothing else compares to it. */
var GEMINI_BUDGET_SPENT = 'probeing:daily-budget-spent';

function localDayStamp() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/* Read out of storage every time rather than held in a variable, and two things
 * fall out of that for free: a tab left open past midnight resets by itself,
 * and two open tabs count against one tally instead of two. */
function geminiTally() {
  var saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(GEMINI_DAY_KEY));
  } catch (e) { /* unreadable storage counts as a fresh day */ }

  var today = localDayStamp();
  if (!saved || saved.day !== today) return { day: today, n: 0 };
  /* Math.max, because a NEGATIVE count would not merely miscount — it would lift
   * the ceiling ABOVE Google's. `{n:-50}` makes geminiCallsLeft() 68, and 68
   * calls is 48 past the refusal this whole budget exists to avoid. Every other
   * way this value can be corrupt already fails safe (a string, a null and a
   * shape all read as 0 or as a huge number; both are survivable). This one did
   * not. Storage is a place anything can be written, including by us with a
   * future bug, so the guard belongs on the READ. */
  return { day: today, n: Math.max(0, Number(saved.n) || 0) };
}

function geminiUsedToday() {
  return geminiTally().n;
}

function geminiCallsLeft() {
  return Math.max(0, geminiDailyBudget() - geminiUsedToday());
}

/* THE PER-MINUTE PACER, which is the OTHER half of the free tier and the half
 * that was left undefended. Google allows 5 requests a minute as well as 20 a
 * day, and the day this shape was designed the dashboard read RPM 5/5 next to
 * RPD 21/20 — both ceilings were hit, and only one of them was being watched.
 *
 * The in-flight coalescing does not cover this. It batches calls that OVERLAP,
 * and six entries typed one after another do not overlap: each is answered
 * before the next is typed, so each gets its own call. Measured, that is six
 * requests inside six milliseconds against a limit of five a minute — which is
 * exactly the catching-up burst a person types after a meeting.
 *
 * So: remember when the recent calls went out, and if the last minute is
 * already full, HOLD the next one until the window opens instead of sending it
 * into a refusal. Holding is cheap here in a way it would be almost nowhere
 * else in this app — the row was written on the tap, nothing on screen is
 * waiting, and only the NAME is late. Rule 4 is untouched: no logging action
 * waits on any of this.
 *
 * Four, not five, for the same reason the daily budget is 18 and not 20: the
 * spare absorbs a Settings -> Test Gemini tap, which goes out unpaced (a
 * diagnostic the user is watching must not sit silently for a minute) and is
 * still counted here so the pacer knows the slot is gone.
 *
 * KEPT IN MEMORY, unlike the daily tally, and that is a deliberate difference. A
 * day outlives a reload and is shared by two open tabs, so it has to live in
 * storage; a sixty-second window does not survive anything worth surviving, and
 * a write per call to track it would buy one edge case — reload, then log five
 * unrecognised entries inside a minute — whose worst outcome is Google's own
 * refusal, which the app already handles by leaving the row unnamed and saying
 * so once. Named rather than solved. */
/* 4 was chosen against a model allowing 5 a minute. Like the daily figure this is
 * per model and varies a lot — gemini-3.5-flash-lite allows 15 — and pacing far
 * below the real ceiling is not free: it holds a name back for up to a minute for
 * no reason at all. Same shape as the daily budget, and the same reason. */
var GEMINI_RPM_DEFAULT = 4;
function geminiRpmLimit() {
  var n = Math.floor(Number(cfg.geminiRpm));
  return (isFinite(n) && n > 0) ? n : GEMINI_RPM_DEFAULT;
}
var GEMINI_RPM_WINDOW_MS = 60000;

/** When the recent calls left this device, oldest first. Trimmed to the window
 *  at every read, and every send reads it first — so the only entries that can
 *  pile up are Settings -> Test Gemini taps, one each. */
var geminiCallTimes = [];

/**
 * How long to wait before another call may go out: 0 means "now".
 *
 * Clamped to the window at both ends, because a device clock that jumps — and
 * phones do, on a network time correction — could otherwise produce a wait of
 * hours from arithmetic that is perfectly correct for a clock that only moves
 * forwards. A pacer that stops naming anything until tomorrow would be a worse
 * bug than the one it is here to prevent.
 */
function geminiPacerWaitMs() {
  var now = Date.now();

  /* `>= 0` drops a stamp that is somehow in the FUTURE — the clock moved
   * backwards under us. Dropping it errs towards sending, which risks one
   * refusal; keeping it would err towards never sending again. */
  geminiCallTimes = geminiCallTimes.filter(function (t) {
    return now - t >= 0 && now - t < GEMINI_RPM_WINDOW_MS;
  });
  if (geminiCallTimes.length < geminiRpmLimit()) return 0;

  // Oldest first, because they are appended in order — so the first slot to
  // free is the first one taken.
  var wait = GEMINI_RPM_WINDOW_MS - (now - geminiCallTimes[0]);
  return Math.min(GEMINI_RPM_WINDOW_MS, Math.max(1, wait));
}

/** Record one call against today AND against this minute. EVERY path that
 *  actually reaches the Edge Function calls this, the Settings test included —
 *  a counter that watched only half the calls would be worse than no counter at
 *  all. */
function noteGeminiCall() {
  geminiCallTimes.push(Date.now());

  var tally = geminiTally();
  tally.n += 1;
  try {
    localStorage.setItem(GEMINI_DAY_KEY, JSON.stringify(tally));
  } catch (e) { /* unwritable storage: undercounting beats refusing to log */ }
  return tally.n;
}

/** "4 of 18 used today". Settings -> Test Gemini is the only place this number
 *  is visible, and it is the one that says whether the day fits. */
function geminiUsageLine() {
  var used = geminiUsedToday();
  return used + ' of ' + geminiDailyBudget() + ' used today' +
    (used >= geminiDailyBudget()
      ? ' — entries keep their own text as the name until tomorrow.'
      : ' (this app\'s own limit, set in Settings — leave room under your model\'s).');
}

/* The batch shape: one object per line, in the order the lines were given. The
 * Edge Function hands any `schema` straight to responseSchema, so an ARRAY
 * needs nothing deployed there — which matters, because that function is pasted
 * in by hand and has been redeployed enough times for one day. */
var EXTRACT_LIST_SCHEMA = {
  type: 'ARRAY',
  items: EXTRACT_SCHEMA
};

/** The batch prompt: numbered lines in, one answer per line out, in order. */
function extractManyPrompt(texts, known) {
  var lines = [
    'You are labelling lines from a personal activity log. Answer with JSON only.',
    '',
    'There are ' + texts.length + ' lines, numbered:'
  ];

  texts.forEach(function (t, i) {
    lines.push((i + 1) + '. ' + JSON.stringify(String(t)));
  });

  lines.push('');
  lines.push('Return a JSON array of exactly ' + texts.length + ' objects, one for each ' +
             'line, in the same order as the numbering above. Answer for every line, ' +
             'including any you cannot name.');
  lines.push('');
  /* The echo is the alignment check. Without it a reordered answer is
   * indistinguishable from a correct one — see EXTRACT_SCHEMA. */
  lines.push('n: the number of the line this object answers, copied from the list above. ' +
             'The first object must have n=1, the second n=2, and so on up to n=' +
             texts.length + '. Never renumber, reorder or skip a line.');
  lines.push('project: the short name of the thing being worked on, two or three words at most.');
  lines.push('tasks: a list of the things being done to it, each a few words. A line ' +
             'that mentions several jobs becomes several entries. Use [] if the line ' +
             'does not say, and never invent one the line does not mention.');
  lines.push('Lines about the same thing must get the same project name, spelled the same way.');

  if (known && known.length) {
    lines.push('');
    lines.push('Project names already in use: ' + known.map(function (n) {
      return JSON.stringify(String(n));
    }).join(', '));
    lines.push('If a line is about one of those, copy that name EXACTLY, character ' +
               'for character, including its capitals.');
    lines.push(SOUNDALIKE);
  }

  lines.push('');
  lines.push('If a line names or implies no project, return "" for both of its fields.');
  lines.push('Apart from matching a name from that list, never reword, translate, ' +
             'expand or correct what was written.');
  return lines.join('\n');
}

/* Entries waiting for the call that is currently out, drained as ONE call the
 * moment it comes back. Waiting for a call already in flight is the only delay
 * this design ever adds, and nothing on screen is waiting on it. */
var extractQueue = [];
var extractBusy = false;

/* A ceiling on one PROMPT, not on the queue: anything past this stays queued
 * and goes in the batch after. Tokens are effectively free, but an unbounded
 * prompt is not a thing to discover in production. */
var EXTRACT_BATCH_MAX = 20;

/**
 * Name one line: what project it is about, and what is being done to it.
 *
 * THREE WAYS THIS ANSWERS, cheapest first. See the long note further up for the
 * measured numbers behind the ordering.
 *
 *   - the line plainly names a project this device already knows: answered here
 *     and now, for nothing. Most entries on a normal day.
 *   - otherwise it joins the queue. Nothing is out -> it is sent alone,
 *     immediately, so an unhurried day is exactly as quick as it was before.
 *   - a call IS out -> it waits for that one, and then goes with everything else
 *     that arrived meanwhile, as a single call.
 *
 * DELIBERATELY NOT THROUGH api(). api() serialises every call through apiChain
 * so this device never competes with itself for the backend; a language model in
 * that queue would make the next M press and the next prayer tap wait behind it,
 * which is the one thing rule 4 forbids. This is a plain fetch, off the chain,
 * and nothing else in the app waits on it.
 *
 * It never rejects. Offline, signed out, out of budget, timed out, running on
 * the Apps Script fallback, or handed something that is not JSON — every one of
 * those resolves to {project:'', detail:''}, which is exactly what the tracker
 * wrote before any of this existed.
 */
function extractProject(text, known) {
  /* THE LOCAL MATCH IS NOW A FALLBACK, NOT THE FIRST CHOICE, and the reason is
   * worth keeping because the same trap will be dug again.
   *
   * It used to run first: if the line named a project already known, the name
   * was taken for free and Gemini never asked. That was right when the model
   * allowed 20 calls a DAY and the only thing extraction produced was a name —
   * `detail` went unread, so losing it cost nothing.
   *
   * Both halves of that stopped being true. The tile now lists the sub-tasks
   * under the heading, so `detail` is the greater part of what a person sees;
   * and gemini-3.5-flash-lite allows 500 a day, so spending one on an entry is
   * no longer the scarce thing it was. Matching locally now BUYS a call we can
   * easily afford and SELLS the sub-tasks, which is the wrong way round — it
   * showed up as two entries landing with a correct project and no tasks at all.
   *
   * So: ask when we can, and keep the free path for exactly the moments we
   * cannot — budget gone, offline, signed out, Gemini refusing. A named project
   * with no tasks beats an entry named after its whole sentence. */
  if (canAskGemini()) {
    return new Promise(function (resolve) {
      extractQueue.push({ text: text, known: known || [], resolve: resolve });
      pumpExtraction();
    });
  }

  /* Say WHY, before falling back. geminiCall() used to be the only thing that
   * set this, and it is no longer reached when the budget is gone — so without
   * this line the day's ceiling became silent again, and "the tasks stopped
   * appearing" would once more be indistinguishable from a broken feature. */
  if (cfg.backend === 'supabase' && sb && sbUser && geminiCallsLeft() <= 0) {
    lastExtractError = GEMINI_BUDGET_SPENT;
  }

  var mine = localProjectName(text);
  if (mine) {
    rememberProject(mine);                 // using a name is what keeps it fresh
    return Promise.resolve({ project: mine, detail: '' });
  }
  return Promise.resolve(noExtraction());
}

/** Is asking Gemini possible at all right now? Not "is it wise" — the pacer
 *  handles waiting — but whether a call could be made today. */
function canAskGemini() {
  return cfg.backend === 'supabase' && Boolean(sb) && Boolean(sbUser) &&
         geminiCallsLeft() > 0;
}

/* Set while the queue is waiting out a full minute, so that the twenty entries
 * that arrive during the wait schedule ONE timer between them rather than
 * twenty. Cleared by the timer itself, before it re-pumps. */
var pacerTimer = null;

/** Send the queue, if nothing is already out and the minute has room. Called
 *  the moment an entry joins — so a lone entry goes at once, with the latency it
 *  always had — again each time a call comes back, which is where the coalescing
 *  happens, and again when a held minute opens. */
function pumpExtraction() {
  if (extractBusy || !extractQueue.length) return;

  /* HELD, NOT DROPPED, and held BEFORE the batch is taken off the queue. Both
   * halves matter:
   *
   *   - nothing is spliced, so entries arriving during the wait join the same
   *     queue and go out in the same batch — the wait makes the batching better,
   *     not worse;
   *   - and the deadline in runExtraction() has not started, so a request held
   *     for fifty seconds still gets its full 15 to answer. Starting the clock
   *     here would time out every held call and quietly undo the pacing.
   *
   * The queue cannot jam on this. `extractBusy` is deliberately NOT set — no
   * call is out — and the timer always fires and always re-enters here, so the
   * worst case is a name that arrives a minute late, or never arrives because
   * the tab was closed first. The ROW is already saved either way. */
  var wait = geminiPacerWaitMs();
  if (wait > 0) {
    if (pacerTimer === null) {
      pacerTimer = setTimeout(function () {
        pacerTimer = null;
        pumpExtraction();
      }, wait);
    }
    return;
  }

  var batch = extractQueue.splice(0, EXTRACT_BATCH_MAX);

  function finish(answers) {
    extractBusy = false;
    batch.forEach(function (item, i) {
      var got = (answers && answers[i]) || null;

      /* Gemini had nothing for this line — refused, timed out, or answered
       * something unusable. Fall back to the free path here rather than giving
       * up: a project we already know, named from the words in the line, beats a
       * tile named after the whole sentence. No tasks, because only the model
       * can read those out of a sentence, but the heading is right. */
      if (!got || !got.project) {
        var mine = localProjectName(item.text);
        if (mine) {
          rememberProject(mine);
          got = { project: mine, detail: '' };
        }
      }
      item.resolve(got || noExtraction());
    });
    pumpExtraction();                      // whatever arrived while that was out
  }

  extractBusy = true;
  /* The second handler is the belt to runExtraction's brace. It is written not
   * to reject, but if it ever did, `extractBusy` would stay true for the life of
   * the page: every later entry would queue behind a call that is never coming
   * back, and every one of those sentences would stay hidden from the next
   * prompt for ever. An unnamed entry is fine. A jammed queue is not. */
  runExtraction(batch).then(finish, function () { finish([]); });
}

/** One Gemini call for one batch, under one deadline. Never rejects, and always
 *  resolves with exactly one answer per entry, in the order they were queued. */
function runExtraction(batch) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer;

  var nothing = function () {
    return batch.map(function () { return noExtraction(); });
  };

  var deadline = new Promise(function (resolve) {
    timer = setTimeout(function () {
      // Abort as well as resolve: a request nobody is waiting for any more
      // should not still be open when the next entry starts its own.
      if (ctrl) { try { ctrl.abort(); } catch (e) { /* already finished */ } }
      resolve(nothing());
    }, EXTRACT_DEADLINE_MS);
  });

  /* A single entry keeps the one-line prompt and the object schema it has
   * always used. The batch shape is for batches: the solo case is the common
   * one and it is not worth changing a request that is known to work. */
  var ask = batch.length === 1
    ? askGemini(batch[0].text, batch[0].known, ctrl).then(function (got) { return [got]; })
    : askGeminiMany(batch, ctrl);

  return Promise.race([ask, deadline]).then(function (got) {
    clearTimeout(timer);
    return keepNames(batch, got);
  }, function () {
    clearTimeout(timer);
    return nothing();                      // see above: this never throws onward
  });
}

/** Line the answers up with the entries, and remember the names that came back
 *  so the next line about the same thing is free. */
function keepNames(batch, got) {
  return batch.map(function (item, i) {
    var one = (got && got[i]) || noExtraction();
    if (one.project) rememberProject(one.project);
    return one;
  });
}

var lastExtractError = '';

/**
 * The one place this app talks to Gemini on the logging path: post `body` to
 * the Edge Function and hand back the model's text, or null.
 *
 * null covers every way there is nothing to read — wrong backend, signed out,
 * the day's budget spent, an HTTP error, an unreadable reply — and the reason
 * is left in `lastExtractError` rather than shown, because a row that stays
 * unnamed is correct behaviour and must not interrupt anybody.
 */
/** Google's refusal, narrowed to "the DAY is gone" rather than "this minute is".
 *  Same discriminator quotaWait() uses: the limit it names. */
function isDailyRefusal(msg) {
  var s = String(msg || '');
  if (s === GEMINI_BUDGET_SPENT) return false;          // that IS our own tally
  if (!/quota|rate.?limit|RESOURCE_EXHAUSTED|exceeded/i.test(s)) return false;
  if (/per.?minute|PerMinute/i.test(s)) return false;
  // Same asymmetry as quotaWait(): only stop for the day when Google actually
  // says the day. An unnamed limit is treated as the minute, and recovers.
  var lim = /limit:\s*([0-9]+)/i.exec(s);
  return !!lim && Number(lim[1]) > geminiRpmLimit() + 2;
}

/** Mark our own budget as gone, so nothing else is attempted today. Reversible
 *  by the date changing, like any other spend — never sticky beyond the day. */
function spendRestOfDay() {
  try {
    localStorage.setItem(GEMINI_DAY_KEY, JSON.stringify({
      day: localDayStamp(), n: geminiDailyBudget()
    }));
  } catch (e) { /* private mode: we simply keep trying, as before */ }
}

async function geminiCall(body, ctrl) {
  /* Gemini has one home and it is the Supabase Edge Function — the key is a
   * secret of that function and must never be anywhere else. On the Apps Script
   * fallback there is simply nothing to ask, and the row goes in unlabelled. */
  if (cfg.backend !== 'supabase' || !sb || !sbUser) return null;

  var got = await sb.auth.getSession();
  var session = got && got.data ? got.data.session : null;
  if (!session || !session.access_token) return null;

  if (geminiCallsLeft() <= 0) {
    lastExtractError = GEMINI_BUDGET_SPENT;
    return null;
  }
  /* Counted BEFORE the answer, on purpose. A request that has left this device
   * has been spent whether or not the reply ever arrives; counting on success
   * would let a run of timeouts walk straight past Google's own ceiling, which
   * is the one number we are here to stay under. */
  noteGeminiCall();

  var base = String(cfg.supaUrl || '').trim().replace(/\/+$/, '');
  var res = await fetch(base + '/functions/v1/gemini', {
    method: 'POST',
    signal: ctrl ? ctrl.signal : undefined,
    headers: {
      /* JSON, not the text/plain that rule 1 demands of Apps Script. That rule
       * exists because Apps Script cannot answer the CORS preflight an
       * application/json POST triggers. This function answers OPTIONS itself. */
      'Content-Type': 'application/json',
      // The user's own token, not the anon key: the function refuses anything
      // whose role is not `authenticated`.
      'Authorization': 'Bearer ' + session.access_token,
      'apikey': String(cfg.supaKey || '').trim()
    },
    body: JSON.stringify(body)
  });

  var data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || !data.ok) {
    /* Remember WHY. A failed extraction leaves the row unlabelled, which is
     * correct and also completely silent — and "the names just stopped
     * appearing" is indistinguishable from "the feature is broken" unless the
     * reason is kept. The reason only; never the prompt, never the answer. */
    lastExtractError = (data && data.error) || ('HTTP ' + res.status);

    /* If GOOGLE says the day is gone, believe it over our own tally and stop
     * asking. The two counts can disagree badly: ours starts at zero the first
     * time this code runs on a device, while Google has been counting all along
     * — on the day this shipped it was already at 21 of 20 before the app had
     * counted one. Without this, every later entry spends a doomed call and
     * waits the full deadline for a refusal we could already predict. */
    if (isDailyRefusal(lastExtractError)) spendRestOfDay();
    return null;
  }

  lastExtractError = '';
  quotaTold = '';                          // Gemini answered: any quota spell is over
  return String(data.text || '');
}

/** One line in, one project + detail out. */
async function askGemini(text, known, ctrl) {
  var answer = await geminiCall({
    prompt: extractPrompt(text, known),
    json: true,
    schema: EXTRACT_SCHEMA,
    /* Do not deliberate. Measured: the same request WITH deliberation took
     * 28.6 seconds to decide that "working on the Ahmed case, fixing the auth
     * bug" is the Ahmed case. Naming a project from one line is not a problem
     * that rewards thinking, and the function drops this knob by itself if
     * the model will not take it. */
    think: 0
  }, ctrl);

  if (answer === null) return noExtraction();
  return tidyExtraction(parseExtraction(answer), known);
}

/** Several lines in, one answer per line out — for the same price as one line.
 *  This is the whole saving on a burst of catching-up entries. */
async function askGeminiMany(items, ctrl) {
  var nothing = function () {
    return items.map(function () { return noExtraction(); });
  };

  // Everything any entry in this batch knew was open, merged and deduplicated.
  var seen = {};
  var known = [];
  items.forEach(function (item) {
    (item.known || []).forEach(function (name) {
      if (seen[name] === 1) return;
      seen[name] = 1;
      known.push(name);
    });
  });

  var answer = await geminiCall({
    prompt: extractManyPrompt(items.map(function (item) { return item.text; }), known),
    json: true,
    schema: EXTRACT_LIST_SCHEMA,
    think: 0
  }, ctrl);
  if (answer === null) return nothing();

  var got = parseExtraction(answer);

  /* MISALIGNMENT IS THE DANGEROUS FAILURE HERE, and it is worth being blunt
   * about: answers are matched to entries by POSITION, so a model that returns
   * four objects for five lines would put line two's project on line one, line
   * three's on line two, and so on — every row named after somebody else's
   * work, silently, for ever, in an append-only store.
   *
   * So the count is checked and nothing is guessed at. If it does not match
   * exactly, NONE of them are labelled: five unnamed rows is a mild
   * disappointment, five wrongly named ones is corrupted history. */
  if (!Array.isArray(got) || got.length !== items.length) {
    lastExtractError = 'gemini answered ' +
      (Array.isArray(got) ? got.length + ' lines' : 'something that is not a list') +
      ' for ' + items.length + ' entries, so none were named';
    return nothing();
  }

  /* AND THE COUNT IS NOT ENOUGH, which is the whole reason `n` exists. The right
   * number of objects in the wrong order passes every check above and is the
   * worst outcome this code can produce: not a missing name, a CONFIDENT wrong
   * one, on every row of the batch, in a store that cannot take it back.
   *
   * So each answer has to say which line it is, and it has to agree with where
   * it landed. `Number()` rather than `===`, because a model that writes "2"
   * instead of 2 is aligned and merely typed; anything that is not a number at
   * all (missing, null, an array, a nested object) is unverifiable and counts as
   * wrong, because "cannot be checked" and "is correct" are not the same claim.
   *
   * One bad slot condemns the batch, never just itself: if the numbering is
   * untrustworthy anywhere in the answer, there is no reason to believe it in
   * the slots that happen to look right. Twenty unnamed rows is a dull evening;
   * twenty wrongly named ones is a corrupted history. */
  var wrong = -1;
  for (var i = 0; i < got.length; i++) {
    var said = got[i] ? Number(got[i].n) : NaN;
    if (said !== i + 1) { wrong = i; break; }
  }
  if (wrong !== -1) {
    /* The model's own value is described, never quoted in. `lastExtractError` is
     * handed to quotaWait(), which decides whether to flash "Gemini is
     * rate-limited" by looking for words like "quota" in it — so a model that
     * answered {"n":"quota exceeded"} could otherwise put a false explanation on
     * screen. Reporting the TYPE says everything a diagnosis needs anyway. */
    var badN = got[wrong] ? got[wrong].n : null;
    lastExtractError = 'gemini numbered line ' + (wrong + 1) + ' as ' +
      (typeof badN === 'number' ? badN : 'a ' + (badN === null ? 'null' : typeof badN)) +
      ', so the batch could not be lined up and none of its ' + items.length +
      ' entries were named';
    return nothing();
  }

  return items.map(function (item, i) {
    return tidyExtraction(got[i], item.known);
  });
}

/* Diagnostic only, used by Settings → Test Gemini when extraction comes back
 * empty. Sends the extraction prompt WITHOUT `json`/`schema` and returns the
 * answer as text, so a person can see which of two very different problems it
 * is: an Edge Function still on the old code (it ignores the schema and the
 * model rambles), or a model that answered something genuinely unparseable.
 * Never called on the logging path — it costs a second round trip. */
async function askGeminiRaw(text) {
  if (cfg.backend !== 'supabase' || !sb || !sbUser) return '(not on Supabase)';
  try {
    var got = await sb.auth.getSession();
    var session = got && got.data ? got.data.session : null;
    if (!session || !session.access_token) return '(not signed in)';

    // A real call against the free tier's 20 a day, so it is counted like one.
    // Not refused when the budget is gone, though: this is the diagnostic, and
    // the two calls held back from the budget exist precisely for it.
    noteGeminiCall();

    var base = String(cfg.supaUrl || '').trim().replace(/\/+$/, '');
    var res = await fetch(base + '/functions/v1/gemini', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': String(cfg.supaKey || '').trim()
      },
      body: JSON.stringify({ prompt: extractPrompt(text, []) })
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || !data.ok) {
      return '(HTTP ' + res.status + ' ' + ((data && data.error) || '') + ')';
    }
    return JSON.stringify(String(data.text || '')).slice(0, 300);
  } catch (e) {
    return '(' + (e && e.message ? e.message : e) + ')';
  }
}

/* Did the mic put the current text in the box? It survives editing on purpose —
 * fixing a misheard word does not make the sentence typed — but not clearing. */
var voiceFilled = false;

$('trackerInput').addEventListener('input', function () {
  if (!this.value.trim()) voiceFilled = false;
});

$('trackerForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var input = $('trackerInput');
  var text = input.value.trim();
  if (!text) return;

  /* replayDay() treats `voice` and `work` identically, so this changes no number
   * anywhere. It is recorded only so Stage 5 can answer "how much of this did I
   * speak rather than type", which is unanswerable later if it is not kept now. */
  var type = voiceFilled ? 'voice' : 'work';
  voiceFilled = false;

  input.value = '';
  var undo = beginToggleWrite();

  var steps = wakeSteps(true);             // logging work is starting work

  /* The open projects, read BEFORE the optimistic row is added. Afterwards the
   * row we are about to write is itself in that list — keyed on the whole
   * sentence, because it has no project yet — and the prompt would be inviting
   * the model to reuse the sentence as a project name. */
  var known = promptNames(openProjects());

  // Typing an entry means you are working — if you were on a break or the day
  // was marked over, this reopens it, so the clock and the label agree.
  if (toggles.work.state !== 'working') setToggle('work', 'working');
  var row = noteLocalRow(type, text);
  flash('Logged', 'ok');

  /* The id of this row, made HERE rather than inside api(), because a label that
   * arrives in a few seconds has to be able to name the row it belongs to. It is
   * the same id every retry of the write would carry, so it stays one row. */
  var rid = newRid();

  steps.push({
    type: type,
    raw_text: text,                        // VERBATIM. The model never edits the
                                           // human record, and Code.gs rejects
                                           // an empty one.
    project: '',                           // filled in later, or never
    detail: '',
    rid: rid
  });

  // On the tap. Everything below only decides what this row is CALLED.
  var wrote = runWrites(steps, undo);

  /* Hide this sentence from the next entry's prompt while its own label is in
   * flight. Only while: once the label has settled, an entry that stayed
   * unlabelled is an ordinary sentence-named tile, and the model should be told
   * about it so a follow-up line lands on the same tile rather than a new one. */
  awaitingLabel[text] = (awaitingLabel[text] || 0) + 1;

  function forget() {
    awaitingLabel[text] -= 1;
    if (awaitingLabel[text] <= 0) delete awaitingLabel[text];
  }

  function settle(got) {
    if (!got.project) {
      /* Saved either way — only the NAME is missing. Worth one quiet line when
       * the cause is a ceiling rather than a shrug, because otherwise the names
       * simply stop appearing and nothing says why.
       *
       * Once per cause, not per entry: `quotaTold` holds WHICH of the two
       * ceilings was mentioned — the cause, not the wording, because Google's
       * refusal carries a countdown that differs every time and comparing
       * sentences would flash on every single entry. It is cleared only when
       * Gemini actually answers again (see geminiCall), which is the whole
       * distinction: the per-minute limit ends when a call succeeds, but the
       * day's budget does not, and a free local match must not re-arm a line
       * about tomorrow.
       *
       * Short, because the banner clears itself in 2.6 seconds and the full
       * explanation does not fit in that. Settings -> Test Gemini prints the
       * long version, and the day's count with it. */
      var cause = lastExtractError === GEMINI_BUDGET_SPENT ? 'budget' : 'rate';
      if (quotaWait(lastExtractError) && quotaTold !== cause) {
        quotaTold = cause;
        flash(cause === 'budget'
          ? 'Saved. Gemini\'s daily limit is used up — no project names until tomorrow.'
          : 'Saved. Gemini is rate-limited, so no project name — it clears in a minute.', 'warn');
      }
      forget(); return;                     // understood nothing: the old behaviour
    }
    wrote.then(function (ok) {
      // A row that never landed has nothing to label, and the failed write has
      // already scheduled its own reconcile against the store.
      if (!ok) { forget(); return; }
      applyLabel(rid, text, row, got, forget);
    });
  }

  extractProject(text, known).then(settle, function () { settle(noExtraction()); });
});

/* Tile names whose label has not settled yet — kept out of the next entry's
 * prompt. Counted rather than flagged, because the same sentence can be logged
 * twice before either one is answered. */
var awaitingLabel = {};
/* Which ceiling has already been mentioned: '' , 'rate' or 'budget'. A name
 * rather than a flag, because there are two causes now — Google's per-minute
 * refusal and our own daily budget — and being told about the second only
 * because the first was mentioned first would be no help at all. */
var quotaTold = '';

/** What the model may be told is already open. */
function openProjects() {
  return replayDay(lastLog).activeProjects.filter(function (name) {
    return !awaitingLabel[name];
  });
}

/** Is `name` still an open project, as far as this device knows right now? */
function isOpenProject(name) {
  return replayDay(lastLog).activeProjects.indexOf(name) !== -1;
}

/**
 * Put Gemini's project name on a row that is already written.
 *
 * `key` is what the tile is called until this lands — the raw sentence — and
 * every check here is about that name changing under the user's feet. See the
 * long note at the top of the tracker for why the row is written first.
 */
function applyLabel(rid, key, row, got, done) {
  /* Supabase only. The Apps Script fallback cannot change a row it has already
   * appended, and extractProject() never returns a project there anyway. */
  if (!usingSupabase()) { done(); return; }

  /* Done already pressed — including on the other device, since these rows are
   * the shared truth. Labelling now would rename the tile back into existence
   * under a name that no `done` row has ever used, and the real one could then
   * never be closed. An unlabelled row is the right answer here. */
  if (!isOpenProject(key)) { done(); return; }

  api('label', { rid: rid, project: got.project, detail: got.detail }).then(function (res) {
    done();
    // No update policy in the database yet, or the row is not there: the entry
    // keeps the sentence as its name, which is where this stage started.
    if (!res || !res.labelled) return;

    /* The tile was closed while the update was in flight, so the `done` row
     * names the sentence and the store now names the project. Close it again
     * under the new name: an append-only store takes something back by
     * appending, and a `done` for a project that is not open costs nothing. */
    if (!isOpenProject(key)) { closeProject(got.project); return; }

    row.project = got.project;
    row.detail = got.detail;
    renderProject();
    renderDaySummary();
    renderLogList();
    // A refresh may have replaced the row above with the store's own copy, in
    // which case the rename shows up when this lands rather than immediately.
    scheduleRefresh(600);

    // Model output, so textContent only — which is all flash() ever uses.
    flash('Logged — ' + got.project + (got.detail ? ': ' + got.detail : ''), 'ok');
  }, function () {
    done();                                // saved and unlabelled; nothing to undo
  });
}

// -------------------------------------------------------------------- voice

/* The Web Speech API, which in practice means Chrome's webkit-prefixed one.
 * Worth knowing before reading the error handling: it is NOT on-device on the
 * desktop — Chrome ships the audio to Google and simply fails with no
 * connection, which is why `network` gets a message of its own. */
var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
var micBtn = $('micBtn');

/* WHY THERE IS A SETTING FOR HIDING THIS BUTTON.
 *
 * This button can only ever reach the Web Speech API, which on Android means
 * Google's recogniser — the one that hears "NeuraVue" as "my review". A page
 * cannot invoke a dictation app; those work by typing into whatever field has
 * focus, from a bubble above the keyboard. So the good transcriber and this
 * button are not two settings of one thing, they are two different microphones,
 * and the app can only offer one of them.
 *
 * Saad asked for a single mic and the better transcription. That is the
 * keyboard's, so this button gets out of the way — per device, because the
 * laptop's free allowance is small enough that its built-in mic still earns its
 * place while the phone's does not.
 *
 * Hidden, never removed: it is the fallback for the day a free tier ends, and
 * it costs one line to keep. */
function paintMic() {
  /* A button that cannot work is worse than no button, and there is a real
   * fallback one line below it in the markup: the keyboard's own mic. */
  var off = !Recognition || Boolean(cfg.hideMic);
  micBtn.hidden = off;
  $('micHint').textContent = off
    ? 'Tap the box, then the mic on your keyboard — Gboard\u2019s, or Wispr Flow\u2019s bubble.'
    : 'Your keyboard\u2019s own mic works in this box too — tap the box, then the mic on the '
      + 'keyboard. Wispr Flow\u2019s bubble appears there as well.';
}
paintMic();

/* Chrome mishears the app's own name more often than it gets it right —
 * "Pro Being", "ProBing", "probing" — and none of those spellings belong in the
 * log. One pattern covers them all: "pro", an optional space, then "being" or
 * "bing", and whatever punctuation follows.
 *
 * The possessive is spelled out because "ProBeing's roadmap review" is a normal
 * thing to say, and the word boundary lands before the apostrophe: without the
 * `'s` the entry was logged as "'s roadmap review". Both apostrophes, because a
 * phone keyboard and a transcript disagree about which one they use. */
var WAKE_WORD = /^\s*pro\s*be?ing\b(?:['’]s)?[\s,.:;'’-]*/i;

function stripWakeWord(said) {
  return String(said || '').replace(WAKE_WORD, '').trim();
}

/* Told apart on purpose. "It did not hear you", "your microphone is blocked" and
 * "you are offline" need three completely different responses from the person
 * holding the phone, and one generic "voice failed" teaches them to ignore all
 * three. The blocked-mic case is also the one the Gboard note under the tracker
 * is there for. */
var VOICE_ERRORS = {
  'not-allowed': 'Microphone is blocked — use the keyboard\'s mic instead.',
  'service-not-allowed': 'Microphone is blocked — use the keyboard\'s mic instead.',
  network: 'Voice needs a connection. Type it, or try again when you are back online.',
  'no-speech': 'Did not catch that — tap the mic and say it again.',
  'audio-capture': 'No microphone found on this device.'
};

/* HOLD-OPEN DICTATION, and why it is not the one-line change it looks like.
 *
 * `continuous = true` is the whole feature on a laptop. On Android it is close
 * to decorative: Chrome ends the session after a few seconds of quiet whatever
 * that flag says, and `onend` fires. So "keep listening until I tap again" is
 * really "start another session every time one ends, until the user says stop"
 * — a loop around a live microphone, which needs three guards or it becomes a
 * mic that runs all afternoon:
 *
 *   1. A fatal error must not restart. A blocked mic that retries sixty times
 *      is sixty permission failures and a flat battery, and none of them tells
 *      the user anything the first one did not.
 *   2. A session that ends almost as soon as it starts is a refusal wearing
 *      `onend`'s clothes — the API reports several failures that way. Three in
 *      a row and we stop and say so.
 *   3. A ceiling in wall-clock time, because the commonest way this ends badly
 *      is nobody tapping stop at all.
 *
 * `no-speech` is deliberately NOT an error here. It is the silence between two
 * sentences, and reporting it once a gap is what would make this mode unusable.
 */
var MIC_MAX_MS = 2 * 60 * 1000;
var MIC_FAST_FAIL_MS = 400;
var MIC_FAST_FAILS = 3;

/* Retrying these achieves nothing: the mic is blocked, absent, or the transcriber
 * is unreachable. A second tap is the right way to try again, not a loop. */
var FATAL_VOICE = {
  'not-allowed': 1, 'service-not-allowed': 1, 'audio-capture': 1, network: 1
};

var listening = false;
var recognizer = null;
var micStop = false;        // the user tapped a second time
var micFatal = false;       // an error there is no point retrying
/* Whether the user has already been told why this ended. Without it the
 * two-minute cutoff was followed by "Did not catch that — tap the mic and say
 * it again", which contradicts the message before it and blames the user for
 * something the app decided. */
var micToldWhy = false;
var micFastFails = 0;
var micHeardSomething = false;
var micTimer = null;

function paintListening(on) {
  micBtn.classList.toggle('listening', on);
  micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  micBtn.setAttribute('aria-label', on ? 'Stop recording' : 'Voice note');
  /* The second tap is the only way out of this mode, so the line under the box
   * says so while it is running. paintMic() puts the normal wording back. */
  if (on) {
    $('micHint').textContent =
      'Listening — keep talking, pauses are fine. Tap the mic again when you are done.';
  } else {
    paintMic();
  }
}

/** End the session for good: no more restarts, button back to normal. */
function finishListening() {
  listening = false;
  recognizer = null;
  if (micTimer) { clearTimeout(micTimer); micTimer = null; }
  paintListening(false);

  /* Focus HERE and not on each chunk. Focusing mid-dictation throws the phone
   * keyboard up over the screen every time a sentence settles. */
  if (micHeardSomething) $('trackerInput').focus();
  else if (!micToldWhy) flash(VOICE_ERRORS['no-speech']);
}

/** Stop, letting the last chunk settle. `stop()` and not `abort()`: abort throws
 *  away the sentence the user has just finished saying. */
function askStop() {
  micStop = true;
  try { recognizer.stop(); } catch (e) { finishListening(); }
}

function appendHeard(heard) {
  /* FILLED, NOT SUBMITTED, and that is a deliberate departure from the plan.
   * The store is append-only and has no delete, so a misheard sentence written
   * without anyone reading it is a row you keep for good. One tap on Log is
   * still comfortably inside the five-second rule, and it is the only moment a
   * mishearing can be caught. This button is also the LESS accurate mic — the
   * one a dictation app is used instead of — so auto-submitting here would be
   * auto-submitting the path most likely to be wrong.
   *
   * Appended rather than replacing, so tapping the mic after typing does not
   * silently destroy what was typed — and so each chunk of a long dictation
   * joins the last instead of erasing it. */
  var box = $('trackerInput');
  var had = box.value.trim();
  box.value = had ? had + ' ' + heard : heard;
  voiceFilled = true;
  micHeardSomething = true;
}

/** One recognition session. Calls itself again through `onend` until stopped. */
function spinListening() {
  var rec = new Recognition();
  recognizer = rec;
  rec.lang = navigator.language || 'en-US';  // the device's language, not a guess
  rec.interimResults = false;              // settled answers only, not a live stream
  rec.continuous = true;                   // honoured on a laptop, ignored on Android
  rec.maxAlternatives = 1;

  var began = Date.now();

  rec.onresult = function (ev) {
    /* From resultIndex, not from 0. A continuous session keeps every result it
     * has ever produced in `ev.results`, so reading [0] would re-append the
     * first sentence after every pause. */
    var fresh = '';
    for (var i = ev.resultIndex; i < ev.results.length; i++) {
      var r = ev.results[i];
      if (r.isFinal && r[0]) fresh += (fresh ? ' ' : '') + r[0].transcript;
    }
    var heard = stripWakeWord(fresh);
    if (heard) appendHeard(heard);         // an empty settled chunk is just quiet
  };

  rec.onerror = function (ev) {
    var code = ev && ev.error;
    if (code === 'aborted') return;        // our own stop(); nothing to report
    if (code === 'no-speech') return;      // the gap between two sentences
    micToldWhy = true;
    if (FATAL_VOICE[code]) {
      micFatal = true;
      flash(VOICE_ERRORS[code] || ('Voice failed — ' + code), 'err');
      return;                              // onend follows and will finish up
    }
    flash(VOICE_ERRORS[code] || ('Voice failed' + (code ? ' — ' + code : '.')), 'err');
  };

  rec.onend = function () {
    if (micStop || micFatal) { finishListening(); return; }

    if (Date.now() - began < MIC_FAST_FAIL_MS) {
      micFastFails += 1;
      if (micFastFails >= MIC_FAST_FAILS) {
        micToldWhy = true;
        flash('The microphone keeps stopping. Type it, or use the keyboard\u2019s mic.', 'err');
        finishListening();
        return;
      }
    } else {
      micFastFails = 0;                    // a session that really ran clears the count
    }

    spinListening();                       // silence, not an ending
  };

  try {
    rec.start();
  } catch (e) {
    flash('Could not start the microphone.', 'err');
    finishListening();
  }
}

/** The mic button's whole behaviour, named so it can be driven by a test with a
 *  fake recogniser. A restart loop is not something to verify by talking to a
 *  phone and hoping. */
function toggleListening() {
  if (listening) { askStop(); return; }    // a second tap means "I have finished"

  listening = true;
  micStop = false;
  micFatal = false;
  micToldWhy = false;
  micFastFails = 0;
  micHeardSomething = false;
  paintListening(true);                    // red before the first word, not after

  /* Guard 3. Two minutes is far longer than any log entry and far shorter than
   * an afternoon of an open microphone. */
  micTimer = setTimeout(function () {
    if (!listening) return;
    micToldWhy = true;
    askStop();
    flash('Microphone stopped after two minutes.', 'warn');
  }, MIC_MAX_MS);

  spinListening();
}

if (Recognition) micBtn.addEventListener('click', toggleListening);

$('refreshBtn').addEventListener('click', function () { refresh({ announce: true }); });

// ------------------------------------------------------------- the data floor

/* A review counts rows. That makes an impossible question look like a boring
 * answer: ask for a week that ended before the first row was ever written and
 * the count comes back 0, which reads as "you did nothing that week" rather than
 * the truth, "ProBeing was not here yet". A zero is a claim about your life; a
 * refusal is a claim about the data. Only one of them is honest.
 *
 * So every range a report is built from goes through here first, and a range
 * that starts before the first event is refused by name instead of summed.
 *
 * Nothing calls this until Stage 5 builds the reviews. It ships now because it
 * is far easier to get right while nobody depends on the answer.
 */

/** The instant of this account's very first event — min(at) — or '' if there are
 *  none at all. Row level security already scopes it to the signed-in user, so
 *  "first row" means their first row. */
async function earliestEventAt() {
  if (!sb || !sbUser) return '';
  var res = await sb.from('events').select('at')
    .order('at', { ascending: true })
    .limit(1);
  if (res.error) throw errorFrom(res.error);
  return (res.data && res.data[0] && res.data[0].at) || '';
}

/* Deliberately takes the floor as an argument and uses no other helper: it is a
 * pure function of two strings, so it can be tested without a database, a clock,
 * or a browser. */
/**
 * @param startDate  the local date a range opens, 'YYYY-MM-DD' (or a Date).
 * @param earliestAt the account's min(at), an ISO instant, or '' for none.
 * @returns {{ok: boolean, floor: string, message: string}} — `ok:false` carries
 *          the sentence to show, and never a number.
 */
function rangeFloor(startDate, earliestAt) {
  var ymd = function (d) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  var start = (startDate instanceof Date) ? ymd(startDate) : String(startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return { ok: false, floor: '', message: 'That is not a date I can read.' };
  }

  if (!earliestAt) {
    return { ok: false, floor: '',
             message: 'There is nothing logged yet, so there is nothing to report on.' };
  }

  var first = new Date(earliestAt);
  if (isNaN(first.getTime())) {
    return { ok: false, floor: '', message: 'The first entry has an unreadable date.' };
  }

  // Compared as local dates, because that is the day the user lived through.
  var floor = ymd(first);
  if (start < floor) {
    return { ok: false, floor: floor,
             message: 'No data before ' + floor + ' — that is the day of the first thing ' +
                      'ProBeing ever recorded. Ask for a range starting on or after it.' };
  }
  return { ok: true, floor: floor, message: '' };
}

/** The two halves together: read the floor, then judge the range.
 *
 *  The instant itself is handed back alongside the verdict so that a SECOND
 *  range — the earlier period the pace line compares against — can be judged
 *  with the pure function above and no second trip to the database. */
async function checkRangeFloor(startDate) {
  var earliest = await earliestEventAt();
  var got = rangeFloor(startDate, earliest);
  got.earliest = earliest;
  return got;
}

// ------------------------------------------------------------------- review

/* WHAT THIS SCREEN ACTUALLY IS: replayDay() run once per day instead of once,
 * the totals added up, sorted into the four kinds of work, and ONE call to
 * Gemini. The arithmetic never leaves this device.
 *
 * That split is a budget rule, not a preference. The free tier allows a handful
 * of Gemini calls a day, so a design that asks the model per day, or per
 * project, or per category, spends a week's allowance on one screen. It is also
 * the shape that gives the right answer: the model writes prose well and adds
 * up badly.
 *
 * WHAT THE MODEL IS LEFT WITH, after the redesign: the Learning line, and one or
 * two lines saying whether this stretch was faster or slower than the one before
 * it — and even that comparison is subtracted here and handed over finished. The
 * headings, the hours, the projects and the bullets under them are all local, so
 * they cannot be hallucinated and they cannot go missing.
 *
 * The order of operations below is the other half of the same idea. Figures
 * first, sentences second — the numbers are on screen before Gemini is asked
 * anything, so a spent budget costs two lines and never the report. */

/** The five ranges the picker offers. `days` counts back from today inclusive,
 *  so "Last 7 days" is today plus the six before it.
 *
 *  "This week" is Monday to TODAY — a week in progress. "Last week" is the
 *  previous complete Monday to Sunday, which is what a weekly review usually
 *  means and is the only range here that never contains today.
 *
 *  Last 30 days is here for a reason beyond wanting a month: it is the only
 *  option that can reach back past 27 Aug 2026, the first row this account has.
 *  Without it the refusal below is unreachable from the shipped UI, and an
 *  untriggerable safeguard is one nobody has ever seen work. */
var REVIEW_RANGES = [
  { id: 'd2', label: 'Last 2 days', days: 2 },
  { id: 'd7', label: 'Last 7 days', days: 7 },
  { id: 'wk', label: 'This week', week: true },
  { id: 'lw', label: 'Last week', week: true, back: 1 },
  { id: 'd30', label: 'Last 30 days', days: 30 }
];

var REVIEW_DEFAULT_RANGE = 'd7';

/** A Date as the local calendar day it falls on, 'YYYY-MM-DD'.
 *  rangeFloor() above has its own copy on purpose — it is written to be a pure
 *  function of two strings with no helpers at all, so it can be tested without
 *  a clock or a browser. Three lines is a cheap price for that. */
function ymdLocal(d) {
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * Turn a picker id into the two local calendar days it covers, inclusive.
 * Takes `now` rather than reading the clock, so the tests can ask for any day.
 */
function reviewRangeOf(id, now) {
  var spec = null;
  REVIEW_RANGES.forEach(function (r) { if (r.id === id) spec = r; });
  if (!spec) spec = REVIEW_RANGES[1];

  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var start;
  var end = today;

  if (spec.week) {
    // Monday, because that is where Saad's week starts and where the Review
    // spec's example week starts. Sunday is day 0 in JS, hence the shuffle.
    var dow = (today.getDay() + 6) % 7;
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow);

    /* `back` walks whole weeks off THIS week's Monday, which is what makes
     * "Last week" the previous COMPLETE week on every day of the week. Counting
     * back from today would be wrong twice over: on a Monday the two weeks are
     * adjacent, and on a Sunday the current week is finishing but is not
     * finished — so last week must still be the one before it, and this way it
     * is, without either case being special-cased. */
    if (spec.back) {
      start = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7 * spec.back);
      end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    }
  } else {
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (spec.days - 1));
  }

  return { id: spec.id, label: spec.label, start: start, end: end };
}

/**
 * The range of the same length immediately before this one: 27 Aug – 2 Sep is
 * measured against 20 – 26 Aug.
 *
 * Worked out here rather than by Gemini, for the same reason every other figure
 * is. A pace verdict is a subtraction, and the model is being asked to write,
 * not to count — it gets both totals and the word already chosen.
 */
function priorRangeOf(win) {
  var midnight = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  // Rounded, because a range that spans a clock change is 23 or 25 hours long
  // on one of its days and would otherwise come out a day short or a day over.
  var days = Math.round((midnight(win.end) - midnight(win.start)) / 86400000) + 1;

  var end = new Date(win.start.getFullYear(), win.start.getMonth(), win.start.getDate() - 1);
  var start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1));
  return { start: start, end: end, days: days };
}

/* When are two periods "about the same"?
 *
 * This was a flat minute, which is no band at all once the range is longer than
 * an afternoon: a week's total lands within a minute of the last one roughly
 * never, so the report announced a change of pace every single time it was
 * opened. A band has to scale with what is being measured.
 *
 * So: within a twentieth of the earlier period, or within a quarter of an hour,
 * whichever is the more forgiving. The floor is what keeps a short range sane —
 * 5% of a two-day period can be three minutes — and the fraction is what keeps
 * a thirty-day one honest.
 *
 * BOTH NUMBERS ARE A JUDGEMENT, NOT A MEASUREMENT. Nothing was counted to
 * arrive at them; they are a guess at when a difference stops being worth a
 * sentence. Move them if the pace line starts reading wrong — that is a
 * preference, not a bug. */
var PACE_SAME_FRACTION = 0.05;              // a twentieth of the earlier period
var PACE_SAME_FLOOR_MS = 15 * 60000;        // …but never a band tighter than this

/** How far the two totals may differ and still be called the same. */
function paceBandMs(priorMs) {
  var prior = (typeof priorMs === 'number' && priorMs > 0) ? priorMs : 0;
  return Math.max(prior * PACE_SAME_FRACTION, PACE_SAME_FLOOR_MS);
}

/**
 * This range against the one before it, as a finished verdict.
 *
 * @param prior from priorRangeOf() — carried through so the prompt can name the
 *              dates it is comparing against rather than say "before".
 * @param known false when the earlier period reaches back past the first row
 *              this account has. Then there is no comparison — not a zero, the
 *              same refusal the date floor and the sleep line make.
 */
function paceOf(workedMs, priorMs, prior, known) {
  var out = {
    known: Boolean(known),
    worked: workedMs,
    prior: known ? priorMs : 0,
    diff: 0,
    word: '',
    days: (prior && prior.days) || 0,
    // Dated only if it really has dates: the prompt names the period it is
    // comparing against, and a half-built one must not put "Invalid Date" there.
    fromYmd: (prior && prior.start instanceof Date) ? ymdLocal(prior.start) : '',
    toYmd: (prior && prior.end instanceof Date) ? ymdLocal(prior.end) : ''
  };
  if (!out.known) return out;

  out.diff = workedMs - priorMs;
  out.word = Math.abs(out.diff) < paceBandMs(priorMs) ? 'about the same'
           : (out.diff > 0 ? 'faster' : 'slower');
  return out;
}

/**
 * One window per local calendar day, [midnight, next midnight).
 *
 * Built by adding to the day-of-month rather than adding 24 hours, which is the
 * whole point: on a day the clocks move, 24 hours is the wrong length and the
 * windows would drift an hour out of step with the days they are meant to
 * name. Asia/Karachi has no daylight saving, so this costs nothing today and
 * cannot be got wrong later by somebody travelling.
 *
 * The 400 is a stop, not a limit: a bad pair of dates must not spin forever.
 */
function dayWindows(startDate, endDate) {
  var out = [];
  var d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  var last = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()).getTime();

  for (var guard = 0; d.getTime() <= last && guard < 400; guard++) {
    var next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    out.push({ ymd: ymdLocal(d), startMs: d.getTime(), endMs: next.getTime() });
    d = next;
  }
  return out;
}

/**
 * Split rows into their local days.
 *
 * Each day comes back NEWEST FIRST, which looks backwards and is not.
 * replayDay() breaks a same-instant tie on where a row sits in the array —
 * "the later it sits, the older it is" — because today() hands it rows in that
 * order. Feeding it oldest-first would replay every tied pair backwards, so
 * "End the day, Start the day" would read as starting after ending. reverse()
 * rather than a sort, because a sort would have to re-derive the order that
 * the query already established.
 */
function bucketByWindow(rows, windows) {
  var buckets = windows.map(function () { return []; });

  (rows || []).forEach(function (row) {
    var t = instantOf(row.at);
    if (isNaN(t)) return;
    for (var i = 0; i < windows.length; i++) {
      if (t >= windows[i].startMs && t < windows[i].endMs) { buckets[i].push(row); break; }
    }
  });

  return buckets.map(function (b) { return b.reverse(); });
}

/**
 * Sleep, measured the only way it can be: from a `sleep` row to the `wake` row
 * that closes it.
 *
 * Walked across the WHOLE range rather than day by day, because a night starts
 * on one date and ends on the next — the one figure in the review that cannot
 * be summed out of per-day answers.
 *
 * NOT TESTED AGAINST REAL ROWS, and it cannot be: there is not one `sleep` or
 * `wake` row in the database. That is exactly why the caller prints "no sleep
 * logged" instead of "0h" — a zero here would be a claim about how Saad slept,
 * and the honest answer is that nothing was recorded.
 *
 * @param rows oldest first.
 */
function sleepInRange(rows) {
  var seen = 0;
  var nights = 0;
  var totalMs = 0;
  var openAt = 0;

  (rows || []).forEach(function (row) {
    if (row.type !== 'sleep' && row.type !== 'wake') return;
    var t = instantOf(row.at);
    if (isNaN(t)) return;
    seen += 1;

    if (row.type === 'sleep') {
      // A second Sleep with no Wake between is the same night, still open.
      if (!openAt) openAt = t;
      return;
    }
    // A Wake with nothing open closes nothing — the night began before this
    // range, and half a night is not a measurement.
    if (openAt && t > openAt) { totalMs += t - openAt; nights += 1; }
    openAt = 0;
  });

  return { rows: seen, nights: nights, totalMs: totalMs, unclosed: Boolean(openAt) };
}

/**
 * The whole range as numbers. Pure: rows and windows in, figures out.
 *
 * THE TOTALS OVERLAP ON PURPOSE, exactly as they do for a single day.
 * sum(byProject) may exceed `worked` — two hours on two projects at once is two
 * hours of your life and two hours of each — and may also fall short of it,
 * which is what `unattributed` measures. Neither is ever derived from the
 * other, here or anywhere.
 *
 * @param rows    every row in the range, oldest first.
 * @param windows one per local day, from dayWindows().
 */
function summariseRange(rows, windows) {
  var sum = {
    days: windows.length,
    daysWithRows: 0,
    worked: 0,
    paused: 0,
    unattributed: 0,
    // Keyed by what was typed, so they carry no prototype — see userMap().
    byProject: userMap(),
    byReason: userMap(),
    m: 0,
    prayers: 0,
    byMode: userMap(),
    perDay: [],
    rows: 0
  };

  var buckets = bucketByWindow(rows, windows);

  windows.forEach(function (w, i) {
    var dayRows = buckets[i];
    sum.rows += dayRows.length;
    if (dayRows.length) sum.daysWithRows += 1;

    // The day's own end, so an unclosed clock stops at midnight instead of
    // running to this moment. replayDay() pulls it back to now for today.
    var day = replayDay(dayRows, w.endMs);

    sum.worked += day.worked;
    sum.paused += day.paused;
    sum.unattributed += day.unattributed;

    Object.keys(day.byProject).forEach(function (p) {
      sum.byProject[p] = (sum.byProject[p] || 0) + day.byProject[p];
    });
    Object.keys(day.byReason).forEach(function (r) {
      sum.byReason[r] = (sum.byReason[r] || 0) + day.byReason[r];
    });

    /* Counted per day, not over the raw range, and that is what makes them
     * LOCAL-day counts. Karachi is five hours ahead of UTC, so 27 Aug's seven M
     * rows are stamped the 27th here and mostly the 27th in UTC — but the same
     * rows late on a UTC evening would fall on the next date entirely. The
     * windows are the device's own midnights, so this counts the days Saad
     * lived through. */
    dayRows.forEach(function (row) {
      if (row.type === 'M') sum.m += 1;
      if (row.type === 'prayer') {
        sum.prayers += 1;
        var mode = String(row.detail || '').trim();
        if (mode) sum.byMode[mode] = (sum.byMode[mode] || 0) + 1;
      }
    });

    sum.perDay.push({ ymd: w.ymd, rows: dayRows.length, worked: day.worked });
  });

  /* Divided by the days that HAVE rows, never by the calendar. 1 Sep has no
   * rows at all — a day nothing was logged is a day with no measurement, not a
   * day of zero hours, and averaging it in would quietly drag every figure in
   * the report down by a seventh. */
  sum.avgWorked = sum.daysWithRows ? Math.round(sum.worked / sum.daysWithRows) : 0;
  sum.empty = sum.daysWithRows === 0;
  sum.sleep = sleepInRange(rows);
  return sum;
}

/**
 * Only the rows that fall inside these day windows.
 *
 * Needed because ONE read now covers two ranges — the one being reviewed and
 * the equal-length one before it, for the pace line. summariseRange() cannot
 * simply be handed the wider set: it buckets work by window, but sleepInRange()
 * walks every row it is given, so last week's nights would be added to this
 * week's total without a single figure looking wrong.
 */
function rowsInWindows(rows, windows) {
  if (!windows || !windows.length) return [];
  var from = windows[0].startMs;
  var to = windows[windows.length - 1].endMs;

  return (rows || []).filter(function (row) {
    var t = instantOf(row.at);
    return !isNaN(t) && t >= from && t < to;
  });
}

/* A project key longer than this is a sentence, not a name.
 *
 * replayDay() keys a row on `project || raw_text`, so an entry Gemini never got
 * to label is filed under its whole sentence — "working on 5-Link Humanoid
 * Project, solving issues for dynamic…". Twelve of the twenty-two work rows in
 * the store are like that, and a week's project list made of them is unreadable.
 *
 * The keying itself is deliberately left alone: the Today tab shares it, and
 * two answers to "which project is this row" is how tiles go missing. So the
 * collapse happens HERE, in the review only, and it is honest about what it is
 * doing — those hours stop being attributed to a project, because they never
 * were. A real name over 40 characters would be swept up too; that is the
 * trade, and it has not happened in 55 rows. */
var REVIEW_NAME_MAX = 40;

function collapseProjects(byProject) {
  var named = userMap();                    // project names, so no prototype
  var otherMs = 0;
  var otherCount = 0;

  Object.keys(byProject || {}).forEach(function (name) {
    var ms = byProject[name];
    if (!name || !(ms > 0)) return;
    if (name.length > REVIEW_NAME_MAX) {
      otherMs += ms;
      otherCount += 1;
      return;
    }
    named[name] = ms;
  });

  return { named: named, otherMs: otherMs, otherCount: otherCount };
}

/** Names sorted by time, longest first. */
function byTimeDesc(map) {
  return Object.keys(map).sort(function (a, b) { return map[b] - map[a]; });
}

/* The two groups nobody chooses, and they always come after the four.
 *
 * They are not kinds of work; they are what is left over. "Uncategorised" is a
 * real project whose kind has not been decided (or was declined), so it can move
 * out of here the moment it is filed. "Unlabelled entries" never can: those are
 * the sentence-shaped keys above, which are not projects at all, so there is
 * nothing to file. Keeping them apart is what stops "I have not answered yet"
 * from reading as "the app could not understand me". */
var CATEGORY_NONE = { id: 'none', label: 'Uncategorised' };
var CATEGORY_UNLABELLED = { id: 'unlabelled', label: 'Unlabelled entries' };

/**
 * Time per project, sorted into the four kinds of work.
 *
 * Pure: the stored assignments arrive as an argument rather than being read out
 * of localStorage here, so the grouping can be tested without a browser — and
 * so a review that has just been re-filed can be redrawn by calling this again
 * with the new map, spending nothing.
 *
 * A group's total is the sum of its projects, and it inherits the overlap that
 * comes with them: two projects worked at once each get the full span, so a
 * heading can read more than the hours worked. That is stated on screen rather
 * than normalised away — see CLAUDE.md, which forbids deriving either from the
 * other.
 *
 * @param byProject project name to milliseconds.
 * @param cats      catKey(name) to a category id, or 'skip'.
 * @returns {{groups: Array, unknown: Array}} — `groups` are the non-empty ones
 *          in display order; `unknown` is every project nothing has been decided
 *          about yet, which is exactly the list the dialog asks about.
 */
function groupProjects(byProject, cats) {
  var split = collapseProjects(byProject);
  var known = cats || {};
  var bucket = {};
  var unknown = [];

  byTimeDesc(split.named).forEach(function (name) {
    /* Validated rather than trusted: a plain object inherits `constructor` and
     * `toString`, and a project may fairly be called either — without this, one
     * such name would come back holding a function and open a group with no
     * label. Anything that is not one of the five answers counts as no answer. */
    var id = known[catKey(name)];
    if (id !== CATEGORY_SKIP && !categoryLabel(id)) id = '';

    if (!id) unknown.push(name);

    // No answer and "none of these" land in the same pile: to the report they
    // are the same thing. They differ only in whether the dialog asks again.
    var into = (id && id !== CATEGORY_SKIP) ? id : CATEGORY_NONE.id;
    (bucket[into] = bucket[into] || []).push({ name: name, ms: split.named[name] });
  });

  var groups = [];
  PROJECT_CATEGORIES.concat([CATEGORY_NONE]).forEach(function (c) {
    var list = bucket[c.id];
    if (!list || !list.length) return;
    groups.push({
      id: c.id,
      label: c.label,
      projects: list,
      ms: list.reduce(function (n, p) { return n + p.ms; }, 0)
    });
  });

  if (split.otherCount) {
    groups.push({
      id: CATEGORY_UNLABELLED.id,
      label: CATEGORY_UNLABELLED.label + ' (' + split.otherCount + ')',
      projects: [], ms: split.otherMs, count: split.otherCount
    });
  }

  return { groups: groups, unknown: unknown };
}

/**
 * The sub-tasks logged against each named project across the range, deduped.
 *
 * Two jobs now: these are the bullets under each project on screen, and they are
 * the only free text the prompt carries — hours say what was worked on, `detail`
 * says what was actually done to it, and that is what makes the Learning line
 * possible at all.
 *
 * Deduped case-insensitively, because "model retraining" and "Model retraining"
 * are one thing said twice, and in the order first seen, because that is the
 * order they were done in.
 *
 * NOT capped. It was, at six per project, and the seventh bullet simply never
 * appeared — no "+3 more", nothing. That is work Saad really did going missing
 * off his own report, which is the one thing this screen must never do. The cap
 * that survives is in reviewPrompt(), where the reason for it is tokens rather
 * than the reader.
 */
function rangeTasks(rows) {
  // Both keyed by project name — see userMap() for why a plain object loses one.
  var out = userMap();
  var seen = userMap();

  (rows || []).forEach(function (row) {
    if (row.type !== 'work' && row.type !== 'voice') return;
    var name = String(row.project || row.raw_text || '').trim();
    if (!name || name.length > REVIEW_NAME_MAX) return;

    String(row.detail || '').split(TASK_SEP).forEach(function (part) {
      var task = part.trim();
      if (!task || task === name) return;
      /* hasOwnProperty, not truthiness, and kept even though `out` now has no
       * prototype to inherit from: it is the check that says exactly what is
       * meant — is there a list here yet — rather than one that happens to
       * agree today. Same reason `=== 1` guards the dedupe below. */
      if (!Object.prototype.hasOwnProperty.call(out, name)) {
        out[name] = [];
        seen[name] = userMap();             // the keys here are the tasks themselves
      }

      var key = task.toLowerCase();
      if (seen[name][key] === 1) return;
      seen[name][key] = 1;
      out[name].push(task);
    });
  });

  return out;
}

/* How many sub-tasks per project the PROMPT carries. Not a limit on the report:
 * the card on screen draws every one of them. A dozen examples of what was done
 * to a project is plenty for naming what was being learned, and everything past
 * that is tokens spent to say the same thing again. */
var REVIEW_TASK_PROMPT_LINES = 12;

/**
 * The one prompt, and it now asks for TWO things only.
 *
 * Everything a person actually wants off this screen — the hours, the projects
 * under each heading, what was done to each — is worked out on this device and
 * drawn straight. None of it is here. What is left for a language model is the
 * pair of jobs it is genuinely better at than arithmetic: reading a week's
 * sub-tasks and naming what was being learned, and turning a subtraction that
 * has already been done into a sentence.
 *
 * The pace figures are handed over finished — both totals, the difference, and
 * the word "faster"/"slower"/"about the same" already chosen — so the model
 * cannot arrive at a second, worse answer than paceOf() did. The instruction not
 * to calculate is the whole design.
 *
 * Sleep, prayers, Ms and break reasons are deliberately absent. They were in
 * here to feed a prose paragraph that no longer exists; a model that is never
 * asked about sleep cannot state a figure for a night nobody recorded.
 */
function reviewPrompt(sum, win, tasks, pace) {
  var lines = [
    'You are helping one person read their own activity log.',
    'Every figure below is already worked out. Do NOT calculate anything.',
    '',
    'Range: ' + win.label + ', ' + ymdLocal(win.start) + ' to ' + ymdLocal(win.end) +
      ' (' + sum.days + ' calendar days, ' + sum.daysWithRows + ' with entries).',
    'Worked in this range: ' + reviewDuration(sum.worked) + '.'
  ];

  if (pace && pace.known) {
    lines.push('Worked in the ' + pace.days + ' days immediately before it' +
               (pace.fromYmd ? ' (' + pace.fromYmd + ' to ' + pace.toYmd + ')' : '') +
               ': ' + reviewDuration(pace.prior) + '.');
    lines.push('So this range is ' + pace.word + ': ' +
               reviewDuration(Math.abs(pace.diff)) + ' of difference.');
  } else {
    /* Same refusal as the date floor and the sleep line: there is nothing before
     * the first row this account has, so the earlier period is unmeasured, not
     * zero. Saying "you worked 0 hours last week" about a week that predates the
     * app is the one sentence this screen must never produce. */
    lines.push('The period before this one is NOT RECORDED — there is nothing ' +
               'logged that far back. Say plainly that there is nothing to ' +
               'compare against. Do not state a figure for it and do not call it zero.');
  }

  lines.push('');
  lines.push('What was worked on, by project:');

  var said = 0;
  byTimeDesc(collapseProjects(sum.byProject).named).forEach(function (name) {
    var t = tasks && Array.isArray(tasks[name]) ? tasks[name] : [];
    if (!t.length) return;
    /* THE ONLY CAP, and it is here because the reason for it is token cost.
     * The screen shows every bullet; a month of one project would otherwise
     * send a very long list to say something a dozen examples already say. */
    lines.push('  ' + name + ': ' + t.slice(0, REVIEW_TASK_PROMPT_LINES).join('; '));
    said += 1;
  });
  if (!said) lines.push('  (the entries do not say what was done)');

  /* NOT NUMBERED, and that is deliberate. This used to read "1. …  2. …", and a
   * model that echoes the shape it is shown wrote "2. Learning: MQTT" — which
   * splitProse() then failed to find, so the Learning card claimed nothing had
   * been named while the model had named plenty. The parser now copes with the
   * numbering as well; showing a template that invites it was the other half of
   * the same bug, and the cheaper half to fix. */
  lines.push('');
  lines.push('Write exactly two things and nothing else.');
  lines.push('First, one or two short lines on the pace, in plain English, addressed ' +
             'to the person as "you", naming both totals as given above. Shorter ' +
             'is better when there is little to say. Do not praise, encourage, ' +
             'advise or editorialise. No headings, no bullet points, no numbering, ' +
             'no markdown.');
  lines.push('Then, as a final separate line, write "Learning:" followed by the ' +
             'topics and skills the entries above suggest were being picked up, ' +
             'comma separated. If the entries do not say, write ' +
             '"Learning: not clear from these entries."');

  return lines.join('\n');
}

/**
 * Split the model's answer into the overview and the Learning line.
 *
 * Forgiving on purpose: a missing marker means the whole answer is the
 * overview, and the Learning card says so, rather than the screen losing a
 * paragraph Gemini did write.
 *
 * The prompt asks for no markdown and the model writes it anyway — "**Learning:**"
 * was the observed failure, and it cost the whole Learning card. So the label's
 * own emphasis (`*`, `_`, `#`, before it and around the colon) is skipped over
 * before matching. The stars are dropped rather than shown, because they are
 * the model's formatting, not something Saad wrote.
 *
 * Two more shapes, both of them the model doing as it was told:
 *
 *   "2. Learning: MQTT"  — the reply numbered, because the instructions were
 *                          numbered. Fixed on BOTH sides: reviewPrompt() no
 *                          longer shows a numbered template.
 *   "## Learning\nMQTT"  — the label as a heading, answer on the next line,
 *                          no colon anywhere.
 *
 * Missing either one left the whole reply in the overview and the Learning card
 * saying nothing had been named — a false statement about something the model
 * had in fact done, which is worse than an empty card.
 */
function splitProse(text) {
  var whole = String(text || '').trim();
  /* Left to right: a newline, an optional list number ("1.", "2)", "3 -"), then
   * any run of bullets and emphasis — repeated, because "### **Learning:**" is a
   * heading AND emphasis and one pass over the class strips only one of them —
   * then the label, then EITHER a colon or the end of the line.
   *
   * The colon-less branch is what lets a heading through, and it is why the
   * label has to be alone on its line: "3. Learning to use MQTT" matches
   * neither branch, and neither does "Machine learning:", because nothing in
   * the prefix class can absorb a word. */
  var parts = whole.split(
    /\n(?:[ \t]*\d+[.)]?)?(?:[ \t]*[-*_#\u2022\u00b7]+)*[ \t]*learning[ \t]*[*_]*[ \t]*(?::[ \t]*[*_]*|\n)/i);
  if (parts.length < 2) return { summary: whole, learning: '' };
  /* And the CLOSING emphasis, for "**Learning: robotics**" — which splits on the
   * label and then leaves the stars on the answer, putting them in the card. */
  var learning = parts.slice(1).join(' ').trim().replace(/[ \t]*[*_]+$/, '').trim();
  return { summary: parts[0].trim(), learning: learning };
}

/* ---------------------------------------------------------------------------
 * From here down it talks to storage, the network and the DOM. Everything above
 * is pure, and the tests in claudeWorkingDocs/tests/ lift it straight out of
 * this file so they cannot drift from what ships.
 * ------------------------------------------------------------------------- */

/* THE PROSE IS CACHED; THE FIGURES ARE NEVER CACHED.
 *
 * Rule 3 says the store wins and a stale "today" is worse than a spinner — so
 * every number on this screen is re-read and re-computed on every visit. What
 * is kept is the paragraph Gemini wrote, because re-opening a tab must not cost
 * one of the day's handful of calls. Regenerate is a button, so spending one is
 * always something Saad did on purpose.
 *
 * The key carries the local day, so tomorrow's visit writes tomorrow's summary
 * even for the same range. A few entries are kept rather than one, so flipping
 * between 2 days and 7 days to compare them does not re-spend a call each way. */
var REVIEW_CACHE_KEY = 'probeing.review';
var REVIEW_CACHE_MAX = 8;

function reviewCacheKey(win) {
  return win.id + '|' + ymdLocal(win.start) + '|' + ymdLocal(win.end) + '|' + localDayStamp();
}

function reviewCacheAll() {
  try {
    var saved = JSON.parse(localStorage.getItem(REVIEW_CACHE_KEY));
    return (saved && typeof saved === 'object') ? saved : {};
  } catch (e) {
    return {};                             // unreadable storage is an empty cache
  }
}

function reviewCacheGet(key) {
  var one = reviewCacheAll()[key];
  return (one && typeof one.text === 'string') ? one : null;
}

function reviewCachePut(key, text) {
  var all = reviewCacheAll();
  all[key] = { text: text, at: Date.now() };

  // Oldest out first, so the cache cannot grow without limit in storage the
  // rest of the app also uses.
  var keys = Object.keys(all).sort(function (a, b) {
    return (all[b].at || 0) - (all[a].at || 0);
  });
  keys.slice(REVIEW_CACHE_MAX).forEach(function (k) { delete all[k]; });

  try {
    localStorage.setItem(REVIEW_CACHE_KEY, JSON.stringify(all));
  } catch (e) { /* private mode: the summary is simply asked for again */ }
}

/* Longer than the extraction deadline, and for the opposite reason. Extraction
 * runs while somebody is logging, so it gives up fast and the row keeps its own
 * text. Nothing is waiting on a review — the figures are already on screen —
 * so it can afford to wait for a slower answer over more input. */
var REVIEW_PROSE_MS = 45000;

/** One call, one paragraph. Never throws: null means "no prose today", and the
 *  reason is left in lastExtractError for the line under the figures. */
async function askReviewProse(prompt) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = setTimeout(function () {
    if (ctrl) { try { ctrl.abort(); } catch (e) { /* already finished */ } }
  }, REVIEW_PROSE_MS);

  /* Cleared first, because the caller turns whatever is left here into the
   * sentence explaining why there is no summary. geminiCall() has one exit —
   * no access token — that returns null without writing a reason, and an old
   * message from this morning's extraction would then be shown as the cause of
   * something that just happened. */
  lastExtractError = '';

  try {
    /* No `json`, no `schema`, and `think` deliberately left unset. The 28.6
     * seconds that made think:0 necessary on the logging path was a thinking
     * model being handed a SHAPE to fill; this asks for sentences, which is
     * what the model is for, and nobody is waiting on it. */
    return await geminiCall({ prompt: prompt }, ctrl);
  } catch (e) {
    lastExtractError = String((e && e.message) || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------ review screen

var reviewRangeId = REVIEW_DEFAULT_RANGE;
/* Which run owns the screen. Every await below is a chance for Saad to tap a
 * different range, and the slower answer must not overwrite the newer one. */
var reviewRun = 0;

/* "Draw the projects card again with whatever is on screen now", or null when
 * there is nothing on screen to redraw.
 *
 * Held here rather than captured by the dialog, because THE DIALOG OUTLIVES THE
 * RUN THAT OPENED IT. Switch range while it is up and a second run starts, sees
 * a dialog already open and leaves it alone — so Save still holds the first
 * run's callback. Guarding that callback with `mine()` made Save write the
 * choice to storage and then silently not redraw, leaving the old grouping on
 * screen until the next run; dropping the guard without this pointer would
 * redraw the OLD run's figures over the new ones. Pointing at the newest draw
 * is the only version that is right either way. */
var reviewRegroup = null;

/** One "12h 30m / worked" figure. */
function reviewFigure(box, value, label) {
  var wrap = document.createElement('div');
  wrap.className = 'sum';

  var n = document.createElement('span');
  n.className = 'sum-n';
  n.textContent = value;

  var l = document.createElement('span');
  l.className = 'sum-l';
  l.textContent = label;

  wrap.append(n, l);
  box.appendChild(wrap);
}

/** One "name .... 1h 20m" row in the projects card.
 *
 *  `cls` goes on the row, not on the name, because the list is three deep now —
 *  a category heading, the projects under it, the tasks under those — and what
 *  distinguishes them is indentation, which is a property of the row. `p-why`
 *  still means break time; the stylesheet reaches it either way, so the Today
 *  tab's own list is untouched. */
function reviewLine(box, name, ms, cls) {
  var li = document.createElement('li');
  if (cls) li.className = cls;

  var n = document.createElement('span');
  n.className = 'p-name';
  // textContent, never markup: these names came out of what the user typed.
  n.textContent = name;

  var t = document.createElement('span');
  t.className = 'p-time';
  t.textContent = reviewDuration(ms);

  li.append(n, t);
  box.appendChild(li);
}

/** One sub-task bullet under a project.
 *
 *  No time of its own, and it never will have one: the app records what was
 *  done, not how long each piece of it took, so a figure here would be the
 *  first invented number on the screen. The bullet itself is drawn by the
 *  stylesheet — it is a marker, not something Saad said. */
function reviewTask(box, text) {
  var li = document.createElement('li');
  li.className = 'p-task';

  var n = document.createElement('span');
  n.className = 'p-name';
  n.textContent = text;          // his own words, or a model's reading of them

  li.appendChild(n);
  box.appendChild(li);
}

/** Wipe every part of the screen that carries a figure or a sentence. Called
 *  before each run, so a refusal can never leave last run's numbers behind it. */
function clearReview() {
  /* Including the redraw itself: an empty screen has no grouping to re-group,
   * and a Save arriving after a refusal must not put the last range's projects
   * back up underneath the refusal's own message. */
  reviewRegroup = null;
  $('reviewFigures').hidden = true;
  $('reviewFigures').textContent = '';
  $('reviewSleep').textContent = '';
  $('reviewProse').textContent = '';
  $('reviewNote').textContent = '';
  $('reviewProjects').textContent = '';
  $('reviewProjectsNote').textContent = '';
  $('reviewLearning').textContent = '';
  $('reviewAgainBtn').hidden = true;
}

function renderReviewFigures(sum) {
  var box = $('reviewFigures');
  box.textContent = '';

  reviewFigure(box, reviewDuration(sum.worked), 'worked');
  reviewFigure(box, reviewDuration(sum.avgWorked), 'per day');
  reviewFigure(box, reviewDuration(sum.paused), 'on break');
  reviewFigure(box, String(sum.prayers), 'prayers');
  reviewFigure(box, String(sum.m), 'M');
  reviewFigure(box, sum.daysWithRows + '/' + sum.days, 'days logged');
  box.hidden = false;

  /* "no sleep logged", never "0h". There is not a single sleep or wake row in
   * the whole store, so a zero would not be a small figure — it would be a
   * false statement about Saad's nights. Same rule as the date floor: refuse
   * rather than report a confident nothing. */
  var sleep = sum.sleep;
  $('reviewSleep').textContent = sleep.rows
    ? 'Sleep ' + reviewDuration(sleep.totalMs) + ' across ' + sleep.nights +
      (sleep.nights === 1 ? ' night' : ' nights') +
      (sleep.unclosed ? ' — one night has no Wake yet, so it is not counted.' : '.')
    : 'No sleep logged in this range — Sleep and Wake were never pressed, so ' +
      'there is nothing to average.';
}

/**
 * The whole of the work half of the review, drawn from local data only.
 *
 * Four headings with their hours, the projects under each with theirs, and
 * under those the sub-tasks that were logged against them. Not one figure or
 * name here has been anywhere near Gemini: they are replayDay()'s totals and
 * the `detail` column, which is why they cannot be hallucinated and why they
 * are on screen before a call is even considered.
 *
 * Break reasons and unattributed time keep their place at the foot of the same
 * card, muted. They are not work and so are not one of the four groups, but
 * they were on this screen before the redesign and dropping them would quietly
 * lose hours Saad can currently see.
 *
 * @param cats  the stored assignments, passed in rather than read here, so
 *              re-filing a project redraws by calling this again.
 * @param tasks from rangeTasks(): project name to its bullets.
 */
function renderReviewProjects(sum, cats, tasks) {
  var box = $('reviewProjects');
  var note = $('reviewProjectsNote');
  box.textContent = '';
  note.textContent = '';

  var got = groupProjects(sum.byProject, cats);
  var seenTasks = tasks || {};

  got.groups.forEach(function (group) {
    reviewLine(box, group.label, group.ms, 'p-group');
    group.projects.forEach(function (p) {
      reviewLine(box, p.name, p.ms, 'p-proj');
      // Array.isArray, not truthiness: `tasks['constructor']` is a function.
      var list = Array.isArray(seenTasks[p.name]) ? seenTasks[p.name] : [];
      list.forEach(function (task) { reviewTask(box, task); });
    });
  });

  if (sum.unattributed > 0) reviewLine(box, 'Not on a named project', sum.unattributed, 'p-why');

  byTimeDesc(sum.byReason).forEach(function (why) {
    if (sum.byReason[why] > 0) reviewLine(box, why, sum.byReason[why], 'p-why');
  });

  if (!box.childNodes.length) {
    note.textContent = 'No time was booked against anything in this range.';
    return;
  }

  /* Said out loud, because the alternative is Saad reading 21h of office work
   * in a 15-hour week and concluding the app is broken. It is not: two projects
   * running at once is an hour of each and an hour of his life, and CLAUDE.md
   * forbids deriving either total from the other. */
  var why = ['A project can add up to more than the hours worked: working on ' +
             'two at once is an hour of each.'];

  var has = function (id) {
    return got.groups.some(function (g) { return g.id === id; });
  };
  if (has(CATEGORY_NONE.id)) {
    why.push('"Uncategorised" is a project you have not said the kind of yet — ' +
             'Settings can change that at any time.');
  }
  if (has(CATEGORY_UNLABELLED.id)) {
    why.push('"Unlabelled entries" is time from lines that never got a project ' +
             'name at all, so there is nothing to categorise.');
  }
  note.textContent = why.join(' ');
}

/** "3 of 18 Gemini calls used today" — on this screen, not only in Settings,
 *  because this is the screen where spending one is a decision. */
function paintReviewUsage() {
  $('reviewUsage').textContent = geminiUsedToday() + ' of ' + geminiDailyBudget() +
    ' Gemini calls used today';
}

function renderReviewPicks() {
  var box = $('reviewPicks');
  box.textContent = '';

  REVIEW_RANGES.forEach(function (r) {
    box.appendChild(pickButton(r.label, r.id === reviewRangeId, false, function () {
      if (r.id === reviewRangeId) return;
      reviewRangeId = r.id;
      renderReviewPicks();
      runReview(false);
    }));
  });
}

/**
 * Build the review for the chosen range.
 *
 * THE ORDER IS THE FEATURE. Floor check, then read, then compute, then RENDER,
 * and only then ask Gemini. Everything the report is actually about is on the
 * screen before a single call is spent, so a spent budget, a refusal, an
 * offline phone or the Apps Script fallback each cost one paragraph and leave
 * the numbers standing. A review that goes blank because a quota ran out would
 * be worse than no review at all.
 *
 * @param force true only from the Regenerate button — the one path allowed to
 *              spend a call when a cached summary already exists.
 */
async function runReview(force) {
  var run = ++reviewRun;
  var mine = function () { return run === reviewRun; };

  var win = reviewRangeOf(reviewRangeId, new Date());
  var human = function (d) {
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };
  $('reviewRange').textContent = win.label + ' (' + human(win.start) + ' – ' + human(win.end) + ')';

  clearReview();
  paintReviewUsage();

  /* Reviews read a date range straight out of Postgres. The Apps Script
   * fallback has no such action and is not getting one — it is kept for the
   * day the primary backend misbehaves, not as a second full app. Saying so
   * beats an error, and beats an empty screen. */
  if (!usingSupabase()) {
    $('reviewNote').textContent = 'Reviews need the Supabase backend. Settings is ' +
      'currently set to Apps Script, which cannot read a date range.';
    return;
  }
  if (!supabaseReady()) {
    $('reviewNote').textContent = 'Sign in to read your entries.';
    return;
  }

  $('reviewNote').textContent = 'Reading your entries…';

  var floor;
  try {
    // Before any reading of rows: a range reaching back past the first row must
    // be refused, not answered with a confident zero for the days before it.
    floor = await checkRangeFloor(win.start);
  } catch (err) {
    if (!mine()) return;
    $('reviewNote').textContent = 'Could not check the range: ' + String(err.message || err);
    return;
  }
  if (!mine()) return;

  if (!floor.ok) {
    // The message and nothing else. No figures are computed, so none can leak
    // onto a screen that has just said it cannot answer.
    $('reviewNote').textContent = floor.message;
    return;
  }

  /* The pace line compares this range with the equal-length one before it, and
   * that earlier period gets the SAME refusal the chosen range just got: if it
   * reaches back past the first row this account has, there is no comparison to
   * make. Judged with the pure function and the instant checkRangeFloor() has
   * already read, so this costs no second trip. */
  var prior = priorRangeOf(win);
  var priorKnown = rangeFloor(prior.start, floor.earliest).ok;

  var rows;
  try {
    // One read covering both periods. Two reads would be two round trips for
    // one screen, and the second would be entirely for a sentence.
    rows = await rangeEvents(new Date(priorKnown ? prior.start : win.start).toISOString(),
                             new Date(win.end.getFullYear(), win.end.getMonth(),
                                      win.end.getDate() + 1).toISOString());
  } catch (err) {
    if (!mine()) return;
    $('reviewNote').textContent = 'Could not read your entries: ' + String(err.message || err);
    return;
  }
  if (!mine()) return;

  /* Narrowed before summarising, never after: summariseRange() buckets work by
   * window, but the sleep walk inside it reads every row it is handed, so the
   * earlier period's nights would land in this one's figure. */
  var windows = dayWindows(win.start, win.end);
  var inRange = rowsInWindows(rows, windows);
  var sum = summariseRange(inRange, windows);

  if (sum.empty) {
    /* Nothing at all was logged. Zero Gemini calls: there is nothing for a
     * paragraph to be about, and "you worked 0 hours" is a sentence about a
     * day that was simply never recorded. */
    $('reviewNote').textContent = 'Nothing was logged between ' + ymdLocal(win.start) +
      ' and ' + ymdLocal(win.end) + ', so there is nothing to summarise. No Gemini ' +
      'call was used.';
    $('reviewProjectsNote').textContent = 'Nothing to show.';
    $('reviewLearning').textContent = 'Nothing to show.';
    return;
  }

  var priorWorked = 0;
  if (priorKnown) {
    var priorWindows = dayWindows(prior.start, prior.end);
    priorWorked = summariseRange(rowsInWindows(rows, priorWindows), priorWindows).worked;
  }
  var pace = paceOf(sum.worked, priorWorked, prior, priorKnown);

  var tasks = rangeTasks(inRange);
  renderReviewFigures(sum);
  /* Published for the dialog's Save to find later — see reviewRegroup. Called
   * immediately, because this IS the first draw. */
  reviewRegroup = function () { renderReviewProjects(sum, projectCategories, tasks); };
  reviewRegroup();
  $('reviewNote').textContent = '';
  $('reviewAgainBtn').hidden = false;

  /* Asked AFTER the figures are up and never awaited, so the report is complete
   * on screen whether this is answered, dismissed or ignored. Saving redraws
   * the grouping alone: which pile a project sits in changes no figure and no
   * sentence, so nothing is re-read and no call is spent.
   *
   * Through reviewRegroup rather than straight to renderReviewProjects, and
   * with no `mine()` guard: this callback can outlive the run that made it. */
  askCategories(groupProjects(sum.byProject, projectCategories).unknown, function () {
    if (reviewRegroup) reviewRegroup();
  });

  await addReviewProse(win, sum, tasks, pace, force, mine);
}

/** The second half: the two written lines, which are allowed to fail. */
async function addReviewProse(win, sum, tasks, pace, force, mine) {
  var key = reviewCacheKey(win);
  var note = $('reviewNote');

  var cached = force ? null : reviewCacheGet(key);
  if (cached) {
    showProse(cached.text);
    note.textContent = 'Written summary from earlier today. Regenerate spends one Gemini call.';
    return;
  }

  if (!canAskGemini()) {
    /* quotaWait() already writes this app's own budget refusal as a sentence,
     * and it is the same sentence the tracker shows — one explanation of the
     * ceiling, in one voice.
     *
     * The second branch looks unreachable, because runReview() has already
     * turned away the Apps Script backend and a signed-out session. It is here
     * for the case those checks cannot cover: a token that expired during the
     * two reads above. */
    note.textContent = geminiCallsLeft() <= 0
      ? quotaWait(GEMINI_BUDGET_SPENT) + ' The figures above are unaffected: they ' +
        'are worked out on this device and never involve Gemini.'
      : 'The written summary needs Gemini, which is unavailable right now. The ' +
        'figures above are unaffected.';
    $('reviewLearning').textContent = 'Needs the written summary.';
    return;
  }

  /* Google allows a handful of requests a minute as well as a day. Holding back
   * rather than sending into a refusal matters here because a refused call is
   * still spent — geminiCall() counts a request the moment it leaves.
   *
   * `waitMs`, not `pace`: the pace verdict is a parameter of this function now,
   * and the two meanings of the word are one letter apart. */
  var waitMs = geminiPacerWaitMs();
  if (waitMs > 0) {
    note.textContent = 'Gemini\'s per-minute limit is full — press Regenerate in about ' +
      Math.ceil(waitMs / 1000) + ' seconds. The figures above are already complete.';
    $('reviewLearning').textContent = 'Needs the written summary.';
    return;
  }

  note.textContent = 'Writing the summary…';
  var answer = await askReviewProse(reviewPrompt(sum, win, tasks, pace));
  if (!mine()) return;

  paintReviewUsage();

  /* An answer with no words in it is not an answer, and is treated exactly like
   * a refusal. geminiCall() turns a `{ok:true, text:""}` reply into an empty
   * string, which used to pass the `=== null` check below and be CACHED as
   * today's summary — blank prose, the Learning card falsely saying nothing was
   * named, and an empty note with no explanation at all. Worse, a cached blank
   * costs no call to redisplay, so every later visit showed the same nothing
   * and only Regenerate could escape it. */
  if (answer === null || !String(answer).trim()) {
    /* Say what happened AND that it does not matter much, in that order.
     * quotaWait() knows the two ceilings by name; anything else is a fault
     * nobody can act on, so it is not put on screen. */
    var why = answer === null ? quotaWait(lastExtractError)
                              : 'Gemini answered with no text. The call is spent either way.';
    note.textContent = 'No written summary this time' + (why ? ' — ' + why : '.') +
      ' The figures above are complete: they are worked out on this device from ' +
      'your own entries, and only the sentences are missing.';
    $('reviewLearning').textContent = 'Needs the written summary.';
    return;
  }

  reviewCachePut(key, answer);
  showProse(answer);
  note.textContent = '';
}

/** Put the model's answer on screen. textContent throughout — this text came
 *  out of a language model, and it is describing user input. */
function showProse(text) {
  var got = splitProse(text);
  $('reviewProse').textContent = got.summary;
  $('reviewLearning').textContent = got.learning ||
    'Gemini did not name anything learned in this range.';
}

$('reviewAgainBtn').addEventListener('click', function () {
  runReview(true);
});

/** Opening the tab. Figures are always recomputed — rule 3, the store wins —
 *  and the prose comes from the cache unless Regenerate is pressed. */
function openReview() {
  renderReviewPicks();
  runReview(false);
}

// ------------------------------------------ which kind of work is a project

/* THE SAME STORE, DRAWN THE SAME WAY, IN TWO PLACES.
 *
 * Saad offered a choice — mark it in Settings, or be asked while the summary is
 * being drafted — and they are not alternatives: they are one store seen from
 * two sides. The dialog is how a new project gets filed the first time it turns
 * up in a review; Settings is how a personal project becomes office work six
 * months later. Both call renderCategoryRows(), because two renderers would
 * eventually be two answers to the same question.
 *
 * A <select> rather than the app's usual row of tap buttons, for one reason:
 * five choices times however many projects is a wall of buttons in a dialog
 * that is already the longest thing in the app. */

var catDlg = $('catDlg');

/* Set by whichever list was drawn last, and read by that list's own Save. Held
 * here rather than passed, because the buttons are wired once at load and the
 * lists are drawn many times. */
var catDlgRead = null;
var catDlgSaved = null;
var catSettingsRead = null;

/**
 * One row per project: its name, and a menu of the four kinds plus "not one of
 * these".
 *
 * @param chosen catKey(name) to the id currently stored.
 * @returns a function that reads EVERY menu back as a fresh map of choices, an
 *          unanswered one as ''. mergedCategories() reads that empty string as
 *          "forget this project", which is what lets Settings take an answer
 *          back rather than only change it.
 */
function renderCategoryRows(box, names, chosen) {
  box.textContent = '';
  var picks = [];

  names.forEach(function (name) {
    var row = document.createElement('div');
    row.className = 'cat-row';

    var label = document.createElement('span');
    label.className = 'cat-name';
    label.textContent = name;               // his own project names — text only

    var sel = document.createElement('select');
    sel.className = 'cat-pick';

    var option = function (value, text) {
      var o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    };

    option('', 'Choose…');
    PROJECT_CATEGORIES.forEach(function (c) { option(c.id, c.label); });
    /* The skip, worded as an answer rather than as a refusal — because that is
     * what it is: it is remembered, and it stops the dialog asking again. */
    option(CATEGORY_SKIP, 'Not one of these');

    sel.value = (chosen && chosen[catKey(name)]) || '';
    row.append(label, sel);
    box.appendChild(row);
    picks.push({ name: name, sel: sel });
  });

  return function () {
    var out = userMap();                    // keyed by project name — see userMap()
    // Every row, INCLUDING the ones left on "Choose…", which come back as ''.
    // That empty string is what lets Settings un-file a project; without it a
    // wrong answer could be changed but never taken back.
    picks.forEach(function (p) { out[catKey(p.name)] = p.sel.value || ''; });
    return out;
  };
}

/** The stored map with `chosen` written over the top of it, and an empty choice
 *  meaning "forget this one".
 *
 *  A merge rather than a replacement, because either list only ever shows some
 *  of the projects — the dialog shows one range's unfiled ones — and the rest
 *  have to survive being off screen. */
function mergedCategories(chosen) {
  var next = userMap();                     // keyed by project name — see userMap()
  Object.keys(projectCategories).forEach(function (k) { next[k] = projectCategories[k]; });
  Object.keys(chosen || {}).forEach(function (k) {
    if (chosen[k]) next[k] = chosen[k];
    else delete next[k];
  });
  return next;
}

/**
 * Ask about the projects nothing has been decided about.
 *
 * Never blocks the review: it is opened after the figures are drawn, it is not
 * awaited, and every way out of it — Save, "Not now", the Escape key — leaves
 * the report complete. An unfiled project is one line under "Uncategorised",
 * which is a state, not an error.
 */
function askCategories(names, onSaved) {
  if (!names || !names.length) return;
  // Never on top of another dialog: Settings and the sign-in prompt both open
  // themselves, and two modals is how a phone ends up with no way back.
  if (catDlg.open || dlg.open || signInDlg.open) return;

  catDlgRead = renderCategoryRows($('catList'), names, projectCategories);
  catDlgSaved = onSaved || null;
  catDlg.showModal();
}

$('catCancelBtn').addEventListener('click', function () {
  /* Nothing is written. These projects are asked about again next time, which
   * is the difference between "not now" and "not one of these" — one is a
   * postponement and the other is an answer. */
  catDlg.close();
});

$('catSaveBtn').addEventListener('click', function () {
  saveProjectCategories(mergedCategories(catDlgRead ? catDlgRead() : {}));
  catDlg.close();
  if (catDlgSaved) catDlgSaved();
});

/** Every project Settings should offer a category for: the ones this device
 *  knows, plus any it has already been told about. The second half matters —
 *  without it a project you have stopped logging could never be re-filed, and a
 *  wrong answer would be permanent. */
function categorySettingsNames() {
  var out = knownNames();
  var seen = userMap();                     // keyed by project name — see userMap()
  out.forEach(function (n) { seen[catKey(n)] = 1; });

  /* Falls back to the key, which is lower-cased: the store keeps the id, not
   * the spelling, and for a name the vocabulary has forgotten that is all
   * there is. Rare — the vocabulary holds sixty names and pinned ones never
   * expire — and a recognisable name beats hiding the row. */
  Object.keys(projectCategories).forEach(function (k) {
    if (seen[k] !== 1) { seen[k] = 1; out.push(k); }
  });
  return out;
}

function renderCategorySettings() {
  var names = categorySettingsNames();
  catSettingsRead = renderCategoryRows($('catSettings'), names, projectCategories);
  $('catSettingsNote').textContent = names.length ? '' :
    'No projects yet — log some work and they will appear here.';
}

// ------------------------------------------------------------------ taskboard

/* The fourth tab is a link, not a screen. Whatever board you already use stays
 * where it is — this app has no business becoming a second one. Opened in the
 * browser, not in the PWA frame, so the back gesture still belongs to ProBeing. */

/** Only http(s) links may be opened. The Save button is type="button", so the
 *  <input type="url"> constraint never runs — this is the only check there is,
 *  and it is what keeps a `javascript:` URL out of window.open(). */
function safeBoardUrl(raw) {
  var url = String(raw || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

$('boardTab').addEventListener('click', function () {
  var url = safeBoardUrl(cfg.boardUrl);
  if (!url) {
    flash('Add a taskboard link starting with https:// in Settings.');
    dlg.showModal();
    return;
  }
  window.open(url, '_blank', 'noopener');
});

// ------------------------------------------------------------- signing in

var signInDlg = $('signInDlg');
var BACKENDS = [
  { id: 'supabase', label: 'Supabase' },
  { id: 'apps', label: 'Apps Script' }
];

function askSignIn() {
  if (!usingSupabase() || signInDlg.open || dlg.open) return;
  if (!cfg.supaUrl || !cfg.supaKey) return;      // nothing to sign in to yet
  $('signInMsg').textContent = '';
  signInDlg.showModal();
}

$('githubBtn').addEventListener('click', async function () {
  if (!sb) { $('signInMsg').textContent = 'Add your Supabase details in Settings first.'; return; }
  $('signInMsg').textContent = 'Opening GitHub…';
  try {
    // Come back to this exact page, so an installed app returns where it left.
    var back = location.origin + location.pathname;
    var res = await sb.auth.signInWithOAuth({
      provider: 'github', options: { redirectTo: back }
    });
    if (res.error) throw res.error;
  } catch (err) {
    $('signInMsg').textContent = String(err.message || err);
  }
});

/** Who is signed in, shown in Settings. */
function paintAccount() {
  var who = $('supaWho');
  if (!who) return;
  if (!cfg.supaUrl || !cfg.supaKey) {
    who.textContent = 'Not connected yet.';
  } else if (sbUser) {
    var name = (sbUser.user_metadata && (sbUser.user_metadata.user_name ||
                sbUser.user_metadata.preferred_username)) || sbUser.email || 'your account';
    who.textContent = 'Signed in as ' + name + '.';
  } else {
    who.textContent = 'Not signed in.';
  }
  $('signOutBtn').hidden = !sbUser;
}

$('signOutBtn').addEventListener('click', async function () {
  if (!sb) return;
  stopLive();
  try { await sb.auth.signOut(); } catch (e) { /* already gone */ }
  dlg.close();
  flash('Signed out', 'ok');
});

// ------------------------------------------------- bringing the Sheet across

/* A one-time import, done from inside the app because that is where the
 * signed-in session already is — a standalone script would have to reproduce
 * the whole OAuth dance to write rows that belong to you.
 *
 * Every row gets a `rid` derived from its own contents, so the unique index
 * does the deduplicating: import the same file twice, or overlapping exports,
 * and the second attempt is refused rather than doubling your history. */

function splitCsv(text) {
  var rows = [];
  var row = [];
  var field = '';
  var quoted = false;

  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);

    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i++; }   // an escaped quote
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text.charAt(i + 1) === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/** A stable id for a row, so re-importing cannot double it. */
function importRid(parts) {
  var key = 'imp|' + parts.join('|');
  var h = 5381;
  for (var i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return 'imp-' + h.toString(36) + '-' + key.length.toString(36);
}

/** One CSV row -> one events row, or null if it is a header or unreadable. */
function rowFromCsv(cells) {
  var at = String(cells[0] || '').trim();
  if (!at || at.toLowerCase() === 'timestamp') return null;     // header
  var when = new Date(at);
  if (isNaN(when.getTime())) return null;

  // The Prayers tab is: timestamp, local_time, date, prayer, mode
  // The Log tab is:     timestamp, local_time, type, raw_text, project, detail
  var third = String(cells[2] || '').trim();
  var isPrayer = /^\d{4}-\d{2}-\d{2}$/.test(third) &&
                 PRAYER_NAMES.indexOf(String(cells[3] || '').trim()) !== -1;

  if (isPrayer) {
    var name = String(cells[3] || '').trim();
    var mode = String(cells[4] || '').trim();
    return { at: when.toISOString(), local_time: String(cells[1] || ''), tz: '',
             type: 'prayer', raw_text: name + ' · ' + mode,
             project: name, detail: mode,
             rid: importRid([at, 'prayer', name, mode]) };
  }

  var type = third;
  if (!type) return null;
  return { at: when.toISOString(), local_time: String(cells[1] || ''), tz: '',
           type: type, raw_text: String(cells[3] || ''),
           project: String(cells[4] || ''), detail: String(cells[5] || ''),
           rid: importRid([at, type, String(cells[3] || '')]) };
}

$('importFile').addEventListener('change', async function () {
  var files = Array.prototype.slice.call(this.files || []);
  var msg = $('importMsg');
  this.value = '';                       // so picking the same file again re-runs

  if (!files.length) return;
  if (!sb || !sbUser) { msg.textContent = 'Sign in first.'; return; }

  var rows = [];
  for (var i = 0; i < files.length; i++) {
    var text = await files[i].text();
    splitCsv(text).forEach(function (cells) {
      var r = rowFromCsv(cells);
      if (r) rows.push(r);
    });
  }

  if (!rows.length) { msg.textContent = 'Nothing readable in those files.'; return; }

  msg.textContent = 'Importing ' + rows.length + ' rows…';
  var added = 0;
  var skipped = 0;

  // In batches, so one bad row cannot lose the whole import, and so a big
  // history does not arrive as one enormous request.
  for (var j = 0; j < rows.length; j += 100) {
    var batch = rows.slice(j, j + 100);
    var res = await sb.from('events').insert(batch);
    if (!res.error) { added += batch.length; continue; }

    // A clash means some of this batch is already here; retry one at a time so
    // the new rows still land.
    for (var k = 0; k < batch.length; k++) {
      var one = await sb.from('events').insert(batch[k]);
      if (!one.error) added += 1;
      else if (one.error.code === '23505') skipped += 1;
      else { msg.textContent = 'Stopped: ' + one.error.message; return; }
    }
  }

  msg.textContent = 'Imported ' + added + ' rows' +
    (skipped ? ', skipped ' + skipped + ' already here' : '') + '.';
  flash('Imported ' + added + ' rows', 'ok');
  refresh();
});

// ----------------------------------------------------------------- settings

var dlg = $('settingsDlg');

function renderBackendPick() {
  var box = $('backendPick');
  box.textContent = '';
  BACKENDS.forEach(function (b) {
    box.appendChild(pickButton(b.label, cfg.backend === b.id, false, function () {
      cfg.backend = b.id;
      renderBackendPick();
      paintBackendFields();
    }));
  });
}

function paintBackendFields() {
  var supa = cfg.backend === 'supabase';
  $('supaFields').hidden = !supa;
  $('appsFields').hidden = supa;
  // The Edge Function lives in the Supabase project; on Apps Script there is
  // nothing for this button to call.
  $('testGeminiBtn').hidden = !supa;
  paintAccount();
}

$('settingsBtn').addEventListener('click', function () {
  renderBackendPick();
  paintBackendFields();
  $('supaUrl').value = cfg.supaUrl || '';
  $('supaKey').value = cfg.supaKey || '';
  $('geminiDaily').value = cfg.geminiDaily || '';
  $('geminiRpm').value = cfg.geminiRpm || '';
  $('apiUrl').value = cfg.apiUrl || '';
  $('token').value = cfg.token || '';
  $('boardUrl').value = cfg.boardUrl || '';
  $('chipsInput').value = chipLabels().join(', ');
  $('projectNames').value = pinnedNames.join('\n');
  renderCategorySettings();
  $('micHide').checked = Boolean(cfg.hideMic);
  $('testResult').textContent = '';
  dlg.showModal();
});

$('cancelBtn').addEventListener('click', function () { dlg.close(); });

$('testBtn').addEventListener('click', async function () {
  if (cfg.backend === 'supabase') {
    if (!sbUser) { $('testResult').textContent = 'Sign in first.'; return; }
    $('testResult').textContent = 'Testing…';
    try {
      await api('ping');
      $('testResult').textContent = '✅ Connected.';
    } catch (err) {
      $('testResult').textContent = '❌ ' + (err.message || err);
    }
    return;
  }

  var probe = { apiUrl: $('apiUrl').value.trim(), token: $('token').value.trim() };
  if (!probe.apiUrl || !probe.token) {
    $('testResult').textContent = 'Fill both fields first.';
    return;
  }

  $('testResult').textContent = 'Testing…';
  var saved = cfg;
  cfg = probe;                                // test with the typed values...
  try {
    await api('ping');
    $('testResult').textContent = '✅ Connected.';
  } catch (err) {
    $('testResult').textContent = '❌ ' + (err.message || err);
  } finally {
    cfg = saved;                              // ...without committing them yet
  }
});

/* Throwaway scaffolding, and labelled as such. It proves one thing that nothing
 * else can prove until Stage 4 exists: that this browser can get an answer out of
 * Gemini without ever holding the Gemini key. The key sits in the Edge Function's
 * own secrets; all that leaves this device is the prompt and the signed-in
 * session's token, which is what the function checks before it spends the key.
 *
 * JSON here, not the text/plain that rule 1 demands of Apps Script: the rule
 * exists because Apps Script cannot answer a CORS preflight. The Edge Function
 * answers OPTIONS itself, so the preflight is fine and JSON is the honest type. */
var GEMINI_TEST_PROMPT = 'Reply with exactly this sentence and nothing else: ' +
  'ProBeing can reach Gemini.';
var GEMINI_TIMEOUT_MS = 30000;   // a cold function plus a model call is not quick

/* One request, not two. This button used to ask Gemini to say hello and THEN
 * run a real extraction, which is two calls per tap — and on the free tier the
 * limit is 20 calls a MINUTE, so a few taps while debugging exhausted it and
 * produced a scary quota error that looked like a billing problem and was not.
 *
 * So the real extraction goes first. If it works, reaching Gemini is proven by
 * the fact that it answered; asking separately was only ever restating that.
 * The hello call now happens ONLY when extraction fails, to separate "cannot
 * reach Gemini at all" from "reached it and could not use the answer". */
/* Which models does this key actually have? Only reachable through the Edge
 * Function, because listing them needs the key and the key lives only there.
 * Costs no generateContent quota, so it still works on a day the quota is gone —
 * which is exactly the day you need it. */
async function listGeminiModels() {
  try {
    var got = await sb.auth.getSession();
    var session = got && got.data ? got.data.session : null;
    if (!session || !session.access_token) return null;

    var base = String(cfg.supaUrl || '').trim().replace(/\/+$/, '');
    var res = await fetch(base + '/functions/v1/gemini', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': String(cfg.supaKey || '').trim()
      },
      body: JSON.stringify({ list: true })
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || !data.ok) return null;
    return data.models || [];
  } catch (e) { return null; }
}

/** Does this refusal mean "no such model"? Then the useful reply is the list of
 *  models that DO exist, not the error text — Google's own message here says to
 *  go and ask, and there is no reason to make a person do that by hand. */
function isUnknownModel(msg) {
  return /is not found for API version|ListModels|not supported for generateContent/i
         .test(String(msg || ''));
}

async function probeExtraction() {
  var began = Date.now();
  var out = { ms: 0, ok: false, project: '', detail: '', status: 0, error: '',
              raw: '', model: '', numbered: false };
  try {
    var got = await sb.auth.getSession();
    var session = got && got.data ? got.data.session : null;
    if (!session || !session.access_token) { out.error = 'not signed in'; return out; }

    // Counted against the day, like every other call that leaves the device —
    // and never refused by the budget, because a diagnostic that stops working
    // exactly when something is wrong is not a diagnostic. The gap between our
    // 18 and Google's 20 is what pays for this.
    noteGeminiCall();

    var base = String(cfg.supaUrl || '').trim().replace(/\/+$/, '');
    var res = await fetch(base + '/functions/v1/gemini', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': String(cfg.supaKey || '').trim()
      },
      /* TWO lines, not one, and that is deliberate. The single-entry path is the
       * easy one and it already works; what is unproven is whether the model
       * honours "return exactly N objects and echo each line's number". If it
       * does not, every batch is refused and those rows quietly keep their own
       * sentence as the name — a failure with no symptom except names that stop
       * appearing on busy days, which is precisely the kind of silence that made
       * this feature take three wrong diagnoses to understand.
       *
       * A batch of two costs the same one request as a batch of one, so this
       * proves the harder path for free. */
      body: JSON.stringify({
        prompt: extractManyPrompt(EXTRACT_PROBE, PROBE_VOCAB),
        json: true, schema: { type: 'ARRAY', items: EXTRACT_SCHEMA }, think: 0
      })
    });
    out.status = res.status;
    var data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || !data.ok) {
      out.error = (data && data.error) || ('HTTP ' + res.status);
      return out;
    }
    /* Which model actually answered. The app never sets this — it is a Supabase
     * secret (GEMINI_MODEL) — so this line is the only way to see what is really
     * being used, and the free tier's limits are PER MODEL, so it is also the
     * only way to know which budget is being spent. */
    out.model = String(data.model || 'unknown');
    out.raw = String(data.text || '');
    var arr = parseExtraction(out.raw);
    if (!arr || !arr.length || arr.length !== EXTRACT_PROBE.length) {
      out.error = 'asked for ' + EXTRACT_PROBE.length + ' answers, got ' +
                  (arr && arr.length ? arr.length : 'none');
      return out;
    }
    /* The whole point of the probe: did it number them? */
    out.numbered = arr.every(function (a, i) { return a && Number(a.n) === i + 1; });
    /* The last line is the mangled one. Did the vocabulary put the name back? */
    var heard = tidyExtraction(arr[EXTRACT_PROBE.length - 1], PROBE_VOCAB);
    out.heard = heard.project;
    out.repaired = heard.project === PROBE_VOCAB[0];
    var got2 = tidyExtraction(arr[0], PROBE_VOCAB);
    out.project = got2.project;
    out.detail = got2.detail;
    out.ok = Boolean(got2.project);
    return out;
  } catch (e) {
    out.error = (e && e.message) ? e.message : String(e);
    return out;
  } finally {
    out.ms = Date.now() - began;
  }
}

/* Three lines, each catching a different failure.
 *   1 and 2 are about different things, so a model that lazily returns one
 *     answer, or the same answer twice, is caught rather than flattered.
 *   3 is a real speech mangling — Android hears "NeuraVue" as "my review" —
 *     paired with the fixed vocabulary below. Without it the sound-alike repair
 *     could only ever be tested by dictating a live entry, which costs a call,
 *     cannot be repeated identically, and confuses "the model did not repair it"
 *     with "the microphone heard something else this time". */
var EXTRACT_PROBE = ['working on the Ahmed case, fixing the auth bug',
                     'spent an hour on the Falcon migration',
                     'my review is looking better after the frame rate fix'];

/* Fixed, and deliberately NOT the user's own list: a test whose answer depends
 * on what happens to be in Settings tells you nothing about the model. */
var PROBE_VOCAB = ['NeuraVue'];

/** Why an entry stayed unnamed, in a sentence, or '' if the reason was not a
 *  ceiling at all.
 *
 *  Two ceilings, and they are not the same shape. Ours is a daily count we keep
 *  ourselves and stop at; Google's is a per-minute refusal that reads like a
 *  bill and is neither a bill nor a fault. The free tier is 5 requests a minute
 *  and 20 a day — this said "20 a minute" for a while, which turned a hard
 *  architectural limit into a non-issue and is how one call per entry shipped. */
function quotaWait(msg) {
  var s = String(msg || '');

  if (s === GEMINI_BUDGET_SPENT) {
    return 'ProBeing has used its ' + geminiDailyBudget() + ' Gemini calls for today — ' +
           'its own limit, set in Settings, not Google\'s. Nothing is broken and nothing ' +
           'has been charged. ' +
           'Entries are still saved — they keep their own text as the name until tomorrow, ' +
           'and any line naming a project the app already knows is still named for free.';
  }

  if (!/quota|rate.?limit|RESOURCE_EXHAUSTED|exceeded/i.test(s)) return '';

  /* WHICH ceiling? Google's refusal names it — "limit: 5" is the per-minute one,
   * "limit: 20" the daily — and the difference is the whole message. Saying "try
   * again in 40 seconds" when the DAY is spent sends you back to a button that
   * cannot work for hours, which is exactly what this said before.
   *
   * The retry hint is not the discriminator: Google offers a short backoff for
   * the daily refusal too, which is what made the first version of this wrong. */
  /* When the refusal does not name a limit, read it as the per-minute one. The
   * two mistakes are not equal: calling it per-minute when it is daily costs a
   * few doomed calls and recovers by itself, while calling it daily when it is
   * per-minute stops naming anything for the rest of the day over a wait of
   * forty seconds. Real refusals do carry "limit: N"; this is for the ones that
   * do not. */
  var lim = /limit:\s*([0-9]+)/i.exec(s);
  var perMinute = /per.?minute|PerMinute/i.test(s) ||
                  !lim || Number(lim[1]) <= geminiRpmLimit() + 2;
  var secs = /retry in ([0-9.]+)s/i.exec(s);

  if (perMinute) {
    return 'Gemini\'s free tier allows 5 requests a minute and that is used up. Nothing ' +
           'has been charged and nothing is broken — it clears on its own' +
           (secs ? ' in about ' + Math.ceil(parseFloat(secs[1])) + ' seconds.' : ' within a minute.');
  }

  return 'Gemini\'s free tier allows 20 requests a DAY and today\'s are gone. Nothing has ' +
         'been charged and nothing is broken. Entries are still saved and still keep their ' +
         'own text as the name; a line naming a project the app already knows is still ' +
         'named for free. This resets once a day on Google\'s clock, not at your midnight, ' +
         'so it may come back during the day rather than overnight.';
}

$('testGeminiBtn').addEventListener('click', async function () {
  var out = $('testResult');
  if (cfg.backend !== 'supabase') { out.textContent = 'Gemini runs on Supabase only.'; return; }
  if (!sb || !sbUser) { out.textContent = 'Sign in first.'; return; }

  /* Every answer carries the day's count, because this is the only place it can
   * be seen and it is the number that says whether the day fits in the free
   * tier. textContent throughout, never innerHTML — some of this text came out
   * of a language model. */
  var say = function (msg) { out.textContent = msg + '\n\n' + geminiUsageLine(); };

  out.textContent = 'Testing the real thing (naming a project)…';

  var p = await probeExtraction();

  if (p.ok) {
    var good = '\u2705 Works (' + p.ms + 'ms): project "' + p.project +
      '", detail "' + p.detail + '"';
    /* Three lines went out. Whether they came back numbered decides if batching
     * — the thing that makes a busy day fit inside the daily allowance — is
     * available at all, and it also decides whether the repair check below is
     * even readable. */
    good += p.numbered
      ? '\n\u2705 Batching works: ' + EXTRACT_PROBE.length +
        ' lines answered and correctly numbered, so busy days cost few calls.'
      : '\n\u26a0\ufe0f Batching is OFF: the answers came back without line numbers, ' +
        'so groups of entries are refused rather than risk naming them wrongly. ' +
        'Everything still works, one call per entry, so a busy day may run out.';
    /* Only meaningful if the answers lined up: an unnumbered reply means the
     * "last" object may not be the mangled line at all. */
    if (p.numbered) {
      good += p.repaired
        ? '\n\u2705 Mis-heard names repaired: "my review" was filed under "NeuraVue".'
        : '\n\u26a0\ufe0f Mis-heard names NOT repaired: "my review" came back as "' +
          (p.heard || 'nothing') + '" with "NeuraVue" on the list. Dictated project ' +
          'names will keep landing under whatever the microphone heard.';
    }
    if (p.ms > EXTRACT_DEADLINE_MS) {
      good += '\n\u26a0\ufe0f Slower than the ' + EXTRACT_DEADLINE_MS +
        'ms the tracker waits, so real entries will often stay unnamed.';
    }
    good += '\nModel: ' + p.model + '  (set by the GEMINI_MODEL secret; the free ' +
            'tier counts each model separately)';
    say(good);
    return;
  }

  var friendly = quotaWait(p.error);
  if (friendly) { say('\u23f3 ' + friendly); return; }

  if (p.error) {
    var line = '\u274c ' + p.error + ' (after ' + p.ms + 'ms)';
    if (!isUnknownModel(p.error)) { say(line); return; }

    // The model name is wrong. Say which names are right.
    out.textContent = line + '\n\nAsking Google which models this key can use…';
    var models = await listGeminiModels();
    if (!models || !models.length) {
      say(line + '\n\nCould not list the available models either.');
      return;
    }
    var lite = models.filter(function (m) { return /lite/i.test(m); });
    say(line +
        '\n\nSet the GEMINI_MODEL secret to one of these instead' +
        (lite.length ? '.\nLighter models, which usually have the bigger free allowance:\n  ' +
                       lite.join('\n  ') : '.') +
        '\n\nAll ' + models.length + ' available:\n  ' + models.join('\n  '));
    return;
  }

  /* It answered, and the answer was unusable. Only now is the second call worth
   * spending: it separates a broken function from a model saying something odd. */
  var unusable = '\u274c Gemini answered but the reply could not be read.' +
    '\nRaw answer: ' + JSON.stringify(p.raw).slice(0, 300);
  out.textContent = unusable + '\nChecking whether Gemini is reachable at all…';
  var raw = await askGeminiRaw(EXTRACT_PROBE[0]);   // one line: the schema is what is in doubt
  say(unusable + '\nWithout the schema it says: ' + raw);
});

$('saveBtn').addEventListener('click', function () {
  // Typing "trello.com/b/abc" without the scheme is a fair mistake, and
  // safeBoardUrl() would quietly store nothing. Say so instead.
  var typedBoard = $('boardUrl').value.trim();
  if (typedBoard && !safeBoardUrl(typedBoard)) {
    $('testResult').textContent = 'The taskboard link must start with https:// — nothing else was saved.';
    return;
  }

  var next = {
    backend: cfg.backend,
    supaUrl: $('supaUrl').value.trim(),
    supaKey: $('supaKey').value.trim(),
    geminiDaily: $('geminiDaily').value.trim(),
    geminiRpm: $('geminiRpm').value.trim(),
    apiUrl: $('apiUrl').value.trim(),
    token: $('token').value.trim(),
    boardUrl: safeBoardUrl(typedBoard),
    // Device-local on purpose: the chip list does not sync between phone and laptop.
    chips: (parseChips($('chipsInput').value).join(', ')) || DEFAULT_CHIPS.join(', '),
    // Also device-local: the phone has a good keyboard mic, the laptop may not.
    hideMic: $('micHide').checked
  };
  if (next.backend === 'supabase') {
    if (!next.supaUrl || !next.supaKey) {
      $('testResult').textContent = 'Fill in the Supabase URL and key first.';
      return;
    }
  } else if (!next.apiUrl || !next.token) {
    $('testResult').textContent = 'Fill both fields first.';
    return;
  }

  var switched = next.backend !== cfg.backend ||
                 next.supaUrl !== cfg.supaUrl || next.supaKey !== cfg.supaKey;
  cfg = next;
  saveConfig(cfg);
  /* Kept out of `cfg` on purpose: that object is credentials plus backend
   * choice, rewritten wholesale when the backend is switched. The vocabulary
   * has no business riding along with it, and neither has the grouping — a
   * project is office work whichever database its rows are in. */
  savePinnedNames(parsePinned($('projectNames').value));
  if (catSettingsRead) saveProjectCategories(mergedCategories(catSettingsRead()));
  paintMic();
  renderChips();
  dlg.close();
  flash('Saved', 'ok');

  if (switched) {
    stopLive();
    lastLog = [];
    todayPrayers = [];
    initSupabase();
  }
  if (usingSupabase() && !sbUser) askSignIn(); else refresh();
});

// -------------------------------------------------------------------- boot

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is optional */ });
  });
}

/* Coming back to the app should show current data — but flipping between apps
 * must not become a request storm, which is exactly how the burst that produces
 * the 404s starts. One reconcile per 20 seconds is plenty. */
var VISIBILITY_THROTTLE_MS = 20000;
var lastVisibleRefresh = 0;

/* Ask again while the app is on screen. Skipped whenever anything is already in
 * flight or a reconcile just happened, so this adds one request a minute at
 * most, and never one the user is waiting behind. */
setInterval(function () {
  if (document.visibilityState !== 'visible') return;
  if (inFlight > 0 || !isConfigured()) return;
  // A live subscription makes polling redundant; keep a slow heartbeat only, in
  // case the socket has quietly died.
  var every = liveChannel ? LIVE_HEARTBEAT_MS : pollInterval();
  if (Date.now() - lastReconcileAt < every) return;
  // One attempt only. A poll that retried three times against a 9s timeout was
  // the other half of the amplification — the client gives up, but Apps Script
  // still runs every one of them to completion, holding its lock.
  refresh({ tries: 1 });
}, 5000);

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  var now = Date.now();
  if (now - lastVisibleRefresh < VISIBILITY_THROTTLE_MS) return;
  lastVisibleRefresh = now;
  refresh();
});

initSupabase();
renderPrayerTicks();
renderProject();
renderDaySummary();
lastVisibleRefresh = Date.now();     // the boot reconcile counts as the first one
refresh();
if (usingSupabase()) {
  if (!cfg.supaUrl || !cfg.supaKey) dlg.showModal();
} else if (!isConfigured()) {
  dlg.showModal();
}
