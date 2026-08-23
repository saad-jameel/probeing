/**
 * ProBeing backend — a small JSON API over the ProBeing Google Sheet.
 *
 * Deployed as a Web App (Execute as: Me, Access: Anyone). Anonymous access is
 * intentional; the shared TOKEN script property is the real lock.
 *
 * IMPORTANT — CORS: browsers cannot send `application/json` here, because the
 * preflight OPTIONS request that triggers is something Apps Script web apps
 * cannot answer. The client therefore POSTs JSON *text* with a Content-Type of
 * text/plain, which is a "simple request" and skips preflight entirely. That is
 * why we read e.postData.contents instead of e.parameter.
 */

var SHEETS = {
  LOG: 'Log',
  PRAYERS: 'Prayers',
  REPORTS: 'Reports',
  NOW: 'Now'
};

/**
 * Timezone for the current request. Each doPost runs in a fresh script context,
 * so a module-level slot is per-request state, not shared between callers.
 * The client sends its own IANA zone; we fall back to the project's.
 */
var REQ_TZ = null;

var PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
var PRAYER_MODES = ['Takbeer-e-oola', 'Partial Jamat', 'Individual'];

// ---------------------------------------------------------------- entrypoints

/** Health check only — deliberately returns nothing sensitive. */
function doGet() {
  return json({ ok: true, service: 'probeing', time: nowIso() });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'empty_body' });
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return json({ ok: false, error: 'bad_json' });
    }

    if (!checkToken(body.token)) {
      return json({ ok: false, error: 'unauthorized' });
    }

    // Honour the device's clock. A phone that travels keeps logging in local
    // time, and "today" rolls over where the user actually is.
    REQ_TZ = validTz(body.tz);

    var handler = ACTIONS[body.action];
    if (!handler) {
      return json({ ok: false, error: 'unknown_action', action: body.action || null });
    }

    // Serialize writes so two fast taps can never interleave into one row.
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      return json(handler(body));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ ok: false, error: 'server_error', detail: String(err) });
  }
}

// ------------------------------------------------------------------- actions

var ACTIONS = {
  ping: function () {
    return { ok: true, pong: true, tz: tz(), time: nowIso() };
  },

  /** Free-text / status entry. project+detail stay empty until Stage 4 (Gemini). */
  log: function (b) {
    var type = b.type || 'work';
    var raw = String(b.raw_text || '').trim();
    if (!raw) return { ok: false, error: 'empty_text' };

    var d = new Date();
    sheet(SHEETS.LOG).appendRow([
      iso(d), human(d), type, raw, b.project || '', b.detail || ''
    ]);
    return { ok: true, type: type, raw_text: raw, at: iso(d) };
  },

  /** The red M button. Records only that it happened, and when. */
  m: function () {
    var d = new Date();
    sheet(SHEETS.LOG).appendRow([iso(d), human(d), 'M', '', '', '']);
    return { ok: true, at: iso(d), m_count: countTodayType('M') };
  },

  prayer: function (b) {
    var name = String(b.prayer || '').trim();
    var mode = String(b.mode || '').trim();
    if (PRAYERS.indexOf(name) === -1) return { ok: false, error: 'bad_prayer', got: name };
    if (PRAYER_MODES.indexOf(mode) === -1) return { ok: false, error: 'bad_mode', got: mode };

    var d = new Date();
    sheet(SHEETS.PRAYERS).appendRow([iso(d), human(d), dateKey(d), name, mode]);
    return { ok: true, prayer: name, mode: mode, at: iso(d) };
  },

  /** Everything the app needs to paint today's screen, in one round trip. */
  today: function () {
    var key = dateKey(new Date());
    var log = rows(SHEETS.LOG).filter(function (r) {
      return dateKeyOf(r[0]) === key;
    }).map(function (r) {
      return {
        at: String(r[0]), local: String(r[1]), type: String(r[2]),
        raw_text: String(r[3]), project: String(r[4]), detail: String(r[5])
      };
    });

    var prayers = rows(SHEETS.PRAYERS).filter(function (r) {
      return String(r[2]) === key || dateKeyOf(r[0]) === key;
    }).map(function (r) {
      return { at: String(r[0]), local: String(r[1]), prayer: String(r[3]), mode: String(r[4]) };
    });

    return {
      ok: true,
      date: key,
      log: log.reverse(),               // newest first for the UI
      prayers: prayers,
      m_count: log.filter(function (x) { return x.type === 'M'; }).length,
      now: readNow()
    };
  },

  now_get: function () {
    return { ok: true, now: readNow() };
  },

  now_set: function (b) {
    var text = String(b.text || '').trim();
    var d = new Date();
    var sh = sheet(SHEETS.NOW);
    sh.getRange(2, 1, 1, 2).setValues([[text, iso(d)]]);
    return { ok: true, now: { text: text, updated: iso(d) } };
  },

  /** Stage 5 fills this in. */
  review: function () {
    return { ok: true, stub: true, text: 'Review arrives in Stage 5.' };
  }
};

