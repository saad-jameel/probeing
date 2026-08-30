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
  if (name === 'review') renderReviewRange();
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

// -------------------------------------------------------- the current project

/* Point 6: the project comes from what you typed, not from a picker. Walk
 * today's rows in order and replay the day: a tracker entry names the project
 * and starts the clock, break/off/sleep stop it, resume starts it again.
 *
 * A break does not change the project — you come back to the same thing — it
 * only pauses the clock, because "hours worked" must not include the coffee. */
function replayDay(log) {
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
  var active = {};                          // project -> 1, currently being worked on
  var reasons = {};                         // break reason -> 1, currently applying
  var byProject = {};
  var byReason = {};
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
   * The old code guarded only negative spans, so this is an old hole, closed. */
  var ceiling = Date.now();

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
      reasons = {};
    } else if (row.type === 'done') {
      var finished = String(row.project || text).trim();
      delete active[finished];
      var idx = order.indexOf(finished);
      if (idx !== -1) order.splice(idx, 1);
    } else if (row.type === 'resume') {
      clock = true;
      underWay = true;
      dayClosed = false;
      reasons = {};
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
        if (move.op === 'set') reasons = {};
        if (move.op !== 'keep') {
          move.names.forEach(function (r) {
            if (move.op === 'drop') delete reasons[r]; else reasons[r] = 1;
          });
        }
      }
    } else if (row.type === 'off' || row.type === 'sleep') {
      // The day being over is not "on break": nothing accrues after it.
      clock = false;
      reasons = {};
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
  var open = {};
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
var EXTRACT_DEADLINE_MS = 4000;

/** Nothing understood. A fresh object every time, because callers read from it
 *  and one shared instance is a bug waiting for a careless assignment. */
function noExtraction() {
  return { project: '', detail: '' };
}

/* Gemini answers in a fixed shape because the Edge Function asks for one. This
 * is that shape, in the API's own schema vocabulary. */
var EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    project: { type: 'STRING' },
    detail: { type: 'STRING' }
  },
  required: ['project', 'detail']
};

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
    'project: the short name of the thing being worked on, two or three words at most.',
    'detail: what is being done to it, a few words. Use "" if the line does not say.'
  ];

  if (known && known.length) {
    lines.push('');
    lines.push('Projects already open today: ' + known.map(function (n) {
      return JSON.stringify(String(n));
    }).join(', '));
    lines.push('If this line is about one of those, copy that name EXACTLY, character ' +
               'for character, including its capitals.');
  }

  lines.push('');
  lines.push('If no project is named or implied, return "" for both fields.');
  lines.push('Never reword, translate, expand or correct what was written.');
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
  var detail = squash('detail').slice(0, DETAIL_MAX);

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

/**
 * Ask the Edge Function to split one line into project + detail.
 *
 * DELIBERATELY NOT THROUGH api(). api() serialises every call through apiChain
 * so this device never competes with itself for the backend; a language model in
 * that queue would make the next M press and the next prayer tap wait behind it,
 * which is the one thing rule 4 forbids. This is a plain fetch, off the chain,
 * and nothing else in the app waits on it.
 *
 * It never rejects. Offline, signed out, timed out, running on the Apps Script
 * fallback, or handed something that is not JSON — every one of those resolves
 * to {project:'', detail:''}, which is exactly what the tracker wrote before.
 */
function extractProject(text, known) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer;

  var deadline = new Promise(function (resolve) {
    timer = setTimeout(function () {
      // Abort as well as resolve: a request nobody is waiting for any more
      // should not still be open when the next entry starts its own.
      if (ctrl) { try { ctrl.abort(); } catch (e) { /* already finished */ } }
      resolve(noExtraction());
    }, EXTRACT_DEADLINE_MS);
  });

  return Promise.race([askGemini(text, known, ctrl), deadline]).then(function (got) {
    clearTimeout(timer);
    return got;
  }, function () {
    clearTimeout(timer);
    return noExtraction();                 // see the promise above: never throws
  });
}

async function askGemini(text, known, ctrl) {
  /* Gemini has one home and it is the Supabase Edge Function — the key is a
   * secret of that function and must never be anywhere else. On the Apps Script
   * fallback there is simply nothing to ask, and the row goes in unlabelled. */
  if (cfg.backend !== 'supabase' || !sb || !sbUser) return noExtraction();

  var got = await sb.auth.getSession();
  var session = got && got.data ? got.data.session : null;
  if (!session || !session.access_token) return noExtraction();

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
    body: JSON.stringify({
      prompt: extractPrompt(text, known),
      json: true,
      schema: EXTRACT_SCHEMA
    })
  });

  var data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || !data.ok) return noExtraction();
  return tidyExtraction(parseExtraction(data.text), known);
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
  var known = openProjects();

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
    if (!got.project) { forget(); return; } // understood nothing: the old behaviour
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

/* A button that cannot work is worse than no button, and there is a real
 * fallback one line below it in the markup: the keyboard's own mic. */
if (!Recognition) micBtn.hidden = true;

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

