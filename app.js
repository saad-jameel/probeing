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

// 'Rest' is gone on purpose: the Break/Work toggle records rest properly, as a
// pair of rows that can be turned into a duration later.
var DEFAULT_CHIPS = ['Tea', 'Lunch', 'Prayer-break', 'PUBG'];

// Sleep pressed during a fresh work session, or in daylight, is more often a
// mis-tap than a bedtime. Anything outside those two windows goes through silently.
var SHORT_SESSION_MINUTES = 45;
var DAY_STARTS_HOUR = 5;
var DAY_ENDS_HOUR = 20;

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
async function api(action, payload) {
  if (!isConfigured()) throw new Error('Not configured — open Settings.');

  var res = await fetch(cfg.apiUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({
      action: action,
      token: cfg.token,
      tz: deviceTz()
    }, payload || {}))
  });

  if (!res.ok) throw new Error('HTTP ' + res.status);

  var data = await res.json();
  if (!data.ok) throw new Error(data.error || 'request failed');
  return data;
}

// ------------------------------------------------------------------ helpers

var $ = function (id) { return document.getElementById(id); };
var bannerTimer;

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

var lastLog = [];      // today's rows from the last successful refresh

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

  var entries = todayEntries(data);
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

  var project = '';
  var totals = {};
  var runningSince = 0;                     // 0 = clock stopped

  function stop(t) {
    if (!runningSince) return;
    totals[project] = (totals[project] || 0) + Math.max(0, t - runningSince);
    runningSince = 0;
  }

  rows.forEach(function (row) {
    var t = instantOf(row.at);

    if (row.type === 'work' || row.type === 'voice') {
      stop(t);                              // close the previous project's segment...
      project = String(row.project || row.raw_text || '').trim();
      runningSince = t;                     // ...and open this one's
    } else if (row.type === 'resume') {
      if (!runningSince) runningSince = t;
    } else if (row.type === 'break' || row.type === 'off' || row.type === 'sleep') {
      stop(t);
    }
    // wake / M / status / prayer do not move the work clock
  });

  var now = Date.now();
  var live = runningSince ? Math.max(0, now - runningSince) : 0;

  return {
    project: project,
    ms: (totals[project] || 0) + live,
    running: Boolean(runningSince)
  };
}

function renderProject() {
  var day = replayDay(lastLog);
  var name = $('projName');
  var time = $('projTime');

  if (!day.project && !day.ms) {
    name.textContent = 'Nothing logged yet';
    time.textContent = 'Type what you are doing on the Today tab.';
    return;
  }

  // textContent, never markup — this string came straight from the input box.
  name.textContent = day.project || 'Working (no project named)';
  time.textContent = humanDuration(day.ms) + ' today' + (day.running ? ' · running' : ' · paused');
}

// The clock on screen should move without a round trip. Cheap: it only re-reads
// rows already in memory.
setInterval(function () {
  if (currentScreen === 'home') renderProject();
}, 30000);

// ----------------------------------------------------------------- M button

var mBtn = $('mBtn');

/* Disabled for the whole round trip: on a phone a double tap is a slip, not two
 * Ms, and the backend is append-only so a stray second row cannot be undone. */