// ------------------------------------------------------------------- helpers

function checkToken(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!expected) return false;
  if (!given || String(given).length !== expected.length) return false;

  // Constant-time-ish compare: always walk the whole string.
  var mismatch = 0;
  var g = String(given);
  for (var i = 0; i < expected.length; i++) {
    mismatch |= (g.charCodeAt(i) ^ expected.charCodeAt(i));
  }
  return mismatch === 0;
}

function sheet(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('missing sheet tab: ' + name);
  return sh;
}

/** All data rows of a tab, header excluded. */
function rows(name) {
  var sh = sheet(name);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
}

function readNow() {
  var sh = sheet(SHEETS.NOW);
  if (sh.getLastRow() < 2) return { text: '', updated: '' };
  var v = sh.getRange(2, 1, 1, 2).getValues()[0];
  return { text: String(v[0] || ''), updated: String(v[1] || '') };
}

function countTodayType(type) {
  var key = dateKey(new Date());
  return rows(SHEETS.LOG).filter(function (r) {
    return String(r[2]) === type && dateKeyOf(r[0]) === key;
  }).length;
}

function tz() { return REQ_TZ || Session.getScriptTimeZone(); }

/**
 * Accept an IANA zone name only if Apps Script can actually format with it.
 * An unvalidated string here would throw deep inside formatDate and turn a
 * typo into a 500 for every subsequent call.
 */
function validTz(name) {
  if (!name || typeof name !== 'string' || name.length > 64) return null;
  if (!/^([A-Za-z_]+\/[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)?|UTC|GMT)$/.test(name)) return null;
  try {
    Utilities.formatDate(new Date(), name, 'yyyy');
    return name;
  } catch (e) {
    return null;
  }
}
function nowIso() { return iso(new Date()); }
function iso(d) { return Utilities.formatDate(d, tz(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function human(d) { return Utilities.formatDate(d, tz(), 'EEE dd MMM, hh:mm a'); }
function dateKey(d) { return Utilities.formatDate(d, tz(), 'yyyy-MM-dd'); }

/**
 * A cell may come back as a Date object or as the ISO string we wrote,
 * depending on how the Sheet decided to type it. Handle both.
 */
function dateKeyOf(cell) {
  if (cell instanceof Date) return dateKey(cell);
  return String(cell).slice(0, 10);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------- one-time setup helper

/**
 * Run this ONCE from the Apps Script editor (select setupSheet, press Run).
 * Creates any missing tab and writes its header row. Safe to re-run: it never
 * touches existing data.
 */
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var headers = {};
  headers[SHEETS.LOG] = ['timestamp', 'local_time', 'type', 'raw_text', 'project', 'detail'];
  headers[SHEETS.PRAYERS] = ['timestamp', 'local_time', 'date', 'prayer', 'mode'];
  headers[SHEETS.REPORTS] = ['period', 'start_date', 'text', 'm_count', 'prayer_stats', 'hours_overview'];
  headers[SHEETS.NOW] = ['status', 'last_updated'];

  Object.keys(headers).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var want = headers[name];
    sh.getRange(1, 1, 1, want.length).setValues([want]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });

  // Now is a single-row tab; make sure that row exists.
  var nowSheet = ss.getSheetByName(SHEETS.NOW);
  if (nowSheet.getLastRow() < 2) nowSheet.appendRow(['', '']);

  // Drop the default "Sheet1" if it is empty and unused.
  var extra = ss.getSheetByName('Sheet1');
  if (extra && extra.getLastRow() === 0) ss.deleteSheet(extra);

  return 'ProBeing tabs ready: ' + Object.keys(headers).join(', ');
}