var listening = false;
var recognizer = null;

function stopListening() {
  listening = false;
  micBtn.classList.remove('listening');
  micBtn.setAttribute('aria-pressed', 'false');
}

if (Recognition) micBtn.addEventListener('click', function () {
  if (listening) {                         // a second tap means "I have finished"
    try { recognizer.stop(); } catch (e) { /* it may have stopped by itself */ }
    return;
  }

  var rec = new Recognition();
  recognizer = rec;
  rec.lang = navigator.language || 'en-US';  // the device's language, not a guess
  rec.interimResults = false;              // one settled answer, not a live stream
  rec.continuous = false;                  // one sentence, then stop on its own
  rec.maxAlternatives = 1;

  rec.onresult = function (ev) {
    var said = ev.results && ev.results[0] && ev.results[0][0]
      ? ev.results[0][0].transcript : '';
    var heard = stripWakeWord(said);
    if (!heard) { flash(VOICE_ERRORS['no-speech']); return; }

    /* FILLED, NOT SUBMITTED, and that is a deliberate departure from the plan.
     * The store is append-only and has no delete, so a misheard sentence written
     * without anyone reading it is a row you keep for good. One tap on Log is
     * still comfortably inside the five-second rule, and it is the only moment a
     * mishearing can be caught. Appended rather than replacing, so tapping the
     * mic after typing does not silently destroy what was typed. */
    var box = $('trackerInput');
    var had = box.value.trim();
    box.value = had ? had + ' ' + heard : heard;
    voiceFilled = true;
    box.focus();
  };

  rec.onerror = function (ev) {
    var code = ev && ev.error;
    if (code === 'aborted') return;        // the user stopped it; nothing to report
    // no-speech is not a failure, it is a retry — so no red banner for it.
    var quiet = code === 'no-speech';
    flash(VOICE_ERRORS[code] || ('Voice failed' + (code ? ' — ' + code : '.')),
          quiet ? '' : 'err');
  };

  rec.onend = stopListening;

  try {
    rec.start();
  } catch (e) {
    stopListening();
    flash('Could not start the microphone.', 'err');
    return;
  }

  listening = true;
  micBtn.classList.add('listening');
  micBtn.setAttribute('aria-pressed', 'true');
});

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

/** The two halves together: read the floor, then judge the range. */
async function checkRangeFloor(startDate) {
  return rangeFloor(startDate, await earliestEventAt());
}

// ------------------------------------------------------------------- review

/** Last week, Monday to Sunday, in the device's own locale. */
function renderReviewRange() {
  var now = new Date();
  var dow = (now.getDay() + 6) % 7;              // 0 = Monday
  var end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 1);
  var start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);

  var f = function (d) {
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };
  $('reviewRange').textContent = 'Last week (' + f(start) + ' – ' + f(end) + ')';
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
  $('apiUrl').value = cfg.apiUrl || '';
  $('token').value = cfg.token || '';
  $('boardUrl').value = cfg.boardUrl || '';
  $('chipsInput').value = chipLabels().join(', ');
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

$('testGeminiBtn').addEventListener('click', async function () {
  var out = $('testResult');
  if (cfg.backend !== 'supabase') { out.textContent = 'Gemini runs on Supabase only.'; return; }
  if (!sb || !sbUser) { out.textContent = 'Sign in first.'; return; }

  out.textContent = 'Asking Gemini…';
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, GEMINI_TIMEOUT_MS) : 0;

  try {
    var got = await sb.auth.getSession();
    var session = got && got.data ? got.data.session : null;
    if (!session || !session.access_token) { out.textContent = 'Sign in first.'; return; }

    var base = String(cfg.supaUrl || '').trim().replace(/\/+$/, '');
    var res = await fetch(base + '/functions/v1/gemini', {
      method: 'POST',
      signal: ctrl ? ctrl.signal : undefined,
      headers: {
        'Content-Type': 'application/json',
        // The user's own token, not the anon key: the function rejects anything
        // whose role is not `authenticated`.
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': String(cfg.supaKey || '').trim()
      },
      body: JSON.stringify({ prompt: GEMINI_TEST_PROMPT })
    });

    var data = null;
    try { data = await res.json(); } catch (e) { /* an error page is not JSON */ }

    if (!res.ok || !data || !data.ok) {
      out.textContent = '❌ ' + ((data && data.error) || ('HTTP ' + res.status));
      return;
    }
    // textContent, never innerHTML — this text came from a language model.
    out.textContent = '✅ Gemini said: ' + data.text;
  } catch (err) {
    out.textContent = '❌ ' + (err && err.name === 'AbortError'
      ? 'Gemini took too long to answer.'
      : (err.message || err));
  } finally {
    clearTimeout(timer);
  }
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
    apiUrl: $('apiUrl').value.trim(),
    token: $('token').value.trim(),
    boardUrl: safeBoardUrl(typedBoard),
    // Device-local on purpose: the chip list does not sync between phone and laptop.
    chips: (parseChips($('chipsInput').value).join(', ')) || DEFAULT_CHIPS.join(', ')
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