mBtn.addEventListener('click', async function () {
  if (mBtn.disabled) return;
  mBtn.disabled = true;

  var before = $('mCount').textContent;
  $('mCount').textContent = ((parseInt(before, 10) || 0) + 1) + ' today';
  var wrote = false;

  try {
    var res = await api('m');
    wrote = true;
    $('mCount').textContent = res.m_count + ' today';   // the Sheet's number wins
    confirmPulse(mBtn);
    refresh();
  } catch (err) {
    $('mCount').textContent = before;                   // nothing was written; put it back
    flash(String(err.message || err), 'err');
  } finally {
    // Nothing was written on the error path, so a retry should be instant.
    if (wrote) coolDown(mBtn); else mBtn.disabled = false;
  }
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

function setToggle(kind, state, at) {
  toggles[kind] = { state: state, at: at || Date.now() };
  localStorage.setItem(TOGGLE_KEY, JSON.stringify(toggles));
  paintToggles();
}

/** Is it night by the app's own definition — the same window the Sleep guard
 *  uses, so "it warned me" and "it ended my day" can never disagree. */
function isNight() {
  var hour = new Date().getHours();
  return hour < DAY_STARTS_HOUR || hour >= DAY_ENDS_HOUR;
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
 * Two independent slip-checks, deliberately not merged: the clock one is about
 * the time of day alone, so it must fire whatever the work state is, while the
 * short-session one only means anything when there is a session being closed.
 * Each returns its own wording, because a message naming a trigger that did not
 * fire reads as a bug.
 */
function sleepConfirmQuestion(closingWork) {
  if (!isNight()) {
    return "It's the middle of the day. Are you sure you're going to sleep?";
  }

  var startedMinsAgo = toggles.work.at ? (Date.now() - toggles.work.at) / 60000 : Infinity;
  if (closingWork && startedMinsAgo < SHORT_SESSION_MINUTES) {
    return 'You started working only a few minutes ago. ' +
           "Are you sure you're going to sleep?";
  }
  return '';
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
 */
async function ensureAwake() {
  if (toggles.sleep.state !== 'asleep') return;
  await api('log', { type: 'wake', raw_text: 'Wake up (auto — back to work)' });
  setToggle('sleep', 'awake');
}

sleepBtn.addEventListener('click', async function () {
  if (sleepBtn.disabled) return;
  var toSleep = toggles.sleep.state === 'awake';
  var closing = toSleep ? sleepClosingRow(toggles.work.state, isNight()) : null;

  // Declining must leave the Sheet untouched, so this runs before any write.
  var question = toSleep ? sleepConfirmQuestion(toggles.work.state === 'working') : '';
  if (question && !window.confirm(question)) return;

  sleepBtn.disabled = true;
  var wrote = false;
  try {
    if (closing) {
      await api('log', { type: closing.type, raw_text: closing.text });
      setToggle('work', closing.state);
    }
    await api('log', {
      type: toSleep ? 'sleep' : 'wake',
      raw_text: toSleep ? 'Sleep' : 'Wake up'
    });
    wrote = true;
    setToggle('sleep', toSleep ? 'asleep' : 'awake');
    confirmPulse(sleepBtn);
    flash(toSleep ? 'Sleep logged' : 'Awake', 'ok');
    refresh();
  } catch (err) {
    flash(String(err.message || err), 'err');
  } finally {
    if (wrote) coolDown(sleepBtn); else sleepBtn.disabled = false;
  }
});

workBtn.addEventListener('click', async function () {
  if (workBtn.disabled) return;
  var toBreak = toggles.work.state === 'working';

  workBtn.disabled = true;
  var wrote = false;
  try {
    // Mirror of the Sleep path: you cannot be asleep and working at once, so
    // starting work ends the night first, and without asking — one tap, and the
    // review still sees a wake row to close the sleep against.
    if (!toBreak) await ensureAwake();
    await api('log', {
      type: toBreak ? 'break' : 'resume',
      raw_text: toBreak ? 'Break' : 'Back to work'
    });
    wrote = true;
    setToggle('work', toBreak ? 'break' : 'working');
    confirmPulse(workBtn);
    flash(toBreak ? 'Break started' : 'Back to work', 'ok');
    refresh();
  } catch (err) {
    flash(String(err.message || err), 'err');
  } finally {
    if (wrote) coolDown(workBtn); else workBtn.disabled = false;
  }
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

  dayBtn.disabled = true;
  var wrote = false;
  try {
    if (off) await ensureAwake();          // starting the day ends the night
    await api('log', {
      type: off ? 'resume' : 'off',
      raw_text: off ? 'Day started' : 'Day over'
    });
    wrote = true;
    setToggle('work', off ? 'working' : 'off');
    confirmPulse(dayBtn);
    flash(off ? 'Day started' : 'Day closed', 'ok');
    refresh();
  } catch (err) {
    flash(String(err.message || err), 'err');
  } finally {
    if (wrote) coolDown(dayBtn); else dayBtn.disabled = false;
  }
});

// -------------------------------------------------------------------- chips

/** The chip labels come from Settings on this device, i.e. they are user input. */
function parseChips(text) {
  return String(text)
    .split(',')
    .map(function (x) { return x.trim(); })
    .filter(function (x) { return x.length > 0; });
}

function chipLabels() {
  // Separators-only input (", , ") parses to nothing, which would leave the row
  // blank with no explanation; treat that the same as an empty box.
  var parts = parseChips(cfg.chips === undefined ? DEFAULT_CHIPS.join(', ') : cfg.chips);
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

  (log || []).forEach(function (row) {
    if (row.type !== 'status') return;
    var label = String(row.raw_text || '').trim();
    if (!label) return;

    var t = instantOf(row.at);
    if (isNaN(t) || t <= chipStats.seen) return;

    var rec = chipStats.items[label] || { n: 0, last: 0 };
    rec.n += 1;
    rec.last = Math.max(rec.last, t);
    chipStats.items[label] = rec;

    if (t > newest) newest = t;
    changed = true;
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
  var order = labels.join('\n');

  // Rebuilding on every refresh would move a chip out from under a finger that
  // is already on its way down; only redraw when the order actually changed.
  if (order === renderedChipOrder && row.childElementCount) return;
  renderedChipOrder = order;
  row.textContent = '';

  labels.forEach(function (label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;            // textContent, never markup — this is user input
    b.addEventListener('click', function () { logChip(b, label); });
    row.appendChild(b);
  });
}

/** One tap, one status row, no confirmation dialog — that is the whole point.
 *  The tally is not touched here; the refresh below brings the row back and
 *  absorbChipStats() counts it once. */
async function logChip(btn, label) {
  if (btn.disabled) return;
  btn.disabled = true;
  chipFreezeUntil = Date.now() + CHIP_FREEZE_MS;   // set before the write, not after
  try {
    await api('log', { type: 'status', raw_text: label });
    confirmPulse(btn);
    refresh();
  } catch (err) {
    flash(String(err.message || err), 'err');
  } finally {
    btn.disabled = false;
  }
}

renderChips();

// ------------------------------------------------------------ prayer picker

var prayerDlg = $('prayerDlg');
var todayPrayers = [];               // from the last today() call; drives the checkmarks
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
  refresh();                          // opens instantly on cached ticks, then corrects them
});

$('prayerCancelBtn').addEventListener('click', function () { prayerDlg.close(); });

$('prayerSaveBtn').addEventListener('click', async function () {
  if (!pickedPrayer || !pickedMode) return;

  // Append-only by design: a duplicate is warned about, never overwritten.
  if (loggedToday(pickedPrayer) &&
      !window.confirm(pickedPrayer + ' is already logged today. Log it again?')) return;

  var btn = this;
  var name = pickedPrayer;
  btn.disabled = true;
  try {
    await api('prayer', { prayer: name, mode: pickedMode });
    prayerDlg.close();
    flash(name + ' logged', 'ok');
    refresh();
  } catch (err) {
    flash(String(err.message || err), 'err');
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ tracker

$('trackerForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  var input = $('trackerInput');
  var text = input.value.trim();
  if (!text) return;

  input.value = '';
  try {
    await ensureAwake();                   // logging work is starting work
    // project stays empty until Gemini splits it out; replayDay() falls back to
    // the raw text so Home can already name what you are on.
    await api('log', { type: 'work', raw_text: text });
    flash('Logged', 'ok');
    // Typing an entry means you are working — if you were on a break or the day
    // was marked over, this reopens it, so the clock and the label agree.
    if (toggles.work.state !== 'working') setToggle('work', 'working');
    refresh();
  } catch (err) {
    input.value = text;                      // give the text back, never lose it
    flash(String(err.message || err), 'err');
  }
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

// Coming back to the app should show current data, not a stale screen.
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') refresh();
});

renderPrayerTicks();
renderProject();
refresh();
if (!isConfigured()) dlg.showModal();
