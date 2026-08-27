/* ProBeing PWA — four screens, two mandatory buttons, two state toggles.
 *
 * Home     : M / Prayer / Sleep-Wake / Break-Work, prayer ticks, current project
 * Today    : the tracker input and today's raw log
 * Review   : the weekly report (layout final, numbers land with the backend)
 * Board    : the fourth tab is a link out to whatever taskboard you already use
 *
 * Everything writes through api() below. The Voice button is still a
 * placeholder; Stage 4 wires it.
 */

'use strict';

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

function parseReasons(text) {
  return String(text || '').split('+').map(function (x) {
    return x.trim();
  }).filter(function (x) {
    return x && x !== PLAIN_BREAK;
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
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

var cfg = loadConfig();
var isConfigured = function () { return Boolean(cfg.apiUrl && cfg.token); };

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
  review: 'text'          // unused until Stage 5, but it is already in IDEMPOTENT
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

async function attemptCall(action, payload) {
  var last;
  var tries = (IDEMPOTENT[action] || backendDedupes) ? MAX_TRIES : 1;

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

async function trackedCall(action, payload) {
  inFlight += 1;
  setConn('busy');
  try {
    var data = await attemptCall(action, payload);
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
function api(action, payload) {
  if (!isConfigured()) return Promise.reject(new Error('Not configured — open Settings.'));

  // One rid per logical write, fixed before the first attempt so every retry
  // carries the same one. Reads need none.
  if (!IDEMPOTENT[action]) {
    payload = Object.assign({ rid: newRid() }, payload || {});
  }

  var run = apiChain.then(
    function () { return trackedCall(action, payload); },
    function () { return trackedCall(action, payload); }   // a failure must not wedge the queue
  );
  apiChain = run.then(function () {}, function () {});
  return run;
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
function noteLocalRow(type, text, project) {
  lastLog.unshift({
    at: localIso(), local: '', type: type,
    raw_text: text || '', project: project || '', detail: ''
  });
  renderProject();
  renderDaySummary();
  renderLogList();
  renderChips();                 // the active break reason may have changed
  scheduleRefresh();
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
 */
function runWrites(steps, undo) {
  var chain = Promise.resolve();
  steps.forEach(function (step) {
    chain = chain.then(function () { return api('log', step); });
  });
  return chain.catch(function (err) {
    if (undo) restoreToggles(undo);
    writeFailed(err);
  }).then(function () {
    if (undo) endToggleWrite();          // release the baseline once drained
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
  if (!isConfigured()) {
    showEmpty('Open Settings to connect.');
    return;
  }
  try {
    renderToday(await api('today'));
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
  var underWay = false;                     // has the day started and not ended
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
      reasons = {};
    } else if (row.type === 'done') {
      var finished = String(row.project || text).trim();
      delete active[finished];
      var idx = order.indexOf(finished);
      if (idx !== -1) order.splice(idx, 1);
    } else if (row.type === 'resume') {
      clock = true;
      underWay = true;
      reasons = {};
    } else if (row.type === 'break') {
      /* Only a day that is under way can go ON a break. A chip tapped before
       * the first work row, or while asleep, must not book every hour since as
       * a break — that was a real bug, and `underWay` is the guard. */
      if (underWay) {
        clock = false;
        reasons = {};
        parseReasons(text).forEach(function (r) { reasons[r] = 1; });
      }
    } else if (row.type === 'off' || row.type === 'sleep') {
      // The day being over is not "on break": nothing accrues after it.
      clock = false;
      reasons = {};
      underWay = false;
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

/** Close one project without touching the others, or the work clock. */
function finishProject(btn, name) {
  if (btn.disabled) return;
  coolDown(btn);
  noteLocalRow('done', name, name);
  flash(name + ' — done', 'ok');
  runWrites([{ type: 'done', raw_text: name, project: name }]);
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
  work: { kind: 'work', state: 'working' }   // typing an entry means you are working
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
    parseReasons(row.raw_text).forEach(function (label) {
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

  var now = replayDay(lastLog).activeReasons;
  var next = now.filter(function (r) { return r !== label; });
  var adding = next.length === now.length;
  if (adding) next.push(label);

  var text = next.length ? next.join(REASON_SEP) : PLAIN_BREAK;

  var undo = beginToggleWrite();
  setToggle('work', 'break');
  // Not fed to the chip tally here — the reconcile brings the row back and
  // absorbChipStats() counts it exactly once, from the Sheet.
  noteLocalRow('break', text);
  confirmPulse(btn);
  flash(adding ? text + ' — on a break' : (next.length ? text : 'On a break'), 'ok');
  runWrites([{ type: 'break', raw_text: text }], undo);
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

$('trackerForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var input = $('trackerInput');
  var text = input.value.trim();
  if (!text) return;

  input.value = '';
  var undo = beginToggleWrite();

  var steps = wakeSteps(true);             // logging work is starting work
  // project stays empty until Gemini splits it out; replayDay() falls back to
  // the raw text so Home can already name what you are on.
  steps.push({ type: 'work', raw_text: text });

  // Typing an entry means you are working — if you were on a break or the day
  // was marked over, this reopens it, so the clock and the label agree.
  if (toggles.work.state !== 'working') setToggle('work', 'working');
  noteLocalRow('work', text);
  flash('Logged', 'ok');
  runWrites(steps, undo);
});

$('micBtn').addEventListener('click', function () {
  flash('Arrives in Stage ' + this.dataset.stage + '.');
});

$('refreshBtn').addEventListener('click', function () { refresh({ announce: true }); });

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

// ----------------------------------------------------------------- settings

var dlg = $('settingsDlg');

$('settingsBtn').addEventListener('click', function () {
  $('apiUrl').value = cfg.apiUrl || '';
  $('token').value = cfg.token || '';
  $('boardUrl').value = cfg.boardUrl || '';
  $('chipsInput').value = chipLabels().join(', ');
  $('testResult').textContent = '';
  dlg.showModal();
});

$('cancelBtn').addEventListener('click', function () { dlg.close(); });

$('testBtn').addEventListener('click', async function () {
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

$('saveBtn').addEventListener('click', function () {
  // Typing "trello.com/b/abc" without the scheme is a fair mistake, and
  // safeBoardUrl() would quietly store nothing. Say so instead.
  var typedBoard = $('boardUrl').value.trim();
  if (typedBoard && !safeBoardUrl(typedBoard)) {
    $('testResult').textContent = 'The taskboard link must start with https:// — nothing else was saved.';
    return;
  }

  var next = {
    apiUrl: $('apiUrl').value.trim(),
    token: $('token').value.trim(),
    boardUrl: safeBoardUrl(typedBoard),
    // Device-local on purpose: the chip list does not sync between phone and laptop.
    chips: (parseChips($('chipsInput').value).join(', ')) || DEFAULT_CHIPS.join(', ')
  };
  if (!next.apiUrl || !next.token) {
    $('testResult').textContent = 'Fill both fields first.';
    return;
  }
  cfg = next;
  saveConfig(cfg);
  renderChips();
  dlg.close();
  flash('Saved', 'ok');
  refresh();
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
  if (Date.now() - lastReconcileAt < POLL_MS) return;
  refresh();
}, 5000);

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  var now = Date.now();
  if (now - lastVisibleRefresh < VISIBILITY_THROTTLE_MS) return;
  lastVisibleRefresh = now;
  refresh();
});

renderPrayerTicks();
renderProject();
renderDaySummary();
lastVisibleRefresh = Date.now();     // the boot reconcile counts as the first one
refresh();
if (!isConfigured()) dlg.showModal();
