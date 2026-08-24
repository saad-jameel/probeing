/* ProBeing PWA — Stage 3: shell, settings, sync, and the logging buttons.
 *
 * M, Prayer and the quick-status chips all write through api() below. The Voice
 * button is still a placeholder; Stage 4 wires it.
 */

'use strict';

var CFG_KEY = 'probeing.config';

// Kept in step with the same two lists in Code.gs, which validates them server-side.
var PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
var PRAYER_MODES = ['Takbeer-e-oola', 'Partial Jamat', 'Individual'];

var DEFAULT_CHIPS = ['Tea', 'Lunch', 'Prayer-break', 'Rest', 'PUBG'];

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

/** Acknowledge a write on the button that was pressed. The banner is a backstop;
 *  this is what you see if you tap and immediately look away. */
function confirmPulse(el) {
  el.classList.remove('confirm');
  void el.offsetWidth;                       // forces a reflow so a fast second tap replays it
  el.classList.add('confirm');
  setTimeout(function () { el.classList.remove('confirm'); }, 500);
}

/** "2026-08-23T14:05:00+05:00" -> "14:05". Falls back to the raw string. */
function clockOf(entry) {
  var m = /T(\d{2}:\d{2})/.exec(entry.at || '');
  if (m) return m[1];
  var h = /(\d{1,2}:\d{2}\s*[AaPp][Mm])/.exec(entry.local || '');
  return h ? h[1] : '';
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

// ------------------------------------------------------------------ render

/** ISO timestamp -> milliseconds since epoch, or NaN if it cannot be read. */
function instantOf(at) {
  return Date.parse(String(at));
}

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

function renderToday(data) {
  $('mCount').textContent = data.m_count + ' today';
  $('nowLine').textContent = (data.now && data.now.text) || 'Nothing logged yet today.';

  // The picker's checkmarks are driven by this; refresh them if it is open.
  todayPrayers = data.prayers || [];
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
    $('nowLine').textContent = 'Not connected.';
    return;
  }
  try {
    renderToday(await api('today'));
    if (opts && opts.announce) flash('Up to date', 'ok');
  } catch (err) {
    flash(String(err.message || err), 'err');
  }
}

// ------------------------------------------------------------------- events

$('refreshBtn').addEventListener('click', function () { refresh({ announce: true }); });

$('trackerForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  var input = $('trackerInput');
  var text = input.value.trim();
  if (!text) return;

  input.value = '';
  try {
    await api('log', { type: 'work', raw_text: text });
    flash('Logged', 'ok');
    refresh();
  } catch (err) {
    input.value = text;                      // give the text back, never lose it
    flash(String(err.message || err), 'err');
  }
});

$('micBtn').addEventListener('click', function () {
  flash('Arrives in Stage ' + this.dataset.stage + '.');
});

// ----------------------------------------------------------------- M button

var mBtn = $('mBtn');

/* Disabled for the whole round trip: on a phone a double tap is a slip, not two
 * Ms, and the backend is append-only so a stray second row cannot be undone. */
mBtn.addEventListener('click', async function () {
  if (mBtn.disabled) return;
  mBtn.disabled = true;

  var before = $('mCount').textContent;
  $('mCount').textContent = ((parseInt(before, 10) || 0) + 1) + ' today';

  try {
    var res = await api('m');
    $('mCount').textContent = res.m_count + ' today';   // the Sheet's number wins
    confirmPulse(mBtn);
    refresh();
  } catch (err) {
    $('mCount').textContent = before;                   // nothing was written; put it back
    flash(String(err.message || err), 'err');
  } finally {
    mBtn.disabled = false;
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

function renderChips() {
  var row = $('chipRow');
  row.textContent = '';

  chipLabels().forEach(function (label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;            // textContent, never markup — this is user input
    b.addEventListener('click', function () { logChip(b, label); });
    row.appendChild(b);
  });
}

/** One tap, one status row, no confirmation dialog — that is the whole point. */
async function logChip(btn, label) {
  if (btn.disabled) return;
  btn.disabled = true;
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
      !window.confirm(pickedPrayer + ' already logged today — log again?')) return;

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
    btn.disabled = false;
  }
});

// ----------------------------------------------------------------- settings

var dlg = $('settingsDlg');

$('settingsBtn').addEventListener('click', function () {
  $('apiUrl').value = cfg.apiUrl || '';
  $('token').value = cfg.token || '';
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
  var next = {
    apiUrl: $('apiUrl').value.trim(),
    token: $('token').value.trim(),
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

refresh();
if (!isConfigured()) dlg.showModal();
