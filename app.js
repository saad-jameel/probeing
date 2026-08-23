/* ProBeing PWA — Stage 2: shell, settings, sync.
 *
 * The M / Prayer / Voice buttons are placeholders here; Stage 3 and 4 wire them.
 * Everything talks to the Apps Script backend through api() below.
 */

'use strict';

var CFG_KEY = 'probeing.config';

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
    body: JSON.stringify(Object.assign({ action: action, token: cfg.token }, payload || {}))
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

function renderToday(data) {
  $('mCount').textContent = data.m_count + ' today';
  $('nowLine').textContent = (data.now && data.now.text) || 'Nothing logged yet today.';

  var list = $('logList');
  list.textContent = '';

  if (!data.log.length) {
    showEmpty('No entries yet today.');
    return;
  }

  data.log.forEach(function (entry) {
    var li = document.createElement('li');

    var when = document.createElement('span');
    when.className = 'when';
    when.textContent = clockOf(entry);

    var what = document.createElement('span');
    what.className = 'what';
    // textContent, not innerHTML — log text is user input and must never be parsed as markup.
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

['mBtn', 'prayerBtn', 'micBtn'].forEach(function (id) {
  $(id).addEventListener('click', function () {
    flash('Arrives in Stage ' + this.dataset.stage + '.');
  });
});

// ----------------------------------------------------------------- settings

var dlg = $('settingsDlg');

$('settingsBtn').addEventListener('click', function () {
  $('apiUrl').value = cfg.apiUrl || '';
  $('token').value = cfg.token || '';
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
  var next = { apiUrl: $('apiUrl').value.trim(), token: $('token').value.trim() };
  if (!next.apiUrl || !next.token) {
    $('testResult').textContent = 'Fill both fields first.';
    return;
  }
  cfg = next;
  saveConfig(cfg);
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
