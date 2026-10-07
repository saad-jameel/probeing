/* ProBeing PWA — four screens, two mandatory buttons, two state toggles.
 *
 * Home     : M / Prayer / Sleep-Wake / Break-Work, prayer ticks, current project
 * Today    : the tracker input and today's raw log
 * Money    : money in and out, PKR, and today's list (Stage 11)
 * Review   : the weekly report (layout final, numbers land with the backend)
 *
 * The taskboard link lives in Settings → Developer settings.
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
/* How to unblock notifications. The installed app has no address bar, so the
 * padlock menu everyone gets pointed at is not there; Android's own app
 * settings are the switch that works. Both routes, the app's one first. */
var UNBLOCK_HELP = 'In the installed app: Android Settings → Apps → ProBeing → ' +
  'Notifications. In a browser tab: the padlock menu beside the address bar ' +
  '(Site settings → Notifications).';

var TOGGLE_KEY = 'probeing.toggles';        // current sleep/work state, per device
var CHIP_STATS_KEY = 'probeing.chipstats';  // how often each status gets logged
var PROJECT_NAMES_KEY = 'probeing.projects'; // project names seen lately, reused for free
var GEMINI_DAY_KEY = 'probeing.geminiday';   // today's Gemini call count, against the free tier

// callSupabase('prayer') refuses anything outside PRAYER_NAMES (in day.js) and this.
var PRAYER_MODES = ['Takbeer-e-oola', 'Partial Jamat', 'Individual'];

/* The chips are BREAK REASONS, not notes.
 *
 * They used to write a `status` row, which was a point in time with no end — so
 * "Lunch" could never become a duration, and tapping "Prayer-break" left the
 * work clock running, which says you were praying and working at once. Now a
 * chip writes the `break` edge itself, carrying its reason, and the next
 * `resume` closes it. That is what lets the review say "Lunch 45m". */
var DEFAULT_CHIPS = ['Prayer-break', 'Lunch', 'Coffee'];

/* PLAIN_BREAK, REASON_SEP and the break-row parsers live in
 * supabase/functions/_shared/day.js, shared with the glance-refresh function. */

/* 9 PM is the line between "a nap in the middle of the day" and "winding up".
 * Only one press is ever silent — on a break after 9 PM, which is unambiguously
 * bedtime. Everything else asks, because every one of those presses closes a
 * session the weekly review has to measure. */
var NIGHT_STARTS_HOUR = 21;
var DAY_STARTS_HOUR = 5;

// ------------------------------------------------------------------- config
// Saved per device in localStorage. The anon key is publishable; RLS and the
// signed-in session do the protecting.

function loadConfig() {
  var saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(CFG_KEY)) || {};
  } catch (e) { /* corrupt storage must not wedge the app */ }

  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  // Left over from the Apps Script backend; dropped so they are not re-saved.
  delete saved.backend;
  delete saved.apiUrl;
  delete saved.token;

  // Comes ready to sign in to. Anything saved on this device still wins.
  if (!saved.supaUrl) saved.supaUrl = DEFAULT_SUPABASE_URL;
  if (!saved.supaKey) saved.supaKey = DEFAULT_SUPABASE_ANON;
  return saved;
}

function saveConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

var cfg = loadConfig();
var isConfigured = function () {
  return Boolean(cfg.supaUrl && cfg.supaKey && sbUser);
};

// ------------------------------------------------------------- prayer place
/* Where prayer times, and so the day's rollover, are worked out (Stage 10).
 * Its own key rather than cfg, which Save rewrites wholesale. `synced` false
 * means user_settings does not have this copy yet, so the server may still be
 * counting a different day; it is retried at the next sign-in. */
var PLACE_KEY = 'probeing.place';

function loadPlace() {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(PLACE_KEY)); } catch (e) { /* the default */ }
  return (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {};
}

function savePlace(p) {
  try { localStorage.setItem(PLACE_KEY, JSON.stringify(p)); } catch (e) { /* kept for this visit */ }
}

// Before anything renders: every counter-day read below depends on it.
var placeSaved = loadPlace();
setPrayerPlace(placeSaved);

// ----------------------------------------------------------------- supabase
/* The backend: taps in ~0.35s, and a live feed so the two devices correct
 * each other without anyone pressing refresh.
 *
 * The rows keep their meanings from the Sheet. Prayers are not a separate
 * table: they are events of type 'prayer' carrying the name in `project` and
 * the mode in `detail`, which is what the Sheet's extra tab was really for. */

var sb = null;                 // the Supabase client, once configured
var sbUser = null;             // the signed-in user, or null

function supabaseReady() {
  return Boolean(sb && sbUser);
}

/* A signal with no data (one bar, a captive portal) hangs a fetch for minutes,
 * and every press queued behind it waits too. So each request gets this long. */
var REQUEST_TIMEOUT_MS = 12000;
var netStalled = false;        // a request timed out and nothing has answered since
var stalledAt = 0;             // when the last one timed out
var NULL_BODY_STATUS = { 101: 1, 103: 1, 204: 1, 205: 1, 304: 1 };   // a Response may not carry a body

/** A clock for durations. The wall clock can step (a time sync, a manual change),
 *  and a step backwards would stretch the stall window. */
function monoNow() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** fetch, given up after REQUEST_TIMEOUT_MS. Named AbortError because postgrest-js
 *  treats that as final; any other name and it retries a read three more times. */
function timedFetch(url, init) {
  init = init || {};
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  if (ctrl && init.signal) {
    if (init.signal.aborted) ctrl.abort();
    else init.signal.addEventListener('abort', function () { ctrl.abort(); });
  }
  var timer;
  var late = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      netStalled = true;
      stalledAt = monoNow();
      var err = new Error('no answer within ' + (REQUEST_TIMEOUT_MS / 1000) + ' seconds');
      err.name = 'AbortError';
      reject(err);                         // before abort(), so this is the error the caller sees
      if (ctrl) { try { ctrl.abort(); } catch (e) { /* already finished */ } }
    }, REQUEST_TIMEOUT_MS);
  });
  // The body is read inside the deadline too: headers alone are not an answer,
  // and a line that dies mid-body would otherwise hold the queue for ever.
  var sent = fetch(url, ctrl ? Object.assign({}, init, { signal: ctrl.signal }) : init)
    .then(function (res) {
      return res.arrayBuffer().then(function (buf) {
        return new Response(NULL_BODY_STATUS[res.status] ? null : buf,
          { status: res.status, statusText: res.statusText, headers: res.headers });
      });
    });
  // Any answer, even one too late to use, means the network is back.
  sent.then(function () { netStalled = false; }, function () {});
  return Promise.race([sent, late]).then(function (res) {
    clearTimeout(timer);
    return res;
  }, function (err) {
    clearTimeout(timer);
    throw err;
  });
}

/** Build (or rebuild) the client from whatever is in Settings. */
function initSupabase() {
  sb = null;
  sbUser = null;
  if (!cfg.supaUrl || !cfg.supaKey) return;
  if (typeof supabase === 'undefined' || !supabase.createClient) return;

  sb = supabase.createClient(cfg.supaUrl.trim().replace(/\/+$/, ''), cfg.supaKey.trim(), {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    global: { fetch: timedFetch }
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

  if (sbUser) {
    /* Whose device this is, remembered for the next launch that cannot reach
     * the network: an offline press is filed under this id and sent only when
     * this same account is signed in again. */
    rememberUser(sbUser.id);
    setSignedOut(false);
    // Every session event, not only a change of user: a token refresh is the
    // first sign that the network is back.
    drainOutbox('session');
  }

  if (sbUser && sbUser.id !== before) {
    signInDlg.close();
    watchLive();
    watchGoogle();
    watchTasks();
    // After the day's own read has had a head start: this is not on the logging path.
    setTimeout(tasksOnOpen, TASKS_OPEN_DELAY_MS);
    refresh();
    /* Every launch, not just the first: a push subscription dies silently — a
     * browser update or a long idle and the endpoint answers 410 Gone — so the
     * only thing that keeps the 11:30 PM check working past a few weeks is
     * writing it down again each time the app opens. Nothing is asked of the
     * user here; it does nothing at all unless permission was already given. */
    syncPushSubscription();
    syncPlace();
    syncMoneyTags();
    if (currentScreen === 'money') readMoney();
  } else if (!sbUser) {
    stopLive();
    /* Nothing repaints the glance until a signed-in read lands again, and a real
     * sign-out takes it out of the shade. Only a REAL one: a launch that could
     * not restore the session (offline, say) comes through here too, with nobody
     * signed in before it, and closing the glance then would throw away the last
     * true figures for nothing. */
    forgetGlance();
    if (before) { closeGlance(); forgetMoney(); }
    /* A SIGN-IN BOX THAT CANNOT REACH GITHUB IS A DEAD END. An app opened with
     * no signal lands here — the token expired and could not be refreshed — and
     * the box would sit over the buttons refusing to do anything. Presses are
     * queued under the last account instead, and the box appears when there is
     * a network to sign in over. A sign-out the user actually pressed always
     * asks, whatever the network is doing. */
    if (signedOutByHand() || navigator.onLine !== false || !currentUserId()) askSignIn();
    paintConn();
    paintOutboxNote();
  }
}

/* Sign out is a decision; a launch that could not restore the session is not.
 * They arrive at the same place and mean opposite things — and the decision has
 * to outlive the page, or signing out and reopening the app with no signal looks
 * to the code exactly like a session it failed to restore: no sign-in box, and
 * presses filed under the account just left. Hence localStorage, beside the last
 * user id. Cleared the moment somebody signs in. */
function signedOutByHand() {
  try { return localStorage.getItem(SIGNED_OUT_KEY) === '1'; } catch (e) { return false; }
}

function setSignedOut(on) {
  try {
    if (on) localStorage.setItem(SIGNED_OUT_KEY, '1');
    else localStorage.removeItem(SIGNED_OUT_KEY);
  } catch (e) { /* full disk: the box simply appears as it used to */ }
}

/** When the current counter day began (day.js decides when that is), as an
 *  instant the database can compare against. By the device's own clock, so
 *  "today" rolls over where the user actually is. */
function counterDayStartIso() {
  return new Date(counterDayStart(Date.now())).toISOString();
}

/* `rid` comes along for one reason: it is how a row the table already has is
 * told apart from the copy this device is still holding in the outbox. Nothing
 * else reads it off a row. */
function sbRow(r) {
  var row = {
    at: r.at, local: r.local_time || '', type: r.type,
    raw_text: r.raw_text || '', project: r.project || '', detail: r.detail || '',
    rid: r.rid || ''
  };
  if (r.node_id) row.node_id = r.node_id;       // the task a Tasks-page start named
  return row;
}

async function sbInsert(payload) {
  /* THE PRESS TIME, NOT THE SEND TIME. api() stamps `at` and `local_time` once,
   * beside the rid, and every attempt — including one replayed off the outbox an
   * hour later — carries that same instant. Stamping here instead is what made a
   * queued row land at the reconnect time. The fallback is for a caller that
   * never went through api(), and keeps the old behaviour for it. */
  var stamped = typeof payload.at === 'string' && !isNaN(Date.parse(payload.at));
  var row = {
    at: stamped ? payload.at : new Date().toISOString(),
    local_time: stamped ? (payload.local_time || '') : humanLocal(),
    tz: deviceTz(),
    type: payload.type || 'work',
    raw_text: String(payload.raw_text || ''),
    project: String(payload.project || ''),
    detail: String(payload.detail || ''),
    rid: payload.rid || null
  };
  // Only when set, so a row without a task still saves on a database without the column.
  if (payload.node_id) row.node_id = String(payload.node_id);

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
  if (isRefusal(e.code)) err.fatal = true;
  return err;
}

/* THE ONLY CODES THAT MEAN "THIS ROW WILL BE REFUSED HOWEVER OFTEN IT IS SENT":
 * Postgres bad data (22xxx), a broken constraint (23xxx) and a permission or RLS
 * refusal (42501). A fatal error deletes a held press on its first send, so the
 * list is kept narrow on purpose. Everything else is kept and retried: an expired
 * or rejected token (PGRST301, PGRST303), the server's connection trouble
 * (PGRST000-003), a 5xx, 408 or 429, and any code not listed here. A press that
 * waits for ever is visible in Settings; a deleted one is gone. */
function isRefusal(code) {
  code = String(code || '');
  if (code === '23505') return false;            // the row is already in: success, see sbInsert
  return code === '42501' || /^2[23][0-9A-Z]{3}$/.test(code);
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
  if (!sb) throw new Error('Add your Supabase details in Settings → Developer settings.');
  if (!sbUser) throw new Error('Sign in to keep logging.');
  payload = payload || {};

  if (action === 'ping') {
    var p = await sb.from('events').select('id').limit(1);
    if (p.error) throw errorFrom(p.error);
    return { ok: true, pong: true, tz: deviceTz() };
  }

  if (action === 'today') {
    // One reading of the rollover for all three reads, so they cannot straddle it.
    var dayStartMs = counterDayStart(Date.now());
    var dayStartIso = new Date(dayStartMs).toISOString();
    var res = await sb.from('events').select('*')
      .gte('at', dayStartIso)
      .order('at', { ascending: false })
      .limit(1000);
    if (res.error) throw errorFrom(res.error);

    var rows = res.data || [];
    var log = [];
    var prayers = [];

    /* Between the rollover and Fajr the prayer day is still yesterday's
     * (prayerDate), so its prayers are read from yesterday's Fajr. */
    var prayerStartMs = prayerDayStart(Date.now());
    if (prayerStartMs < dayStartMs) {
      var early = await sb.from('events').select('*').eq('type', 'prayer')
        .gte('at', new Date(prayerStartMs).toISOString()).lt('at', dayStartIso)
        .order('at', { ascending: false }).limit(100);
      if (early.error) throw errorFrom(early.error);
      rows = rows.concat(early.data || []);
    }

    rows.forEach(function (r) {
      if (r.type === 'prayer') {
        prayers.push({ at: r.at, local: r.local_time || '', rid: r.rid || '',
                       prayer: r.project || '', mode: r.detail || '' });
      } else {
        log.push(sbRow(r));
      }
    });

    /* The newest state row from BEFORE today, so the pills survive an overnight
     * close. The 11:30 PM auto-close is stamped yesterday, so it is never in the
     * rows above and no device ever adopted it — the pill read "Working" all day
     * while the server correctly held the day closed, and the nightly check
     * stayed silent. Deliberately kept out of `log`: it may move the toggles,
     * never the figures. A failure here is ignored rather than thrown — a missing
     * carry row is a stale pill, but a thrown one is no refresh at all.
     *
     * Several rows, not one. The auto-close writes `off` AND `sleep` at the same
     * instant, and they move different pills, so fetching a single newest row
     * returns an arbitrary one of the pair and leaves the other pill stale. These
     * go through the same reconcile as today's rows, which already keeps the
     * newest per pill; the limit is a cap on the read, not an assumption about
     * how many are needed. */
    var carry = null;                  // null = unknown, never "none": see dayFigures
    var prior = await sb.from('events').select('at, type')
      .lt('at', dayStartIso)
      .in('type', Object.keys(STATE_ROWS))
      .order('at', { ascending: false })
      .limit(12);
    if (!prior.error) carry = prior.data || [];

    /* The lead-in: the session still running from before the rollover, which
     * "working on" and the hours replay but no count ever reads. A failure is
     * thrown, unlike carry's: without it the screen would say, confidently,
     * that the night's projects and hours never happened. */
    var leadRes = await sb.from('events').select('*')
      .lt('at', dayStartIso)
      .gte('at', new Date(dayStartMs - LEAD_MAX_MS).toISOString())
      .in('type', LEAD_TYPES)
      .order('at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1000);
    if (leadRes.error) throw errorFrom(leadRes.error);

    return {
      ok: true,
      date: counterDate(dayStartMs),
      log: log,
      carry: carry,
      lead: sessionLead((leadRes.data || []).map(sbRow), dayStartMs),
      prayers: prayers,
      m_count: log.filter(function (x) { return x.type === 'M'; }).length,
      now: { text: '', updated: '' }
    };
  }

  if (action === 'log') {
    // 14b: a subdone whose closing mark was refused (parked) is withdrawn, not written.
    if (payload.type === 'subdone' && payload.closing_rid &&
        parkedAll().some(function (x) { return x && x.rid === payload.closing_rid; })) {
      return { ok: true, withdrawn: true };
    }
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

  /* Stage 14a: an Unsorted entry filed from the tray. The same fill-once update
   * as `label`, now with the task. Sent again off the outbox, it finds the row
   * already carrying this node_id, which is success. */
  if (action === 'file') {
    if (!payload.entry_rid || !payload.node_id) {
      var badFile = new Error('bad_file');
      badFile.fatal = true;
      throw badFile;
    }
    var put = { node_id: String(payload.node_id) };
    if (payload.project) {
      put.project = String(payload.project);
      put.detail = String(payload.detail || '');
    }
    var fil = await sb.from('events').update(put)
      .eq('rid', payload.entry_rid).eq('project', '').is('node_id', null)
      .select('rid');
    if (fil.error) throw errorFrom(fil.error);
    if ((fil.data || []).length) return { ok: true, filed: true };
    var fileRow = await sb.from('events').select('node_id,project').eq('rid', payload.entry_rid).limit(1);
    if (fileRow.error) throw errorFrom(fileRow.error);
    var filedRow = (fileRow.data || [])[0];
    if (filedRow && filedRow.node_id === put.node_id) return { ok: true, filed: true, already: true };
    var taken = new Error(!filedRow ? 'that entry is not in your log'
                          : filedRow.node_id || filedRow.project ? 'it was already filed somewhere else'
                          : 'the database did not accept the filing');
    taken.fatal = true;                          // sending it again would get the same answer
    throw taken;
  }

  /* Stage 14b: Done, Drop or Undo ('open') on an item, append-only. The item is
   * named by its rid, so a mark on an item still waiting here can be sent too. */
  if (action === 'mark') {
    if (!payload.item_rid || ITEM_MARKS[payload.mark] !== 1) {
      var badMark = new Error('bad_mark');
      badMark.fatal = true;
      throw badMark;
    }
    var markAt = typeof payload.at === 'string' && !isNaN(Date.parse(payload.at));
    var mk = await sb.from('item_marks').insert({
      rid: payload.rid, item_rid: String(payload.item_rid), mark: payload.mark,
      at: markAt ? payload.at : new Date().toISOString(),
      local_time: markAt ? (payload.local_time || '') : humanLocal()
    });
    // 23505: this mark is already in.
    if (mk.error && mk.error.code !== '23505') throw errorFrom(mk.error);
    return { ok: true, duplicate: Boolean(mk.error) };
  }

  // Stage 14b: an item added by hand under one of his tasks.
  if (action === 'item') {
    var itemTitle = cleanItemTitle(payload.title);
    if (!payload.node_id || !itemTitle) {
      var badItem = new Error('bad_item');
      badItem.fatal = true;
      throw badItem;
    }
    var itemAt = typeof payload.at === 'string' && !isNaN(Date.parse(payload.at));
    var ni = await sb.from('items').insert({
      rid: payload.rid, node_id: String(payload.node_id), title: itemTitle, made_by: 'hand',
      at: itemAt ? payload.at : new Date().toISOString()
    });
    if (ni.error && ni.error.code !== '23505') throw errorFrom(ni.error);
    return { ok: true, duplicate: Boolean(ni.error) };
  }

  if (action === 'm') {
    // at/local_time forwarded, not rebuilt: this row must carry the instant the
    // tile was tapped even when it is sent off the outbox hours later.
    await sbInsert({ type: 'M', raw_text: '', rid: payload.rid,
                     at: payload.at, local_time: payload.local_time });
    /* THE ROW IS IN. Past this line the write has succeeded, so a failure of the
     * count below must not be reported as a failure of the write: that would put
     * a press that actually landed back on the queue as "waiting", and the only
     * reason it costs nothing today is that the rid makes the resend a no-op.
     * M is the one logging action that makes a second call, and this is the
     * whole of what that second call is for — a nicer number on the tile. */
    var c = await sb.from('events').select('id', { count: 'exact', head: true })
      .eq('type', 'M').gte('at', counterDayStartIso());
    if (c.error) return { ok: true };            // saved; the tile keeps its own count
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
                     project: name, detail: mode, rid: payload.rid,
                     at: payload.at, local_time: payload.local_time });
    return { ok: true, prayer: name, mode: mode };
  }

  /* Stage 13b: a loan is a money row with kind 'loan' and a person. It has its
   * own action so an older tab HOLDS it (R8) instead of sending it as spending.
   * Money 2: a record-only due ('due') and the wallet's count ('wallet'), the same. */
  if (moneyItem({ action: action })) {
    // Checked again here: a held item is sent exactly as it was stored.
    var kind = MONEY_KIND_OF[action];
    var amount = kind === 'opening' ? parseWalletAmount(payload.amount) : parseMoneyAmount(payload.amount);
    var tag = String(payload.tag || '').trim();
    var person = kind === 'loan' || kind === 'due' ? cleanPerson(payload.person) : '';
    if (MONEY_DIRS[kind].indexOf(payload.dir) === -1 || !amount || !tag ||
        tag.length > MONEY_TAG_MAX || ((kind === 'loan' || kind === 'due') && !person)) {
      var badMoney = new Error('bad_money');
      badMoney.fatal = true;
      throw badMoney;
    }
    var pressed = typeof payload.at === 'string' && !isNaN(Date.parse(payload.at));
    var moneyRow = {
      rid: payload.rid,
      at: pressed ? payload.at : new Date().toISOString(),
      local_time: pressed ? (payload.local_time || '') : humanLocal(),
      tz: deviceTz(),
      dir: payload.dir,
      amount: amount,
      currency: 'PKR',
      tag: tag,
      note: String(payload.note || '').trim().slice(0, MONEY_NOTE_MAX),
      voids_rid: payload.voids_rid || null
    };
    // Cash names no kind or person, so it still saves before those columns exist.
    if (kind !== 'cash') moneyRow.kind = kind;
    if (person) moneyRow.person = person;
    var ins = await sb.from('money').insert(moneyRow);
    // 23505: this rid, or a void of this row, is already in. Success either way.
    if (ins.error && ins.error.code !== '23505') throw errorFrom(ins.error);
    return { ok: true, duplicate: Boolean(ins.error) };
  }

  if (action === 'review') return { ok: true, stub: true, text: 'Review arrives in Stage 5.' };
  /* DEAD ON PURPOSE, and not a Stage 4 gap. The plan's step 2 was a one-line
   * "what am I doing right now", written by a model after every log. The two
   * state pills under the logo replaced it: they say the same thing, they are
   * computed from the rows rather than asserted by an LLM, and they cannot go
   * stale. Nothing in the app calls these two. Deleting them is a separate job. */
  if (action === 'now_get' || action === 'now_set') return { ok: true, now: { text: '', updated: '' } };

  var unknown = new Error('unknown_action');
  unknown.fatal = true;
  throw unknown;
}

/**
 * Every row between two instants, oldest first — the `today` read widened to a
 * date range, and the only new read Stage 5 needs.
 *
 * NOT AN ACTION, and not through api(): this is one Postgres select that
 * nobody is mid-tap behind, so it has no need of the serialised queue.
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

  /* `lte` can pick up a row stamped exactly at the closing rollover, which
   * belongs to the next day. Harmless: the day windows below drop it, because
   * a day is [rollover, next rollover) — closed at the start, open at the end,
   * so no instant can land in two days or in none. */
  var rows = res.data || [];

  /* A prayer's day turns at Fajr, FAJR_MARGIN_MIN after the rollover: an Isha
   * logged in those minutes belongs to the last day read, so read them too.
   * prayerDays() places them; everything else counts by window and skips them. */
  var endMs = Date.parse(endIso);
  var tail = await sb.from('events').select('*').eq('type', 'prayer')
    .gte('at', new Date(endMs + 1).toISOString())
    .lt('at', new Date(endMs + FAJR_MARGIN_MIN * 60000).toISOString())
    .order('at', { ascending: true }).limit(100);
  if (tail.error) throw errorFrom(tail.error);
  return rows.concat(tail.data || []).map(sbRow);
}

/**
 * Money rows between two instants, for the Review card and the reports. Like
 * rangeEvents, one direct select. Voids pressed after `endIso` are read too:
 * voiding yesterday's mistake today must still take it out of yesterday.
 */
// Every column, so kind and person (Stage 13b) are read without the read
// failing on a database that does not have them yet.
var MONEY_COLS = '*';

async function rangeMoney(startIso, endIso) {
  if (!sb || !sbUser) throw new Error('Sign in to read your money.');
  var res = await sb.from('money').select(MONEY_COLS)
    .gte('at', startIso).lt('at', endIso)
    .order('at', { ascending: true }).limit(5000);
  if (res.error) throw errorFrom(res.error);
  var later = await sb.from('money').select(MONEY_COLS)
    .gte('at', endIso).not('voids_rid', 'is', null).limit(5000);
  if (later.error) throw errorFrom(later.error);
  return (res.data || []).concat(later.data || []);
}

/** The instants a run of day windows opens and closes at, for a read. */
function windowsStartIso(windows) { return new Date(windows[0].startMs).toISOString(); }
function windowsEndIso(windows) { return new Date(windows[windows.length - 1].endMs).toISOString(); }

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

/* One request at a time, through a promise chain, and only reads are retried.
 * Every write still carries a `rid`, fixed in api() so any retry reuses it: the
 * unique index on (user_id, rid) makes a repeat a no-op, and `label` uses the
 * rid to find its row. */

var IDEMPOTENT = { ping: 1, today: 1, now_get: 1, review: 1 };
var MAX_TRIES = 3;
var RETRY_DELAY_MS = 500;
var STALL_RETRY_MS = 15000;
var apiChain = Promise.resolve();

/** Enough entropy that two devices cannot collide on the (user_id, rid) index. */
function newRid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function attemptCall(action, payload, opts) {
  var last;
  var tries = IDEMPOTENT[action] ? MAX_TRIES : 1;
  if (opts && opts.tries) tries = Math.min(tries, opts.tries);

  for (var i = 0; i < tries; i++) {
    /* A stalled network is treated like an offline one: fail at once, except one
     * real try every STALL_RETRY_MS to see if answers are back. Otherwise each
     * queued call spends 12 s and a press behind them waits for all of them. */
    if (netStalled && monoNow() - stalledAt < STALL_RETRY_MS) {
      throw new Error('No answer from the server — trying again shortly.');
    }
    try {
      return await callSupabase(action, payload);
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
  var write = !IDEMPOTENT[action];

  /* One rid per logical write, fixed before the first attempt so every retry
   * carries the same one — and ONE INSTANT with it. `at` is when the button was
   * pressed; a write sent an hour later off the outbox still lands at the time
   * it happened, which is the whole of Stage 7c. Reads need neither. */
  if (write) {
    payload = Object.assign({
      rid: newRid(), at: new Date().toISOString(), local_time: humanLocal()
    }, payload || {});
  }

  var canQueue = write && canOutbox(action);

  if (!isConfigured()) {
    /* WHERE EVERY OFFLINE PRESS USED TO DIE. An app opened with no signal cannot
     * refresh an expired token, so there is no user, so this rejected before a
     * rid existed and no queue could ever have seen the press. Now it is kept,
     * filed under the last account that was signed in here. */
    if (canQueue) {
      var held = queueWrite(action, payload);
      if (held) return Promise.resolve(held);
    }
    return Promise.reject(new Error(
      cfg.supaUrl && cfg.supaKey ? 'Sign in to keep logging.' : 'Not configured — open Settings.'));
  }

  /* THE PRESS IS SECURED BEFORE IT GOES ANYWHERE NEAR THE NETWORK.
   *
   * This used to queue the write from the FAILURE, inside attempt() — which
   * looks equivalent and is not, because attempt() only runs once the serialised
   * chain reaches it. Measured, with a real session and the radio off: one
   * `today` read takes 7 seconds to fail, because supabase-js retries six times
   * inside itself before admitting it, and this file then retries a read three
   * times. So the chain is busy for twenty seconds or more, every press made in
   * that window is still sitting in a promise that has not been called, and a
   * reload throws it away. Not in the table, not in the outbox, nothing said.
   * That is the bug Saad hit on 23 Sep: press an entry, then M, reload, and the
   * M is simply gone. Which press is lost is a race, which is why the order
   * seemed to matter.
   *
   * So the write goes on the device first, marked as being sent — stored, so a
   * reload cannot lose it, but not counted as "waiting" and saying nothing,
   * because nothing is wrong yet. Then it is dropped again the moment the table
   * takes it. A duplicate is impossible either way: the rid is fixed above and
   * the unique index makes a repeat a no-op. */
  var secured = canQueue && holdWrite(action, payload);

  function attempt() {
    return trackedCall(action, payload, opts).then(function (res) {
      if (secured) dropItem(payload.rid);      // the table has it; nothing to keep
      return res;
    }, function (err) {
      if (secured) {
        /* A refusal the database really made will be refused again: park it,
         * as the drain does, so Settings still names it once the banner is gone.
         * The screen rolls back as before. Anything else is the network. */
        if (err && err.fatal) throw parkRefused({ rid: payload.rid, action: action, payload: payload }, err);
        return nowWaiting(action, payload);
      }
      // The hold could not be stored at all (a full disk). Try once more here,
      // which is where this used to live.
      if (canQueue && !(err && err.fatal)) {
        var q = queueWrite(action, payload);
        if (q) return q;
      }
      throw err;
    });
  }

  var run = apiChain.then(attempt, attempt);   // a failure must not wedge the queue
  apiChain = run.then(function () {}, function () {});
  return run;
}

// ------------------------------------------------------------------- outbox

/* Stage 7c. Press M with no signal and the press is KEPT ON THIS DEVICE, then
 * sent when the signal comes back — carrying the time it was pressed, never the
 * time it was finally sent.
 *
 * WHY RETRYING IS SAFE HERE when rule 0 says never retry a write: every write
 * already carries a `rid`, and a unique index on (user_id, rid) turns a repeat
 * into a no-op. The database says 23505 and sbInsert reads that as success. Two
 * tabs draining the same queue therefore write one row each, not two.
 *
 * localStorage, not Background Sync: a service worker cannot see the sign-in, so
 * it could not send anything as this user. The cost is that the queue only
 * drains while the app is open — the glance and the widget lag until then, and
 * that is said plainly on screen rather than hidden.
 *
 * Nothing here caches a READ. Rule 3 still stands: the outbox holds only presses
 * this device made and has not managed to send.
 */

var OUTBOX_KEY = 'probeing.outbox';
var PARKED_KEY = 'probeing.outbox.parked';
var LAST_USER_KEY = 'probeing.lastuser';
var SIGNED_OUT_KEY = 'probeing.signedout';
var OUTBOX_MAX = 500;
var PARKED_MAX = 50;

/* The writes a person makes. `label` is deliberately absent: it only ever
 * fills in a project name on a row, and a name that never arrives leaves the
 * entry called by its own sentence — which is what it was called anyway. */
var QUEUEABLE = { log: 1, m: 1, prayer: 1, money: 1, loan: 1, due: 1, wallet: 1, file: 1, mark: 1, item: 1 };

function trimUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

/** The account this device belongs to — the signed-in one, or the last one that
 *  was, which is all an offline launch has to go on. */
function currentUserId() {
  if (sbUser && sbUser.id) return sbUser.id;
  try { return localStorage.getItem(LAST_USER_KEY) || ''; } catch (e) { return ''; }
}

function rememberUser(id) {
  try { localStorage.setItem(LAST_USER_KEY, String(id || '')); } catch (e) { /* full disk */ }
}

/** Can this write be kept at all? Only if we know whose it is and where it goes. */
function canOutbox(action) {
  return QUEUEABLE[action] === 1 && Boolean(currentUserId()) &&
         Boolean(cfg.supaUrl) && Boolean(cfg.supaKey);
}

/* Parsed only when the stored text has changed, and read from localStorage every
 * single time. TWO TABS SHARE ONE QUEUE: a cached array is exactly how the second
 * tab resurrects an item the first one has already sent. */
var outboxRaw = null;
var outboxList = [];

function storedList(raw) {
  var v;
  try { v = JSON.parse(raw); } catch (e) { return []; }
  return Array.isArray(v) ? v : [];
}

/* ANY action is kept, including one this version does not know: a newer app on
 * this device may have queued it, and filtering it out here deletes it the next
 * time this page saves the list. Unknown actions are held, never sent (R8). */
function sensibleItem(it) {
  return Boolean(it) && typeof it === 'object' && typeof it.action === 'string' &&
         Boolean(it.action) && Boolean(it.payload) && typeof it.payload === 'object' &&
         Boolean(it.rid);
}

/** Can this version send it? */
function knownAction(it) { return QUEUEABLE[it.action] === 1; }

function outboxAll() {
  var raw = '';
  try { raw = localStorage.getItem(OUTBOX_KEY) || ''; } catch (e) { raw = ''; }
  if (raw !== outboxRaw) {
    outboxRaw = raw;
    outboxList = storedList(raw).filter(sensibleItem);
  }
  return outboxList;
}

/**
 * Write the queue back. False means it could not be stored, and the caller must
 * report a failure rather than claim the press was kept.
 *
 * NOTHING IS EVER DROPPED QUIETLY. The cap used to be a `slice`, which reported
 * the 501st press as saved and made the first one vanish — silent data loss, in
 * the one part of the app built to prevent exactly that. An overflowing item is
 * moved into the same "could not save" list a refusal goes to, where it is named
 * in Settings and can be cleared on purpose. It takes about two weeks with no
 * signal to reach, so the cost of saying so is nothing.
 */
function saveOutbox(list) {
  if (list.length > OUTBOX_MAX) {
    var spill = list.slice(0, list.length - OUTBOX_MAX);
    list = list.slice(list.length - OUTBOX_MAX);
    spill.forEach(function (it) {
      addParked(it, 'this device can only hold ' + OUTBOX_MAX + ' unsent entries');
    });
    flash(spill.length + (spill.length === 1 ? ' old unsent entry' : ' old unsent entries') +
      ' could not be kept — see Settings.', 'err');
  }
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
  } catch (e) {
    return false;
  }
  outboxRaw = null;                         // force the next read to re-parse
  return true;
}

/** Items for this account and this Supabase project. Anything else is HELD:
 *  another account's entry must never be written into this one, and another
 *  project's must never be sent to a database it was not made for. */
function ourItem(it) {
  return Boolean(it.user) && it.user === currentUserId() &&
         it.url === trimUrl(cfg.supaUrl);
}

/** This account's items, whether or not this version can send them. */
function outboxMine() { return outboxAll().filter(ourItem); }

function outboxOurs() { return outboxMine().filter(knownAction); }

function outboxHeld() {
  return outboxAll().filter(function (it) { return !ourItem(it) || !knownAction(it); });
}

/** Ours, but saved by a newer version of the app: held until that version runs. */
function outboxNewer() {
  return outboxMine().filter(function (it) { return !knownAction(it); });
}

/* `sending` marks a write this page is attempting right now. It is on the device
 * so a reload cannot lose it, but it is NOT waiting: nothing has gone wrong yet,
 * and an amber count flickering on every ordinary tap would be noise. It is also
 * not something to drain — this page is already on it. */
function outboxWaiting() {
  return outboxOurs().filter(function (it) { return !it.sending; });
}

function outboxCount() { return outboxWaiting().length; }

function queuedReply(action, payload) {
  return { ok: true, queued: true, rid: payload.rid, type: payload.type || '' };
}

/* One banner per offline spell, not one per tap. Cleared the moment a call
 * succeeds again, which is what makes it "per spell". */
var offlineTold = false;

/** Put a write on the device. `sending` is true while this page is attempting
 *  it — see outboxWaiting(). False means it could not be stored at all. */
function putOutbox(action, payload, sending) {
  var list = outboxAll().slice();

  // The same logical write can come through twice (a retry, a second drain).
  // It carries the same rid, so it is the same item, not a second one.
  if (list.some(function (it) { return it.rid === payload.rid; })) return true;

  var item = {
    rid: payload.rid,
    action: action,
    payload: payload,
    user: currentUserId(),
    url: trimUrl(cfg.supaUrl),
    queuedAt: Date.now()
  };
  if (sending) item.sending = true;
  list.push(item);
  return saveOutbox(list);
}

/** Say it once per offline spell, and repaint everything that shows a count. */
function tellWaiting() {
  if (!offlineTold) {
    offlineTold = true;
    flash('Saved on this device — it will send itself when you are back online.', 'warn');
  }
  paintConn();
  paintOutboxNote();
  paintTodayNote();
  paintGlance();                  // the shade counts what this device is holding
}

/** Hold a write on the device for the length of the attempt. Silent: nothing has
 *  gone wrong yet, and this runs on every press, online or not. */
function holdWrite(action, payload) {
  return putOutbox(action, payload, true);
}

/**
 * Keep a write on this device, and say so. Returns what api() should resolve
 * with, or null if it could not be stored at all.
 */
function queueWrite(action, payload) {
  if (!putOutbox(action, payload, false)) return null;
  tellWaiting();
  return queuedReply(action, payload);
}

/** The attempt failed for the network: it is not in flight any more, it is
 *  waiting — and that is the moment to say so. */
function nowWaiting(action, payload) {
  var changed = false;
  var list = outboxAll().map(function (it) {
    if (it.rid !== payload.rid || !it.sending) return it;
    changed = true;
    var copy = {};
    Object.keys(it).forEach(function (k) { if (k !== 'sending') copy[k] = it[k]; });
    return copy;
  });
  if (changed) saveOutbox(list);
  tellWaiting();
  return queuedReply(action, payload);
}

/** `sending` belongs to the page that set it. A reload means nobody is sending
 *  anything, so whatever is still marked is simply waiting — and must be, or it
 *  would sit in the outbox for ever, counted by nothing and drained by nothing. */
function clearStaleSending() {
  var list = outboxAll();
  if (!list.some(function (it) { return it.sending; })) return;
  saveOutbox(list.map(function (it) {
    if (!it.sending) return it;
    var copy = {};
    Object.keys(it).forEach(function (k) { if (k !== 'sending') copy[k] = it[k]; });
    return copy;
  }));
}

function dropItem(rid) {
  saveOutbox(outboxAll().filter(function (it) { return it.rid !== rid; }));
}

/* Rows the database itself refused — a bad prayer name, an empty entry. They
 * will be refused again, so they are parked out of the way rather than retried
 * for ever, and said out loud in Settings so nothing disappears quietly. */
function parkedAll() {
  var raw = '';
  try { raw = localStorage.getItem(PARKED_KEY) || ''; } catch (e) { raw = ''; }
  return storedList(raw);
}

/** Move an item onto the parked list, and return how it is named there. Touches
 *  the outbox not at all — saveOutbox calls this while it is mid-write, and the
 *  two must not chase each other. */
function addParked(it, why) {
  var row = queuedRow(it) || {};
  var list = parkedAll();
  var what = moneyItem(it) ? moneyWhat(queuedMoney(it))
           : it.action === 'file' ? 'Filing "' + String((it.payload || {}).raw_text || '') + '"'
           : it.action === 'mark' || it.action === 'item' ? itemWhat(it)
           : String(row.raw_text || row.type || it.action);
  list.push({
    rid: it.rid,
    at: (it.payload || {}).at || '',
    what: what,
    why: String(why || 'refused')
  });
  try {
    localStorage.setItem(PARKED_KEY, JSON.stringify(list.slice(-PARKED_MAX)));
  } catch (e) { /* nothing more we can do about it */ }
  return what;
}

function parkItem(it, err) {
  var what = addParked(it, (err && err.message) || 'refused');
  dropItem(it.rid);
  return what;
}

/** Park a press refused on its first send; the error to show, in plain words. */
function parkRefused(it, err) {
  var what = parkItem(it, err);
  paintOutboxNote();
  var told = new Error('Could not save "' + what + '": the database refused it. ' +
                       'It is listed in Settings with the reason.');
  told.fatal = true;
  return told;
}

function forgetParked() {
  try { localStorage.removeItem(PARKED_KEY); } catch (e) { /* already gone */ }
}

/** Take `rid` off the parked list: a fixed-rid press (a direct Done) made again. */
function unpark(rid) {
  var list = parkedAll();
  var kept = list.filter(function (x) { return !x || x.rid !== rid; });
  if (kept.length === list.length) return;
  try { localStorage.setItem(PARKED_KEY, JSON.stringify(kept)); } catch (e) { /* stays parked */ }
}

// ------------------------------------------- what a queued write looks like

/** A queued write as a log row, so the Today screen can count it exactly like a
 *  row that has landed. Prayers are drawn from their own list, hence the null. */
function queuedRow(it) {
  var p = it.payload || {};
  // Only log and M are log rows. Money has queuedMoney(); an unknown action, none.
  if (it.action !== 'log' && it.action !== 'm') return null;
  if (it.action === 'm') {
    return { at: p.at, local: p.local_time || '', type: 'M',
             raw_text: '', project: '', detail: '', rid: it.rid };
  }
  var row = { at: p.at, local: p.local_time || '', type: p.type || 'work',
              raw_text: p.raw_text || '', project: p.project || '',
              detail: p.detail || '', rid: it.rid };
  if (p.node_id) row.node_id = p.node_id;
  return row;
}

/* Each write that becomes a `money` row, and the kind it is stored as. */
var MONEY_KIND_OF = { money: 'cash', loan: 'loan', due: 'due', wallet: 'opening' };
var MONEY_ACTION_OF = { cash: 'money', loan: 'loan', due: 'due', opening: 'wallet' };
// The dirs each kind may carry, as money_dir_check has them.
var MONEY_DIRS = { cash: ['in', 'out'], loan: ['in', 'out'], due: ['they_owe', 'i_owe'], opening: ['set'] };

/** The action that writes a row of this kind, or '' for a kind this version does not know. */
function moneyActionOf(kind) {
  return Object.prototype.hasOwnProperty.call(MONEY_ACTION_OF, kind) ? MONEY_ACTION_OF[kind] : '';
}

/** A write that becomes a `money` row: cash, a loan (13b), a due or the wallet (Money 2). */
function moneyItem(it) {
  return Object.prototype.hasOwnProperty.call(MONEY_KIND_OF, it.action);
}

/** A queued money write as a `money` row, for the Money screen and its figures. */
function queuedMoney(it) {
  var p = it.payload || {};
  var row = { rid: it.rid, at: p.at, local_time: p.local_time || '', dir: p.dir,
              amount: p.amount, tag: p.tag || '', note: p.note || '',
              voids_rid: p.voids_rid || null, queued: true };
  var kind = MONEY_KIND_OF[it.action];
  if (kind !== 'cash') row.kind = kind;
  if (kind === 'loan' || kind === 'due') row.person = cleanPerson(p.person);
  return row;
}

function queuedPrayer(it) {
  var p = it.payload || {};
  return { at: p.at, local: p.local_time || '', rid: it.rid,
           prayer: p.prayer || '', mode: p.mode || '' };
}

/** Held marks and hand-added items (14b), as the rows they will become, so a
 *  press shows at once and survives a reload. `have`: rids the read returned. */
function queuedMarks(have) {
  return outboxOurs().filter(function (it) {
    return it.action === 'mark' && !(have && have[it.rid]);
  }).map(markOf);
}

function queuedItems(have) {
  return outboxOurs().filter(function (it) {
    return it.action === 'item' && !(have && have[it.rid]);
  }).map(itemOf);
}

function markOf(it) {
  var p = it.payload || {};
  return { rid: it.rid, item_rid: p.item_rid, mark: p.mark, at: p.at, queued: true };
}

function itemOf(it) {
  var p = it.payload || {};
  return { rid: it.rid, node_id: p.node_id, title: cleanItemTitle(p.title), made_by: 'hand',
           at: p.at, queued: true };
}

/** How a held mark or item is named in Settings. */
function itemWhat(it) {
  var p = it.payload || {};
  var verb = it.action === 'item' ? 'New item' : ITEM_VERBS[p.mark] || 'Mark';
  return verb + ' "' + String(p.title || '') + '"';
}

/** The counter day a queued press belongs to — the day it was PRESSED. An M
 *  pressed before the rollover and sent after it is yesterday's M, and must
 *  never be added to today. */
function queuedDay(it) {
  var t = instantOf((it.payload || {}).at);
  return isNaN(t) ? '' : counterDate(t);
}

function queuedToday() {
  var today = counterDate(Date.now());
  return outboxOurs().filter(function (it) { return queuedDay(it) === today; });
}

/** Queued presses from before `beforeMs` (the rollover), as rows, for the
 *  lead-in: a Work pressed at 04:20 and still waiting at 04:40 is part of the
 *  session. sessionLead() keeps only the ones that belong to it. */
function queuedRowsBefore(beforeMs, have) {
  return outboxOurs().map(queuedRow).filter(function (r) {
    var t = r ? instantOf(r.at) : NaN;
    return r && !isNaN(t) && t < beforeMs && !(have && have[r.rid]);
  });
}

/** `have` is a map of rids the table has already returned, so a row is not
 *  counted twice in the moment between a drain and the next read. */
function queuedRowsToday(have) {
  return queuedToday().map(queuedRow).filter(function (r) {
    return r && !(have && have[r.rid]);
  });
}

/** Held prayer presses of the current PRAYER day (prayerDate), not the counter day. */
function queuedPrayersToday(have) {
  var today = prayerDate(Date.now());
  var held = outboxOurs().filter(function (it) { return it.action === 'prayer'; }).map(queuedPrayer);
  return prayersOn(held, today).filter(function (p) { return !(have && have[p.rid]); });
}

/** Every local date with something still waiting, any day — what the report gate
 *  asks about. Items from a newer version count too: they are real and unsent.
 *  A void also holds the day of the row it cancels. */
function queuedDates() {
  var seen = userMap();
  outboxMine().forEach(function (it) {
    var d = queuedDay(it);
    if (d) seen[d] = 1;
    var voidsAt = instantOf((it.payload || {}).voids_at);
    if (moneyItem(it) && !isNaN(voidsAt)) seen[counterDate(voidsAt)] = 1;
    // Filing renames an entry, so it holds that entry's day too.
    var entryAt = instantOf((it.payload || {}).entry_at);
    if (it.action === 'file' && !isNaN(entryAt)) seen[counterDate(entryAt)] = 1;
  });
  return Object.keys(seen);
}

// ---------------------------------------------------------------- draining

/* Oldest first, one at a time, through the same serialised chain every other
 * call uses — so a drain can never race a tap. */
var draining = false;
var lastDrainAt = -Infinity;      // monoNow(), so a wall-clock step cannot pause the drain
var DRAIN_RETRY_MS = 15000;

function sendQueued(it) {
  function go() { return trackedCall(it.action, it.payload, { tries: 1 }); }
  var run = apiChain.then(go, go);
  apiChain = run.then(function () {}, function () {});
  return run;
}

/**
 * Send what is waiting. Never throws; a spell with no signal simply stops and
 * leaves the rest for the next trigger.
 *
 * `why` is only used to tell the browser's own `online` event apart from the
 * polls: everything else stands down while navigator.onLine says there is no
 * network, because a failed fetch every few seconds helps nobody.
 */
async function drainOutbox(why) {
  lastDrainAt = monoNow();
  if (draining || !supabaseReady()) return;
  if (why !== 'online' && navigator.onLine === false) return;

  var list = outboxWaiting();              // never a write this page is mid-way through
  if (!list.length) return;

  draining = true;
  var sent = 0;
  var parked = 0;
  var landed = [];                         // entries that still have no name
  try {
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      // Signing out (or switching project) mid-drain must stop it there.
      if (!supabaseReady() || !ourItem(it)) break;
      try {
        await sendQueued(it);
      } catch (err) {
        if (err && err.fatal) { parkItem(it, err); parked += 1; continue; }
        break;                              // still no signal: keep the rest
      }
      dropItem(it.rid);
      sent += 1;
      if (labellable(it)) landed.push(it);
    }
  } finally {
    draining = false;
    lastDrainAt = monoNow();
  }

  paintConn();
  paintOutboxNote();
  paintTodayNote();
  if (parked) {
    flash(parked + (parked === 1 ? ' entry could not be saved' : ' entries could not be saved') +
      ' — see Settings.', 'err');
  }
  if (sent) {
    flash(sent + (sent === 1 ? ' offline entry sent' : ' offline entries sent'), 'ok');
    refresh();                              // the table has them now; re-read once
    if (currentScreen === 'money') readMoney();
    scheduleFiling();                       // a filed entry leaves the tray
    scheduleItems();                        // and the items, which the other device may have closed
  }
  // Deliberately not awaited: the rows are safe in the table and only the name
  // is outstanding, so nothing above waits on a language model. With Google
  // connected the server names them as they land (Stage 14a).
  if (landed.length && !serverFiles()) labelLanded(landed);
}

/* NAMING WHAT ARRIVES LATE.
 *
 * An entry typed with no signal never got a project name, and nothing ever went
 * back for it: offline there is no row to label — `label` finds its row by rid,
 * and the row is not in the table yet — so the whole sentence stood as the tile
 * heading for ever, sub-tasks and all. Measured 23 Sep: two entries the same
 * afternoon, the online one named "tail skill", the offline one still carrying
 * its first sentence. The fix is to do it when the queued write lands, through
 * the same extractProject()/applyLabel() pair the tracker uses.
 */

/** A landed write that would have been named had there been a signal: a typed
 *  entry, with words in it, not yet carrying a project. Never an M, a prayer or
 *  a state row — none of those has anything to name. */
function labellable(it) {
  var p = it.payload || {};
  return it.action === 'log' && (p.type === 'work' || p.type === 'voice') &&
         !String(p.project || '').trim() && Boolean(String(p.raw_text || '').trim());
}

/** Name them oldest first, one at a time, so each entry's prompt can see the
 *  names the ones before it earned. Never rejects: one entry that cannot be
 *  named must not stop the entry behind it, and nothing awaits this.
 *
 *  Every sentence in the batch is held for the whole run, not only the one being
 *  named: an unnamed arrival is an open project keyed on its sentence, and the
 *  prompt would offer it to the model as a name already in use. */
function labelLanded(items) {
  var texts = items.map(function (it) { return String((it.payload || {}).raw_text || ''); });
  texts.forEach(holdName);
  return items.reduce(function (chain, it) {
    function go() { return nameLanded(it); }
    return chain.then(go, go);
  }, Promise.resolve()).catch(function () { /* a name is decoration */ })
    .then(function () { texts.forEach(releaseName); });
}

function nameLanded(it) {
  var p = it.payload || {};
  var text = String(p.raw_text || '');

  /* Both checks BEFORE the call rather than after it. Gemini's day is 18 calls
   * and one must not be spent on a name that cannot be used: applyLabel refuses
   * a tile that is not open — a project already finished, or an entry from a day
   * that is over — and out of budget the entry simply keeps its own sentence,
   * which is exactly how an unlabelled entry has always looked. */
  if (!canAskGemini() || !isOpenProject(text)) return Promise.resolve();

  /* Held BEFORE the prompt is built, and that order is the whole point here: this
   * row IS in today's rows now, keyed on its own sentence because it has no
   * project yet, so an unheld sentence would be handed to the model as a project
   * name it is welcome to reuse. */
  holdName(text);
  var known = promptNames(openProjects());

  return new Promise(function (resolve) {
    function done() { releaseName(text); resolve(); }
    extractProject(text, known).then(function (got) {
      // Nothing understood, and nothing to say about it: the row is saved and
      // unnamed, which is a state the screen already draws.
      if (!got || !got.project) { done(); return; }
      applyLabel(p.rid, text, rowByRid(p.rid) || {}, got, done);
    }, function () { done(); });
  });
}

/** The row on screen with this rid, so a name that lands can show at once
 *  instead of waiting for the next read. */
function rowByRid(rid) {
  var hit = sessionLog().filter(function (r) { return r.rid && r.rid === rid; });
  return hit.length ? hit[0] : null;
}

/** Get the session back after a spell offline. getSession() refreshes an expired
 *  token, which needs the network — so a launch with no signal leaves nobody
 *  signed in until this runs. */
function retrySession() {
  if (!sb || sbUser || navigator.onLine === false) return;
  sb.auth.getSession().then(function (res) {
    adoptSession(res && res.data ? res.data.session : null);
  }, function () { /* still no network */ });
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
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'money' },
        function () { if (currentScreen === 'money') scheduleMoneyRead(400); })
    .subscribe();
}

function stopLive() {
  stopGoogle();
  if (!liveChannel) return;
  try { sb.removeChannel(liveChannel); } catch (e) { /* already gone */ }
  liveChannel = null;
}

// ------------------------------------------------------------------ helpers

var $ = function (id) { return document.getElementById(id); };
var bannerTimer;

/* The dot beside the cog. Green = the last call to the server worked, red = it
 * did not, amber = one is in flight. Small on purpose: a status light, not an
 * alarm. It is the honest answer to "is it just slow, or is it broken?"
 *
 * A fourth state, and it outranks the other three: anything waiting on this
 * device shows amber with a count beside it. Red would be a lie there — the
 * press is not lost, it is held — and green would be a bigger one. */
var connState = '';
var CONN_TITLES = {
  ok: 'Connected — saved to the server',
  bad: 'Not reaching the server. Tap the cog to check Settings.',
  busy: 'Talking to the server…'
};

function setConn(state) {
  // A call that worked ends the offline spell, so the next one may speak again.
  if (state === 'ok') offlineTold = false;
  connState = state;
  paintConn();
}

/** Repaint the dot. Cheap, and it has to run even when the state has not moved,
 *  because the count can change without it. */
function paintConn() {
  var n = outboxCount();
  var waiting = n + ' waiting — saved on this device, sends when online';
  var el = $('connDot');
  if (el) {
    el.className = 'dot ' + (n ? 'wait' : connState);
    el.title = n ? waiting : (CONN_TITLES[connState] || 'Not connected');
  }
  var label = $('connWait');
  if (label) {
    label.textContent = n ? n + ' waiting' : '';
    label.title = waiting;
    label.hidden = !n;
  }
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

/** A row's time on this device's clock, "14:05". Postgres sends UTC, so the
 *  digits in `at` are not the local time. Falls back to the readable stamp. */
function clockOf(entry) {
  var t = instantOf(entry.at || '');
  if (isFinite(t)) {
    var d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  var h = /(\d{1,2}:\d{2}\s*[AaPp][Mm])/.exec(entry.local || '');
  return h ? h[1] : '';
}

// instantOf() and humanDuration() live in day.js.

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
  if (name === 'money') openMoney();
  if (name === 'tasks') openTasksPage();
}

/* Only tabs that name a screen switch screens. Every tab does since the
 * taskboard link moved to Settings (Stage 11); the guard stays so a link-style
 * tab can never call showScreen(undefined) and hide every screen. */
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
function noteLocalRow(type, text, project, detail, nodeId) {
  var row = {
    at: localIso(), local: '', type: type,
    raw_text: text || '', project: project || '', detail: detail || ''
  };
  if (nodeId) row.node_id = nodeId;
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
 * Under the old backend the two devices could not tell each other anything:
 * it only spoke when spoken to. So the app asks, on a timer, whenever it is on
 * screen. That closes the "nothing changes until I refresh" gap to about a minute.
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
 * A lost reply can mean the row DID land and only the answer was lost.
 * Reporting the failure and then leaving the screen alone is the worst of
 * both worlds: it shows a number the server contradicts, and the natural
 * response is to tap again — creating by hand exactly the duplicate that not
 * retrying was meant to prevent. So the server gets the last word, quickly.
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
 * It resolves with true only if every step landed, 'queued' if any of them is
 * waiting on this device, false if one really failed. Nothing has to look — the
 * failure is already reported and reconciled here — but the tracker does, because
 * asking the database to label a row that was never written is a wasted call
 * against a backend this app is careful not to talk to twice.
 *
 * A QUEUED WRITE IS NOT A FAILURE. No undo, no red banner, and the screen keeps
 * what the tap put there: the row is on this device with the time it was
 * pressed, and will be in the table shortly.
 */
function runWrites(steps, undo) {
  var chain = Promise.resolve();
  var queued = false;
  steps.forEach(function (step) {
    chain = chain.then(function () {
      return api('log', step).then(function (res) {
        if (res && res.queued) queued = true;
      });
    });
  });
  return chain.then(function () {
    return queued ? 'queued' : true;
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
var lastLead = [];       // the session's rows from before the rollover: replayed, never counted
var todayPrayers = [];   // today's prayer rows; drives the ticks and the picker
var lastReadAt = 0;      // when a read of today last landed; 0 = none this visit
var dayUnread = false;   // could not read today at all — say so, never imply zero

/** Today's rows plus the lead-in, newest first — what every replay of the work
 *  session reads. Counts (M, prayers, the list, chip learning) read lastLog. */
function sessionLog() {
  return lastLog.concat(lastLead);
}

/** Rows with their tasks' current titles from the mirror (day.js namedRows), for
 *  what is drawn. Filing and naming keep reading the rows as stored. */
function named(rows) {
  return namedRows(rows, taskNodes);
}

/** The lead-in: the read's, plus presses still queued from before the rollover. */
function leadWithQueue(lead, have) {
  var start = counterDayStart(Date.now());
  return sessionLead((lead || []).concat(queuedRowsBefore(start, have)), start);
}

function renderToday(data) {
  lastReadAt = Date.now();
  dayUnread = false;

  /* EVERY RE-READ PUTS THE QUEUE BACK. Without this the read replaces the
   * screen's rows with the table's, and an offline M vanishes from the count,
   * the ticks and the list until it is sent — which reads as losing it.
   * Anything the table has already returned is dropped from the merge by its
   * rid, for the moment between a drain and the read that follows it. */
  var have = userMap();
  (data.log || []).forEach(function (r) { if (r.rid) have[r.rid] = 1; });
  (data.prayers || []).forEach(function (p) { if (p.rid) have[p.rid] = 1; });
  (data.lead || []).forEach(function (r) { if (r.rid) have[r.rid] = 1; });

  lastLog = (data.log || []).concat(queuedRowsToday(have));
  lastLead = leadWithQueue(data.lead, have);
  $('mCount').textContent = lastLog.filter(function (r) {
    return r.type === 'M';
  }).length + ' today';

  // Today's rows are the shared truth between devices: they correct the toggles
  // and they teach the chip order. `carry` adds the last state row from before
  // today, so a day closed overnight is not missed.
  reconcileToggles(lastLog, data.carry);
  absorbChipStats(lastLog);
  renderProject();
  paintPlan();                        // a read after Fajr is the new day's plan too
  if (currentScreen === 'tasks') paintTasksPage();   // its Working on reads these rows

  /* The picker's checkmarks and the Home ticks are both driven by this, and the
   * queue goes back into it for the same reason it goes back into the rows
   * above — with one extra consequence that makes this the worse half to get
   * wrong. `loggedToday()` reads this list, so a queued prayer missing from it
   * turns off the "already logged today" warning, and the next tap writes a
   * SECOND real row under a different rid. The unique index cannot catch that
   * one: it is a genuinely new write, and the store is append-only. */
  todayPrayers = prayersOn(data.prayers, prayerDate(Date.now())).concat(queuedPrayersToday(have));
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
    // Offline this list cannot be the whole day, so it must not claim to be.
    showEmpty(dayUnread && !lastReadAt
      ? (navigator.onLine === false ? 'Offline' : 'Could not reach the server') +
        ' — nothing logged on this device yet today.'
      : 'No entries yet today.');
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
    var filed = filingNote(entry);
    if (filed) {
      var note = document.createElement('span');
      note.className = 'filing';
      note.textContent = filed;
      what.appendChild(note);
    }

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
    /* No session — offline, most likely, because a phone opens cold and an
     * expired token cannot be refreshed without a network. Show what this
     * device is holding rather than an empty day, and say the rest of today
     * cannot be read: rule 3 forbids caching the read, so the only alternative
     * would be a confident low number, which is worse than a missing one. */
    if (currentUserId() && cfg.supaUrl && cfg.supaKey) {
      markDayUnread();
      return;
    }
    showEmpty('Open Settings to connect.');
    return;
  }
  /* For the glance (Stage 7b). The time is taken BEFORE the read is sent, so the
   * "as of" it prints can only ever be earlier than what the rows really cover,
   * never later. The epoch is how a sign-out disowns a read already on its way. */
  var readAt = Date.now();
  var epoch = glanceEpoch;
  try {
    var data = await api('today', null, opts);
    renderToday(data);
    if (epoch === glanceEpoch) armGlance(data, readAt);
    drainOutbox('read');                  // a read that worked means the way is open
    if (opts && opts.announce) flash('Up to date', 'ok');
  } catch (err) {
    /* With no network a failed read is expected, not news. The amber dot and the
     * line under the card already say what is going on, and a red banner after
     * every tap would contradict "a queued write is not a failure". */
    /* Any failed read: say the figures may be out of date, never a confident
     * zero (rule 3). A timeout or stall is not news either; the note says it. */
    markDayUnread();
    if (navigator.onLine === false || netStalled) return;
    flash(String(err.message || err), 'err');
  }
}

/** Today could not be read. A read that landed earlier in this visit is still
 *  the best truth there is; only a visit with no read at all falls back to what
 *  this device is holding. The note under the card says which. */
function markDayUnread() {
  dayUnread = true;
  if (!lastReadAt) {
    lastLog = queuedRowsToday();
    lastLead = leadWithQueue([]);
    todayPrayers = queuedPrayersToday();
    $('mCount').textContent = lastLog.filter(function (r) {
      return r.type === 'M';
    }).length + ' today';
    renderPrayerTicks();
    renderProject();
    renderLogList();
  }
  renderDaySummary();
  paintConn();
}

// userMap() lives in day.js.

// -------------------------------------------------------- the current project

// replayDay() and dayFigures() live in day.js.

/**
 * The line under the Today card: what this device is holding, or why the figures
 * above are only part of the day. Empty and hidden when neither applies.
 *
 * It exists because the honest failure offline is a LOW number, not a missing
 * one — "0m worked" is a confident claim about a day nobody could read.
 */
function paintTodayNote() {
  var el = $('todayNote');
  if (!el) return;
  var n = outboxCount();
  var msg = '';

  // Offline, or online with a server that did not answer (a timeout, a stall).
  var why = navigator.onLine === false ? 'Offline'
                                       : 'Could not reach the server, so this may be out of date';
  if (dayUnread && !lastReadAt) {
    // Nothing was ever read this visit: the figures above are the queue alone.
    msg = why + ' — this is only what you logged on this device. The rest of today, ' +
          'and anything from your other device, appears when you reconnect.';
  } else if (dayUnread) {
    // A read landed earlier, so the figures are real but no longer current.
    msg = why + ' — the figures above are from the last time this device could read ' +
          'your rows' + (n ? ', plus what is waiting here' : '') + '. Anything logged ' +
          'on your other device since then is missing until you reconnect.';
  } else if (n) {
    msg = n + (n === 1 ? ' entry is' : ' entries are') + ' waiting to be sent. ' +
          'They are saved here with the time you pressed them, and counted above.';
  }

  el.textContent = msg;
  el.hidden = !msg;
}

/* The Today tab's header. Everything here is derived from the same rows the
 * list below shows — one source of truth, nothing stored, and it is right the
 * instant a row is written rather than after a round trip. */
function renderDaySummary() {
  paintTodayNote();
  // Hours and projects are the session's; M and prayers the counter day's.
  var figures = dayFigures(lastLog, todayPrayers, undefined, undefined, lastLead, taskTree());
  var day = figures.day;

  $('sumWorked').textContent = humanDuration(figures.worked);
  $('sumBreak').textContent = humanDuration(day.paused);
  $('sumPrayers').textContent = figures.prayersDone + '/5';
  $('sumM').textContent = figures.mCount;

  var box = $('sumProjects');
  box.textContent = '';

  var filing = filingKeys();

  /** One "name .... 1h 20m" line. `muted` marks it as a break, not work;
   *  `finished` ticks a project you have pressed Done on; `sub` indents a
   *  sub-task under its project. */
  function line(name, ms, muted, finished, sub) {
    var li = document.createElement('li');

    var n = document.createElement('span');
    n.className = 'p-name' + (muted ? ' p-why' : '') + (sub ? ' p-sub' : '');

    if (finished) {
      var tick = document.createElement('span');
      tick.className = 'p-done';
      tick.textContent = '✓';
      n.appendChild(tick);
    }

    // textContent on a text node, never markup — this is user input.
    n.appendChild(document.createTextNode(name));
    // Still its sentence because filing has not landed: said, so it is not read as a project.
    if (!muted && !sub && filing[name] === 1) {
      var f = document.createElement('span');
      f.className = 'p-filing';
      f.textContent = 'filing…';
      n.appendChild(f);
    }

    var t = document.createElement('span');
    t.className = 'p-time';
    t.textContent = humanDuration(ms);

    li.append(n, t);
    box.appendChild(li);
  }

  var byTime = function (map) {
    return function (a, b) { return map[b] - map[a]; };
  };

  /* The tick means Done was pressed. End day closes every project too (since
   * 29 Sep), so "not open" is no longer the test. */
  var open = userMap();                     // project names again — see userMap()
  day.activeProjects.forEach(function (p) { open[p] = 1; });
  var pressed = donePressed(named(sessionLog()));
  var subs = subtaskTimes(day);

  Object.keys(day.byProject)
    .filter(function (name) { return name && day.byProject[name] > 0; })
    .sort(byTime(day.byProject))
    .forEach(function (name) {
      line(name, day.byProject[name], false, !open[name] && pressed[name] === 1);
      (subs[name] || []).forEach(function (s) { line('▸ ' + s.title, s.ms, false, false, true); });
      delete subs[name];
    });
  // A sub-task whose project line is not here (an entry filed under its sentence).
  Object.keys(subs).forEach(function (name) {
    subs[name].forEach(function (s) { line('▸ ' + name + ' › ' + s.title, s.ms, false, false, true); });
  });

  // Where the break time actually went — Lunch 45m, Prayer-break 20m.
  if (day.unattributed > 0) line('Not on a named project', day.unattributed, true);

  Object.keys(day.byReason)
    .filter(function (why) { return why && day.byReason[why] > 0; })
    .sort(byTime(day.byReason))
    .forEach(function (why) { line(why, day.byReason[why], true); });
}

/** day.bySubtask by project name, as the tree names them now: {project:
 *  [{title, ms}]}, longest first. A task the tree does not know is left out, and
 *  so is a project with no sub-tasks (its own line already says it). */
function subtaskTimes(day) {
  var index = nodeIndex(taskNodes);
  var out = userMap();
  Object.keys(day.bySubtask || {}).forEach(function (id) {
    var ms = day.bySubtask[id];
    var names = nodeNames(index, id);
    if (!(ms > 0) || !names || !names.detail) return;
    var title = index.byId[id].gone_at ? names.detail + ' (deleted in Google)' : names.detail;
    (out[names.project] = out[names.project] || []).push({ title: title, ms: ms });
  });
  Object.keys(out).forEach(function (p) { out[p].sort(function (a, b) { return b.ms - a.ms; }); });
  return out;
}

/** Projects whose newest work/voice/done row is a Done press, keyed as
 *  replayDay() keys them. `rows` newest first. */
function donePressed(rows) {
  var out = userMap();
  var seen = userMap();
  (rows || []).forEach(function (row) {
    if (row.type !== 'work' && row.type !== 'voice' && row.type !== 'done') return;
    var name = String(row.project || row.raw_text || '').trim();
    if (!name || seen[name] === 1) return;
    seen[name] = 1;
    if (row.type === 'done') out[name] = 1;
  });
  return out;
}

// projectTasks() and TASK_SEP live in day.js, shared with the widget's list.

function renderProject() {
  var rows = named(sessionLog());
  var day = replayDay(rows);
  var list = $('projList');
  var empty = $('projEmpty');

  list.textContent = '';
  empty.hidden = day.activeProjects.length > 0;

  if (!day.activeProjects.length) {
    empty.textContent = day.worked
      ? 'Nothing open. ' + humanDuration(day.worked) + ' worked this session.'
      : 'Nothing yet — say what you are on below.';
    return;
  }

  // Sub-tasks finished by their own Done leave the list: "project\ntitle" -> 1.
  var finished = userMap();
  var index = nodeIndex(taskNodes);
  Object.keys(doneHere()).forEach(function (id) {
    var names = nodeNames(index, id);
    if (names && names.detail) finished[names.project + '\n' + names.detail.replace(/\s+/g, ' ').trim().toLowerCase()] = 1;
  });

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
    t.textContent = humanDuration(day.byProject[name] || 0) + ' this session' +
                    (day.running ? '' : ' · paused');

    main.append(n, t);

    /* The sub-tasks, under their heading. Every one is either the user's own
     * words or a model's reading of them, so textContent throughout. The one
     * being worked on is drawn below with its items instead (14b). */
    var sub = name === day.subtaskProject ? nodeIndex(taskNodes).byId[day.currentSubtask] : null;
    var subTitle = sub ? String(sub.title || '').trim() || '(untitled)' : '';
    var tasks = projectTasks(rows, name).filter(function (t) {
      return (!sub || sub.kind !== 'subtask' || !sameTitle(t, subTitle)) &&
             !finished[name + '\n' + t.replace(/\s+/g, ' ').trim().toLowerCase()];
    });
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
    if (sub) main.appendChild(currentSubtaskBlock(sub, subTitle));

    // "Stop", not "Done": it stops the clock on this; Done is for finished items (C1).
    var done = document.createElement('button');
    done.type = 'button';
    done.className = 'done-btn';
    done.textContent = 'Stop';
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
  // The project's task, when it has exactly one, so a rename in Google keeps it closed.
  var node = tileNode(name);
  var steps = storedNames(name).map(function (stored) {
    noteLocalRow('done', stored, stored, '', node);
    var row = { type: 'done', raw_text: stored, project: stored };
    if (node) row.node_id = node;
    return row;
  });
  runWrites(steps);
}

/** The names the rows behind the tile `name` were stored under, still open in a
 *  replay of the stored rows (as Review replays them). After a rename in Google
 *  the tile shows the new name; Stop must close the old one too. */
function storedNames(name) {
  var raw = sessionLog();
  var shown = named(raw);
  var open = replayDay(raw).activeProjects;
  var out = [];
  raw.forEach(function (r, i) {
    if (r.type !== 'work' && r.type !== 'voice') return;
    var key = String(r.project || r.raw_text || '').trim();
    if (String(shown[i].project || shown[i].raw_text || '').trim() !== name) return;
    if (open.indexOf(key) !== -1 && out.indexOf(key) === -1) out.push(key);
  });
  return out.length ? out : [name];
}

/** The task_nodes id of the one Google project the tile `name` is filed under,
 *  or '' when there is none or more than one. */
function tileNode(name) {
  var index = nodeIndex(taskNodes);
  var found = userMap();
  named(sessionLog()).forEach(function (r) {
    if ((r.type !== 'work' && r.type !== 'voice') || !r.node_id) return;
    if (String(r.project || r.raw_text || '').trim() !== name) return;
    var n = index.byId[r.node_id];
    if (!n) return;
    var up = n.kind === 'subtask' ? index.byGoogle[(n.list_id || '') + '|' + n.parent_google_id] : n;
    if (up) found[up.id] = 1;
  });
  var ids = Object.keys(found);
  return ids.length === 1 ? ids[0] : '';
}

function finishProject(btn, name) {
  if (btn.disabled) return;
  coolDown(btn);
  closeProject(name);
  flash(name + ' — stopped', 'ok');
}

// The clock on screen should move without a round trip. Cheap: it only re-reads
// rows already in memory.
setInterval(function () {
  if (currentScreen === 'home') renderProject();
  if (currentScreen === 'today') renderDaySummary();
  paintDeadlines();                  // orange to red to the dot, without a redraw
  // A prayer's time arriving, or the day turning, opens or closes its button.
  if (prayerGateKey(Date.now()) !== prayerGates) {
    renderPrayerTicks();
    if (prayerDlg.open) renderPrayerPicks();
  }
}, 30000);

// ----------------------------------------------------------------- M button

var mBtn = $('mBtn');

/* Each tap writes its own M; coolDown() only swallows a second tap inside
 * 400 ms, which on a phone is a slip. Counts M writes still in flight, so a
 * late reply's count cannot undo the taps made after it. */
var pendingWrites = 0;

mBtn.addEventListener('click', function () {
  if (mBtn.disabled) return;
  coolDown(mBtn);                    // 400ms against a slip, not the round trip

  $('mCount').textContent = ((parseInt($('mCount').textContent, 10) || 0) + 1) + ' today';
  confirmPulse(mBtn);
  noteLocalRow('M', '');

  pendingWrites += 1;
  api('m').then(function (res) {
    // The store's number wins — but only once nothing else is still in flight,
    // or a reply computed three taps ago would undo the two taps after it.
    // A queued press has no number to give back; the tap's own count stands.
    if (pendingWrites === 1 && res && typeof res.m_count === 'number') {
      $('mCount').textContent = res.m_count + ' today';
    }
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

/** Was the open session already running at today's rollover, with no close
 *  since? Then he has been up all night, and Sleep ends the day however light
 *  it is outside (Saad, 25 Sep). */
function sessionFromLastNight(log, lead) {
  var opened = (lead || []).some(function (r) { return OPEN_TYPES[r.type] === 1; });
  var closedSince = (log || []).some(function (r) { return CLOSED_TYPES[r.type] === 1; });
  return opened && !closedSince;
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

/** The store wins: adopt any state row newer than what this device remembers.
 *  Rows can arrive in any order, so scan them all.
 *
 *  `carry` is state rows from before today (see callSupabase), absent on the Apps
 *  Script fallback. They are scanned the same way and held to the same "newer
 *  than local" rule, so they can only fill a gap — never undo something done on
 *  this device today. */
function reconcileToggles(log, carry) {
  var rows = (log || []).slice().concat(carry || []);
  rows.forEach(function (row) {
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
  var night = isNight() || sessionFromLastNight(lastLog, lastLead);
  var closing = toSleep ? sleepClosingRow(toggles.work.state, night) : null;

  // Declining must leave the Sheet untouched, so this runs before any write.
  var question = toSleep ? sleepConfirmQuestion(toggles.work.state, night) : '';
  if (question && !window.confirm(question)) return;

  coolDown(sleepBtn);

  function go() {
    // The prompt may have been open while a re-read landed: already asleep
    // (the 11:30 check, or the other device) means there is nothing to write.
    if (toSleep && toggles.sleep.state !== 'awake') {
      flash('Sleep was already logged', 'ok');
      return;
    }
    closing = toSleep ? sleepClosingRow(toggles.work.state, night) : null;
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
  }

  // Only a Sleep that ends the day asks about prayers; a nap does not.
  if (closing && closing.type === 'off') askDayPrayers(go);
  else go();
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
  coolDown(dayBtn);
  var ending = toggles.work.state !== 'off';     // what the tap meant, fixed now

  function go() {
    /* The prompt may have been open while the 11:30 check or the other device
     * closed the day. "End day anyway" must then write nothing: acting on the
     * new state would START the day. */
    if (ending && toggles.work.state === 'off') {
      flash('The day was already closed', 'ok');
      return;
    }
    var off = !ending;
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
  }

  if (!ending) go();
  else askDayPrayers(go);
});

/* Stage 13b (Saad, 29 Sep): before an `off` row, name any prayer whose time has
 * begun and is not logged, with a button to log each one there. None missing:
 * no dialog and no extra tap (rule 4). "End day anyway" always goes ahead. */
var dayPrayersDlg = $('dayPrayersDlg');
var dayOffPending = null;       // the End day / night Sleep waiting on the prompt

/** Today's prayers whose time has begun and that are not logged (a held press counts). */
function missingPrayers(now) {
  return PRAYER_NAMES.filter(function (name) {
    return !loggedToday(name) && !prayerWaiting(name, now);
  });
}

function askDayPrayers(go) {
  var missing = missingPrayers(Date.now());
  if (!missing.length) { dayOffPending = null; go(); return; }
  dayOffPending = go;
  $('dayPrayersText').textContent = 'Not logged today: ' + missing.join(', ');
  var box = $('dayPrayersList');
  box.textContent = '';
  missing.forEach(function (name) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick';
    b.textContent = name;
    b.addEventListener('click', function () {
      dayPrayersDlg.close();                     // the picker comes back here when done
      openPrayerPicker(name);
    });
    box.appendChild(b);
  });
  if (!dayPrayersDlg.open) dayPrayersDlg.showModal();
}

/** Back from the picker: ask again, or end the day if nothing is left. */
function afterPrayerPicker() {
  if (!dayOffPending) return;
  var go = dayOffPending;
  dayOffPending = null;
  askDayPrayers(go);
}

$('dayPrayersAnyway').addEventListener('click', function () {
  var go = dayOffPending;
  dayOffPending = null;
  dayPrayersDlg.close();
  if (go) go();
});
// Escape writes nothing; End day can simply be pressed again.
dayPrayersDlg.addEventListener('cancel', function () { dayOffPending = null; });

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
  replayDay(sessionLog()).activeReasons.forEach(function (r) { lit[r] = 1; });
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
  if (replayDay(sessionLog()).activeReasons.indexOf(label) !== -1) {
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

/** The row logging `name` in the current prayer day (prayerDate), or null. If two
 *  devices both logged it, the FIRST one counts. Held presses are in todayPrayers. */
function loggedRow(name) {
  var today = prayerDate(Date.now());
  var hit = null;
  todayPrayers.forEach(function (p) {
    if (p.prayer !== name) return;
    var t = instantOf(p.at);
    if (!isNaN(t) && prayerDate(t) !== today) return;      // another day's, until the re-read
    if (!hit || t < instantOf(hit.at)) hit = p;
  });
  return hit;
}

function loggedToday(name) {
  return Boolean(loggedRow(name));
}

/** When `name` begins in the prayer day holding `now`. That day turns at Fajr,
 *  so all five are that date's — Isha at 1 AM, or 5 minutes before Fajr, is open. */
function prayerOpensAt(name, now) {
  var ymd = prayerDate(now).split('-');
  return prayerTimes({ y: Number(ymd[0]), m: Number(ymd[1]), d: Number(ymd[2]) })[name];
}

/** Not yet time for `name`. A time that cannot be worked out never blocks. */
function prayerWaiting(name, now) {
  var t = prayerOpensAt(name, now);
  return isFinite(t) && now < t;
}

/** "Asr · 4:52 PM", for a prayer whose time has not come. */
function prayerWaitLabel(name, now) {
  return name + ' · ' + glanceClock(prayerOpensAt(name, now));
}

/** Point 6: Home shows the five prayers as ticks, not as log lines. Read-only —
 *  logging still goes through the picker, so a tick cannot be set by a mis-tap.
 *  One whose time has not come shows when it does. */
function renderPrayerTicks() {
  var box = $('prayerTicks');
  box.textContent = '';
  var done = 0;
  var now = Date.now();

  PRAYER_NAMES.forEach(function (name) {
    var isDone = loggedToday(name);
    if (isDone) done += 1;
    var waiting = !isDone && prayerWaiting(name, now);

    var el = document.createElement('span');
    el.className = 'tick' + (isDone ? ' done' : '') + (waiting ? ' waiting' : '');

    var mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = isDone ? '✓' : '○';

    var label = document.createElement('span');
    label.textContent = waiting ? prayerWaitLabel(name, now) : name;

    el.append(mark, label);
    box.appendChild(el);
  });

  $('prayerSub').textContent = done + ' of 5';
  prayerGates = prayerGateKey(now);
}

/** Which prayers are waiting right now, so the 30 s tick repaints only on a change. */
var prayerGates = '';
function prayerGateKey(now) {
  return PRAYER_NAMES.map(function (name) { return prayerWaiting(name, now) ? 1 : 0; }).join('') +
         counterDate(now) + prayerDate(now);
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

/* Once per counter day, and never before its time: Saad removed the
 * press-and-hold override on 29 Sep. Both are aria-disabled rather than
 * `disabled`, so a tap can still say why. */
function renderPrayerPicks() {
  var box = $('prayerList');
  box.textContent = '';
  var now = Date.now();

  // A re-read (the other device's row) can land while this one is picked.
  if (pickedPrayer && loggedToday(pickedPrayer)) {
    pickedPrayer = null;
    $('modeWrap').hidden = true;
    $('prayerSaveBtn').disabled = true;
  }

  PRAYER_NAMES.forEach(function (name) {
    var row = loggedRow(name);
    var waiting = !row && prayerWaiting(name, now);
    var label = row ? name + (row.mode ? ' · ' + row.mode : '')
                    : waiting ? prayerWaitLabel(name, now) : name;

    var b = pickButton(label, pickedPrayer === name, Boolean(row), function () {
      if (row) { flash(name + ' is already logged today.', 'warn'); return; }
      if (waiting) {
        flash(name + ' begins at ' + glanceClock(prayerOpensAt(name, now)) + '.', 'warn');
        return;
      }
      pickedPrayer = name;
      pickedMode = null;
      $('modeWrap').hidden = false;
      $('prayerSaveBtn').disabled = true;
      renderPrayerPicks();
      renderModePicks();
    });
    if (row || waiting) {
      b.setAttribute('aria-disabled', 'true');
      b.classList.add(row ? 'logged' : 'waiting');
    }
    box.appendChild(b);
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

/** The picker, with `preset` already picked when it may be logged now (the
 *  end-of-day prompt's buttons). */
function openPrayerPicker(preset) {
  var ok = Boolean(preset) && !loggedToday(preset) && !prayerWaiting(preset, Date.now());
  pickedPrayer = ok ? preset : null;
  pickedMode = null;
  $('modeWrap').hidden = !ok;
  $('prayerSaveBtn').disabled = true;
  renderPrayerPicks();
  renderModePicks();
  prayerDlg.showModal();
  scheduleRefresh(1200);              // opens instantly on cached ticks, then corrects them
}

$('prayerBtn').addEventListener('click', function () { openPrayerPicker(null); });

$('prayerCancelBtn').addEventListener('click', function () {
  prayerDlg.close();
  afterPrayerPicker();
});
// Escape, in a browser; Save and Cancel call it themselves.
prayerDlg.addEventListener('close', afterPrayerPicker);

$('prayerSaveBtn').addEventListener('click', function () {
  if (!pickedPrayer || !pickedMode) return;

  // Checked again: a re-read or the clock may have moved since the pick.
  var refused = loggedToday(pickedPrayer) ? ' is already logged today.'
    : prayerWaiting(pickedPrayer, Date.now()) ? ' has not begun yet.' : '';
  if (refused) {
    flash(pickedPrayer + refused, 'warn');
    pickedPrayer = null;
    $('modeWrap').hidden = true;
    $('prayerSaveBtn').disabled = true;
    renderPrayerPicks();
    return;
  }

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
  afterPrayerPicker();                // queued after the prayer, so the day closes after it
});

// ------------------------------------------------- what are you working on?

/* Pressing Work in the morning resumes... nothing. `resume` carries on with the
 * day's current project, and on the first press of the day there isn't one, so
 * the clock would run against a blank name. Ask once, only when there is
 * genuinely nothing to carry on with, and let it be skipped. */

var projectDlg = $('projectDlg');

function maybeAskProject() {
  if (projectDlg.open) return;
  if (replayDay(sessionLog()).activeProjects.length) return;   // already on something
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
  // Typing a name in the box is the opposite of forgetting it.
  list.forEach(function (n) { unforget(n); });
}

/* Names forgotten in Settings, lower-cased. Kept so a forgotten name that is
 * still on today's rows stays out of the prompt too. Read from storage every
 * time, so every open tab obeys a Forget made in another. */
var FORGOTTEN_KEY = 'probeing.forgotten';
var FORGOTTEN_MAX = 200;

function loadForgotten() {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(FORGOTTEN_KEY)); } catch (e) { /* none */ }
  return Array.isArray(saved) ? saved.filter(function (n) { return typeof n === 'string'; }) : [];
}

function forgottenMap() {
  var out = userMap();
  loadForgotten().forEach(function (n) { out[n] = 1; });
  return out;
}

function saveForgotten(list) {
  try {
    localStorage.setItem(FORGOTTEN_KEY, JSON.stringify(list.slice(-FORGOTTEN_MAX)));
  } catch (e) { /* a full store: the name may be offered again */ }
}

function unforget(name) {
  var key = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  var list = loadForgotten();
  if (list.indexOf(key) !== -1) saveForgotten(list.filter(function (n) { return n !== key; }));
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

/* `focus` is Saad's own line, drawn in his own words: "just take the projects
 * and PhD time". Three of the four kinds are the work a week is judged on; the
 * fourth is life — groceries, errands — and counting it as productivity would
 * make a busy Saturday read as a good week.
 *
 * The flag lives HERE rather than as a list of ids somewhere near the review,
 * because a fifth kind added to this array would otherwise be silently outside
 * the headline figure and nothing would say so. */
var PROJECT_CATEGORIES = [
  { id: 'office',   label: 'Office Projects',   focus: true },
  { id: 'personal', label: 'Personal Projects', focus: true },
  { id: 'phd',      label: 'PhD Working',       focus: true },
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

/** Is this one of the kinds that count towards focused hours? False for
 *  anything that is not one of the four, which is deliberate: Uncategorised and
 *  Unlabelled are "nobody has said what this is", and a headline figure must not
 *  quietly include a guess. */
function isFocusCategory(id) {
  var yes = false;
  PROJECT_CATEGORIES.forEach(function (c) { if (c.id === id && c.focus) yes = true; });
  return yes;
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

  // Re-read first: another tab may have forgotten a name this one still holds.
  recentProjects = loadProjectNames();
  unforget(clean);                         // named again, so it is learned again
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

/** Drop a learned name, so no prompt offers it again. It comes back only if an
 *  entry is named that again. */
function forgetProject(name) {
  var key = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  recentProjects = loadProjectNames().filter(function (n) { return n.toLowerCase() !== key; });
  try {
    localStorage.setItem(PROJECT_NAMES_KEY, JSON.stringify(recentProjects));
  } catch (e) { /* a full store: the name stays until it falls off the end */ }
  var gone = loadForgotten().filter(function (n) { return n !== key; });
  gone.push(key);
  saveForgotten(gone);
}

/** Drop the kind of work a project was filed as. */
function forgetCategory(name) {
  var next = userMap();
  var key = catKey(name);
  projectCategories = loadProjectCategories();   // storage wins over this tab's copy
  Object.keys(projectCategories).forEach(function (k) {
    if (k !== key) next[k] = projectCategories[k];
  });
  saveProjectCategories(next);
}

// Another tab changed a store: pick it up now rather than at the next read.
window.addEventListener('storage', function (e) {
  if (!e.key || e.key === PROJECT_NAMES_KEY) recentProjects = loadProjectNames();
  if (!e.key || e.key === PROJECT_CATEGORY_KEY) projectCategories = loadProjectCategories();
});

/** Every project name this device could recognise: the ones on today's rows
 *  that already carry one, then the remembered set. */
function knownNames() {
  var seen = {};
  var out = [];
  // Storage, not this tab's copy: another tab may have forgotten a name.
  recentProjects = loadProjectNames();
  var gone = forgottenMap();

  function add(name) {
    var clean = String(name || '').replace(/\s+/g, ' ').trim();
    var key = clean.toLowerCase();
    /* `=== 1`, not truthiness: a plain object inherits `constructor` and
     * `toString` from its prototype, and a project may fairly be called either
     * of those. */
    if (!clean || seen[key] === 1 || gone[key] === 1) return;
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
  var gone = forgottenMap();
  (open || []).concat(knownNames()).forEach(function (name) {
    var clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean || seen[clean.toLowerCase()] === 1 || gone[clean.toLowerCase()] === 1) return;
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
      : ' (this app\'s own limit, set in Developer settings — leave room under your model\'s).');
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
 * It never rejects. Offline, signed out, out of budget, timed out, or handed
 * something that is not JSON — every one of
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
  if (sb && sbUser && geminiCallsLeft() <= 0) {
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
 *  handles waiting — but whether a call could be made today.
 *
 *  With no network the call cannot land, and it would still be counted against
 *  the day's budget on the way out. The free local match is the right answer
 *  offline, and the comment above has said so since before it was true. */
function canAskGemini() {
  return Boolean(sb) && Boolean(sbUser) && navigator.onLine !== false &&
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

/* Which model actually answered, straight out of the Edge Function's reply.
 * This app never chooses the model — it is a Supabase secret (GEMINI_MODEL) —
 * so reading it back is the only way a saved report can say which one wrote it,
 * and the free tier's allowance is counted per model, so it is also the only
 * record of which budget a report was paid for out of. */
var lastGeminiModel = '';

/**
 * The one place this app talks to Gemini on the logging path: post `body` to
 * the Edge Function and hand back the model's text, or null.
 *
 * null covers every way there is nothing to read — signed out,
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
   * secret of that function and must never be anywhere else. */
  if (!sb || !sbUser) return null;

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
      // JSON is fine: this function answers the CORS preflight itself.
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
  lastGeminiModel = String(data.model || '');
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
  if (!sb || !sbUser) return '(not signed in)';
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
                                           // human record, and the log action
                                           // rejects an empty one.
    project: '',                           // filled in later, or never
    detail: '',
    rid: rid
  });

  // On the tap. Everything below only decides what this row is CALLED.
  var wrote = runWrites(steps, undo);
  row.rid = rid;                           // so Today can show its filing

  /* Stage 14a: with Google connected the server files it (classify). Naming it
   * here too would race the server for the same fill-once row (C9). */
  if (serverFiles()) {
    wrote.then(function () { scheduleFiling(); });
    return;
  }

  holdName(text);

  function forget() { releaseName(text); }

  /* Read in the same tick as extractProject() reads it, so it says whether this
   * entry was put to Gemini at the tap. */
  var askedAtTap = canAskGemini();

  /* NOT ASKED AT THE TAP, AND LANDED BY ITS OWN SEND rather than the outbox
   * drain: offline, the fetch can hang until the signal is back and then go
   * through, so the drain never sees this write and never names it. Name it
   * here instead, through the drain's own labelLanded(). One call either way:
   * a write the drain delivers resolves 'queued' here, never true. */
  function landedUnasked(ok) {
    if (ok !== true || askedAtTap || !canAskGemini()) return false;
    labelLanded([{ action: 'log', payload: { type: type, raw_text: text, project: '', rid: rid } }]);
    return true;
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
      if (askedAtTap) { forget(); return; } // understood nothing: the old behaviour
      /* Held until the write lands, so an entry named on arrival before this
       * one never sees this sentence offered as a name already in use. */
      wrote.then(function (ok) { landedUnasked(ok); forget(); });
      return;
    }
    wrote.then(function (ok) {
      // A row that never landed has nothing to label, and the failed write has
      // already scheduled its own reconcile against the store. A QUEUED row has
      // nothing to label yet — `label` finds its row by rid, and the row is
      // not in the table. The drain names it when it lands (labelLanded).
      if (ok !== true) { forget(); return; }
      // A name matched on the device, offline: Gemini can read the tasks as well.
      if (landedUnasked(ok)) { forget(); return; }
      applyLabel(rid, text, row, got, forget);
    });
  }

  extractProject(text, known).then(settle, function () { settle(noExtraction()); });
});

/* Tile names whose label has not settled yet — kept out of the next entry's
 * prompt. Counted rather than flagged, because the same sentence can be logged
 * twice before either one is answered. */
var awaitingLabel = {};

/* Hide a sentence from the next entry's prompt while its own label is in
 * flight, and show it again once that settles: an entry that stayed unlabelled
 * is an ordinary sentence-named tile, and the model should be told about it so
 * a follow-up line lands on the same tile rather than a new one. Two callers —
 * the tracker, and an entry named on arrival off the outbox. */
function holdName(text) {
  awaitingLabel[text] = (awaitingLabel[text] || 0) + 1;
}

function releaseName(text) {
  awaitingLabel[text] -= 1;
  if (awaitingLabel[text] <= 0) delete awaitingLabel[text];
}

/* Which ceiling has already been mentioned: '' , 'rate' or 'budget'. A name
 * rather than a flag, because there are two causes now — Google's per-minute
 * refusal and our own daily budget — and being told about the second only
 * because the first was mentioned first would be no help at all. */
var quotaTold = '';

/** What the model may be told is already open. */
function openProjects() {
  return replayDay(sessionLog()).activeProjects.filter(function (name) {
    return !awaitingLabel[name];
  });
}

/** Is `name` still an open project, as far as this device knows right now? */
function isOpenProject(name) {
  return isOpenAt(sessionLog(), name);
}

/**
 * Put Gemini's project name on a row that is already written.
 *
 * `key` is what the tile is called until this lands — the raw sentence — and
 * every check here is about that name changing under the user's feet. See the
 * long note at the top of the tracker for why the row is written first.
 */
function applyLabel(rid, key, row, got, done) {
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

    /* The tile was closed while the update was in flight. If Done closed it, the
     * `done` row names the sentence and the store now names the project, so it
     * is closed again under the new name. If End day or Sleep closed it, the new
     * name is not open either, and a `done` would only fake a Done tick. */
    if (!isOpenProject(key)) {
      if (donePressed(sessionLog())[key] === 1) closeProject(got.project);
      return;
    }

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

/* Deliberately takes the floor as an argument: it is a pure function of two
 * strings, so it can be tested without a database, a clock, or a browser. Its
 * one helper is day.js's counterDate(). */
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

  // Compared as counter days, because that is the day the user lived through:
  // a first row at 02:00 belongs to the evening before.
  var floor = counterDate(first.getTime());
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

/** The counter day `now` falls in, as that date's local midnight — the
 *  calendar every range and report is counted in. */
function counterToday(now) {
  var p = counterDate(now.getTime()).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

/** When the counter day named by local date `d` begins. Midday is inside
 *  every counter day, so asking about it names that day without this file
 *  knowing the hour. */
function counterStartOf(d) {
  return counterDayStart(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime());
}

/**
 * Turn a picker id into the two local calendar days it covers, inclusive.
 * Takes `now` rather than reading the clock, so the tests can ask for any day.
 */
function reviewRangeOf(id, now) {
  var spec = null;
  REVIEW_RANGES.forEach(function (r) { if (r.id === id) spec = r; });
  if (!spec) spec = REVIEW_RANGES[1];

  // The counter day: at 02:00 on a Monday it is still Sunday, and this week
  // has not begun.
  var today = counterToday(now);
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
 * One window per counter day, [its rollover, the next day's rollover).
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
    out.push({ ymd: ymdLocal(d), startMs: counterStartOf(d), endMs: counterStartOf(next) });
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
 * Each window's prayers, one per name. A prayer row goes to its PRAYER day
 * (prayerDate: an Isha in the minutes before Fajr is the day before's), not to
 * the counter-day window it sits in. When a name was logged twice in a day (two
 * devices at once, or an old tab), the EARLIEST row counts and the rest are
 * `repeats`. Pass every row read, so such an Isha just past the range is seen.
 *
 * @returns {Array<{names, order, repeats}>} per window: names maps a name to its row.
 */
function prayerDays(rows, windows) {
  var at = userMap();
  var out = windows.map(function (w, i) {
    at[w.ymd] = i;
    return { names: userMap(), order: [], repeats: 0 };
  });
  (rows || []).filter(function (r) { return r && r.type === 'prayer'; })
    .map(function (r) { return { row: r, t: instantOf(r.at) }; })
    .filter(function (x) { return !isNaN(x.t); })
    .sort(function (a, b) { return a.t - b.t; })
    .forEach(function (x) {
      var i = at[prayerDate(x.t)];
      if (i === undefined) return;
      var day = out[i];
      // The name lives in `project`; raw_text is the fallback for a row without one.
      var name = String(x.row.project || x.row.raw_text || '').trim();
      if (day.names[name] !== undefined) { day.repeats += 1; return; }
      day.names[name] = x.row;
      day.order.push(name);
    });
  return out;
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
 * @param rows    every row in the range, oldest first. Rows before the first
 *                window are allowed and only replayed as a session's lead-in;
 *                nothing outside the windows is counted.
 * @param windows one per counter day, from dayWindows().
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
    bySubtask: userMap(),                 // Stage 16: task_nodes id -> ms
    m: 0,
    prayers: 0,
    byMode: userMap(),
    perDay: [],
    rows: 0
  };

  var buckets = bucketByWindow(rows, windows);
  var prayed = prayerDays(rows, windows);
  var newestFirst = (rows || []).slice().reverse();     // sessionLead's order

  windows.forEach(function (w, i) {
    var dayRows = buckets[i];
    sum.rows += dayRows.length;
    if (dayRows.length) sum.daysWithRows += 1;

    /* Replayed from the newest close before the window, credited only from its
     * start. Alone, a session that crossed the line lost everything after it:
     * work 21:44 to End day 02:00 reported 2.27h, not 4.27h. The window's own
     * end stops an unclosed clock; replayDay() pulls it back to now for today. */
    var day = replayDay(dayRows.concat(sessionLead(newestFirst, w.startMs)), w.endMs, w.startMs);

    sum.worked += day.worked;
    sum.paused += day.paused;
    sum.unattributed += day.unattributed;

    Object.keys(day.byProject).forEach(function (p) {
      sum.byProject[p] = (sum.byProject[p] || 0) + day.byProject[p];
    });
    Object.keys(day.byReason).forEach(function (r) {
      sum.byReason[r] = (sum.byReason[r] || 0) + day.byReason[r];
    });
    Object.keys(day.bySubtask).forEach(function (id) {
      sum.bySubtask[id] = (sum.bySubtask[id] || 0) + day.bySubtask[id];
    });

    /* Counted per day, not over the raw range, and that is what makes them
     * LOCAL-day counts. Karachi is five hours ahead of UTC, so 27 Aug's seven M
     * rows are stamped the 27th here and mostly the 27th in UTC — but the same
     * rows late on a UTC evening would fall on the next date entirely. The
     * windows are the device's own counter days, so this counts the days Saad
     * lived through. */
    dayRows.forEach(function (row) {
      if (row.type === 'M') sum.m += 1;
    });
    // Prayers by their prayer day, each name once, with its first-logged mode.
    prayed[i].order.forEach(function (name) {
      sum.prayers += 1;
      var mode = String(prayed[i].names[name].detail || '').trim();
      if (mode) sum.byMode[mode] = (sum.byMode[mode] || 0) + 1;
    });

    sum.perDay.push({ ymd: w.ymd, rows: dayRows.length, worked: day.worked });
  });

  /* Divided by the days that HAVE rows, never by the calendar. 1 Sep has no
   * rows at all — a day nothing was logged is a day with no measurement, not a
   * day of zero hours, and averaging it in would quietly drag every figure in
   * the report down by a seventh. */
  sum.avgWorked = sum.daysWithRows ? Math.round(sum.worked / sum.daysWithRows) : 0;
  sum.empty = sum.daysWithRows === 0;
  // The windows' rows only: a lead-in's night belongs to the period before.
  sum.sleep = sleepInRange(rowsInWindows(rows, windows));
  return sum;
}

/**
 * The five prayers crossed with the three modes, and what was missed.
 *
 * summariseRange() already counts prayers twice — a total, and a breakdown by
 * mode across all five — and neither can answer "how was Fajr this month".
 * This walks the same day windows and keeps the two apart.
 *
 * MISSED IS COUNTED ONLY ON DAYS THAT HAVE ROWS, which is the rule
 * `daysWithRows` and the daily average already follow. A day with nothing
 * logged at all is a day with no measurement — the phone was off, or the app
 * was never opened — and booking five misses against it would turn silence into
 * a claim about how Saad prayed. A day that has rows and no Fajr among them is
 * a real miss, and is counted as one.
 *
 * `logged` counts each (prayer, prayer day) once, and it is deliberately the same
 * figure summariseRange() reports as `prayers`: both read prayerDays(), so a
 * report whose breakdown disagrees with its own total is a bug rather than a
 * difference of opinion. sum(total) + other = logged; a second row of one
 * prayer in a day (two devices, or an old tab) is in `repeats` only (13b).
 *
 * @param rows    every row in the range. Only `type:'prayer'` rows are counted,
 *                but the rest decide which days count as measured at all.
 * @param windows one per local day, from dayWindows().
 * @param nowMs   defaults to now; a day ending after it is not judged for Missed.
 */
function prayerStats(rows, windows, nowMs) {
  var wins = windows || [];
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var out = {
    byPrayer: [],
    modes: PRAYER_MODES.slice(),
    logged: 0,
    other: 0,
    repeats: 0,              // a prayer's second row on one day: in neither `logged` nor `total`
    days: wins.length,
    daysWithRows: 0,
    daysFinished: 0,         // days already over; only these can hold a miss
    daysJudged: 0            // finished days with rows: the base Missed is counted on
  };

  // Keyed by prayer name, so it carries no prototype — see userMap(). Without
  // it a row naming itself "constructor" would find a function here.
  var index = userMap();
  PRAYER_NAMES.forEach(function (name) {
    var one = { name: name, total: 0, missed: 0, noMode: 0, byMode: userMap() };
    // Every mode present at zero, so a month with no Takbeer-e-oola says so
    // rather than leaving the reader to notice a key that is not there.
    PRAYER_MODES.forEach(function (mode) { one.byMode[mode] = 0; });
    index[name] = one;
    out.byPrayer.push(one);
  });

  var buckets = bucketByWindow(rows, wins);
  var prayed = prayerDays(rows, wins);

  wins.forEach(function (w, i) {
    // A day not yet over judges a prayer only once the next one has begun.
    var finished = w.endMs <= now;
    if (finished) out.daysFinished += 1;
    var day = prayed[i];
    if (!buckets[i].length && !day.order.length) return;   // unmeasured: not five misses
    out.daysWithRows += 1;
    if (finished) out.daysJudged += 1;

    // One per prayer per day (prayerDays), as on the Today card; the first row's mode.
    out.repeats += day.repeats;
    var seen = userMap();                  // the prayer names logged this day
    day.order.forEach(function (name) {
      out.logged += 1;

      /* A name that is neither of the five is counted apart rather than
       * dropped — see `other` below. */
      var one = index[name];
      if (!one) { out.other += 1; return; }
      one.total += 1;
      seen[one.name] = 1;

      /* A mode that is not one of the three is counted too. `total` must always
       * equal the modes plus `noMode`, or the breakdown loses a prayer that was
       * really offered — the same rule that makes `other` exist. */
      var mode = String(day.names[name].detail || '').trim();
      if (one.byMode[mode] === undefined) one.noMode += 1;
      else one.byMode[mode] += 1;
    });

    var due = finished ? null : missedDueTimes(w);
    out.byPrayer.forEach(function (one, k) {
      if (seen[one.name] === 1) return;
      if (finished || (due && due[k] <= now)) one.missed += 1;
    });
  });

  return out;
}

/* Stage 10. When each prayer of an unfinished day counts as missed: once the
 * NEXT prayer has begun, and Isha once the day turns. Chosen over "once its own
 * time has passed", which would call Asr missed a minute after it began. */
function missedDueTimes(w) {
  var ymd = String(w.ymd || '').split('-');
  var t = prayerTimes({ y: Number(ymd[0]), m: Number(ymd[1]), d: Number(ymd[2]) });
  return PRAYER_NAMES.map(function (name, k) {
    var next = k + 1 < PRAYER_NAMES.length ? t[PRAYER_NAMES[k + 1]] : w.endMs;
    return isFinite(next) ? next : w.endMs;
  });
}

// ------------------------------------------------------------------- money

/* Stage 11. Counted in whole paisa, so 0.10 + 0.20 is 0.30 and never
 * 0.30000000000000004. numeric(14,2) allows 12 digits before the point. */
var MONEY_INT_DIGITS = 12;
var MONEY_UNTAGGED = 'Untagged';
var MONEY_DUES_TAG = 'Dues';    // cash dues in spent/got and in Review's tags (feedback 1)
// The first counter day with money. A range starting earlier is labelled, not read as whole.
var MONEY_SINCE = '2026-09-29';

/** An amount off a row (Postgres sends a number, the outbox holds a string) as
 *  whole paisa, or NaN if it cannot be read. */
function moneyPaisa(x) {
  var s = typeof x === 'number' ? (isFinite(x) ? x.toFixed(2) : '')
                                : String(x === null || x === undefined ? '' : x).trim();
  var m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2));
}

/** What was typed, as '450.00', or '' when it is not an amount above zero with at
 *  most two decimals. Commas and spaces are grouping and are ignored. */
function parseMoneyAmount(text) {
  var s = String(text === null || text === undefined ? '' : text).replace(/[\s,]/g, '');
  var m = new RegExp('^(\\d{0,' + MONEY_INT_DIGITS + '})(?:\\.(\\d{0,2}))?$').exec(s);
  if (!m || (!m[1] && !m[2])) return '';
  var paisa = Number(m[1] || '0') * 100 + Number(((m[2] || '') + '00').slice(0, 2));
  if (!(paisa > 0)) return '';
  return Math.floor(paisa / 100) + '.' + String(paisa % 100).padStart(2, '0');
}

/** parseMoneyAmount, except that zero is allowed: a wallet can be empty. */
function parseWalletAmount(text) {
  var s = String(text === null || text === undefined ? '' : text).replace(/[\s,]/g, '');
  if (/^0*(\.0{0,2})?$/.test(s) && /0/.test(s)) return '0.00';
  return parseMoneyAmount(text);
}

var LOAN_PERSON_MAX = 40;       // the check on money.person

/** A loan's person as stored: spaces collapsed, at most LOAN_PERSON_MAX
 *  characters (counted as Postgres does, so an emoji is not cut in half). */
function cleanPerson(text) {
  var s = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, LOAN_PERSON_MAX).join('').trim();
}

/** 12450 -> "12,450"; 0.5 -> "0.50". Fixed shape, not the locale's, so a
 *  report reads the same on both devices. */
function formatPkr(n) {
  var paisa = Math.round(Math.abs(Number(n) || 0) * 100);
  var whole = String(Math.floor(paisa / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  var cents = paisa % 100;
  return (Number(n) < 0 && paisa ? '-' : '') + whole +
         (cents ? '.' + String(cents).padStart(2, '0') : '');
}

/** A net figure: "+1,200", "-300", "0". */
function signedPkr(n) { return (Number(n) > 0 ? '+' : '') + formatPkr(n); }

/** Mark `figs` with MONEY_SINCE when `windows` start before it. Returns `figs`. */
function moneySince(figs, windows) {
  if (figs && windows && windows.length && windows[0].ymd < MONEY_SINCE) figs.since = MONEY_SINCE;
  return figs;
}

/** "29 Sep" for figures moneySince() marked, else ''. Not the locale's: en-GB now says "Sept". */
function moneySinceDay(figs) {
  if (!figs || !figs.since) return '';
  var p = String(figs.since).split('-');
  return Number(p[2]) + ' ' + 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[Number(p[1]) - 1];
}

/**
 * Money in and out over counter-day windows, from `money` rows. Pure.
 *
 * A void and the row it cancels are both left out of every figure. Voids are
 * read from every row given, not only those inside the windows, because a
 * mistake can be voided the next day. Tags go through userMap(), so a tag
 * called __proto__ is counted like any other.
 *
 * Cash dues ('loan': a Settle, or a due with cash moved now) count as spent or
 * got, under the tag MONEY_DUES_TAG (feedback 1, Saad: "if I am paying it now,
 * it should also add to my today spent"), and also in loanIn/loanOut.
 * Record-only dues and the wallet's count (Money 2) have no in/out dir, so they
 * count for nothing here.
 *
 * @returns {{in, out, net, byTagIn, byTagOut, loanIn, loanOut, entries, loans, voided}} in rupees.
 */
function moneyFigures(rows, windows) {
  var cancelled = userMap();
  (rows || []).forEach(function (r) { if (r && r.voids_rid) cancelled[r.voids_rid] = 1; });

  var paisa = { 'in': 0, out: 0 };
  var loan = { 'in': 0, out: 0 };
  var byTag = { 'in': userMap(), out: userMap() };
  var out = { entries: 0, loans: 0, voided: 0 };

  bucketByWindow(rows, windows || []).forEach(function (day) {
    day.forEach(function (r) {
      if (r.voids_rid || (r.dir !== 'in' && r.dir !== 'out')) return;
      if (r.rid && cancelled[r.rid] === 1) { out.voided += 1; return; }
      var p = moneyPaisa(r.amount);
      if (!(p > 0)) return;
      var tag = String(r.tag || '').trim() || MONEY_UNTAGGED;
      if (r.kind === 'loan') {
        loan[r.dir] += p;
        out.loans += 1;
        tag = MONEY_DUES_TAG;
      } else {
        out.entries += 1;
      }
      paisa[r.dir] += p;
      byTag[r.dir][tag] = (byTag[r.dir][tag] || 0) + p;
    });
  });

  function rupees(map) {
    var m = userMap();
    Object.keys(map).forEach(function (k) { m[k] = map[k] / 100; });
    return m;
  }
  out['in'] = paisa['in'] / 100;
  out.out = paisa.out / 100;
  out.net = (paisa['in'] - paisa.out) / 100;          // cash dues are inside in/out now
  out.loanIn = loan['in'] / 100;
  out.loanOut = loan.out / 100;
  out.duesInOut = true;                // marks reports saved since: out/in include cash dues
  out.byTagIn = rupees(byTag['in']);
  out.byTagOut = rupees(byTag.out);
  return out;
}

/**
 * What each person owes, from every due row given, whatever its day. Pure.
 * Positive: they owe you. A cash due ('loan': lent, borrowed, or a settlement)
 * counts the way the cash went: out raises what they owe you, in lowers it. A
 * record-only due counts as written: 'they_owe' raises it, 'i_owe' lowers it.
 * Voided rows count for nothing, as in moneyFigures. Names match whatever the
 * case; the latest spelling is shown. Zero balances are left out.
 *
 * @returns {Array<{person, owed}>} owed in rupees, largest first.
 */
function loanBalances(rows) {
  var cancelled = userMap();
  (rows || []).forEach(function (r) { if (r && r.voids_rid) cancelled[r.voids_rid] = 1; });
  var paisa = userMap();
  var shown = userMap();
  var latest = userMap();
  var SIGN = { loan: { out: 1, 'in': -1 }, due: { they_owe: 1, i_owe: -1 } };
  (rows || []).forEach(function (r) {
    if (!r || (r.kind !== 'loan' && r.kind !== 'due') || r.voids_rid) return;
    var sign = SIGN[r.kind][r.dir];
    if (sign !== 1 && sign !== -1) return;
    if (r.rid && cancelled[r.rid] === 1) return;
    var name = cleanPerson(r.person);
    var p = moneyPaisa(r.amount);
    if (!name || !(p > 0)) return;
    var key = name.toLowerCase();
    var t = instantOf(r.at) || 0;
    if (shown[key] === undefined || t >= latest[key]) { shown[key] = name; latest[key] = t; }
    paisa[key] = (paisa[key] || 0) + sign * p;
  });
  return Object.keys(paisa).filter(function (k) { return paisa[k] !== 0; })
    .map(function (k) { return { person: shown[k], owed: paisa[k] / 100 }; })
    .sort(function (a, b) {
      return (Math.abs(b.owed) - Math.abs(a.owed)) || (a.person.toLowerCase() < b.person.toLowerCase() ? -1 : 1);
    });
}

/** "Ali owes you PKR 2,000" / "You owe Sara PKR 500". */
function loanBalanceLine(b) {
  return b.owed > 0 ? b.person + ' owes you PKR ' + formatPkr(b.owed)
                    : 'You owe ' + b.person + ' PKR ' + formatPkr(-b.owed);
}

/**
 * The wallet, from every money row. Pure. It starts at the newest starting
 * amount (an 'opening' row) and moves with each cash row and each cash due
 * ('loan') pressed after it; a record-only due never moves it. Voided rows and
 * voids count for nothing. Newest is by press time, so two devices agree
 * whatever order the rows reached the table in.
 *
 * @returns {{set, left, from}} left in rupees, from the opening's `at`; set is
 *   false (and left 0) until a starting amount exists.
 */
function walletFigures(rows) {
  var cancelled = userMap();
  (rows || []).forEach(function (r) { if (r && r.voids_rid) cancelled[r.voids_rid] = 1; });
  var open = null;
  var openT = -Infinity;
  (rows || []).forEach(function (r) {
    if (!r || r.kind !== 'opening' || r.voids_rid || (r.rid && cancelled[r.rid] === 1)) return;
    var t = instantOf(r.at);
    if (isNaN(t) || !(moneyPaisa(r.amount) >= 0)) return;
    // A tie in the same millisecond goes to the larger rid, the same on both devices.
    if (!open || t > openT || (t === openT && String(r.rid) > String(open.rid))) { open = r; openT = t; }
  });
  if (!open) return { set: false, left: 0, from: '' };
  var paisa = moneyPaisa(open.amount);
  (rows || []).forEach(function (r) {
    if (!r || r.voids_rid || (r.rid && cancelled[r.rid] === 1)) return;
    var kind = r.kind || 'cash';
    if ((kind !== 'cash' && kind !== 'loan') || (r.dir !== 'in' && r.dir !== 'out')) return;
    if (!(instantOf(r.at) > openT)) return;
    var p = moneyPaisa(r.amount);
    if (p > 0) paisa += r.dir === 'in' ? p : -p;
  });
  return { set: true, left: paisa / 100, from: open.at };
}

/** Counter days from `today` (a local date) to the next 1st, today included:
 *  1 on the 30th of September, 31 on the 1st of October. */
function daysTillFirst(today) {
  var y = today.getFullYear();
  var m = today.getMonth();
  return Math.round((Date.UTC(y, m + 1, 1) - Date.UTC(y, m, today.getDate())) / 86400000);
}

/** What is left, spread over the days to the next 1st, in whole rupees rounded
 *  down so the days add up to no more than is there. 0 when nothing is left. */
function perDayTillFirst(left, today) {
  var paisa = Math.round(Number(left) * 100);
  if (!(paisa > 0)) return 0;
  return Math.floor(paisa / daysTillFirst(today) / 100);
}

/** What one range read must cover, first to last counter day inclusive: from a
 *  lead-in's reach before the first, so a session already running is replayed
 *  from where it began, to the rollover after the last. */
function rangeReadBounds(first, last) {
  var after = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return { startIso: new Date(counterStartOf(first) - LEAD_MAX_MS).toISOString(),
           endIso: new Date(counterStartOf(after)).toISOString() };
}

/**
 * Only the rows that fall inside these day windows.
 *
 * Needed because ONE read now covers two ranges — the one being reviewed and
 * the equal-length one before it, for the pace line. sleepInRange() walks every
 * row it is given, so it is handed only these — otherwise last week's nights
 * would be added to this week's total without a single figure looking wrong.
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
 * The headline figure for a period: the hours that were actually spent on work.
 *
 * Office Projects + Personal Projects + PhD Working, and nothing else. Saad
 * named the rule himself — "just take the projects and PhD time" — and the
 * exclusions are the point of it: "Personal working" is groceries, and
 * Uncategorised and Unlabelled are time nobody has said the kind of yet. Adding
 * either would make the one number on this screen that answers "was this a good
 * week" a guess.
 *
 * The rest is not thrown away. `outside` carries every group that is not
 * focused work, with its hours, because a figure that silently leaves out a
 * third of the week is worse than one that shows its own edges — and the
 * summary is written from these two together.
 *
 * Built on groupProjects(), so it inherits the same collapse of sentence-shaped
 * keys and the same overlap: two projects at once is an hour of each, and this
 * total may therefore exceed the hours worked. Never normalised — CLAUDE.md.
 */
function focusOf(byProject, cats) {
  var got = groupProjects(byProject, cats);
  var out = { ms: 0, groups: [], outside: [], filed: false };

  got.groups.forEach(function (g) {
    if (isFocusCategory(g.id)) {
      out.ms += g.ms;
      out.groups.push(g);
    } else {
      out.outside.push(g);
    }
  });

  /* NOTHING FILED IS NOT ZERO HOURS. Until at least one project has been put in
   * one of the three kinds, `ms` is 0 because nobody has answered the question —
   * not because no work was done. Everything downstream reads this flag rather
   * than testing `ms`, so a period of unfiled work is reported as unknown, the
   * same refusal the date floor and the sleep line make. */
  out.filed = out.groups.length > 0;
  return out;
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
 * One period, written out for the model: the headline figure, the projects
 * under each kind of work with their hours, and what was actually done to them.
 *
 * BOTH PERIODS GO THROUGH HERE, which is the point of it existing. The old
 * prompt described this range in full and gave the earlier one a single total,
 * so the only comparison a model could make was "more hours" or "fewer hours".
 * Saad asked for the comparison he actually reads — which project stopped, which
 * one started, where the time went — and that needs the same detail on both
 * sides.
 *
 * Every project is listed, not only the ones with sub-tasks. A project worked on
 * last period and not this one is exactly the thing the summary is meant to
 * notice, and it has no sub-tasks here to be noticed by.
 */
function promptPeriod(heading, sum, cats, tasks) {
  var lines = [heading];
  var focus = focusOf(sum.byProject, cats);
  var seen = tasks || {};

  if (!focus.groups.length && !focus.outside.length) {
    lines.push('  Nothing was logged against any project in this period.');
    return lines;
  }

  lines.push(focus.filed
    ? '  Focused hours (office projects, personal projects and PhD): ' +
      reviewDuration(focus.ms)
    : '  Focused hours: NOT KNOWN. None of the projects below has been filed as ' +
      'office, personal or PhD work yet, so there is no figure. Do not call it zero.');

  var draw = function (group) {
    lines.push('  ' + group.label + ' ' + reviewDuration(group.ms));
    group.projects.forEach(function (p) {
      // Array.isArray, not truthiness: `tasks['constructor']` is a function.
      var t = Array.isArray(seen[p.name]) ? seen[p.name] : [];
      /* THE ONLY CAP, and it is here because the reason for it is token cost.
       * The screen shows every bullet; a month of one project would otherwise
       * send a very long list to say something a dozen examples already say. */
      lines.push('    ' + p.name + ' ' + reviewDuration(p.ms) +
                 (t.length ? ': ' + t.slice(0, REVIEW_TASK_PROMPT_LINES).join('; ') : ''));
    });
  };

  focus.groups.forEach(draw);
  if (focus.outside.length) {
    lines.push('  Not counted in the focused hours:');
    focus.outside.forEach(draw);
  }

  return lines;
}

/**
 * The one prompt, and it asks for THREE things.
 *
 * Everything a person actually wants off this screen — the hours, the projects
 * under each heading, what was done to each — is worked out on this device and
 * drawn straight, so none of the figures here can be hallucinated. What is left
 * for a language model is the job it is genuinely better at than arithmetic:
 * reading two lists of work side by side and saying what moved.
 *
 * WHAT THIS PROMPT NO LONGER CONTAINS is as deliberate as what it does. The
 * range, the calendar-day count and the total worked used to head it, and the
 * model dutifully handed them back — "Over the last 7 days from 2026-08-27 to
 * 2026-09-02, you worked 41h 42m across 6 calendar days with entries" — directly
 * underneath the range label and the figures card that already say all three.
 * Instructing it not to repeat them would have been a weaker fix than not
 * giving them: a figure that is not in the prompt cannot be restated.
 *
 * THE OVERVIEW NOW NAMES NO FIGURE AT ALL, and here the weaker fix is the only
 * one available. Saad read a summary that opened "You spent 47h 20m on office
 * projects, personal projects and PhD, with 35h 16m going to NeuraVue (17h 39m),
 * OneNet (17h 36m)…" — every one of those numbers already drawn, in that order,
 * in the card immediately above it — and asked for that clause gone, keeping
 * only the half that judged the work. The per-project hours cannot be taken out
 * of the prompt to force it: they are how the model tells a seventeen-hour
 * project from a twenty-one-second one, and without them it weighs a stray
 * entry the same as OneNet. So they stay, and the instruction names the single
 * line that may carry a figure — the Productivity verdict, per Review_Spec.md's
 * "slower or faster, with the hours named" — and forbids it everywhere else.
 *
 * The pace verdict is still handed over finished — both totals, the difference
 * and the word already chosen — because a subtraction is exactly what the model
 * must not do. It is now a comparison of FOCUSED hours rather than of wall-clock
 * hours worked, because that is the figure Saad defined as the one worth judging.
 *
 * Sleep, prayers, Ms and break reasons are deliberately absent. They were in
 * here to feed a prose paragraph that no longer exists; a model that is never
 * asked about sleep cannot state a figure for a night nobody recorded.
 *
 * @param win   the range being reviewed — only its label is used, never its dates.
 * @param now   {sum, tasks} for that range.
 * @param prior {sum, tasks, days} for the equal-length period before it, or null
 *              when nothing is recorded that far back.
 * @param cats  the stored category assignments, passed in rather than read here.
 * @param pace  paceOf() on the two FOCUSED totals. `known` false means the
 *              difference is not worth stating — which is not the same thing as
 *              `prior` being null, and the two are reported differently.
 */
function reviewPrompt(win, now, prior, cats, pace) {
  var lines = [
    'You are helping one person read their own activity log.',
    'Every figure below is already worked out. Do NOT calculate anything: never ' +
      'add, subtract, average or round. Every number you write must be copied ' +
      'from below exactly as it is written there.',
    ''
  ];

  lines = lines.concat(promptPeriod('THIS PERIOD (' + win.label + '):',
                                    now.sum, cats, now.tasks));
  lines.push('');

  if (prior) {
    lines = lines.concat(promptPeriod('THE PERIOD BEFORE IT (the ' + prior.days +
                                      ' days immediately before):',
                                      prior.sum, cats, prior.tasks));
    if (pace && pace.known) {
      /* Its own paragraph, not the tail of the earlier period's list: it is a
       * fact about both of them. */
      lines.push('');
      lines.push('Change in focused hours: ' + pace.word + ' — ' +
                 reviewDuration(pace.prior) + ' then, ' + reviewDuration(pace.worked) +
                 ' now, a difference of ' + reviewDuration(Math.abs(pace.diff)) + '.');
    }
  } else {
    /* Same refusal as the date floor and the sleep line: there is nothing before
     * the first row this account has, so the earlier period is unmeasured, not
     * zero. Saying "you worked 0 hours last week" about a week that predates the
     * app is the one sentence this screen must never produce.
     *
     * The second half of this instruction is newer and is Saad's: the absence
     * was being announced in a sentence of its own — "There is nothing to
     * compare against from the period before this one" — which is a whole line
     * of a five-line summary spent saying nothing happened. */
    lines.push('THE PERIOD BEFORE IT is NOT RECORDED — there is nothing logged ' +
               'that far back. Write about this period only. Do not state a ' +
               'figure for the earlier one and do not call it zero. Do not spend ' +
               'a sentence explaining that it is missing: a short clause, or ' +
               'nothing at all.');
  }

  /* NOT NUMBERED, and that is deliberate. This used to read "1. …  2. …", and a
   * model that echoes the shape it is shown wrote "2. Learning: MQTT" — which
   * splitProse() then failed to find, so the Learning card claimed nothing had
   * been named while the model had named plenty. The parser now copes with the
   * numbering as well; showing a template that invites it was the other half of
   * the same bug, and the cheaper half to fix. */
  lines.push('');
  lines.push('Write three things, in this order, and nothing else.');
  /* With nothing before it there is no change to name, and asking for one
   * anyway is what produced a whole sentence about the absence. The shape is
   * otherwise identical, which is the point: the first range of a new account
   * gets a real summary, not an apology. */
  lines.push(prior
    ? 'First, one or two short lines naming what CHANGED between the two ' +
      'periods — a project dropped entirely, a new one picked up, time moving ' +
      'from one to another. Name the projects, address the person as "you", ' +
      'and write NO hours, minutes or seconds in these lines.'
    : 'First, one or two short lines on what the WORK in this period was ' +
      'actually like — what was being done, and how it went. Name a project ' +
      'only where the point needs it, address the person as "you", and write ' +
      'NO hours, minutes or seconds in these lines.');
  lines.push('In those same lines you may judge the WORK and not only the clock: ' +
             'the sub-tasks say what was actually being done, some of it is ' +
             'inherently slower than the rest, and fewer hours on hard work is ' +
             'not less done. Say that only where the sub-tasks bear it out.');
  lines.push('Then, on a short line of its own, write "Productivity:" followed by ' +
             'your verdict in a few words. Be rational, not encouraging: say ' +
             'plainly when a period was worse, and do not praise, congratulate, ' +
             'advise or reassure. "Productivity: down, and the tasks do not ' +
             'explain it" is a perfectly good answer.');
  lines.push('Then, as a final separate line, write "Learning:" followed by the ' +
             'topics and skills the entries above suggest were being picked up, ' +
             'comma separated. If the entries do not say, write ' +
             '"Learning: not clear from these entries."');
  /* Split on whether the comparison fact exists, and not only for tidiness:
   * pointing at a "Change in focused hours" line that was never written is an
   * invitation to supply one. With nothing to compare, the rule is simply that
   * no figure belongs anywhere in the answer. */
  lines.push(pace && pace.known
    ? 'THE ONE PLACE A FIGURE MAY APPEAR is the Productivity line, and only the ' +
      'two totals in the "Change in focused hours" fact above. Nowhere else.'
    : 'WRITE NO FIGURE ANYWHERE — no hours, no minutes, no seconds, in any of ' +
      'the three lines.');
  lines.push('Never list the projects with their times, and never add up a ' +
             'heading or a period: those figures are drawn on the screen ' +
             'directly above your words, and handing them back is the one thing ' +
             'this summary must not do. They are given to you so you can see ' +
             'what was large and what was small, not so you can repeat them.');
  lines.push('Do not restate the dates, the length of the range, or how many days ' +
             'had entries: same reason.');
  lines.push('No headings, no bullet points, no numbering, no markdown.');

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

/**
 * Every figure a summary is made of, for one span and for the equal-length
 * period before it. Rows in, numbers out: no awaits, no screen, no storage.
 *
 * EXTRACTED WHEN STAGE 6 ARRIVED, and the reason is worth keeping. A saved
 * report needs exactly this arithmetic and none of the drawing, so the report
 * path started life with its own copy of it — and the mutation harness noticed
 * within the hour: three of its mutations stopped being applicable because the
 * line each one breaks had begun to appear twice. Two copies would have been two
 * answers to "how many hours was last week", which is the same argument this
 * repo has already made about two renderers, about one code path reading data,
 * and about a second replayDay() living in Deno.
 *
 * @param rows       one read covering BOTH periods, oldest first.
 * @param win        the span being summarised.
 * @param prior      priorRangeOf(win) — the equal-length period before it.
 * @param priorKnown false when that period reaches back past the first row this
 *                   account has, in which case there is no comparison to make.
 * @param cats       the stored category assignments, passed in rather than read.
 */
function spanFigures(rows, win, prior, priorKnown, cats) {
  /* The whole read goes to summariseRange(), which counts inside the windows
   * only but needs the rows before them as a lead-in. Tasks are this span's. */
  var windows = dayWindows(win.start, win.end);
  var inRange = rowsInWindows(rows, windows);
  var sum = summariseRange(rows, windows);

  /* The earlier period gets EVERYTHING this one gets — its own project totals
   * and its own sub-tasks — because the comparison Saad reads is per project,
   * not per total. Same rows, same one read: rowsInWindows() narrows the wide
   * result twice rather than the database being asked twice. */
  var earlier = null;
  if (priorKnown) {
    var priorWindows = dayWindows(prior.start, prior.end);
    var priorRows = rowsInWindows(rows, priorWindows);
    earlier = { sum: summariseRange(rows, priorWindows),
                tasks: rangeTasks(priorRows), days: prior.days };
  }

  /* The verdict is on FOCUSED hours — office, personal and PhD projects — which
   * is the line Saad drew: "just take the projects and PhD time".
   *
   * `known` needs both periods to have something filed, and that is not the
   * same test as `priorKnown`. A period whose projects have never been put in a
   * kind has 0 focused hours because nobody answered the question, and
   * subtracting one of those from the other would be a difference between two
   * figures that do not exist. The prompt then falls back to the two project
   * lists, which is where the answer really is anyway. */
  var focus = focusOf(sum.byProject, cats);
  var priorFocus = earlier ? focusOf(earlier.sum.byProject, cats) : null;
  var pace = paceOf(focus.ms, priorFocus ? priorFocus.ms : 0, prior,
                    Boolean(priorFocus) && focus.filed && priorFocus.filed);

  // `rows` too: prayerStats() places prayers by prayer day, which can lie just past the windows.
  return { windows: windows, inRange: inRange, rows: rows, sum: sum, tasks: rangeTasks(inRange),
           earlier: earlier, focus: focus, pace: pace };
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

/* WHY THE KEY CARRIES A FINGERPRINT OF THE PROMPT ITSELF.
 *
 * The cache exists so re-opening the tab does not spend one of the day's few
 * calls. It outlived a deploy: the prompt was rewritten, both devices kept
 * replaying prose the OLD prompt had produced, and the change read as though it
 * had never shipped. Saad saw exactly that on his phone and his laptop, hours
 * after the deploy was verified live.
 *
 * The stamp is taken from the SOURCE of the two functions that build the prompt,
 * not from a version number somebody has to remember to raise. A number would
 * have been forgotten the first time it mattered — which is the same argument
 * this repo already made about the secret scan: a check that
 * depends on remembering is not a check. There is no build step here (CLAUDE.md),
 * so the source text is stable between deploys unless it genuinely changed.
 *
 * It over-invalidates: editing a comment inside those functions costs one call.
 * That is the right way round. A stale summary looks like a broken deploy and
 * sends someone hunting through the service worker; one spare call does not. */
var promptStampCache = '';

function promptStamp() {
  if (promptStampCache) return promptStampCache;
  var src = String(reviewPrompt) + String(promptPeriod);
  var h = 5381;
  for (var i = 0; i < src.length; i++) {
    h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;   // djb2-xor, kept unsigned
  }
  promptStampCache = h.toString(36);
  return promptStampCache;
}

function reviewCacheKey(win) {
  return win.id + '|' + ymdLocal(win.start) + '|' + ymdLocal(win.end) + '|' +
         localDayStamp() + '|' + promptStamp();
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
  showPrayerTable($('reviewPrayers'), null);
  showMoneyFigures($('reviewMoney'), null, '');
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
 * screen before a single call is spent, so a spent budget, a refusal or an
 * offline phone each cost one paragraph and leave
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
    var bounds = rangeReadBounds(priorKnown ? prior.start : win.start, win.end);
    rows = await rangeEvents(bounds.startIso, bounds.endIso);
  } catch (err) {
    if (!mine()) return;
    $('reviewNote').textContent = 'Could not read your entries: ' + String(err.message || err);
    return;
  }
  if (!mine()) return;

  /* Every figure, in one call, from the same function the saved reports use —
   * see spanFigures(). Nothing between here and the render below reads the
   * database or the clock. */
  var got = spanFigures(rows, win, prior, priorKnown, projectCategories);
  var sum = got.sum;
  var tasks = got.tasks;

  /* Money is its own read and its own lines: a failure costs those lines, never
   * the review. Drawn before the empty check, since money can be logged on a day
   * with no other entry. */
  var moneyFigs = null;
  var moneyErr = '';
  try {
    moneyFigs = moneySince(moneyFigures(await rangeMoney(windowsStartIso(got.windows),
                                                         windowsEndIso(got.windows)), got.windows),
                           got.windows);
  } catch (err) {
    moneyErr = String((err && err.message) || err);
  }
  if (!mine()) return;
  showMoneyFigures($('reviewMoney'), moneyFigs, moneyErr);

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

  renderReviewFigures(sum);
  showPrayerTable($('reviewPrayers'), prayerStats(got.rows, got.windows));
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

  /* Built here, from the same figures that were just drawn, and handed over
   * finished. addReviewProse() decides whether to SPEND a call; deciding what
   * would be in it is this function's job, and splitting them that way means the
   * prompt can never be built from a different set of numbers than the screen. */
  await addReviewProse(win, reviewPrompt(win, { sum: sum, tasks: tasks }, got.earlier,
                                         projectCategories, got.pace),
                       force, mine);
}

/**
 * Is the model's answer usable, and if not, why not.
 *
 * AN ANSWER WITH NO WORDS IN IT IS NOT AN ANSWER, and is treated exactly like a
 * refusal. geminiCall() turns a `{ok:true, text:""}` reply into an empty string,
 * which used to pass a `=== null` check and then be CACHED as today's summary —
 * blank prose, a Learning card falsely saying nothing had been named, and an
 * empty note with no explanation at all. Worse, a cached blank costs no call to
 * redisplay, so every later visit showed the same nothing and only Regenerate
 * could escape it.
 *
 * One copy, because the review and the saved report both have to make this
 * judgement and it would be indefensible for them to make different ones.
 *
 * @returns {{ok: boolean, why: string}} — `why` is a clause for the note, and is
 *          legitimately empty for a fault nobody can act on. Read `ok`, never
 *          the emptiness of `why`.
 */
function judgeProse(answer) {
  if (answer === null || !String(answer).trim()) {
    /* Say what happened. quotaWait() knows the two ceilings by name; anything
     * else is a fault nobody can do anything about, so it is not put on screen. */
    return { ok: false,
             why: answer === null
               ? quotaWait(lastExtractError)
               : 'Gemini answered with no text. The call is spent either way.' };
  }
  return { ok: true, why: '' };
}

/** The second half: the written lines, which are allowed to fail. Takes the
 *  finished prompt rather than the figures, because the only decision left here
 *  is whether to spend a call on it. */
async function addReviewProse(win, prompt, force, mine) {
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
     * turned away a signed-out session. It is here
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
   * `waitMs`, not `pace`: this file already uses "pace" for the faster/slower
   * verdict, and the two meanings of the word are one letter apart. */
  var waitMs = geminiPacerWaitMs();
  if (waitMs > 0) {
    note.textContent = 'Gemini\'s per-minute limit is full — press Regenerate in about ' +
      Math.ceil(waitMs / 1000) + ' seconds. The figures above are already complete.';
    $('reviewLearning').textContent = 'Needs the written summary.';
    return;
  }

  note.textContent = 'Writing the summary…';
  var answer = await askReviewProse(prompt);
  if (!mine()) return;

  paintReviewUsage();

  // Say what happened AND that it does not matter much, in that order.
  var verdict = judgeProse(answer);
  if (!verdict.ok) {
    note.textContent = 'No written summary this time' +
      (verdict.why ? ' — ' + verdict.why : '.') +
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
  /* The reports come AFTER the review has finished, never alongside it. Both
   * halves of this screen can spend a Gemini call, the day allows about twenty
   * in total, and two spent on one tab open is a tenth of the day gone before
   * anything has been read. Chained rather than started together so the budget
   * check below sees the review's call already counted. */
  runReview(false).then(refreshReports, refreshReports);
}

// ------------------------------------------------------------------ reports

/* WHY REPORTS ARE MADE HERE AND NOT BY A SERVER AT MIDNIGHT.
 *
 * The obvious shape for a weekly report is pg_cron waking an Edge Function on
 * Monday morning. Three things stop it, and they are written down because the
 * idea will come back:
 *
 *   - the gemini Edge Function refuses any token whose role is not
 *     `authenticated`, and a scheduled job holds `service_role`. It would be
 *     turned away with a 401 before it ever reached the model;
 *   - the four headings a report groups work under live in THIS BROWSER, in
 *     localStorage under `probeing.categories`. A server cannot read them, so
 *     its report could not have the shape docs/Review_Spec.md asks for;
 *   - and replayDay() would have to exist a second time, in Deno. This repo
 *     already has one story about a live copy drifting from the repo (the
 *     `goals` action) and does not need a second one where the two copies
 *     disagree about how many hours a week was.
 *
 * So the app writes the report when the Review tab is opened, and Postgres
 * keeps it. Scheduling belongs to Stage 7, where push notifications give a
 * server a reason to be awake at 11:30 PM at all.
 *
 * A report is the Review screen's own summary for a fixed span — the same
 * figures, the same prompt, ONE call — with the answer saved instead of cached.
 * Nothing here loops the model over days, projects or prayers.
 */

/* Week before month, and the order is load-bearing: at most one report is
 * written per tab open, so the first of these that is missing is the one that
 * gets written and the other waits for the next visit. The recent one is the
 * one somebody would look for. */
var REPORT_PERIODS = ['week', 'month'];

/* How many reports the list shows. Roughly a year of weeks and months, which is
 * more history than this screen has any way of filling yet. */
var REPORT_LIST_MAX = 24;

/**
 * The span a report covers: the last COMPLETE one of its kind, never the one in
 * progress. Takes `now` rather than reading the clock, so the tests can ask for
 * any day.
 *
 * A week is the picker's own "Last week", by calling it rather than by copying
 * it — one definition of Monday-to-Sunday, used by two screens, so they cannot
 * drift apart.
 *
 * A month is the previous calendar month on every day INCLUDING the 1st: asked
 * on 1 September, August has just finished and is exactly what is wanted, and
 * the month in progress is never reported on for the same reason "This week" is
 * not — days that have not happened drag every average down.
 *
 * Anything that is not 'month' is a week, which mirrors reviewRangeOf() falling
 * back to a real range rather than crashing on an id it does not know.
 */
function reportRangeOf(period, now) {
  if (period === 'month') {
    // The counter day: before the rollover on the 1st, last month is not over.
    var today = counterToday(now);
    var start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    /* Day 0 of this month is the last day of the previous one, and Date rolls
     * January back into December by itself — so no month-length table, and no
     * February special case. */
    var end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { period: 'month', label: monthLabel(start), start: start, end: end };
  }

  var lw = reviewRangeOf('lw', now);
  return { period: 'week', label: 'Last week', start: lw.start, end: lw.end };
}

/** "August 2026", in whatever the device calls August. */
function monthLabel(d) {
  try {
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  } catch (e) {
    return ymdLocal(d).slice(0, 7);        // a browser that cannot format it
  }
}

/** 'YYYY-MM-DD' as "31 Aug 2026". Split by hand, because new Date('2026-08-31')
 *  is midnight UTC — which is the day BEFORE in every zone west of London, and
 *  a report titled with the wrong day is exactly the kind of small lie this
 *  screen must not tell. */
function humanYmd(ymd) {
  var p = String(ymd || '').slice(0, 10).split('-');
  if (p.length !== 3) return String(ymd || '');

  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  if (isNaN(d.getTime())) return String(ymd || '');
  try {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) {
    return String(ymd);
  }
}

/** "Last week (31 Aug 2026 – 6 Sep 2026)" — a span named in full, for a note
 *  that has to say which one it is talking about. */
function spanText(win) {
  return win.label + ' (' + humanYmd(ymdLocal(win.start)) + ' – ' +
         humanYmd(ymdLocal(win.end)) + ')';
}

/**
 * The half of a saved report that is not prose: NUMBERS ONLY.
 *
 * `text` is what Gemini wrote; `stats` is what this device counted. Keeping them
 * in separate columns is what makes the honesty check possible at all — the M
 * count in a saved report can be compared against a hand count of the raw rows
 * without anybody parsing English out of a paragraph. Not one sentence belongs
 * in here.
 */
function reportStats(sum, prayers, money) {
  var stats = {
    worked: sum.worked,
    paused: sum.paused,
    unattributed: sum.unattributed,
    byProject: sum.byProject,
    byReason: sum.byReason,
    m: sum.m,
    prayers: sum.prayers,
    prayerBreakdown: prayers,
    sleep: sum.sleep,
    days: sum.days,
    daysWithRows: sum.daysWithRows,
    avgWorked: sum.avgWorked
  };
  if (money) stats.money = money;              // Stage 11; never shown to Gemini
  return stats;
}

/** Every saved report, newest first. Re-read on every visit and never cached —
 *  rule 3 applies to a report exactly as it does to today's rows. */
async function savedReports() {
  if (!sb || !sbUser) throw new Error('Sign in to read your reports.');

  var res = await sb.from('reports')
    .select('period,start_date,end_date,text,stats,model,generated_at')
    .order('start_date', { ascending: false })
    .order('generated_at', { ascending: false })
    .limit(REPORT_LIST_MAX);
  if (res.error) throw errorFrom(res.error);
  return res.data || [];
}

/**
 * Write the report, replacing whatever was there for the same span.
 *
 * The conflict target is the unique index in docs/supabase_schema.sql,
 * (user_id, period, start_date), so pressing Generate twice for one week leaves
 * one row and not two. Two things are sent that could in principle be defaulted,
 * and both are deliberate: `user_id`, because the conflict target names it and
 * a half-specified target is a silent second row; and `generated_at`, because a
 * column default only fires on an INSERT — without it a rewritten report would
 * still be stamped with the moment the first version was written.
 *
 * This needs an UPDATE policy on `reports`, which the schema file now carries.
 * Rewriting a report is not the same as rewriting an event: an event is a fact
 * and is append-only, a report is derived from those facts and may legitimately
 * be rebuilt from them.
 */
async function saveReport(win, text, stats, model) {
  var res = await sb.from('reports').upsert({
    user_id: sbUser.id,
    period: win.period,
    start_date: ymdLocal(win.start),
    end_date: ymdLocal(win.end),
    text: String(text || ''),
    stats: stats,
    model: String(model || ''),
    generated_at: new Date().toISOString()
  }, { onConflict: 'user_id,period,start_date' });
  if (res.error) throw errorFrom(res.error);
}

/** "Week · 31 Aug 2026 – 6 Sep 2026". Built from the dates the report was SAVED
 *  with, never from today's clock, so an old report is titled by the days it
 *  actually covers. */
function reportHeading(row) {
  return (row.period === 'month' ? 'Month' : 'Week') + ' · ' +
         humanYmd(row.start_date) + ' – ' + humanYmd(row.end_date);
}

/** The one line of figures under a saved report's heading, read out of `stats`
 *  — the copy that was true when it was written. Never recomputed here, or the
 *  numbers would quietly disagree with the words printed beside them. */
function reportFigureLine(stats) {
  var bits = [reviewDuration(stats.worked || 0) + ' worked'];
  if (stats.avgWorked) bits.push(reviewDuration(stats.avgWorked) + ' per day');
  bits.push(Number(stats.m || 0) + ' M');
  bits.push(Number(stats.prayers || 0) + ' prayers');
  if (stats.days) bits.push(Number(stats.daysWithRows || 0) + '/' + Number(stats.days) +
                            ' days logged');
  // Reports from before Stage 11 have no money, and a week with none says nothing.
  var money = stats.money;
  var loans = money && (Number(money.loanOut) || Number(money.loanIn));
  // Saved since feedback 1 (duesInOut), out/in include cash dues; before, they did not.
  // The words differ, so an old report and a new one cannot be read alike.
  var incl = money && money.duesInOut === true;
  function part(n, word, dues) {
    return formatPkr(n) + ' ' + word + (incl && Number(dues) ? ' (incl. dues ' + formatPkr(dues) + ')' : '');
  }
  if (money && (Number(money.out) || Number(money['in']) || loans)) {
    bits.push('PKR ' + part(money.out, 'out', money.loanOut) + ' · ' + part(money['in'], 'in', money.loanIn) + ' · net ' +
              signedPkr(money.net) + (money.since ? ' since ' + moneySinceDay(money) : ''));
  }
  if (loans && !incl) {
    bits.push('cash dues not in these: ' + formatPkr(money.loanOut || 0) + ' paid · ' +
              formatPkr(money.loanIn || 0) + ' received');
  }
  return bits.join(' · ');
}

/** The prayer x mode table from prayerStats() or a saved report's copy of it;
 *  null when `stats` has no breakdown. Text only (rule 5). */
function prayerTable(stats) {
  if (!stats || !Array.isArray(stats.byPrayer) || !stats.byPrayer.length) return null;
  var modes = Array.isArray(stats.modes) && stats.modes.length ? stats.modes : PRAYER_MODES;
  // A column for prayers logged with no mode, only when there are any.
  var noMode = stats.byPrayer.some(function (p) { return Number(p && p.noMode) > 0; });

  function cell(row, tag, text, title) {
    var c = document.createElement(tag);
    c.textContent = text;
    if (title) c.setAttribute('title', title);
    row.appendChild(c);
    return c;
  }

  var table = document.createElement('table');
  table.className = 'prayer-table';
  var head = document.createElement('thead');
  var hr = document.createElement('tr');
  cell(hr, 'th', '');
  // "Takbeer", "Partial", "Individual": the first word, with the full name on hover.
  modes.forEach(function (m) { cell(hr, 'th', String(m).split(/[\s-]/)[0], String(m)); });
  if (noMode) cell(hr, 'th', 'No mode');
  cell(hr, 'th', 'Missed');
  head.appendChild(hr);

  var body = document.createElement('tbody');
  stats.byPrayer.forEach(function (p) {
    p = p || {};
    var tr = document.createElement('tr');
    cell(tr, 'th', String(p.name || '')).setAttribute('scope', 'row');
    var by = (p.byMode && typeof p.byMode === 'object') ? p.byMode : {};
    modes.forEach(function (m) { cell(tr, 'td', String(Number(by[m]) || 0)); });
    if (noMode) cell(tr, 'td', String(Number(p.noMode) || 0));
    cell(tr, 'td', String(Number(p.missed) || 0)).className = 'prayer-missed';
    body.appendChild(tr);
  });
  table.append(head, body);

  // Missed only counts finished days with something logged; say how many.
  // Reports saved before these fields existed only cover finished days.
  var note = document.createElement('p');
  note.className = 'prayer-note';
  var judged = stats.daysJudged === undefined ? stats.daysWithRows : stats.daysJudged;
  var finished = stats.daysFinished === undefined ? stats.days : stats.daysFinished;
  var text = 'Missed counts days with entries but no such prayer (' +
    (Number(judged) || 0) + ' of ' + (Number(finished) || 0) + ' finished days had entries).';
  if (Number(stats.days) > Number(finished)) {
    text += ' Today counts a prayer as missed once the next one has begun, and Isha once the day turns.';
  }
  if (Number(stats.repeats) > 0) text += ' A prayer logged twice in a day counts once.';
  var other = Number(stats.other) || 0;
  if (other) text += other === 1 ? ' 1 prayer row had another name and is not in the table.'
                                  : ' ' + other + ' prayer rows had another name and are not in the table.';
  note.textContent = text;

  var box = document.createElement('div');
  box.className = 'prayer-box';
  box.append(table, note);
  return box;
}

/** Draw the table into `box`, or empty and hide it. */
function showPrayerTable(box, stats) {
  box.textContent = '';
  var table = prayerTable(stats);
  if (table) box.appendChild(table);
  box.hidden = !table;
}

/**
 * The saved reports, newest first.
 *
 * textContent on every string here, and rule 5 is only half the reason: the
 * project names inside `stats` are what Saad typed, and `text` came out of a
 * language model, which is text this app trusts even less than its own user's.
 * Nothing on this path builds markup from a string.
 */
function renderReports(rows) {
  var box = $('reportList');
  box.textContent = '';

  (rows || []).forEach(function (r) {
    var stats = (r.stats && typeof r.stats === 'object') ? r.stats : {};

    var li = document.createElement('li');

    var head = document.createElement('p');
    head.className = 'report-head';
    head.textContent = reportHeading(r);

    var figs = document.createElement('p');
    figs.className = 'report-figs';
    figs.textContent = reportFigureLine(stats);

    var body = document.createElement('p');
    body.className = 'report-text';
    body.textContent = String(r.text || '');

    li.append(head, figs);
    var prayers = prayerTable(stats.prayerBreakdown);
    if (prayers) li.appendChild(prayers);
    li.appendChild(body);
    box.appendChild(li);
  });
}

/**
 * One report: the figures worked out on this device, ONE Gemini call for the
 * words, and a row in `reports`.
 *
 * It reuses the Review screen's own prompt on purpose. The report IS that
 * screen's summary for a fixed span, and a second prompt would be a second
 * voice and twice as much to keep true — the Stage 5 lesson, where one prompt
 * edit had to invalidate every cached summary on both devices.
 *
 * THE MODEL IS NEVER LOOPED. One call, for the whole span, over figures that
 * are already finished. A call per day, per project or per prayer is the
 * failure mode `docs/ProBeing_Execution_Plan.md` names, and against twenty
 * calls a day it is fatal rather than merely slow.
 *
 * @returns a sentence saying what went wrong, for the note under the list, or
 *          '' when the report was written and saved.
 */
async function generateReport(win) {
  // Before anything is read: a span reaching back past the first row is refused
  // by name, never answered with a confident zero for the days before it.
  var floor = await checkRangeFloor(win.start);
  if (!floor.ok) return floor.message;

  var prior = priorRangeOf(win);
  var priorKnown = rangeFloor(prior.start, floor.earliest).ok;

  // One read covering both spans, exactly as runReview() does it.
  var bounds = rangeReadBounds(priorKnown ? prior.start : win.start, win.end);
  var rows = await rangeEvents(bounds.startIso, bounds.endIso);

  /* THE SAME ARITHMETIC THE REVIEW SCREEN DRAWS, out of the same function. Not
   * a copy of it: a second copy would be a second answer to "how many hours was
   * last week", and the saved report would slowly stop matching the screen. */
  var got = spanFigures(rows, win, prior, priorKnown, projectCategories);

  if (got.sum.empty) {
    /* Nothing was logged, so there is nothing for a paragraph to be about and
     * no call is spent. Saving an empty report would also make this span read
     * as "already reported" for ever. */
    return 'Nothing was logged between ' + ymdLocal(win.start) + ' and ' +
           ymdLocal(win.end) + ', so there is no report to write. No Gemini call was used.';
  }

  var prompt = reviewPrompt(win, { sum: got.sum, tasks: got.tasks }, got.earlier,
                            projectCategories, got.pace);

  /* Money is read before the one call, so a failed read costs no call, and a
   * failure stops the report: it is written once, and must not miss the money. */
  var money = moneySince(moneyFigures(await rangeMoney(windowsStartIso(got.windows),
                                                       windowsEndIso(got.windows)), got.windows),
                         got.windows);

  /* Checked HERE rather than by the caller, and checked twice over. Everything
   * above this line is free — no call has left the device — and the pacer's
   * answer thirty seconds ago is not its answer now. */
  if (!canAskGemini()) {
    return geminiCallsLeft() <= 0
      ? quotaWait(GEMINI_BUDGET_SPENT) + ' The report can be written tomorrow, ' +
        'and nothing is lost by waiting: it is worked out from rows that are not going anywhere.'
      : 'The report needs Gemini, which is unavailable right now.';
  }
  var waitMs = geminiPacerWaitMs();
  if (waitMs > 0) {
    return 'Gemini\'s per-minute limit is full — try again in about ' +
           Math.ceil(waitMs / 1000) + ' seconds.';
  }

  var answer = await askReviewProse(prompt);      // the one call, and the only one
  paintReviewUsage();

  /* NOTHING IS SAVED WITHOUT WORDS. A row with an empty `text` would count as
   * "this span has been reported" for ever and the span would never be written
   * properly. Refusing costs nothing: the figures are recomputed from the rows
   * every time anyway. Judged by the same function the review screen uses, so
   * the two cannot come to different conclusions about the same reply. */
  var verdict = judgeProse(answer);
  if (!verdict.ok) {
    return 'No report written' + (verdict.why ? ' — ' + verdict.why : '.') +
           ' Nothing was saved.';
  }

  await saveReport(win, answer,
                   reportStats(got.sum, prayerStats(got.rows, got.windows), money),
                   lastGeminiModel);
  return '';
}

/* HOW MUCH OF THE DAY MUST BE LEFT before a report is written WITHOUT being
 * asked for. Opening a tab must never spend the last call: the ones after it
 * are what name the projects on everything Saad logs for the rest of the day,
 * and a report is worth less than that. Below this line the button appears and
 * says so — the same decision, made out loud instead of silently. */
var REPORT_AUTO_RESERVE = 3;

/* Which spans have already been attempted in this page's lifetime AND cost a
 * call. Review is a tab somebody flicks in and out of, and a refused call is
 * spent whether or not it answered — without this a bad afternoon could spend
 * the whole allowance three taps at a time. Only failures that really sent
 * something are recorded, so a refusal that cost nothing (a span before the
 * first row, a span with no entries) is free to be re-read next time. In memory
 * only: a reload is a fresh decision. */
var reportTried = userMap();

/** The span the button will write. Held here because the button is wired once
 *  at load and the list is drawn many times. */
var reportWanted = null;

/** One at a time. Two fast tab switches must not start two reports, which is
 *  two Gemini calls for one thing nobody asked for twice. */
var reportsBusy = false;

/**
 * The first span with no report saved for it, or null when there is nothing
 * left that can be written. Compared on (period, start_date), which is the same
 * pair the unique index uses — so "already reported" means exactly what the
 * database means by it.
 *
 * A SPAN THE FLOOR REFUSES IS NOT MISSING, IT IS UNREPORTABLE. Telling those two
 * apart is the whole job of `earliestAt`, and treating them as one thing is a
 * button that never changes: August 2026 opens on the 1st, this account's first
 * row is the 27th, so August can never be written — offered on every visit,
 * refused the instant it is pressed, and hiding the rewrite path for the week
 * that did work behind it. Skipping it costs nothing, because a span that opens
 * before the first row has no rows for a report to be about.
 *
 * @param earliestAt the account's min(at) as an ISO instant, or '' when there
 *        are no rows at all — which makes every span unreportable, and for an
 *        empty account that is the right answer rather than an edge case.
 * @param pending local dates ('YYYY-MM-DD') that still have an entry waiting on
 *        this device. A SPAN WITH ONE IS NOT WRITTEN AT ALL. A report is written
 *        once, when Review opens, so a Sunday 23:58 entry sent on Monday would
 *        otherwise be missing from last week's report for good. Waiting costs a
 *        visit; writing early costs the record.
 */
function missingReport(saved, now, earliestAt, pending) {
  var have = userMap();                    // keyed by period|date, so no prototype
  (saved || []).forEach(function (r) {
    have[String(r.period) + '|' + String(r.start_date).slice(0, 10)] = 1;
  });

  var want = null;
  REPORT_PERIODS.forEach(function (period) {
    if (want) return;
    var win = reportRangeOf(period, now);
    if (!rangeFloor(win.start, earliestAt).ok) return;   // unreportable, so skip it
    if (spanHasPending(win, pending)) return;            // incomplete, so not yet
    if (have[win.period + '|' + ymdLocal(win.start)] !== 1) want = win;
  });
  return want;
}

/** Does `win` contain a day with something still unsent on this device? */
function spanHasPending(win, pending) {
  if (!pending || !pending.length) return false;
  var from = ymdLocal(win.start);
  var to = ymdLocal(win.end);
  return pending.some(function (d) { return d >= from && d <= to; });
}

/** Write `win`'s report and put the refreshed list on screen. Returns a sentence
 *  for the note — empty when it worked. */
async function writeReport(win) {
  $('reportNote').textContent = 'Writing the report for ' + spanText(win) +
    ' — one Gemini call…';

  var trouble;
  try {
    trouble = await generateReport(win);
  } catch (err) {
    trouble = 'Could not write the report: ' + String((err && err.message) || err);
  }
  if (trouble) return trouble;

  try {
    renderReports(await savedReports());
  } catch (err) {
    return 'The report was saved, but the list could not be re-read: ' +
           String((err && err.message) || err);
  }
  return '';
}

/**
 * The Past Reports half of the screen: read what is saved, draw it, and write
 * the missing one — but only when there is room in the day to do it unasked.
 *
 * Never throws. This runs after the review has drawn itself, and a report that
 * cannot be written must cost a line of explanation and nothing else.
 *
 * DELIBERATELY NOT CALLED BY THE BUTTON. Pressing Write is one decision to spend
 * one call, and re-entering here afterwards would find the OTHER span still
 * missing and write that too — two calls for one press. The button therefore
 * updates the list and its own label itself, and the next visit picks up
 * whatever is still outstanding.
 */
async function refreshReports() {
  if (reportsBusy) return;
  reportsBusy = true;

  try {
    var note = $('reportNote');
    var btn = $('reportMakeBtn');
    btn.hidden = true;
    reportWanted = null;

    if (!supabaseReady()) {
      $('reportList').textContent = '';
      note.textContent = 'Saved reports need a signed-in account.';
      return;
    }

    var saved;
    try {
      saved = await savedReports();
    } catch (err) {
      note.textContent = 'Could not read your saved reports: ' +
                         String((err && err.message) || err);
      return;
    }
    renderReports(saved);
    note.textContent = saved.length ? '' : 'No reports saved yet.';

    var now = new Date();

    /* How far back the data goes, read before anything is decided, because a
     * span that opens before the first row cannot be reported at all and must
     * not be what the button advertises. One indexed row — nowhere near a
     * Gemini call. */
    var earliest;
    try {
      earliest = await earliestEventAt();
    } catch (err) {
      /* No button, deliberately: its label and its target both come from
       * `earliest`, so offering one here risks spending a Gemini call on the
       * wrong month. But every other refusal on this card ends with something
       * Saad can do, and this one ended with a browser's own error string.
       * Reopening the tab IS the retry — showScreen('review') calls
       * openReview() on every visit — and nothing said so. */
      note.textContent = 'Could not check how far back your data goes: ' +
                         String((err && err.message) || err) +
                         '. Open this tab again to retry.';
      return;
    }

    var pending = queuedDates();
    var want = missingReport(saved, now, earliest, pending);

    /* With nothing missing the button still points at the last complete week,
     * so a report can be rewritten deliberately — a week whose projects have
     * since been filed under their headings reads quite differently. Pressing it
     * overwrites that week's row rather than adding a second one; the unique
     * index sees to that. That fallback is offered only when the week is itself
     * inside the data, for the same reason an unreportable span is skipped
     * above: a button that is refused every time it is pressed is worse than no
     * button. */
    var week = reportRangeOf('week', now);
    var weekFloor = rangeFloor(week.start, earliest);
    var weekPending = spanHasPending(week, pending);
    reportWanted = want || (weekFloor.ok && !weekPending ? week : null);

    if (!reportWanted) {
      /* Nothing here can be written yet — not even a rewrite. Name the span and
       * give the reason, rather than leaving a card with no button and no
       * explanation for why. */
      note.textContent = weekPending
        ? spanText(week) + ' still has an entry waiting to be sent from this ' +
          'device, so its report is held back — it would be written without that ' +
          'entry, and a report is only written once.'
        : spanText(week) + ': ' + weekFloor.message;
      return;
    }

    var kind = reportWanted.period === 'week' ? 'weekly' : 'monthly';
    btn.textContent = (want ? 'Write the ' : 'Rewrite the ') + kind + ' report';
    btn.hidden = false;

    if (!want) return;

    var key = want.period + '|' + ymdLocal(want.start) + '|' + localDayStamp();
    var left = geminiCallsLeft();
    var waitMs = geminiPacerWaitMs();
    var why = '';

    if (reportTried[key] === 1) why = 'It was tried a moment ago and did not work.';
    else if (left <= REPORT_AUTO_RESERVE) {
      why = 'It was not written by itself because only ' + left + ' of today\'s ' +
            geminiDailyBudget() + ' Gemini calls are left, and opening a tab must ' +
            'never spend the last of them.';
    } else if (waitMs > 0) {
      why = 'Gemini\'s per-minute limit is full for another ' +
            Math.ceil(waitMs / 1000) + ' seconds.';
    }

    if (why) {
      note.textContent = spanText(want) + ' has no report yet. ' + why +
        ' Press the button to write it anyway — it costs a single Gemini call.';
      return;
    }

    var before = geminiUsedToday();
    var trouble = await writeReport(want);
    if (geminiUsedToday() > before) reportTried[key] = 1;

    /* Named, exactly as the branch above names it. This sentence lands under a
     * list that may have another span's report sitting at the top of it, and a
     * bare "No data before …" then reads as a verdict on the report you can
     * see rather than on the one that was refused. */
    note.textContent = trouble ? spanText(want) + ': ' + trouble : '';
    // It exists now, so the button's job changes from writing to rewriting.
    if (!trouble) btn.textContent = 'Rewrite the ' + kind + ' report';
  } finally {
    reportsBusy = false;
  }
}

$('reportMakeBtn').addEventListener('click', async function () {
  var win = reportWanted;
  if (!win || reportsBusy) return;

  reportsBusy = true;
  this.disabled = true;
  try {
    var trouble = await writeReport(win);
    $('reportNote').textContent = trouble;
    if (!trouble) {
      this.textContent = 'Rewrite the ' +
        (win.period === 'week' ? 'weekly' : 'monthly') + ' report';
    }
  } finally {
    this.disabled = false;
    reportsBusy = false;
  }
});

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
var catSettingsShown = null;   // each Settings row's stored kind as drawn; Save writes only changes

/** The Settings kinds the user actually changed since the list was drawn, so an
 *  untouched Save cannot write back a kind another tab has since forgotten. */
function settingsCategoryEdits() {
  var picks = catSettingsRead ? catSettingsRead() : {};
  var out = userMap();
  Object.keys(picks).forEach(function (k) {
    if (!catSettingsShown || picks[k] !== (catSettingsShown[k] || '')) out[k] = picks[k];
  });
  return out;
}

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
  projectCategories = loadProjectCategories();   // storage wins over this tab's copy
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

/** `chosen` defaults to the stored kinds; a redraw passes the unsaved picks. */
function renderCategorySettings(chosen) {
  projectCategories = loadProjectCategories();   // storage wins over this tab's copy
  var names = categorySettingsNames();
  catSettingsRead = renderCategoryRows($('catSettings'), names, chosen || projectCategories);
  catSettingsShown = userMap();
  names.forEach(function (n) { catSettingsShown[catKey(n)] = projectCategories[catKey(n)] || ''; });
  $('catSettingsNote').textContent = names.length ? '' :
    'No projects yet — log some work and they will appear here.';
}

/** The learned names, each with Forget (and Forget kind when it has one).
 *  Pinned names are left out: their box above is where they are edited. */
function renderLearnedNames() {
  var box = $('learnedNames');
  box.textContent = '';
  recentProjects = loadProjectNames();

  var pinned = userMap();
  pinnedNames.forEach(function (n) { pinned[n.toLowerCase()] = 1; });
  var names = recentProjects.filter(function (n) { return pinned[n.toLowerCase()] !== 1; });

  if (!names.length) {
    var none = document.createElement('p');
    none.className = 'hint';
    none.textContent = 'Nothing learned yet.';
    box.appendChild(none);
    return;
  }

  names.forEach(function (name) {
    var kind = projectCategories[catKey(name)] || '';
    var row = document.createElement('div');
    row.className = 'cat-row';

    var label = document.createElement('span');
    label.className = 'cat-name';
    label.textContent = name + (kind ? ' · ' +
      (kind === CATEGORY_SKIP ? 'not one of the four' : categoryLabel(kind)) : '');
    row.appendChild(label);

    var acts = document.createElement('span');
    acts.className = 'learned-acts';
    var button = function (text, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn';
      b.textContent = text;
      b.addEventListener('click', fn);
      acts.appendChild(b);
    };
    if (kind) {
      button('Forget kind', function () {
        forgetCategory(name);
        redrawForgotten(catKey(name));
        flash('Forgot the kind of work for “' + name + '”', 'ok');
      });
    }
    button('Forget', function () {
      forgetProject(name);
      redrawForgotten('');
      flash('Forgot “' + name + '”', 'ok');
    });
    row.appendChild(acts);
    box.appendChild(row);
  });
}

/** Redraw both Settings lists after a Forget, keeping unsaved picks in the
 *  kinds list — but not for `droppedKey`, or Save would write it straight back. */
function redrawForgotten(droppedKey) {
  var shown = mergedCategories(settingsCategoryEdits());
  if (droppedKey) delete shown[droppedKey];
  renderCategorySettings(shown);
  renderLearnedNames();
}

// ------------------------------------------------------------ money screen

/* Stage 11, reshaped by Money 2 (1 Oct). Expense is picked already, so spending
 * is the digits, a tag and Save. Save hands the row to api(), which holds it on
 * the device before anything is sent; nothing on that path waits for a read.
 * The history is in the Logs dialog, so nothing on the screen grows with it. */

var MONEY_TAGS_KEY = 'probeing.moneytags';
// Saad's list (feedback 1), shown in this order. A typed tag is never added to it.
var MONEY_DEFAULT_TAGS = {
  out: ['Food', 'Laundry', 'Groceries', 'Transport', 'Shopping', 'Family', 'Health'],
  'in': ['Salary']
};
// A saved list without this version is replaced by the defaults once, on both copies.
var MONEY_TAGS_VERSION = 2;
// The same limits as the checks in docs/supabase_schema.sql.
var MONEY_TAG_MAX = 40;
var MONEY_NOTE_MAX = 200;
var MONEY_TAGS_MAX = 30;
var MONEY_PAGE = 1000;          // rows per request: Supabase hands back at most 1000 at once

var moneyRows = [];             // every money row, from the last read
var moneyLocal = [];            // saved on this page and not yet seen in a read
var moneyReadAt = 0;
var moneyWhy = '';              // why the last read failed, or ''
var moneyReadSeq = 0;
var moneyReadTimer;
var moneyForm = { dir: 'out', tag: '' };
var logsDlg = $('logsDlg');
var duesDlg = $('duesDlg');
var dueDlg = $('dueDlg');
var settleDlg = $('settleDlg');
var walletDlg = $('walletDlg');

/** Trimmed, no commas, no repeats whatever the case, at most MONEY_TAGS_MAX. */
function cleanTags(list) {
  var seen = userMap();
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (t) {
    var tag = String(t === null || t === undefined ? '' : t).replace(/,/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, MONEY_TAG_MAX);
    var key = tag.toLowerCase();
    if (!tag || seen[key] === 1 || out.length >= MONEY_TAGS_MAX) return;
    seen[key] = 1;
    out.push(tag);
  });
  return out;
}

/** This device's copy. One saved before MONEY_TAGS_VERSION becomes the defaults;
 *  the next sync then adopts the server's list if it is migrated, or sends these. */
function loadMoneyTags() {
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(MONEY_TAGS_KEY)); } catch (e) { /* the defaults */ }
  if (saved && typeof saved === 'object' && !Array.isArray(saved) && saved.v === MONEY_TAGS_VERSION) return saved;
  return { out: MONEY_DEFAULT_TAGS.out.slice(), 'in': MONEY_DEFAULT_TAGS['in'].slice(),
           v: MONEY_TAGS_VERSION, synced: true };
}

// {out, in, v, synced}: this device's copy of user_settings.money_tags, so the
// chips work offline. `synced` false means the server has not got it yet.
var moneyTags = loadMoneyTags();

function saveMoneyTags() {
  try { localStorage.setItem(MONEY_TAGS_KEY, JSON.stringify(moneyTags)); } catch (e) { /* kept for this visit */ }
}

/** His fixed list for a direction, or the defaults. */
function fixedTags(dir) {
  var mine = cleanTags(moneyTags[dir]);
  return mine.length ? mine : MONEY_DEFAULT_TAGS[dir].slice();
}

/** Both lists to user_settings. Only money_tags is sent, so updated_at, which
 *  decides whose prayer place wins, does not move. */
async function pushMoneyTags() {
  if (!supabaseReady()) throw new Error('Sign in first.');
  var res = await sb.from('user_settings').upsert({
    user_id: sbUser.id, money_tags: { v: MONEY_TAGS_VERSION, out: fixedTags('out'), 'in': fixedTags('in') }
  }, { onConflict: 'user_id' });
  if (res.error) throw errorFrom(res.error);
  moneyTags.synced = true;
  saveMoneyTags();
}

async function pullMoneyTags() {
  var got = await sb.from('user_settings').select('money_tags').eq('user_id', sbUser.id).limit(1);
  if (got.error) throw errorFrom(got.error);
  var t = ((got.data || [])[0] || {}).money_tags;
  // None saved, or a list from before MONEY_TAGS_VERSION: the server takes ours (the defaults, once).
  if (!t || typeof t !== 'object' || Array.isArray(t) || t.v !== MONEY_TAGS_VERSION) {
    await pushMoneyTags();
    return;
  }
  moneyTags = { out: cleanTags(t.out), 'in': cleanTags(t['in']), v: MONEY_TAGS_VERSION, synced: true };
  saveMoneyTags();
  if (moneyTagsIdle()) renderMoneyTags();                          // never under a finger
}

/* At sign-in, like the prayer place: a change the server never got goes up,
 * otherwise the server's copy is read. */
async function syncMoneyTags() {
  if (!supabaseReady()) return;
  try {
    if (moneyTags.synced === false) await pushMoneyTags();
    else await pullMoneyTags();
  } catch (e) { /* tried again at the next sign-in; this device keeps its list */ }
}

/** From Settings. Empty means the defaults. */
function changeMoneyTags(outTags, inTags) {
  var next = { out: outTags.length ? outTags : MONEY_DEFAULT_TAGS.out.slice(),
               'in': inTags.length ? inTags : MONEY_DEFAULT_TAGS['in'].slice() };
  if (next.out.join('\n') === fixedTags('out').join('\n') &&
      next['in'].join('\n') === fixedTags('in').join('\n')) return;
  moneyTags = { out: next.out, 'in': next['in'], v: MONEY_TAGS_VERSION, synced: false };
  saveMoneyTags();
  renderMoneyTags();
  if (!supabaseReady()) return;
  pushMoneyTags().catch(function (err) {
    flash('Money tags saved on this device, but not on the server (' +
      String((err && err.message) || err) + '). Sent again next time the app opens.', 'warn');
  });
}

/** The read's rows, rows saved since, and what the outbox holds; newest first. */
function moneyMerged() {
  var have = userMap();
  var out = moneyRows.slice();
  out.forEach(function (r) { if (r.rid) have[r.rid] = 1; });
  function add(r) {
    if (r.rid && have[r.rid] === 1) return;
    if (r.rid) have[r.rid] = 1;
    out.push(r);
  }
  moneyLocal.forEach(add);
  outboxOurs().filter(moneyItem).map(queuedMoney).forEach(add);
  return out.sort(function (a, b) { return (instantOf(b.at) || 0) - (instantOf(a.at) || 0); });
}

/** "Spent 450 · Food", "Lent 2,000 · Ali", "Ali owes you 500" or "Wallet set
 *  to 9,000", for the parked list, the confirm and the banner. */
function moneyWhat(r) {
  var amount = formatPkr(moneyPaisa(r.amount) / 100);
  var pre = r.voids_rid ? 'Void of ' : '';
  var person = String(r.person || '');
  if (r.kind === 'opening') return pre + 'Wallet set to ' + amount;
  if (r.kind === 'due') {
    return pre + (r.dir === 'they_owe' ? person + ' owes you ' + amount : 'You owe ' + person + ' ' + amount);
  }
  if (r.kind === 'loan') return pre + String(r.tag || 'Due') + ' ' + amount + ' · ' + person;
  return pre + (r.dir === 'in' ? 'Got ' : 'Spent ') + amount + ' · ' + String(r.tag || '');
}

/** A range's money as a few lines; none when nothing was logged. */
function moneyLines(figs) {
  if (!figs || !(figs.entries || figs.loans)) return [];
  function byAmount(map) {
    return Object.keys(map).sort(function (a, b) { return (map[b] - map[a]) || (a < b ? -1 : 1); })
      .map(function (k) { return k + ' ' + formatPkr(map[k]); }).join(' · ');
  }
  var lines = ['PKR ' + formatPkr(figs.out) + ' spent · ' + formatPkr(figs['in']) + ' in · net ' +
               signedPkr(figs.net) + (figs.since ? ' since ' + moneySinceDay(figs) : '')];
  if (Object.keys(figs.byTagOut).length) lines.push('Spent on: ' + byAmount(figs.byTagOut));
  if (Object.keys(figs.byTagIn).length) lines.push('In from: ' + byAmount(figs.byTagIn));
  // Cash dues are already in the lines above, as their own tag (MONEY_DUES_TAG).
  if (figs.voided) {
    lines.push(figs.voided + (figs.voided === 1 ? ' voided entry is' : ' voided entries are') +
               ' left out.');
  }
  return lines;
}

/** Draw moneyLines() into `box`, or `why` the money could not be read. */
function showMoneyFigures(box, figs, why) {
  box.textContent = '';
  var lines = why ? ['Money could not be read: ' + why] : moneyLines(figs);
  lines.forEach(function (text, i) {
    var p = document.createElement('p');
    p.className = i ? 'money-sub' : 'money-head';
    p.textContent = text;
    box.appendChild(p);
  });
  box.hidden = !lines.length;
}

/* An icon per tag name, any case, so the grid reads at a glance. Shown, never
 * stored; a tag with no icon here gets the plain label. */
var MONEY_TAG_ICONS = {
  food: '🍔', groceries: '🛒', transport: '🚌', bills: '🧾', health: '💊', family: '👪',
  shopping: '🛍️', other: '📦', salary: '💼', freelance: '💻', gift: '🎁', gifts: '🎁',
  fuel: '⛽', petrol: '⛽', rent: '🏠', home: '🏠', coffee: '☕', chai: '☕', tea: '☕',
  lunch: '🍱', dinner: '🍽️', restaurant: '🍽️', snacks: '🍪', education: '📚', books: '📚',
  phone: '📱', mobile: '📱', internet: '🌐', clothes: '👕', travel: '✈️', taxi: '🚕',
  medicine: '💊', doctor: '🩺', car: '🚗', bike: '🏍️', electricity: '💡', utilities: '💡',
  gas: '🔥', water: '💧', entertainment: '🎬', gym: '🏋️', charity: '🤲', sadqa: '🤲',
  zakat: '🤲', investment: '📈', profit: '📈', bonus: '🎉', refund: '↩️', fees: '🧾', kids: '🧸',
  laundry: '🧺'
};
var MONEY_TAG_ICON_NONE = '🏷️';

function moneyTagIcon(tag) {
  var key = String(tag || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MONEY_TAG_ICONS, key) ? MONEY_TAG_ICONS[key]
                                                                     : MONEY_TAG_ICON_NONE;
}

/** One cell of the tag grid: an icon over a name. */
function tagCell(icon, name, on, onPick) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'tag-cell' + (on ? ' on' : '');
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  var i = document.createElement('span');
  i.className = 'tag-ico';
  i.setAttribute('aria-hidden', 'true');
  i.textContent = icon;
  var n = document.createElement('span');
  n.className = 'tag-name';
  n.textContent = name;                   // user text: never markup
  b.append(i, n);
  b.addEventListener('click', onPick);
  return b;
}

/** Nothing picked and no new tag being typed: the grid may be redrawn. */
function moneyTagsIdle() { return !moneyForm.tag && $('moneyNewTag').hidden; }

function renderMoneyTags() {
  var box = $('moneyTags');
  box.textContent = '';
  var dir = moneyForm.dir;
  fixedTags(dir).forEach(function (tag) {
    var cell = tagCell(moneyTagIcon(tag), tag, tag === moneyForm.tag, function () { pickMoneyTag(tag); });
    cell.dataset.tag = tag;
    box.appendChild(cell);
  });
  var add = tagCell('+', 'New', false, openNewTag);
  add.classList.add('tag-add');
  add.setAttribute('aria-label', 'A new tag');
  box.appendChild(add);
}

/** Expense / Income: the tab shown as picked. */
function paintMoneyDir() {
  $('moneyOutBtn').setAttribute('aria-pressed', String(moneyForm.dir === 'out'));
  $('moneyInBtn').setAttribute('aria-pressed', String(moneyForm.dir === 'in'));
}

function pickMoneyDir(dir) {
  if (moneyForm.dir !== dir) {
    moneyForm.dir = dir;
    moneyForm.tag = '';
    $('moneyNewTag').hidden = true;
    $('moneyNewTag').value = '';
  }
  paintMoneyDir();
  renderMoneyTags();
  paintMoneySave();
  $('moneyAmount').focus();               // the digits need no tap of their own
}

function paintTagCells() {
  Array.prototype.forEach.call($('moneyTags').querySelectorAll('.tag-cell'), function (b) {
    var on = !b.classList.contains('tag-add') && b.dataset.tag === moneyForm.tag && Boolean(moneyForm.tag);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function pickMoneyTag(tag) {
  moneyForm.tag = tag;
  $('moneyNewTag').hidden = true;
  $('moneyNewTag').value = '';
  paintTagCells();
  paintMoneySave();
}

function openNewTag() {
  moneyForm.tag = '';
  paintTagCells();
  $('moneyNewTag').hidden = false;
  $('moneyNewTag').focus();
  paintMoneySave();
}

/** The tag Save will use: the cell, or what was typed (for this entry only),
 *  spelled like a saved tag it matches so "food" does not become a second "Food". */
function moneyTagNow() {
  if ($('moneyNewTag').hidden) return moneyForm.tag;
  var typed = cleanTags([$('moneyNewTag').value])[0] || '';
  if (!typed || !moneyForm.dir) return typed;
  var same = fixedTags(moneyForm.dir)
    .filter(function (t) { return t.toLowerCase() === typed.toLowerCase(); })[0];
  return same || typed;
}

function paintMoneySave() {
  $('moneySaveBtn').disabled = !(moneyForm.dir && parseMoneyAmount($('moneyAmount').value) &&
                                 moneyTagNow());
}

/** Back to Expense, the common case, with nothing typed. */
function resetMoneyForm() {
  moneyForm = { dir: 'out', tag: '' };
  $('moneyAmount').value = '';
  $('moneyNote').value = '';
  $('moneyNewTag').value = '';
  $('moneyNewTag').hidden = true;
  paintMoneyDir();
  $('moneyAmount').blur();
  renderMoneyTags();
  paintMoneySave();
}

/** Show it, then send it. api() has it on the device before this returns.
 *  `action` is 'money', 'loan', 'due' or 'wallet'; anything else is cash. */
function sendMoney(payload, action) {
  action = moneyItem({ action: action }) ? action : 'money';
  var row = queuedMoney({ rid: payload.rid, action: action, payload: payload });
  row.queued = false;
  moneyLocal.unshift(row);
  api(action, payload).then(function (res) {
    if (!(res && res.queued)) scheduleMoneyRead();
  }, function (err) {
    // Refused outright: take it back off the screen, as a failed prayer is.
    moneyLocal = moneyLocal.filter(function (r) { return r.rid !== payload.rid; });
    renderMoney();
    writeFailed(err);
  });
  renderMoney();
}

function saveMoney() {
  var typed = $('moneyAmount').value;
  var amount = parseMoneyAmount(typed);
  var tag = moneyTagNow();
  if (!moneyForm.dir || !amount || !tag) {
    flash(typed.trim() && !amount
      ? 'That amount cannot be read: digits, and at most two after the point.'
      : 'Type an amount and pick a tag.', 'err');
    return;
  }
  var payload = { rid: newRid(), at: new Date().toISOString(), local_time: humanLocal(),
                  dir: moneyForm.dir, amount: amount, tag: tag,
                  note: $('moneyNote').value.trim().slice(0, MONEY_NOTE_MAX) };
  sendMoney(payload);
  flash(moneyWhat(payload), 'ok');
  resetMoneyForm();
}

/** A void is a new row naming the old one, of the same kind; the old one is
 *  never changed. False when he said no. */
function voidMoney(r) {
  var kind = r.kind || 'cash';
  var action = moneyActionOf(kind);
  if (!action) return false;
  if (!window.confirm('Void ' + moneyWhat(r) + '? It stays in your record, struck through, ' +
                      'and stops counting.')) return false;
  var payload = { rid: newRid(), at: new Date().toISOString(), local_time: humanLocal(),
                  dir: r.dir, tag: String(r.tag || ''), note: '',
                  amount: kind === 'opening' ? parseWalletAmount(r.amount) : parseMoneyAmount(r.amount),
                  voids_rid: r.rid, voids_at: r.at };
  if (kind === 'loan' || kind === 'due') payload.person = cleanPerson(r.person);   // a void copies the row it cancels
  sendMoney(payload, action);
  flash('Voided: ' + moneyWhat(r), 'ok');
  return true;
}

/** Days from counter day `ymd` back to `todayYmd`: 0 today, 1 yesterday. */
function ymdBack(ymd, todayYmd) {
  function utc(x) { var p = String(x).split('-'); return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  return Math.round((utc(todayYmd) - utc(ymd)) / 86400000);
}

/** A day heading: "Today", "Yesterday", else "Sat 26 Sep". `back` is days before today. */
function moneyDayName(ymd, back) {
  if (back === 0) return 'Today';
  if (back === 1) return 'Yesterday';
  var p = String(ymd).split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  try {
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch (e) {
    return String(ymd);
  }
}

function renderMoney() {
  var rows = moneyMerged();
  var today = counterToday(new Date());
  var figs = moneyFigures(rows, dayWindows(today, today));
  $('moneyTodayText').textContent = 'spent ' + formatPkr(figs.out) + ' · got ' + formatPkr(figs['in']);

  // Before the first read the wallet is not known, whatever this device holds.
  var wallet = walletFigures(rows);
  var known = wallet.set && moneyReadAt > 0;
  $('walletLeft').textContent = known ? formatPkr(wallet.left) : '—';
  $('walletPerDay').textContent = known ? formatPkr(perDayTillFirst(wallet.left, today)) : '—';
  var days = daysTillFirst(today);
  $('walletDays').textContent = days === 1 ? 'today is the last day' : days + ' days, today included';
  $('walletSetBtn').textContent = wallet.set ? 'Recount' : 'Set starting amount';
  $('walletHint').hidden = wallet.set;

  var monthDays = dayWindows(new Date(today.getFullYear(), today.getMonth(), 1), today);
  var month = moneySince(moneyFigures(rows, monthDays), monthDays);
  $('moneyMonth').textContent = (month.since ? 'Since ' + moneySinceDay(month) : 'This month') +
    ': got ' + formatPkr(month['in']) + ' · spent ' + formatPkr(month.out);

  var held = outboxOurs().filter(moneyItem).length;
  var note = [];
  if (moneyWhy) {
    note.push((moneyReadAt ? 'Could not refresh (' + moneyWhy + '), so this may be out of date.'
                           : 'Could not read your money (' + moneyWhy + '), so only what this ' +
                             'device is holding is shown.'));
  }
  if (held) note.push(held + ' waiting to be sent from this device.');
  $('moneyStatus').textContent = note.join(' ');
  $('moneyStatus').hidden = !note.length;
  if (moneyTagsIdle()) renderMoneyTags();
  if (logsDlg.open) renderLogs();
  if (duesDlg.open) renderDues();
  if (dueDlg.open) paintDue();
}

/** Every money row, a page at a time: the wallet runs from the first one.
 *  `stale()` stops early when a newer read has started. */
async function readAllMoney(stale) {
  var all = [];
  var seen = userMap();
  for (var from = 0; ; from += MONEY_PAGE) {
    var res = await sb.from('money').select(MONEY_COLS)
      .order('at', { ascending: true }).order('id', { ascending: true })
      .range(from, from + MONEY_PAGE - 1);
    if (res.error) throw errorFrom(res.error);
    var got = res.data || [];
    // A late row landing mid-read shifts the pages by one; the repeat is dropped.
    got.forEach(function (r) {
      var key = String(r.id || r.rid);
      if (seen[key] === 1) return;
      seen[key] = 1;
      all.push(r);
    });
    if (got.length < MONEY_PAGE || stale()) return all;
  }
}

async function readMoney() {
  clearTimeout(moneyReadTimer);
  if (!supabaseReady()) {
    if (!moneyReadAt) moneyWhy = navigator.onLine === false ? 'offline' : 'not signed in';
    renderMoney();
    return;
  }
  var seq = ++moneyReadSeq;
  try {
    var rows = await readAllMoney(function () { return seq !== moneyReadSeq; });
    if (seq !== moneyReadSeq) return;
    moneyRows = rows;
    var have = userMap();
    moneyRows.forEach(function (r) { have[r.rid] = 1; });
    moneyLocal = moneyLocal.filter(function (r) { return have[r.rid] !== 1; });
    moneyReadAt = Date.now();
    moneyWhy = '';
  } catch (err) {
    if (seq !== moneyReadSeq) return;
    moneyWhy = String((err && err.message) || err);
  }
  renderMoney();
}

function scheduleMoneyRead(delay) {
  clearTimeout(moneyReadTimer);
  moneyReadTimer = setTimeout(readMoney, typeof delay === 'number' ? delay : 1500);
}

function openMoney() {
  renderMoney();
  readMoney();
}

/** Signed out, or another database: this account's money is not the next one's. */
function forgetMoney() {
  moneyRows = [];
  moneyLocal = [];
  moneyReadAt = 0;
  moneyWhy = '';
  if (currentScreen === 'money') renderMoney();
}

$('moneyOutBtn').addEventListener('click', function () { pickMoneyDir('out'); });
$('moneyInBtn').addEventListener('click', function () { pickMoneyDir('in'); });
$('moneyAmount').addEventListener('input', paintMoneySave);
$('moneyNewTag').addEventListener('input', paintMoneySave);
$('moneySaveBtn').addEventListener('click', saveMoney);

// ----------------------------------------------------------- money dialogs

/* Logs, Dues and the wallet open over the Money screen. However one closes
 * (its button, Save, or Escape), focus goes back to what opened it. */
var moneyDlgOpener = userMap();

function openMoneyDlg(dlg, opener, first) {
  moneyDlgOpener[dlg.id] = opener || null;
  if (!dlg.open) dlg.showModal();
  if (first) first.focus();
}

function closeMoneyDlg(dlg) {
  if (dlg.open) dlg.close();
  var back = moneyDlgOpener[dlg.id];
  moneyDlgOpener[dlg.id] = null;
  // A Settle button is redrawn by its own save: the same person's new one, else Add a due.
  if (back && !back.isConnected && back.dataset && back.dataset.person !== undefined) {
    var key = back.dataset.person;
    back = Array.prototype.filter.call($('duesList').querySelectorAll('button'), function (b) {
      return b.dataset.person === key;
    })[0] || $('dueAddBtn');
  }
  if (back && back.isConnected) back.focus();
}

/** Wire a dialog's Escape, and stop Enter in a field from closing it unsaved. */
function moneyDlgKeys(dlg, onEnter) {
  dlg.addEventListener('cancel', function (e) { e.preventDefault(); closeMoneyDlg(dlg); });
  dlg.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); });
  dlg.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !e.target || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    if (onEnter) onEnter();
  });
}

// ------------------------------------------------------------- money logs

/* Every money entry, newest first under its counter day, searched and filtered
 * here; Void lives here too. A void row is never listed: what it cancelled is,
 * struck through. */
var LOGS_KINDS = [['all', 'All'], ['expense', 'Expense'], ['income', 'Income'], ['dues', 'Dues']];
var logsFilter = { kind: 'all', tag: '', month: '', day: '', q: '' };

/** expense, income, dues or wallet. */
function logsKindOf(r) {
  var kind = r.kind || 'cash';
  if (kind === 'loan' || kind === 'due') return 'dues';
  if (kind === 'opening') return 'wallet';
  if (kind === 'cash') return r.dir === 'in' ? 'income' : 'expense';
  return '';
}

/** The rows the Logs dialog shows under filter `f`, in the order given. */
function logsMatch(rows, f) {
  var q = String(f.q || '').trim().toLowerCase();
  return rows.filter(function (r) {
    if (!r || r.voids_rid) return false;
    var t = instantOf(r.at);
    if (isNaN(t)) return false;
    if (f.kind !== 'all' && logsKindOf(r) !== f.kind) return false;
    if (f.tag && !((r.kind || 'cash') === 'cash' && String(r.tag || '') === f.tag)) return false;
    var ymd = counterDate(t);
    if (f.day && ymd !== f.day) return false;
    if (f.month && ymd.slice(0, 7) !== f.month) return false;
    if (q && [r.note, r.tag, r.person].join('\n').toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
}

/** "Oct 2026" for '2026-10'. */
function monthName(ym) {
  var p = String(ym).split('-');
  return 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[Number(p[1]) - 1] + ' ' + p[0];
}

/** Refill a <select> with [value, label] pairs, keeping the choice if it is still there. */
function fillSelect(sel, pairs, keep) {
  sel.textContent = '';
  pairs.forEach(function (pv) {
    var o = document.createElement('option');
    o.value = pv[0];
    o.textContent = pv[1];                // a tag he typed: never markup
    sel.appendChild(o);
  });
  sel.value = pairs.some(function (pv) { return pv[0] === keep; }) ? keep : '';
  return sel.value;
}

/** One entry in the Logs list. */
function logsLine(r, off) {
  var kind = r.kind || 'cash';
  var amount = formatPkr(moneyPaisa(r.amount) / 100);
  var li = document.createElement('li');
  li.className = (off ? 'voided' : '') + (kind !== 'cash' ? ' loan' : '');
  var when = document.createElement('span');
  when.className = 'when';
  when.textContent = glanceClock(instantOf(r.at));
  var what = document.createElement('span');
  what.className = 'what';
  var text = kind === 'opening' || kind === 'due' ? moneyWhat({ kind: kind, dir: r.dir, amount: r.amount, person: r.person })
           : (r.dir === 'in' ? '+' : '−') + amount + ' · ' + String(r.tag || '') +
             (kind === 'loan' ? ' · ' + String(r.person || '') : '');
  what.textContent = text + (r.note ? ' — ' + r.note : '');       // his own words: never markup
  var tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = off ? 'void' : r.queued ? 'waiting' :
    { cash: r.dir === 'in' ? 'in' : 'spent', loan: 'due · cash', due: 'due', opening: 'wallet' }[kind] || kind;
  li.append(when, what, tag);
  if (!off && moneyActionOf(kind)) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-btn';
    b.textContent = 'Void';
    b.addEventListener('click', function () { if (voidMoney(r)) $('logsCloseBtn').focus(); });
    li.appendChild(b);
  }
  return li;
}

function renderLogs() {
  var rows = moneyMerged();
  var cancelled = userMap();
  rows.forEach(function (r) { if (r.voids_rid) cancelled[r.voids_rid] = 1; });
  var f = logsFilter;

  Array.prototype.forEach.call($('logsKinds').querySelectorAll('button'), function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.kind === f.kind));
  });
  // The tags and months on offer are the ones in the record.
  var tags = userMap();
  var months = userMap();
  rows.forEach(function (r) {
    if (r.voids_rid || isNaN(instantOf(r.at))) return;
    months[counterDate(instantOf(r.at)).slice(0, 7)] = 1;
    if ((r.kind || 'cash') === 'cash' && r.tag) tags[String(r.tag)] = 1;
  });
  f.tag = fillSelect($('logsTag'), [['', 'All tags']].concat(Object.keys(tags).sort(function (a, b) {
    return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
  }).map(function (t) { return [t, t]; })), f.tag);
  f.month = fillSelect($('logsMonth'), [['', 'All months']].concat(Object.keys(months).sort().reverse()
    .map(function (m) { return [m, monthName(m)]; })), f.month);

  var todayYmd = counterDate(Date.now());
  $('logsDayRow').hidden = !f.day;
  $('logsDayText').textContent = f.day ? moneyDayName(f.day, ymdBack(f.day, todayYmd)) + ' only' : '';

  var shown = logsMatch(rows, f);
  var list = $('logsList');
  list.textContent = '';
  var groups = [];
  var byDay = userMap();
  shown.forEach(function (r) {
    var ymd = counterDate(instantOf(r.at));
    if (!byDay[ymd]) { byDay[ymd] = { ymd: ymd, rows: [] }; groups.push(byDay[ymd]); }
    byDay[ymd].rows.push(r);
  });
  groups.sort(function (a, b) { return a.ymd < b.ymd ? 1 : -1; });
  groups.forEach(function (g) {
    // The day's spending and income among the entries shown, cash dues included
    // (as moneyFigures counts them); record-only dues and the wallet are neither.
    var sum = { 'in': 0, out: 0 };
    g.rows.forEach(function (r) {
      var p = moneyPaisa(r.amount);
      var kind = r.kind || 'cash';
      if ((kind === 'cash' || kind === 'loan') && !(r.rid && cancelled[r.rid] === 1) && p > 0 &&
          sum[r.dir] !== undefined) sum[r.dir] += p;
    });
    var head = document.createElement('li');
    head.className = 'day-head';
    head.textContent = moneyDayName(g.ymd, ymdBack(g.ymd, todayYmd)) + ' · spent ' +
      formatPkr(sum.out / 100) + ' · got ' + formatPkr(sum['in'] / 100);
    list.appendChild(head);
    g.rows.forEach(function (r) { list.appendChild(logsLine(r, Boolean(r.rid) && cancelled[r.rid] === 1)); });
  });
  if (!shown.length) {
    var empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = rows.some(function (r) { return !r.voids_rid; }) ? 'Nothing matches.' : 'Nothing logged yet.';
    list.appendChild(empty);
  }
  $('logsCount').textContent = shown.length + (shown.length === 1 ? ' entry' : ' entries');
  $('logsNote').textContent = $('moneyStatus').textContent;
  $('logsNote').hidden = $('moneyStatus').hidden;
}

/** `day`: a counter day to show alone, as "Today ›" asks. */
function openLogs(opener, day) {
  logsFilter = { kind: 'all', tag: '', month: '', day: day || '', q: '' };
  $('logsSearch').value = '';
  renderLogs();
  openMoneyDlg(logsDlg, opener, $('logsCloseBtn'));
}

LOGS_KINDS.forEach(function (k) {
  var b = pickButton(k[1], k[0] === 'all', false, function () {
    logsFilter.kind = k[0];
    renderLogs();
  });
  b.dataset.kind = k[0];
  $('logsKinds').appendChild(b);
});
$('logsSearch').addEventListener('input', function () { logsFilter.q = $('logsSearch').value; renderLogs(); });
$('logsTag').addEventListener('change', function () { logsFilter.tag = $('logsTag').value; renderLogs(); });
$('logsMonth').addEventListener('change', function () { logsFilter.month = $('logsMonth').value; renderLogs(); });
$('logsDayClear').addEventListener('click', function () {
  logsFilter.day = '';
  renderLogs();
  $('logsSearch').focus();
});
$('logsBtn').addEventListener('click', function () { openLogs($('logsBtn'), ''); });
$('moneyTodayBtn').addEventListener('click', function () {
  openLogs($('moneyTodayBtn'), counterDate(Date.now()));
});
$('logsCloseBtn').addEventListener('click', function () { closeMoneyDlg(logsDlg); });
moneyDlgKeys(logsDlg, null);

// ------------------------------------------------------------------- dues

/* Was Lend / Borrow (Stage 13b). A due is either a record only ('due', no cash
 * moved, the wallet untouched) or cash moved now ('loan', which moves the
 * wallet and counts as spent or got, tag Dues). Settling is cash moved too. The fixed tags
 * of the cash ones are 13b's, so its rows keep their meaning. */
var DUE_CHOICES = [
  { action: 'due', dir: 'they_owe', tag: 'Owes me',
    label: function (n) { return n ? n + ' owes me' : 'They owe me'; } },
  { action: 'due', dir: 'i_owe', tag: 'I owe',
    label: function (n) { return n ? 'I owe ' + n : 'I owe them'; } },
  { action: 'loan', dir: 'out', tag: 'Lent',
    label: function (n) { return 'I gave ' + (n || 'them') + ' cash'; } },
  { action: 'loan', dir: 'in', tag: 'Borrowed',
    label: function (n) { return 'I took cash from ' + (n || 'them'); } }
];
var SETTLE_CHOICES = [
  { dir: 'in', tag: 'Repaid to me', label: function (n) { return n + ' paid me'; } },
  { dir: 'out', tag: 'Repaid by me', label: function (n) { return 'I paid ' + n; } }
];
var LOAN_PEOPLE_MAX = 12;       // names offered as chips
var dueChoice = null;
var settle = { person: '', choice: null, warned: '' };

function renderDues() {
  var list = $('duesList');
  list.textContent = '';
  var owed = loanBalances(moneyMerged());
  owed.forEach(function (b) {
    var li = document.createElement('li');
    var line = document.createElement('span');
    line.className = 'due-line';
    line.textContent = loanBalanceLine(b);          // a typed name: never markup
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-btn';
    btn.textContent = 'Settle';
    btn.setAttribute('aria-label', 'Settle with ' + b.person);
    btn.dataset.person = b.person.toLowerCase();
    btn.addEventListener('click', function () { openSettle(b.person, btn); });
    li.append(line, btn);
    list.appendChild(li);
  });
  $('duesEmpty').hidden = owed.length > 0;
  // A failed read means the balances are partial, and they say so.
  var note = !moneyWhy ? ''
    : moneyReadAt ? 'Could not refresh (' + moneyWhy + '), so these balances may be out of date.'
    : 'Could not read your dues (' + moneyWhy + '), so only what this device holds is counted.';
  $('duesNote').textContent = note;
  $('duesNote').hidden = !note;
}

function openDues(opener) {
  renderDues();
  openMoneyDlg(duesDlg, opener, $('dueAddBtn'));
}

/** Names used on dues before, most used first, then the latest; one spelling each. */
function loanPeople() {
  var seen = userMap();
  var list = [];
  moneyMerged().forEach(function (r) {
    if ((r.kind !== 'loan' && r.kind !== 'due') || r.voids_rid) return;
    var name = cleanPerson(r.person);
    if (!name) return;
    var key = name.toLowerCase();
    var t = instantOf(r.at) || 0;
    if (seen[key] === undefined) { seen[key] = { name: name, n: 0, t: t }; list.push(seen[key]); }
    seen[key].n += 1;
    if (t > seen[key].t) { seen[key].t = t; seen[key].name = name; }
  });
  return list.sort(function (a, b) { return (b.n - a.n) || (b.t - a.t); })
    .slice(0, LOAN_PEOPLE_MAX).map(function (x) { return x.name; });
}

/** What was typed, spelled like a name already used so "ali" stays "Ali". */
function loanPersonNow() {
  var typed = cleanPerson($('duePerson').value);
  if (!typed) return '';
  return loanPeople().filter(function (n) { return n.toLowerCase() === typed.toLowerCase(); })[0] || typed;
}

/** The four choices carry the typed name, so "Ali owes me" reads as said. */
function paintDue() {
  var name = loanPersonNow();
  Array.prototype.forEach.call(dueDlg.querySelectorAll('[data-due]'), function (b) {
    var c = DUE_CHOICES[Number(b.dataset.due)];
    b.textContent = c.label(name);                  // a typed name: never markup
    b.setAttribute('aria-pressed', String(dueChoice === c));
  });
  var people = $('duePeople');
  people.textContent = '';
  var typed = cleanPerson($('duePerson').value).toLowerCase();
  loanPeople().forEach(function (n) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (n.toLowerCase() === typed ? ' on' : '');
    b.textContent = n;                               // a typed name: never markup
    b.addEventListener('click', function () {
      $('duePerson').value = n;
      paintDue();
    });
    people.appendChild(b);
  });
  $('dueSaveBtn').disabled = !(dueChoice && name && parseMoneyAmount($('dueAmount').value));
}

function openDue(opener) {
  dueChoice = null;
  $('duePerson').value = '';
  $('dueAmount').value = '';
  $('dueNote').value = '';
  paintDue();
  openMoneyDlg(dueDlg, opener, dueDlg.querySelector('[data-due="0"]'));
}

function saveDue() {
  var typed = $('dueAmount').value;
  var amount = parseMoneyAmount(typed);
  var person = loanPersonNow();
  if (!dueChoice || !person || !amount) {
    flash(typed.trim() && !amount
      ? 'That amount cannot be read: digits, and at most two after the point.'
      : 'Pick what happened, a person and an amount.', 'err');
    return;
  }
  var c = dueChoice;
  var payload = { rid: newRid(), at: new Date().toISOString(), local_time: humanLocal(),
                  dir: c.dir, amount: amount, tag: c.tag, person: person,
                  note: $('dueNote').value.trim().slice(0, MONEY_NOTE_MAX) };
  sendMoney(payload, c.action);
  closeMoneyDlg(dueDlg);
  flash(moneyWhat(queuedMoney({ rid: payload.rid, action: c.action, payload: payload })), 'ok');
}

/** The balance now for one person, matched whatever the case, or null. */
function balanceOf(person) {
  var key = String(person || '').toLowerCase();
  return loanBalances(moneyMerged()).filter(function (b) { return b.person.toLowerCase() === key; })[0] || null;
}

/** The line asking to confirm a settlement that takes the balance past zero,
 *  or '' when it stays on the same side (the normal case: no extra tap). */
function settleOverLine(b, choice, amountText) {
  var amount = parseMoneyAmount(amountText);
  if (!b || !choice || !amount) return '';
  var owed = Math.round(b.owed * 100);
  var after = owed + (choice.dir === 'out' ? 1 : -1) * moneyPaisa(amount);
  if (after === 0 || (after > 0) === (owed > 0)) return '';
  var was = owed > 0 ? b.person + ' owes (' + formatPkr(owed / 100) + ')'
                     : 'you owe ' + b.person + ' (' + formatPkr(-owed / 100) + ')';
  var then = after > 0 ? b.person + ' will owe you ' + formatPkr(after / 100)
                       : 'you’ll owe ' + b.person + ' ' + formatPkr(-after / 100);
  return 'That’s more than ' + was + '. Save anyway? Then ' + then + '.';
}

function paintSettle() {
  Array.prototype.forEach.call(settleDlg.querySelectorAll('[data-settle]'), function (b) {
    var c = SETTLE_CHOICES[Number(b.dataset.settle)];
    b.textContent = c.label(settle.person);         // a typed name: never markup
    b.setAttribute('aria-pressed', String(settle.choice === c));
  });
  // Any change takes back a warning already shown: it described the old amount.
  settle.warned = '';
  $('settleWarn').hidden = true;
  $('settleSaveBtn').textContent = 'Save';
  $('settleSaveBtn').disabled = !(settle.choice && parseMoneyAmount($('settleAmount').value));
}

/** Settle with one person: the full balance is filled in, and a smaller amount
 *  is a part payment. Who paid whom is picked from the balance's sign. */
function openSettle(person, opener) {
  var b = balanceOf(person);
  settle = { person: b ? b.person : cleanPerson(person),
             choice: SETTLE_CHOICES[b && b.owed < 0 ? 1 : 0], warned: '' };
  $('settleTitle').textContent = 'Settle with ' + settle.person;
  $('settleOwed').textContent = b ? loanBalanceLine(b) + '.' : 'You are square.';
  $('settleAmount').value = b ? formatPkr(Math.abs(b.owed)).replace(/,/g, '') : '';
  paintSettle();
  openMoneyDlg(settleDlg, opener, settleDlg.querySelector('[data-settle="' + SETTLE_CHOICES.indexOf(settle.choice) + '"]'));
}

function saveSettle() {
  var amount = parseMoneyAmount($('settleAmount').value);
  if (!settle.choice || !settle.person || !amount) {
    flash('That amount cannot be read: digits, and at most two after the point.', 'err');
    return;
  }
  // Past zero, the first Save only says so; the second saves.
  var over = settleOverLine(balanceOf(settle.person), settle.choice, $('settleAmount').value);
  if (over && settle.warned !== over) {
    settle.warned = over;
    $('settleWarn').textContent = over;             // a typed name: never markup
    $('settleWarn').hidden = false;
    $('settleSaveBtn').textContent = 'Save anyway';
    return;
  }
  var payload = { rid: newRid(), at: new Date().toISOString(), local_time: humanLocal(),
                  dir: settle.choice.dir, amount: amount, tag: settle.choice.tag, note: '',
                  person: settle.person };
  sendMoney(payload, 'loan');
  closeMoneyDlg(settleDlg);                         // after the redraw, so focus finds the new Settle
  flash(moneyWhat(queuedMoney({ rid: payload.rid, action: 'loan', payload: payload })), 'ok');
}

DUE_CHOICES.forEach(function (c, i) {
  var b = pickButton(c.label(''), false, false, function () {
    dueChoice = c;
    paintDue();
  });
  b.dataset.due = String(i);
  $(i < 2 ? 'dueRecordKinds' : 'dueCashKinds').appendChild(b);
});
SETTLE_CHOICES.forEach(function (c, i) {
  var b = pickButton('', false, false, function () {
    settle.choice = c;
    paintSettle();
  });
  b.dataset.settle = String(i);
  $('settleKinds').appendChild(b);
});

$('duesBtn').addEventListener('click', function () { openDues($('duesBtn')); });
$('duesCloseBtn').addEventListener('click', function () { closeMoneyDlg(duesDlg); });
$('dueAddBtn').addEventListener('click', function () { openDue($('dueAddBtn')); });
$('duePerson').addEventListener('input', paintDue);
$('dueAmount').addEventListener('input', paintDue);
$('dueCancelBtn').addEventListener('click', function () { closeMoneyDlg(dueDlg); });
$('dueSaveBtn').addEventListener('click', saveDue);
$('settleAmount').addEventListener('input', paintSettle);
$('settleCancelBtn').addEventListener('click', function () { closeMoneyDlg(settleDlg); });
$('settleSaveBtn').addEventListener('click', saveSettle);
moneyDlgKeys(duesDlg, null);
moneyDlgKeys(dueDlg, function () { if (!$('dueSaveBtn').disabled) saveDue(); });
moneyDlgKeys(settleDlg, function () { if (!$('settleSaveBtn').disabled) saveSettle(); });

// ----------------------------------------------------------------- wallet

/* The starting amount is a money row ('opening'), not a setting: it goes
 * through the outbox like any press, and the newest by press time wins on both
 * devices. Setting it again is a recount: from then on it counts from there. */
function paintWallet() {
  $('walletSaveBtn').disabled = !parseWalletAmount($('walletAmount').value);
}

function openWallet(opener) {
  $('walletAmount').value = '';
  paintWallet();
  openMoneyDlg(walletDlg, opener, $('walletAmount'));
}

function saveWallet() {
  var amount = parseWalletAmount($('walletAmount').value);
  if (!amount) {
    flash('That amount cannot be read: digits, and at most two after the point.', 'err');
    return;
  }
  var payload = { rid: newRid(), at: new Date().toISOString(), local_time: humanLocal(),
                  dir: 'set', amount: amount, tag: 'Wallet', note: '' };
  closeMoneyDlg(walletDlg);
  sendMoney(payload, 'wallet');
  flash(moneyWhat({ kind: 'opening', amount: amount }), 'ok');
}

$('walletSetBtn').addEventListener('click', function () { openWallet($('walletSetBtn')); });
$('walletAmount').addEventListener('input', paintWallet);
$('walletCancelBtn').addEventListener('click', function () { closeMoneyDlg(walletDlg); });
$('walletSaveBtn').addEventListener('click', saveWallet);
moneyDlgKeys(walletDlg, function () { if (!$('walletSaveBtn').disabled) saveWallet(); });

// ------------------------------------------------------------------ taskboard

/* A link, not a screen: whatever board you already use stays where it is. It was
 * the fourth tab until Stage 11 gave that place to Money; now it is a button in
 * Settings → Developer settings. Opened in the browser, not the PWA frame. */

/** Only http(s) links may be opened. The Save button is type="button", so the
 *  <input type="url"> constraint never runs — this is the only check there is,
 *  and it is what keeps a `javascript:` URL out of window.open(). */
function safeBoardUrl(raw) {
  var url = String(raw || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

// The link as typed, so it can be tried before Save; else the saved one.
$('boardOpenBtn').addEventListener('click', function () {
  var url = safeBoardUrl($('boardUrl').value) || safeBoardUrl(cfg.boardUrl);
  if (!url) {
    $('testResult').textContent = 'Add a taskboard link starting with https:// first.';
    return;
  }
  window.open(url, '_blank', 'noopener');
});

// ------------------------------------------------------------- signing in

var signInDlg = $('signInDlg');

function askSignIn() {
  if (signInDlg.open || dlg.open) return;
  if (!cfg.supaUrl || !cfg.supaKey) return;      // nothing to sign in to yet
  $('signInMsg').textContent = '';
  signInDlg.showModal();
}

$('githubBtn').addEventListener('click', async function () {
  if (!sb) { $('signInMsg').textContent = 'Add your Supabase details in Settings → Developer settings first.'; return; }
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
  paintOutboxNote();
}

/**
 * What Settings says about the outbox: what is waiting, what is being held for
 * another account or another project, and what the database refused outright.
 *
 * Plain sentences rather than a list of rows — the point is a count you can
 * trust, not a second copy of the log. Every string is user text, so textContent
 * only (rule 5).
 */
function paintOutboxNote() {
  var el = $('outboxNote');
  if (!el) return;

  var ours = outboxCount();
  var newer = outboxNewer().length;
  var held = outboxHeld().length - newer;
  var parked = parkedAll();
  var lines = [];

  if (ours) {
    lines.push(ours + (ours === 1 ? ' entry is' : ' entries are') +
      ' waiting to be sent, saved on this device with the time you pressed ' +
      (ours === 1 ? 'it' : 'them') + '.');
  }
  if (held) {
    lines.push(held + (held === 1 ? ' entry belongs' : ' entries belong') +
      ' to a different account or a different Supabase project, so ' +
      (held === 1 ? 'it is' : 'they are') + ' being held here rather than sent. ' +
      'Sign in to that account, or put that project back in Developer settings, ' +
      'and ' + (held === 1 ? 'it goes' : 'they go') + ' up.');
  }
  if (newer) {
    lines.push(newer + (newer === 1 ? ' entry was' : ' entries were') + ' saved by a newer ' +
      'version of ProBeing on this device. This version cannot send ' +
      (newer === 1 ? 'it' : 'them') + ', so ' + (newer === 1 ? 'it is' : 'they are') +
      ' kept untouched. Close and reopen the app to get the newer version, which sends ' +
      (newer === 1 ? 'it' : 'them') + '.');
  }
  if (parked.length) {
    lines.push(parked.length + (parked.length === 1 ? ' entry was' : ' entries were') +
      ' refused by the database and will not be retried: ' +
      parked.map(function (p) {
        return (p.what || 'entry') + ' (' + p.why + ')';
      }).join('; ') + '.');
  }

  el.textContent = lines.join(' ');
  el.hidden = !lines.length;
  var btn = $('outboxForgetBtn');
  if (btn) btn.hidden = !parked.length;
}

$('outboxForgetBtn').addEventListener('click', function () {
  if (!window.confirm('Forget the entries the database refused? They are not in ' +
    'your log and cannot be recovered afterwards.')) return;
  forgetParked();
  paintOutboxNote();
});

$('signOutBtn').addEventListener('click', async function () {
  if (!sb) return;

  /* Never dropped silently, and never sent to whoever signs in next. They wait
   * on this device for THIS account, and go up when it signs back in. Saad's
   * decision, and the warning is here because "signed out" is the one moment a
   * person would reasonably expect a queue to be thrown away. */
  var waiting = outboxCount();
  if (waiting && !window.confirm(
    waiting + (waiting === 1 ? ' entry has' : ' entries have') + ' not been sent yet. ' +
    (waiting === 1 ? 'It stays' : 'They stay') + ' on this device and ' +
    (waiting === 1 ? 'is' : 'are') + ' sent when you sign back in with the same account. ' +
    'Sign out anyway?')) return;

  setSignedOut(true);
  stopLive();
  /* The shade must not keep this account's day — nor get it back from a read
   * that was already on its way when this was pressed. */
  forgetGlance();
  closeGlance();
  try { await sb.auth.signOut(); } catch (e) { /* already gone */ }
  dlg.close();
  flash('Signed out', 'ok');
});

// ----------------------------------------------------------------- settings

var dlg = $('settingsDlg');

/* Stage 13b. Settings' explanations sit behind a "?" by each heading, so the
 * screen shows the controls. The words are <template>s in index.html. */
var helpDlg = $('helpDlg');
var helpOpener = null;

function openHelp(btn) {
  var tpl = document.getElementById(btn.getAttribute('data-help'));
  if (!tpl || !tpl.content) return;
  $('helpTitle').textContent = btn.getAttribute('data-title') || '';
  var body = $('helpBody');
  body.textContent = '';
  body.appendChild(tpl.content.cloneNode(true));   // our own static markup, never user text
  helpOpener = btn;
  helpDlg.showModal();
  $('helpCloseBtn').focus();
}

function closeHelp() {
  if (helpDlg.open) helpDlg.close();
  if (helpOpener) helpOpener.focus();               // back where the reader was
  helpOpener = null;
}

Array.prototype.forEach.call(document.querySelectorAll('.help-btn'), function (b) {
  b.addEventListener('click', function () { openHelp(b); });
});
$('helpCloseBtn').addEventListener('click', closeHelp);
// Escape: closed here, so focus goes back to the "?" whatever the browser does.
helpDlg.addEventListener('cancel', function (e) { e.preventDefault(); closeHelp(); });
helpDlg.addEventListener('click', function (e) { if (e.target === helpDlg) closeHelp(); });

$('settingsBtn').addEventListener('click', function () {
  paintAccount();
  $('supaUrl').value = cfg.supaUrl || '';
  $('supaKey').value = cfg.supaKey || '';
  $('geminiDaily').value = cfg.geminiDaily || '';
  $('geminiRpm').value = cfg.geminiRpm || '';
  $('boardUrl').value = cfg.boardUrl || '';
  $('chipsInput').value = chipLabels().join(', ');
  $('moneyOutTags').value = fixedTags('out').join(', ');
  $('moneyInTags').value = fixedTags('in').join(', ');
  $('projectNames').value = pinnedNames.join('\n');
  renderCategorySettings();
  renderLearnedNames();
  fillPlaceSelects();
  paintPlace();
  $('placeResult').textContent = '';
  $('micHide').checked = Boolean(cfg.hideMic);
  $('glanceOn').checked = Boolean(cfg.glance);
  $('glanceResult').textContent = glanceBlockedNote();
  $('testResult').textContent = '';
  paintPushState();
  hidePairCode();                    // never a code left over from a past visit
  $('pairResult').textContent = '';
  loadDeviceKeys();                  // not awaited: the dialog opens now
  loadGoogle();                      // likewise
  loadPrayerRemind();                // likewise
  loadTaskRemind();                  // likewise
  dlg.showModal();
});

$('cancelBtn').addEventListener('click', function () { dlg.close(); });

$('testBtn').addEventListener('click', async function () {
  if (!sbUser) { $('testResult').textContent = 'Sign in first.'; return; }
  $('testResult').textContent = 'Testing…';
  try {
    await api('ping');
    $('testResult').textContent = '✅ Connected.';
  } catch (err) {
    $('testResult').textContent = '❌ ' + (err.message || err);
  }
});

/* Throwaway scaffolding, and labelled as such. It proves one thing that nothing
 * else can prove until Stage 4 exists: that this browser can get an answer out of
 * Gemini without ever holding the Gemini key. The key sits in the Edge Function's
 * own secrets; all that leaves this device is the prompt and the signed-in
 * session's token, which is what the function checks before it spends the key.
 * JSON is fine: the Edge Function answers the CORS preflight itself. */
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
    $('devSettings').open = true;           // the field is folded away; show it
    $('testResult').textContent = 'The taskboard link must start with https:// — nothing else was saved.';
    return;
  }

  var next = {
    supaUrl: $('supaUrl').value.trim(),
    supaKey: $('supaKey').value.trim(),
    geminiDaily: $('geminiDaily').value.trim(),
    geminiRpm: $('geminiRpm').value.trim(),
    boardUrl: safeBoardUrl(typedBoard),
    // Device-local on purpose: the chip list does not sync between phone and laptop.
    chips: (parseChips($('chipsInput').value).join(', ')) || DEFAULT_CHIPS.join(', '),
    // Also device-local: the phone has a good keyboard mic, the laptop may not.
    hideMic: $('micHide').checked,
    // Device-local as well, and off unless ticked: the phone wants it, a laptop
    // may not want a toast every minute.
    glance: $('glanceOn').checked
  };
  if (!next.supaUrl || !next.supaKey) {
    $('devSettings').open = true;
    $('testResult').textContent = 'Fill in the Supabase URL and key first.';
    return;
  }

  var switched = next.supaUrl !== cfg.supaUrl || next.supaKey !== cfg.supaKey;
  cfg = next;
  saveConfig(cfg);
  /* Kept out of `cfg` on purpose: that object is credentials and device
   * settings, rewritten wholesale on every save. The vocabulary
   * has no business riding along with it, and neither has the grouping — a
   * project is office work whichever database its rows are in. */
  savePinnedNames(parsePinned($('projectNames').value));
  if (catSettingsRead) saveProjectCategories(mergedCategories(settingsCategoryEdits()));
  paintMic();
  renderChips();
  dlg.close();
  flash('Saved', 'ok');

  if (switched) {
    stopLive();
    lastLog = [];
    lastLead = [];
    todayPrayers = [];
    forgetGlance();                  // another database's day is not this one's
    closeGlance();
    forgetMoney();
    initSupabase();
  }
  // After the switch, so a new database gets them at its own sign-in.
  changeMoneyTags(cleanTags(parseChips($('moneyOutTags').value)),
                  cleanTags(parseChips($('moneyInTags').value)));
  // Applied here and not on the tick, so Cancel leaves the shade as it found it.
  applyGlanceSetting();
  if (!sbUser) askSignIn(); else refresh();
});

// ------------------------------------------------------------ prayer times

/** Write the place where the Edge Functions read it. Direct, like the push
 *  subscription: a setting, not a press, so the outbox does not hold it.
 *  Coordinates, and the zone measured with them, go only from the device that
 *  measured them (`own`); any other sends method and Asr alone, and the upsert
 *  keeps the columns it leaves out. */
async function pushPlace() {
  if (!supabaseReady()) throw new Error('Sign in first.');
  var p = currentPlace();
  var stamp = new Date().toISOString();
  // Named: a column default only fires on an insert, and this may be an update.
  var row = { user_id: sbUser.id, method: p.method, asr_school: p.asr, updated_at: stamp };
  if (placeSaved.own && p.known) {
    row.lat = p.lat;
    row.lng = p.lng;
    row.time_zone = p.zone;
  }
  var res = await sb.from('user_settings').upsert(row, { onConflict: 'user_id' });
  if (res.error) throw errorFrom(res.error);
  placeSaved.at = stamp;                    // so the next pull does not read our own write as newer
  placeSaved.synced = true;
  savePlace(placeSaved);
}

/** Take the place from user_settings when it was set later than this device's
 *  own (on the other device, say), so phone and laptop count the same day. */
async function pullPlace() {
  var got = await sb.from('user_settings')
    .select('lat, lng, time_zone, method, asr_school, updated_at').eq('user_id', sbUser.id).limit(1);
  if (got.error) throw errorFrom(got.error);
  var row = (got.data || [])[0] || null;
  if (!row || !(Date.parse(row.updated_at) > (Date.parse(placeSaved.at || '') || 0))) return row;

  // A row without coordinates never replaces a known location; its method and Asr still apply.
  if (!isNaN(finiteNum(row.lat)) && !isNaN(finiteNum(row.lng))) {
    placeSaved.lat = row.lat;
    placeSaved.lng = row.lng;
    placeSaved.zone = row.time_zone;        // the zone travels with the location
    placeSaved.own = false;                 // measured on the other device
  }
  placeSaved.method = row.method;
  placeSaved.asr = row.asr_school;
  placeSaved.at = row.updated_at;
  placeSaved.synced = true;
  savePlace(placeSaved);
  setPrayerPlace(placeSaved);
  renderPrayerTicks();
  refresh();                                // the day may now turn at another time
  return row;
}

/* At every sign-in: a change this device made that the server never got goes
 * first; otherwise the server's copy is read. Nothing is written just because
 * the app opened. The server's zone moves only when "Use my location" is
 * pressed, with the location - otherwise a laptop on UTC, or a phone abroad
 * while the laptop stays home, would flip it at every launch. */
async function syncPlace() {
  if (!supabaseReady()) return;
  try {
    if (placeSaved.synced === false) await pushPlace();
    else await pullPlace();
  } catch (e) { /* tried again at the next sign-in; this device's own day is unaffected */ }
}

/** Adopt changed place fields: this device at once, the server when it answers. */
function changePlace(fields, said) {
  Object.keys(fields).forEach(function (k) { placeSaved[k] = fields[k]; });
  placeSaved.at = new Date().toISOString();
  placeSaved.synced = false;
  savePlace(placeSaved);
  setPrayerPlace(placeSaved);
  paintPlace();
  renderPrayerTicks();
  refresh();                                // the day may now turn at another time

  var out = $('placeResult');
  if (!supabaseReady()) {
    out.textContent = said + ' Saved on this device; the server gets it once you sign in.';
    return;
  }
  out.textContent = said + ' Telling the server…';
  pushPlace().then(function () {
    out.textContent = said + ' The server uses it too.';
  }, function (err) {
    out.textContent = said + ' Saved on this device, but the server copy failed (' +
      String((err && err.message) || err) + '). It is sent again next time the app opens.';
  });
}

/** Where the times are for, today's five, and when the next day starts. */
function paintPlace() {
  var p = currentPlace();
  var now = Date.now();
  var where = p.known ? 'Your location: ' + p.lat.toFixed(3) + ', ' + p.lng.toFixed(3)
                      : 'Karachi — the default until you use your location';
  var times = PRAYER_NAMES.map(function (n) {
    return n + ' ' + glanceClock(prayerOpensAt(n, now));
  }).join(' · ');
  var next = counterDayStart(counterDayStart(now) + 30 * 3600000);
  $('placeNow').textContent = where + ' (time zone ' + p.zone + '). Today: ' + times +
    '. The next day starts at ' + glanceClock(next) + '.';
}

function fillPlaceSelects() {
  var p = currentPlace();
  [['prayerMethod', PRAYER_METHODS, p.method], ['asrSchool', ASR_SCHOOLS, p.asr]].forEach(function (s) {
    var sel = $(s[0]);
    sel.textContent = '';
    Object.keys(s[1]).forEach(function (key) {
      var o = document.createElement('option');
      o.value = key;
      o.textContent = s[1][key].label;
      sel.appendChild(o);
    });
    sel.value = s[2];
  });
}

/* Refused or unavailable. Nothing saved means Karachi, which is already the
 * default; a location saved earlier is kept, since a timeout indoors says
 * nothing about where he is. */
function placeRefused(why) {
  $('placeResult').textContent = why + (currentPlace().known
    ? ' Your saved location is still used.' : ' Using Karachi’s times.');
  paintPlace();
}

$('placeBtn').addEventListener('click', function () {
  if (!navigator.geolocation) { placeRefused('This browser cannot share a location.'); return; }
  $('placeResult').textContent = 'Asking the browser for your location…';
  navigator.geolocation.getCurrentPosition(function (pos) {
    // Three decimals is about 100 m, far finer than prayer times need.
    changePlace({
      lat: Math.round(pos.coords.latitude * 1000) / 1000,
      lng: Math.round(pos.coords.longitude * 1000) / 1000,
      zone: deviceTz() || currentPlace().zone,
      own: true                             // only this device may send these coordinates
    }, 'Location saved.');
  }, function (err) {
    placeRefused(err && err.code === 1 ? 'Location was refused.' : 'Your location could not be found.');
  }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 600000 });
});

$('prayerMethod').addEventListener('change', function () {
  changePlace({ method: $('prayerMethod').value }, 'Method changed.');
});

$('asrSchool').addEventListener('change', function () {
  changePlace({ asr: $('asrSchool').value }, 'Asr changed.');
});

// ------------------------------------------------- bedtime notifications

/* Stage 7a. The app's half of the 11:30 PM check: get a postbox from the
 * browser's push service, tell Supabase where it is, and keep it current.
 * Everything after that happens in sw.js and in the `wrapup` Edge Function,
 * because by then the app is closed and the phone is face down.
 *
 * NOTHING HERE ADDS A TAP TO LOGGING. It runs on launch and from Settings, and
 * never from the path an M or a prayer takes.
 */

/* SHIPPED ON PURPOSE, and safe to — for exactly the reason the anon key at the
 * top of this file is. This is the PUBLIC half of the VAPID pair: it says who
 * the sender is, and it can only be used to check a signature, never to make
 * one. The private half was written to ~/.probeing/ by scripts/make_vapid.js and
 * lives in the Edge Function's secrets.
 *
 * It has to be here rather than in Settings because the browser wants it at
 * subscribe time, before anything has been read from the network, and because a
 * key nobody can type wrongly is a key nobody types. */
var VAPID_PUBLIC_KEY = 'BBXOK45W7ya1yq1YB7rGNtHOri4Ur6a3bqgBP9f1-hs15jv-kVbjsjZtyP7SLNP6gUd4WUuT8tpFxbglF29E7Zk';

/** base64url text -> bytes. `pushManager.subscribe` wants the key as bytes, and
 *  atob is the only decoder a browser ships. */
function b64urlBytes(text) {
  var norm = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** bytes -> base64url, for the two keys the subscription hands back. */
function bytesB64url(buf) {
  var bytes = new Uint8Array(buf);
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window &&
         typeof Notification !== 'undefined';
}

/** Which device this row is, in words. There is nothing else in the table that
 *  tells the phone's subscription from the laptop's. */
function deviceLabel() {
  var ua = String(navigator.userAgent || '');
  if (/Android/i.test(ua)) return 'Phone (Android)';
  if (/iPhone|iPad/i.test(ua)) return 'Phone (iOS)';
  if (/Windows/i.test(ua)) return 'Laptop (Windows)';
  if (/Mac OS X/i.test(ua)) return 'Laptop (Mac)';
  if (/Linux/i.test(ua)) return 'Laptop (Linux)';
  return 'Unknown device';
}

/**
 * This device's push subscription, made if it does not exist.
 *
 * A SUBSCRIPTION ALREADY SIGNED TO A DIFFERENT KEY IS THROWN AWAY FIRST. The
 * browser refuses to re-subscribe with a new applicationServerKey and throws
 * InvalidStateError instead, which would read as "notifications are broken" for
 * ever afterwards. Regenerating the VAPID pair should cost one silent
 * re-subscribe, not a support case.
 */
async function pushSubscription() {
  var reg = await navigator.serviceWorker.ready;
  var have = await reg.pushManager.getSubscription();

  if (have) {
    var signedTo = have.options && have.options.applicationServerKey;
    if (signedTo && bytesB64url(signedTo) !== VAPID_PUBLIC_KEY) {
      await have.unsubscribe();
      have = null;
    }
  }
  if (have) return have;

  return reg.pushManager.subscribe({
    // Chrome only grants a subscription on the promise that every push shows
    // something. sw.js keeps that promise; see the push handler there.
    userVisibleOnly: true,
    applicationServerKey: b64urlBytes(VAPID_PUBLIC_KEY)
  });
}

/**
 * Write the subscription down where the Edge Function can find it.
 *
 * An overwrite, keyed on the endpoint, because THE POSTBOX CHANGES WITHOUT
 * WARNING. A browser update, a long idle spell, a reinstall — the old endpoint
 * starts answering 410 Gone and the new one is simply different. The failure is
 * completely silent: everything goes on working for three weeks and then the
 * notifications stop, with no error anywhere. Overwriting on every launch is the
 * cheap half of the fix; the Edge Function deleting a 410'd row is the other.
 */
async function savePushSubscription(sub) {
  var res = await sb.from('push_subscriptions').upsert({
    // Named explicitly: the column's default only fires on an insert, and this
    // statement is an insert-or-update.
    user_id: sbUser.id,
    endpoint: sub.endpoint,
    p256dh: bytesB64url(sub.getKey('p256dh')),
    auth: bytesB64url(sub.getKey('auth')),
    label: deviceLabel(),
    last_seen_at: new Date().toISOString()
  }, { onConflict: 'endpoint' });
  if (res.error) throw errorFrom(res.error);
}

/** On every launch, quietly. Never asks for permission — that is the Settings
 *  button's job, and a permission prompt on startup is how a person clicks
 *  Block once and never sees a notification again. */
async function syncPushSubscription() {
  if (!pushSupported() || !supabaseReady()) return;
  if (Notification.permission !== 'granted') return;
  try {
    await savePushSubscription(await pushSubscription());
  } catch (e) { /* a device that cannot subscribe still logs perfectly well */ }
}

/** Where the `wrapup` function lives, from whatever Settings holds. */
function wrapupUrl() {
  return String(cfg.supaUrl || '').trim().replace(/\/+$/, '') + '/functions/v1/wrapup';
}

/** Ask the Edge Function to push something to every device on the account. */
async function callWrapup(body) {
  var got = await sb.auth.getSession();
  var session = got && got.data ? got.data.session : null;
  if (!session || !session.access_token) throw new Error('Sign in first.');

  var res = await fetch(wrapupUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + session.access_token,
      'apikey': String(cfg.supaKey || '').trim()
    },
    body: JSON.stringify(body)
  });
  var data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || !data.ok) {
    throw new Error((data && data.error) || ('HTTP ' + res.status));
  }
  return data;
}

/** What the Settings block says about this device, before anything is pressed. */
function paintPushState() {
  var out = $('pushResult');
  if (!out) return;

  if (!pushSupported()) {
    out.textContent = 'This browser cannot do notifications at all.';
    return;
  }
  if (Notification.permission === 'denied') {
    out.textContent = 'Notifications are blocked for this site, and Chrome will not ask ' +
      'again. ' + UNBLOCK_HELP + ' Then press the button.';
    return;
  }
  if (Notification.permission !== 'granted') {
    out.textContent = 'Not on for this device yet.';
    return;
  }
  out.textContent = 'On for this device.';
}

$('pushOnBtn').addEventListener('click', async function () {
  var out = $('pushResult');
  if (!pushSupported()) { out.textContent = 'This browser cannot do notifications.'; return; }
  if (!sb || !sbUser) { out.textContent = 'Sign in first.'; return; }

  out.textContent = 'Asking the browser…';
  var granted;
  try {
    granted = await Notification.requestPermission();
  } catch (e) {
    out.textContent = 'The browser refused: ' + ((e && e.message) || e);
    return;
  }
  if (granted !== 'granted') {
    paintPushState();
    return;
  }

  out.textContent = 'Registering this device…';
  try {
    await savePushSubscription(await pushSubscription());
  } catch (e) {
    out.textContent = '❌ Could not register this device: ' + ((e && e.message) || e);
    return;
  }
  out.textContent = '✅ On for this device. Press "Send me a test push now" to prove it.';
});

$('pushTestBtn').addEventListener('click', async function () {
  var out = $('pushResult');
  if (!sb || !sbUser) { out.textContent = 'Sign in first.'; return; }

  out.textContent = 'Sending…';
  try {
    /* Re-registering first, because the commonest reason a test push does not
     * arrive is a subscription this device made before it was signed in — the
     * row was never written, and the function has nowhere to send to. */
    if (pushSupported() && Notification.permission === 'granted') {
      await savePushSubscription(await pushSubscription());
    }
    var data = await callWrapup({ test: true });
    if (!data.sent) {
      out.textContent = '⚠️ Nothing was sent: no device is registered' +
        (data.dropped ? ' (' + data.dropped + ' dead one dropped)' : '') +
        '. Press "Turn on notifications" first.';
      return;
    }
    out.textContent = '✅ Sent to ' + data.sent + ' device' +
      (data.sent === 1 ? '' : 's') +
      (data.failed ? ', ' + data.failed + ' refused' : '') +
      (data.dropped ? ', ' + data.dropped + ' dead one dropped' : '') +
      '. It should arrive within a few seconds.';
  } catch (e) {
    out.textContent = '❌ ' + ((e && e.message) || e);
  }
});

// ------------------------------------------- the home-screen widget (Stage 8)

/* Stage 8. The widget is a native box on the Android home screen, put there by
 * the Trusted Web Activity wrapper, and it shows the SAME two lines as the
 * notification shade. The glance-refresh Edge Function writes them, every ten
 * minutes and after each new row, with the same day.js the shade uses.
 *
 * IT IS LOOK-ONLY (Saad, 16 Sep 2026). Tapping it opens ProBeing; there is no M
 * button on it, no prayer button and no microphone. That decision is the whole
 * of its security story: the credential a widget holds can do exactly one thing,
 * read two lines of text. Rule 4 is untouched either way — nothing in this
 * section sits on the path an M or a prayer takes.
 *
 * A WIDGET CANNOT SIGN IN. It is not a browser: no session, nowhere to keep one,
 * and no way to run the GitHub sign-in at all. So it is PAIRED instead. Settings
 * makes a short code, shows it once, and stores only its FINGERPRINT; the widget
 * quotes the code at a door called glance_for(), which hands back those two
 * lines and nothing else. The door itself is in docs/supabase_schema.sql.
 */

/* THE CODE'S ALPHABET, AND WHY IT IS NOT THE WHOLE OF A TO Z.
 *
 * Thirty characters, with I, L, O, U and the digits 0 and 1 left out on purpose:
 * this is read off one screen and typed into another, and a code that can be
 * read two ways is a support case rather than a code.
 *
 * SIXTEEN OF THEM IS 78.5 BITS — 30^16, which is 4.3 x 10^23 codes. At a million
 * guesses a second that is about fourteen billion years, near enough the age of
 * the universe, and nobody gets a million guesses a second out of a database
 * answering over the internet. It is far more than this job needs: the code
 * guards two lines of text that are already on display on a home screen. What it
 * must be is unguessable by somebody who knows exactly what shape it is, and it
 * is that many times over.
 */
var PAIR_CODE_CHARS = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
var PAIR_CODE_LEN = 16;
var PAIR_CODE_GROUP = 4;                     // "ABCD-EFGH-JKMN-PQRS", to be typed

/**
 * A fresh pairing code.
 *
 * crypto.getRandomValues(), NEVER Math.random(). Math.random is built to look
 * random rather than to be unpredictable: a handful of its outputs is enough to
 * work out the state behind them and print every number it will produce after.
 * That is fine for shuffling a list and useless for a credential.
 */
function newPairCode() {
  var n = PAIR_CODE_CHARS.length;                       // 30
  /* THE BIAS THIS AVOIDS. A byte is 0-255 and 256 does not divide by 30, so
   * `byte % 30` on its own would land on the first sixteen characters of the
   * alphabet slightly more often than on the last fourteen. Small enough never
   * to be noticed, and exactly the kind of lean that makes a code easier to
   * guess than its length claims. So the top 16 byte values are thrown away
   * rather than wrapped round, leaving 240 — eight whole alphabets, every
   * character equally likely. */
  var limit = 256 - (256 % n);                          // 240
  var out = '';

  while (out.length < PAIR_CODE_LEN) {
    var buf = new Uint8Array(PAIR_CODE_LEN);
    crypto.getRandomValues(buf);
    for (var i = 0; i < buf.length && out.length < PAIR_CODE_LEN; i++) {
      if (buf[i] >= limit) continue;                    // discarded, not wrapped
      out += PAIR_CODE_CHARS.charAt(buf[i] % n);
    }
  }
  return out;
}

/** "ABCDEFGHJKMNPQRS" -> "ABCD-EFGH-JKMN-PQRS". The grouping is for the eye and
 *  the thumb; the dashes are not part of the secret. */
function pairCodeDisplay(code) {
  var out = [];
  var plain = String(code || '');
  for (var i = 0; i < plain.length; i += PAIR_CODE_GROUP) {
    out.push(plain.slice(i, i + PAIR_CODE_GROUP));
  }
  return out.join('-');
}

/**
 * What is actually hashed: letters and digits only, in capitals.
 *
 * So a code works typed with the dashes or without them, in lower case, or with
 * a stray space from a paste. glance_for() in docs/supabase_schema.sql strips
 * exactly the same things before it compares. If those two ever disagree,
 * pairing fails in the one way that is genuinely hard to diagnose — silently,
 * with both halves looking correct.
 */
function normalisePairCode(typed) {
  return String(typed || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/** Bytes as lowercase hex, which is the shape Postgres's encode(…, 'hex')
 *  produces — the two strings are compared character for character. */
function hexOf(buf) {
  var bytes = new Uint8Array(buf);
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return out;
}

/** The fingerprint that goes into device_keys. The code itself is never stored,
 *  never sent anywhere but here, and never written to the console. */
async function pairCodeHash(code) {
  var bytes = new TextEncoder().encode(normalisePairCode(code));
  return hexOf(await crypto.subtle.digest('SHA-256', bytes));
}

/** crypto.subtle exists only in a secure context — https, or localhost. Over
 *  plain http on a LAN address it is simply absent, and this is what lets the
 *  button say so instead of throwing something unreadable. */
function pairingSupported() {
  return typeof crypto !== 'undefined' && Boolean(crypto.subtle) &&
         typeof crypto.getRandomValues === 'function' && typeof TextEncoder !== 'undefined';
}

/** The paired widgets, a row each with a Revoke beside it. textContent
 *  throughout: the label is a string out of the database (rule 5). */
function renderDeviceKeys(rows) {
  var box = $('deviceList');
  box.textContent = '';

  if (!rows || !rows.length) {
    var none = document.createElement('p');
    none.className = 'hint';
    none.textContent = 'No widget is paired yet.';
    box.appendChild(none);
    return;
  }

  rows.forEach(function (r) {
    var row = document.createElement('div');
    row.className = 'cat-row';

    var name = document.createElement('span');
    name.className = 'cat-name';
    /* "last read" is the only thing that tells a working pairing from a code
     * typed in wrongly, which is the reason that column exists at all. */
    name.textContent = (r.label || 'Widget') + ' · ' +
      (r.last_seen_at ? 'last read ' + humanYmd(ymdLocal(new Date(r.last_seen_at)))
                      : 'never used yet');

    var kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'link-btn';
    kill.textContent = 'Revoke';
    kill.addEventListener('click', function () { revokeDeviceKey(r.id); });

    row.append(name, kill);
    box.appendChild(row);
  });
}

/**
 * Read the list.
 *
 * `secret_sha256` IS DELIBERATELY NOT ASKED FOR. Nothing on screen needs it, and
 * a column that is never fetched cannot reach a DOM node by accident. It is only
 * a fingerprint, so this is tidiness rather than a defence — but the tidy habit
 * is what keeps the real defences honest.
 */
async function loadDeviceKeys() {
  if (!sb || !sbUser) { renderDeviceKeys([]); return; }
  try {
    var res = await sb.from('device_keys')
      .select('id,label,created_at,last_seen_at')
      .order('created_at', { ascending: false });
    if (res.error) throw errorFrom(res.error);
    renderDeviceKeys(res.data || []);
  } catch (e) {
    renderDeviceKeys([]);
    $('pairResult').textContent = 'Could not read the paired list: ' + ((e && e.message) || e);
  }
}

/** Take one widget's key away, named by its id. Deleting the row is the whole of
 *  revoking: there is nothing else to withdraw, because the code itself was
 *  never kept. */
async function revokeDeviceKey(id) {
  var out = $('pairResult');
  out.textContent = 'Revoking…';
  try {
    var res = await sb.from('device_keys').delete().eq('id', id);
    if (res.error) throw errorFrom(res.error);
    hidePairCode();
    out.textContent = 'Revoked. That code opens nothing now.';
    await loadDeviceKeys();
  } catch (e) {
    out.textContent = '❌ ' + ((e && e.message) || e);
  }
}

/** Take the code off the screen — when Settings opens, and after a revoke, so a
 *  code cannot sit there from an earlier visit. */
function hidePairCode() {
  $('pairCode').textContent = '';
  $('pairCode').hidden = true;
}

/* Make a code, store its fingerprint, then show it.
 *
 * IN THAT ORDER ON PURPOSE. If the database refuses the row nothing is shown, so
 * a code can never be copied onto a scrap of paper while the door it is supposed
 * to open was never fitted. */
$('pairBtn').addEventListener('click', async function () {
  var out = $('pairResult');
  hidePairCode();

  if (!sb || !sbUser) { out.textContent = 'Sign in first.'; return; }
  if (!pairingSupported()) {
    out.textContent = 'This browser cannot make a code here. Open ProBeing over https ' +
      '(the GitHub Pages address, or localhost) and try again.';
    return;
  }

  out.textContent = 'Making a code…';
  try {
    var code = newPairCode();
    var res = await sb.from('device_keys').insert({
      // Named explicitly, as every other write here does: the column's default
      // only fires for a signed-in browser, and being explicit costs nothing.
      user_id: sbUser.id,
      secret_sha256: await pairCodeHash(code),
      label: 'Widget · ' + humanLocal()
    });
    if (res.error) throw errorFrom(res.error);

    $('pairCode').textContent = pairCodeDisplay(code);        // shown, never logged
    $('pairCode').hidden = false;
    out.textContent = 'Type this into the widget once. Write it down first — ProBeing ' +
      'keeps only a fingerprint of it, so it can never be shown again. Lost it? Revoke ' +
      'it below and make another.';
    await loadDeviceKeys();
  } catch (e) {
    out.textContent = '❌ ' + ((e && e.message) || e);
  }
});

// ------------------------------------------------ the glance in the shade

/* Stage 7b. "Working on" and "Today so far", one swipe down, WITHOUT a push.
 *
 * A push is how a server starts a notification while the app is closed. This is
 * the app posting one itself, with registration.showNotification(), while it is
 * running — so it needs the notification permission and the service worker, and
 * none of 7a's VAPID, Edge Function or pg_cron machinery.
 *
 * "AS OF" IS WHEN THE ROWS WERE READ, NOT WHEN THEY WERE PAINTED. That is the
 * whole honesty of this feature, and the first build got it wrong: it stamped
 * the paint instant, so a phone opened in airplane mode went on stamping the
 * current time over figures hours old, then left that on the lock screen. So the
 * glance shows exactly what the last successful read of the table returned, with
 * the work clock stopped at the moment that read was sent — not the taps made
 * since (the read each one triggers brings it in a second later), and not the
 * clock running on to now.
 *
 * Rejected: stamping "now" while live sync looks connected. This file does not
 * track the Realtime channel's state, and the heartbeat poll exists precisely
 * because that socket can die without saying so; a gate on it would bring the
 * same lie back, only more rarely. What the snapshot costs is lag while the app
 * sits idle on screen. Reads come on every change Realtime announces, on every
 * return to the app, and otherwise every five minutes — so the glance can trail
 * the Today card by that much. It is never wrong about when it was right.
 *
 * The shade stays per device. The widget's copy is written by the server
 * (glance-refresh), from the same day.js, so the two agree. Rejected: Periodic
 * Background Sync (Chrome runs it a few times a day at best, and a service
 * worker cannot read the session anyway).
 *
 * NOTHING HERE MAY SLOW A TAP (rule 4). It paints when a read lands, never inside
 * a button's own render; the notification is handed to the browser without
 * waiting for it, and every error is swallowed.
 */

/* The fixed options, in one place. The tag is its own — not 7a's probeing-awake
 * or probeing-awake-failed — so repainting the glance can never replace the
 * 11:30 PM question. It is a matched pair with GLANCE_TAG in sw.js.
 *
 * `silent` IS THE ONE LINE TO FLIP. Shipped true, because an update must not
 * buzz. The untested risk: Android may file a silent notification under its
 * "Silent" section, which a Pixel can hide from the lock screen. If so, set it
 * to false — the phone buzzes once when the glance first appears, and later
 * repaints under the same tag stay quiet anyway.
 *
 * Deliberately absent: `renotify` (Chrome throws when it is paired with silent),
 * the pin-until-clicked flag 7a's question uses (it parks a toast on a Windows
 * screen), and `actions` (a button would make it look like the Yes question). */
var GLANCE_OPTIONS = {
  tag: 'probeing-glance',
  silent: true,
  icon: 'icons/icon-192.png',
  badge: 'icons/favicon-32.png'
};

/* Once a minute while the app is on screen: put back a glance that was swiped
 * away, and take down one left from a previous day. Neither changes a figure, so
 * a minute with nothing to fix makes no call at all. */
var GLANCE_TICK_MS = 60000;

/* The last successful read of today: its rows, copied, and the moment it was
 * sent. Null until one lands — the readiness gate. Before that lastLog is empty,
 * and a paint would put "0m · 0 M" in the shade over the true figures from last
 * time. */
var glanceSnap = null;

/* Moved on by forgetGlance(). refresh() notes it before sending a read and arms
 * the glance only if it has not moved, so a read sent before Sign out cannot
 * bring that account's day back after it. */
var glanceEpoch = 0;

/* The title and body last handed over. A read that changes nothing — the
 * heartbeat, a return to the app in the same minute — is no call at all. */
var glanceShown = '';

/* The last showNotification, still on its way or not. tidyGlance() looks at the
 * shade only after it has landed; otherwise a glance being put up this instant
 * looks exactly like one that was swiped away, and goes up twice. */
var glanceShowing = Promise.resolve();

// glanceClock() and glanceText() live in day.js.

/** The options for one paint — a fresh object, so nothing can edit the constant.
 *  `timestamp` is the "as of" too: Android prints its age in the shade's header,
 *  which says how old the figures are a second time. */
function glanceOptions(body, atMs) {
  var options = { body: body, timestamp: atMs };
  Object.keys(GLANCE_OPTIONS).forEach(function (k) { options[k] = GLANCE_OPTIONS[k]; });
  return options;
}

function glanceSupported() {
  return 'serviceWorker' in navigator && typeof Notification !== 'undefined';
}

/** Ticked on this device, and allowed. Reads the permission; never asks for it. */
function glanceWanted() {
  return Boolean(cfg.glance) && glanceSupported() && Notification.permission === 'granted';
}

/**
 * What Settings says under the box when it is ticked but cannot work. Empty when
 * all is well.
 *
 * The case this exists for: permission given when the box was ticked, then taken
 * back in Chrome's site settings. The box stays ticked — the choice is still
 * his, and allowing notifications again brings the glance straight back — but
 * without this line nothing appears and nothing says why.
 */
function glanceBlockedNote() {
  if (!cfg.glance) return '';
  if (!glanceSupported()) {
    return 'Ticked, but this browser cannot show notifications, so nothing appears.';
  }
  if (Notification.permission === 'denied') {
    return 'Ticked, but notifications are now blocked for this site, so nothing appears. ' +
      UNBLOCK_HELP;
  }
  if (Notification.permission !== 'granted') {
    return 'Ticked, but this site is no longer allowed to show notifications, so nothing ' +
      'appears. Untick this and tick it again to be asked.';
  }
  return '';
}

/**
 * The shade's words for the last read, or null while no read has landed.
 * glance-refresh builds the widget's the same way, from the same day.js.
 * `carry` is what lets an empty morning read "Not started yet".
 */
function glanceWords() {
  if (!glanceSnap) return null;
  var snap = glanceSnap;

  /* Queued presses count here too, for the same reason they count on the Today
   * card: they happened, and this device is the only thing that knows. The "as
   * of" moves with them — a press IS an observation this device made — but never
   * for anything else, so an idle phone cannot go on stamping the current time
   * over figures hours old. That was the first build's bug; this is the one
   * narrow case where new information really did arrive offline.
   *
   * The widget's copy cannot show these: it is written by the server, which has
   * not been told yet. A queued entry reaches the widget when it saves.
   *
   * Filtered by rid, exactly as renderToday does it. A write whose row landed
   * and whose REPLY was lost is in the read AND still in the outbox, and
   * without this the shade would say "2 M" over a Today card saying "1 M". */
  var have = userMap();
  snap.log.forEach(function (r) { if (r.rid) have[r.rid] = 1; });
  snap.prayers.forEach(function (p) { if (p.rid) have[p.rid] = 1; });
  snap.lead.forEach(function (r) { if (r.rid) have[r.rid] = 1; });

  var log = snap.log.concat(queuedRowsToday(have));
  var lead = leadWithQueue(snap.lead, have);
  var prayers = snap.prayers.concat(queuedPrayersToday(have));
  var at = snap.at;
  queuedToday().forEach(function (it) {
    if (have[it.rid]) return;              // already in the read: it is not news
    var t = instantOf((it.payload || {}).at);
    if (!isNaN(t) && t > at) at = t;
  });

  var text = glanceText(dayFigures(log, prayers, at, snap.carry, lead, taskTree()), at);
  return { title: text.title, body: text.body, at: at };
}

/**
 * A read of today has landed: keep it for the shade, and paint.
 *
 * The rows are copied because lastLog is the same array, and every tap unshifts
 * into it — the glance would otherwise count a tap the table has not confirmed,
 * under a time from before it was made.
 *
 * Painted even while the page is hidden. The M tapped just before the phone is
 * locked arrives in exactly such a read, and every figure in it is true as of
 * the time it carries. The first build refused hidden paints only because its
 * time was the paint's own.
 */
function armGlance(data, readAt) {
  glanceSnap = {
    log: (data.log || []).slice(),
    prayers: (data.prayers || []).slice(),
    carry: Array.isArray(data.carry) ? data.carry.slice() : null,
    lead: (data.lead || []).slice(),
    at: readAt
  };
  paintGlance();
}

/** Forget the read this page holds, and disown any read still on its way. */
function forgetGlance() {
  glanceSnap = null;
  glanceEpoch += 1;
}

/**
 * Put the last read in the shade, replacing what is there. Nothing to do if it
 * reads exactly as what was last handed over.
 *
 * Yesterday's read is not painted once the day has turned here. Its weekday keeps
 * it honest, but the glance is for the day in progress (Saad kept this on 15 Sep):
 * it is dropped and taken down until today's first read lands, which offline
 * means no glance at all.
 */
function paintGlance() {
  try {
    if (!glanceSnap || !glanceWanted()) return;
    var text = glanceWords();
    if (counterDate(text.at) !== counterDate(Date.now())) {
      glanceSnap = null;
      closeGlance();
      return;
    }

    var shown = text.title + '\n' + text.body;
    if (shown === glanceShown) return;
    glanceShown = shown;

    glanceShowing = navigator.serviceWorker.ready.then(function (reg) {
      return reg.showNotification(text.title, glanceOptions(text.body, text.at));
    }).catch(function () {
      // It never appeared, so the next paint must not skip it.
      if (glanceShown === shown) glanceShown = '';
    });
  } catch (e) { /* a convenience: it must never break the read it rides on */ }
}

/** Take the glance out of the shade. Safe to call when there is none. */
function closeGlance() {
  glanceShown = '';
  try {
    if (!glanceSupported()) return;
    navigator.serviceWorker.getRegistration().then(function (reg) {
      return reg ? reg.getNotifications({ tag: GLANCE_OPTIONS.tag }) : [];
    }).then(function (list) {
      list.forEach(function (n) { n.close(); });
    }).catch(function () { /* nothing there to close */ });
  } catch (e) { /* likewise */ }
}

/**
 * Check the shade against what was put there. Changes no figure.
 *
 * Swiped away: forget it was shown, so the paint at the end puts it back. Asking
 * the browser, rather than re-showing the same text every minute to be sure, is
 * what keeps an idle minute to no call — the first build made three a minute,
 * and on Windows each can surface as a toast.
 *
 * From a previous day, going by its timestamp (which is its "as of"): close it.
 * That catches a glance left by an earlier visit, which this page never painted.
 */
function tidyGlance() {
  try {
    if (!cfg.glance || !glanceSupported()) return;
    glanceShowing.then(function () {
      return navigator.serviceWorker.getRegistration();
    }).then(function (reg) {
      if (!reg) return;
      var looked = glanceShown;
      return reg.getNotifications({ tag: GLANCE_OPTIONS.tag }).then(function (list) {
        var today = counterDate(Date.now());
        var left = list.filter(function (n) {
          var old = typeof n.timestamp === 'number' && n.timestamp > 0 &&
                    counterDate(n.timestamp) !== today;
          if (old) n.close();
          return !old;
        });
        // Nothing of ours in the shade, and nothing painted while looking: swiped.
        if (!left.length && glanceShown === looked) glanceShown = '';
        paintGlance();
      });
    }).catch(function () { /* nothing to tidy */ });
  } catch (e) { /* likewise */ }
}

/** Save's half: take the glance down when unticked, and when ticked put the last
 *  read up at once rather than at the next read. */
function applyGlanceSetting() {
  if (cfg.glance) {
    tidyGlance();
  } else {
    closeGlance();
  }
}

/* Ticking the box asks for the permission there and then, from the tap itself —
 * the same browser prompt "Turn on notifications" raises. Only a tick ever asks;
 * nothing on launch does, because a prompt nobody asked for is how a person
 * presses Block once and never sees a notification again. The setting itself
 * changes on Save, like every other box in this dialog. */
$('glanceOn').addEventListener('change', async function () {
  var box = $('glanceOn');
  var out = $('glanceResult');
  out.textContent = '';
  if (!box.checked) return;

  if (!glanceSupported()) {
    box.checked = false;
    out.textContent = 'This browser cannot show notifications.';
    return;
  }
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') {
    box.checked = false;
    out.textContent = 'Notifications are blocked for this site, and Chrome will not ask ' +
      'again. ' + UNBLOCK_HELP + ' Then tick this again.';
    return;
  }

  out.textContent = 'Asking the browser…';
  var answer = 'default';
  try {
    answer = await Notification.requestPermission();
  } catch (e) { /* treated as a no */ }
  paintPushState();                  // the bedtime block reads the same permission

  if (answer === 'granted') {
    out.textContent = 'Allowed. Press Save to show it.';
    return;
  }
  box.checked = false;
  out.textContent = 'Not allowed, so this stays off.';
});

/* Only while on screen. A backgrounded page's timers run at the browser's whim,
 * and a tick from one would put back a glance swiped away on the lock screen. */
setInterval(function () {
  if (document.visibilityState !== 'visible') return;
  tidyGlance();
}, GLANCE_TICK_MS);

/* Coming back: it may have been swiped, or the day may have turned, while the
 * app was away. The refresh this same return triggers brings the figures up to
 * date a moment later. Leaving needs nothing: only a read changes the glance,
 * and it paints whenever one lands. */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') tidyGlance();
});

/* And once on launch, for a glance an earlier visit left from a previous day.
 * It only reads the permission; nothing on launch asks for it. */
tidyGlance();

// ------------------------------------------------- google tasks (Stage 12)

/* Settings' Google Tasks section. Every Google token stays in the google-link
 * function; this side only ever sees who is connected and which list. Nothing
 * here is on the logging path (rule 4). */
var googleStatus = null;       // the last google-link status reply; null while checking
var googleSync = null;         // this user's sync_state row, or null
var googleSyncRead = false;    // read this visit; until then serverFiles() remembers
var googleChannel = null;
// Stage 18's columns, read with the rest of the row.
var SYNC_SHEET_COLS = ',sheet_url,last_export_at,export_error,sheet_note';

var GOOGLE_TIMEOUT_MS = 30000;   // a cold function plus a call to Google

/** Ask google-link. Always resolves; a failure is {ok:false, error}. */
async function googleCall(op, extra) {
  return functionCall('google-link', Object.assign({ op: op }, extra || {}));
}

/** POST `body` to Edge Function `name` with his JWT. Always resolves, as above. */
async function functionCall(name, body) {
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, GOOGLE_TIMEOUT_MS) : 0;
  try {
    if (!sb) return { ok: false, error: 'Sign in first.' };
    var got = await sb.auth.getSession();
    var session = got && got.data ? got.data.session : null;
    if (!session || !session.access_token) return { ok: false, error: 'Sign in first.' };
    var base = String(cfg.supaUrl || '').trim().replace(/\/+$/, '');
    var res = await fetch(base + '/functions/v1/' + name, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': String(cfg.supaKey || '').trim()
      },
      body: JSON.stringify(body || {}),
      signal: ctrl ? ctrl.signal : undefined
    });
    var data = await res.json().catch(function () { return null; });
    // Our functions never answer 404; Supabase does when the function is not deployed.
    if (res.status === 404) return { ok: false, notDeployed: true, error: 'the ' + name + ' function is not deployed yet' };
    if (data && typeof data === 'object' && typeof data.ok === 'boolean') return data;
    return { ok: false, error: 'the server answered ' + res.status };
  } catch (e) {
    // timedOut: the server may still finish what it was asked.
    if (e && e.name === 'AbortError') return { ok: false, timedOut: true, error: 'no answer within 30 seconds' };
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Row level security returns only this user's row. A missing table reads as none. */
async function readGoogleSync() {
  googleSync = null;
  if (!sb) return;
  function read(cols) { return sb.from('sync_state').select(cols).limit(1); }
  try {
    var cols = 'connected,google_email,list_id,list_title,last_error,last_error_at,last_pull_ok_at,deep_ignored';
    var res = await read(cols + SYNC_SHEET_COLS);
    // Before Stage 18's columns exist, the rest of the row still reads.
    if (res.error && res.error.code === '42703') res = await read(cols);
    if (!res.error) {
      googleSync = (res.data || [])[0] || null;
      await rememberServerFiles();
      googleSyncRead = true;
    }
  } catch (e) { /* the status reply stands in */ }
}

/** Which state the section is in, and its words. sync_state wins where it has a row. */
function googleView(status, sync) {
  if (!status) return { state: 'checking', text: 'Checking Google…' };
  if (status.configured === false && status.problem === 'token key malformed') {
    return { state: 'dormant', text: 'Google setup has a problem: the token key is malformed.' };
  }
  // A reply without `ok` is Supabase's own, not google-link's: not deployed yet.
  if (status.configured === false || status.notDeployed || typeof status.ok !== 'boolean') {
    return { state: 'dormant', text: 'Google isn’t set up yet — see your to-do list.' };
  }
  if (!status.ok) return { state: 'unknown', text: 'Could not check Google: ' + (status.error || 'no answer') };
  var connected = sync ? Boolean(sync.connected) : Boolean(status.connected);
  if (!connected) return { state: 'off', text: 'Not connected.' };
  var email = (sync && sync.google_email) || status.email || '';
  var list = (sync && sync.list_title) || status.list_title || '';
  var err = String((sync && sync.last_error) || '');
  if (status.reconnect || err.indexOf('Reconnect Google') === 0) {
    return { state: 'reconnect', email: email, list: list,
             text: 'Reconnect Google: it stopped accepting ProBeing’s permission' +
                   (email ? ' for ' + email : '') + '.' };
  }
  return { state: 'on', email: email, list: list,
           text: 'Connected as ' + (email || 'your Google account') + '. ' +
                 (list ? 'List: ' + list + '.' : 'No list chosen yet.'),
           note: status.drive === false ? 'Drive not allowed — the Google Sheets copy won’t ' +
                                          'work. Reconnect and tick both boxes to fix.' : '' };
}

function paintGoogle() {
  var v = googleView(googleStatus, googleSync);
  $('googleState').textContent = v.text;                  // rule 5: email and title are data
  $('googleNote').textContent = v.note || '';
  $('googleNote').hidden = !v.note;
  var connect = $('googleConnectBtn');
  connect.hidden = v.state !== 'off' && v.state !== 'reconnect';
  connect.textContent = v.state === 'reconnect' ? 'Reconnect Google' : 'Connect Google';
  $('googleListBtn').hidden = v.state !== 'on';
  $('googleDisconnectBtn').hidden = v.state !== 'on' && v.state !== 'reconnect';
  if (v.state !== 'on') $('googleListPick').hidden = true;
  paintTasksSettings(v);
  paintSheet(v);
  return v;
}

// ------------------------------------------------- google sheet copy (Stage 18)

var sheetExporting = false;

/** Only a Google Sheets address is ever a link; anything else is not shown. */
function sheetHref(url) {
  var u = String(url || '');
  return /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+(\/[^\s"'<>]*)?$/.test(u) ? u : '';
}

/** When it last copied, and what went wrong or changed. */
function sheetText(sync) {
  var parts = [];
  var t = Date.parse((sync && sync.last_export_at) || '');
  if (isFinite(t)) {
    var day = ymdLocal(new Date(t));
    parts.push('Copied to your Google Sheet ' + (day === ymdLocal(new Date()) ? 'today' : humanYmd(day)) +
               ' at ' + clockOf({ at: sync.last_export_at }) + '. It is rewritten daily at 12:00 Karachi time.');
  } else parts.push('Not copied to a Google Sheet yet. It is written daily at 12:00 Karachi time.');
  if (sync && sync.sheet_note) parts.push(String(sync.sheet_note));
  var err = String((sync && sync.export_error) || '');
  if (err && err.indexOf('Reconnect Google') !== 0) parts.push('⚠ ' + err);
  return parts.join(' ');
}

/** Settings: the Sheet link and Export now, while Google is connected. */
function paintSheet(v) {
  var on = v.state === 'on';
  $('sheetBlock').hidden = !on;
  if (!on) return;
  $('sheetLine').textContent = sheetText(googleSync);   // rule 5: the note is server text
  var href = sheetHref(googleSync && googleSync.sheet_url);
  var link = $('sheetLink');
  link.hidden = !href;
  if (href) link.href = href; else link.removeAttribute('href');
  var btn = $('sheetExportBtn');
  btn.disabled = sheetExporting;
  btn.textContent = sheetExporting ? 'Exporting…' : 'Export now';
}

$('sheetExportBtn').addEventListener('click', async function () {
  if (sheetExporting) return;
  var out = $('sheetResult');
  out.textContent = '';
  sheetExporting = true;
  paintGoogle();
  var r = await functionCall('sheets-export', {});
  if (r.timedOut) {
    // The export goes on without the page: look again later, and hold the button meanwhile.
    out.textContent = 'Still working (no answer within 30 seconds yet) — check back in a minute.';
    setTimeout(function () { readGoogleSync().then(paintGoogle); }, 60000);
    setTimeout(function () { sheetExporting = false; readGoogleSync().then(paintGoogle); }, 120000);
    return;
  }
  try {
    await readGoogleSync();
  } finally {
    sheetExporting = false;
    paintGoogle();
  }
  if (r.reconnect && googleStatus) { googleStatus.reconnect = true; paintGoogle(); }
  if (!r.ok) out.textContent = '❌ ' + (r.error || 'not exported');
  else if (r.busy) out.textContent = 'An export is already running; the line above updates when it finishes.';
  else if (r.skipped) out.textContent = 'Nothing to export: ' + r.skipped + '.';
  else {
    var n = 0;
    Object.keys(r.rows || {}).forEach(function (k) { n += Number(r.rows[k]) || 0; });
    out.textContent = (r.replaced ? 'Made a new Sheet (the old one was in the bin or deleted) and copied '
                       : r.created ? 'Made your Google Sheet and copied ' : 'Copied ') +
                      n + (n === 1 ? ' row.' : ' rows.');
  }
});

/** On opening Settings. Just connected with no list yet: the picker opens by itself. */
async function loadGoogle() {
  googleStatus = null;
  $('googleResult').textContent = '';
  $('googleListPick').hidden = true;
  paintGoogle();
  var both = await Promise.all([googleCall('status'), readGoogleSync()]);
  googleStatus = both[0];
  var v = paintGoogle();
  if (v.state === 'on' && !v.list) showGoogleLists();
}

async function showGoogleLists() {
  var out = $('googleResult');
  var pick = $('googleListPick');
  out.textContent = 'Reading your Tasks lists…';
  var r = await googleCall('lists');
  if (!r.ok) {
    out.textContent = '❌ ' + (r.error || 'could not read your lists');
    if (r.reconnect) {
      await readGoogleSync();
      if (googleStatus) googleStatus.reconnect = true;
      paintGoogle();
    }
    return;
  }
  var lists = r.lists || [];
  var chosen = (googleStatus && googleStatus.list_id) || '';
  pick.textContent = '';
  var first = document.createElement('option');
  first.value = '';
  first.textContent = lists.length ? 'Choose the list ProBeing should use' : 'You have no Tasks lists yet';
  pick.appendChild(first);
  lists.forEach(function (l) {
    var o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.title || '(untitled list)';
    if (l.id === chosen) o.selected = true;
    pick.appendChild(o);
  });
  pick.hidden = false;
  out.textContent = '';
}

/* The page swaps for Google's own. The indirection lets a test watch it. */
function googleGo(url) { window.location.assign(url); }

$('googleConnectBtn').addEventListener('click', async function () {
  var out = $('googleResult');
  out.textContent = 'Opening Google…';
  var r = await googleCall('start');
  if (!r.ok || !/^https:\/\/accounts\.google\.com\//.test(String(r.url || ''))) {
    out.textContent = '❌ ' + (r.error || 'no Google link came back');
    return;
  }
  googleGo(r.url);
});

$('googleListBtn').addEventListener('click', function () { showGoogleLists(); });

$('googleListPick').addEventListener('change', async function () {
  var out = $('googleResult');
  var id = $('googleListPick').value;
  if (!id) return;
  out.textContent = 'Saving…';
  var r = await googleCall('pick', { list_id: id });
  if (!r.ok) { out.textContent = '❌ ' + (r.error || 'not saved'); return; }
  if (googleStatus) { googleStatus.list_id = r.list_id; googleStatus.list_title = r.list_title; }
  if (googleSync) googleSync.list_title = r.list_title;
  $('googleListPick').hidden = true;
  paintGoogle();
  out.textContent = 'ProBeing will use “' + r.list_title + '”.';
  syncTasks(true);                   // its first copy now, not in 15 minutes
});

$('googleDisconnectBtn').addEventListener('click', async function () {
  if (!confirm('Disconnect Google? ProBeing stops reading your Tasks, and Google is asked ' +
               'to cancel its permission. Your ProBeing log is not touched.')) return;
  var out = $('googleResult');
  out.textContent = 'Disconnecting…';
  var r = await googleCall('disconnect');
  if (!r.ok) { out.textContent = '❌ ' + (r.error || 'not disconnected'); return; }
  googleStatus = { ok: true, configured: true, connected: false };
  await readGoogleSync();
  paintGoogle();
  out.textContent = r.note || 'Disconnected. Google has cancelled ProBeing’s permission.';
});

/* Its own channel, so a missing sync_state table cannot upset the events feed.
 * The announcement is only a nudge: the row is read again. */
function watchGoogle() {
  if (!sb || !sbUser || googleChannel) return;
  googleChannel = sb.channel('probeing-google')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sync_state' },
        function () {
          // The Home card reads this row too, so it is re-read with Settings shut.
          readGoogleSync().then(function () {
            if (dlg.open) paintGoogle();
            paintPlan();
          });
        })
    .subscribe();
}

function stopGoogle() {
  stopTasks();
  if (!googleChannel) return;
  try { sb.removeChannel(googleChannel); } catch (e) { /* already gone */ }
  googleChannel = null;
}

// ----------------------------------------- google tasks mirror (Stage 13)

/* The read-only copy of his Tasks list. tasks-sync pulls it into task_nodes;
 * this side asks for a pull, reads the rows and draws them, using tree.js.
 * Titles are his text (rule 5). Nothing here is on the logging path (rule 4). */
var taskNodes = [];              // this user's task_nodes rows, as last read
var TASKS_SYNC_EVERY_MS = 2 * 60 * 1000;
var TASKS_OPEN_DELAY_MS = 2000;
var lastTasksSyncAt = 0;         // when a pull was last asked for
var lastTasksCheckAt = 0;        // when sync_state was last read on open or return
var tasksSyncing = false;
var tasksChannel = null;
var taskNodesTimer = 0;

/** A list is picked, so there is something to pull. */
function tasksConnected() {
  return Boolean(googleSync && googleSync.connected && googleSync.list_title);
}

/* What was sent to Google (Stage 15) rides along; before those columns exist
 * the Stage 13 set is read instead, so an app ahead of its SQL still shows the tree. */
var TASK_NODE_COLS = 'id,google_id,list_id,parent_google_id,kind,title,position,due,g_status,gone_at';
var TASK_NODE_SENT = ',g_completed_at,g_reopened_at,pb_pushed_at,pb_completed_at,pb_due,pb_due_sent_at';

/** Open and done rows first, then the newest gone ones. A failed read keeps the last. */
async function readTaskNodes() {
  if (!sb) return;
  function read(cols) {
    return sb.from('task_nodes').select(cols)
      .order('gone_at', { ascending: false, nullsFirst: true }).limit(1000);
  }
  try {
    var res = await read(TASK_NODE_COLS + TASK_NODE_SENT);
    if (res.error && res.error.code === '42703') res = await read(TASK_NODE_COLS);
    if (!res.error) taskNodes = res.data || [];
  } catch (e) { /* the last read stands */ }
}

/** A task's title, marked when Google no longer has it (Stage 15). */
function nodeTitle(n) {
  var t = String((n && n.title) || '').trim() || '(untitled)';
  return n && n.gone_at ? t + ' (deleted in Google)' : t;
}

/* A list picked before stays in the table; only the list tasks-sync last read is shown. */
function currentNodes() {
  var list = googleSync && googleSync.list_id;
  return list ? taskNodes.filter(function (n) { return n.list_id === list; }) : [];
}

/**
 * Ask tasks-sync to pull, then read what it wrote. `force` is Sync now; the
 * other callers pull at most once per TASKS_SYNC_EVERY_MS. Resolves to the
 * function's reply, or null when it did not ask.
 */
async function syncTasks(force) {
  if (tasksSyncing || !tasksConnected()) return null;
  if (!force && Date.now() - lastTasksSyncAt < TASKS_SYNC_EVERY_MS) return null;
  tasksSyncing = true;
  lastTasksSyncAt = Date.now();
  paintTasksSettings();
  try {
    var r = await functionCall('tasks-sync', {});
    await Promise.all([readGoogleSync(), readTaskNodes()]);
    return r;
  } finally {
    tasksSyncing = false;
    paintTasks();
    if (dlg.open) paintGoogle();
  }
}

/** On sign-in and on coming back: what the table holds, then a pull if one is due. */
async function tasksOnOpen() {
  if (!sbUser) return;
  lastTasksCheckAt = Date.now();
  await readGoogleSync();
  if (tasksConnected()) await Promise.all([readTaskNodes(), readTaskPlans()]);
  paintTasks();
  scheduleFiling();
  scheduleItems(0);
  syncTasks(false);
}

function paintTasks() {
  paintPlan();
  paintTasksSettings();
  paintTasksPage();
  // Names and the current sub-task come from the mirror (14b), so these follow it.
  renderProject();
  renderDaySummary();
}

/** Home's Upcoming tasks: Planned and due tasks, soonest first; when there are
 *  none, every open task (13b). Grouped under their projects. Hidden until a
 *  list is connected. */
function paintPlan() {
  var card = $('planCard');
  if (!tasksConnected() || typeof todaysPlan !== 'function') { card.hidden = true; return; }
  var now = Date.now();
  var today = counterDate(now);
  var plan = homePlanLeaves(currentNodes(), today, counterDayEnd(now));
  var list = $('planList');
  list.textContent = '';
  planGroups(plan).forEach(function (g) {
    var li = document.createElement('li');
    if (!g.up) {
      // A childless project, or a sub-task whose project is not in the list.
      li.appendChild(taskButton(g.leaves[0], 'planList', taskMeta(g.leaves[0], today, true)));
    } else {
      li.className = 'plan-group';
      var head = document.createElement('div');
      head.className = 'plan-project';
      head.textContent = nodeTitle(g.up);
      li.appendChild(head);
      var sub = document.createElement('ul');
      g.leaves.forEach(function (leaf) {
        var sli = document.createElement('li');
        sli.appendChild(taskButton(leaf, 'planList', taskMeta(leaf, today, false)));
        sub.appendChild(sli);
      });
      li.appendChild(sub);
    }
    list.appendChild(li);
  });
  list.hidden = !plan.length;
  $('planEmpty').hidden = plan.length > 0;
  card.hidden = false;
}

/** Leaves grouped by project, in the order each project first appears:
 *  [{up, leaves}]. A leaf with no project is a group of its own, up null. */
function planGroups(leaves) {
  var out = [];
  var byUp = userMap();
  (leaves || []).forEach(function (l) {
    if (!l.up) { out.push({ up: null, leaves: [l] }); return; }
    var g = byUp[l.up.id];
    if (!g) { g = byUp[l.up.id] = { up: l.up, leaves: [] }; out.push(g); }
    g.leaves.push(l);
  });
  return out;
}

/** When it last pulled, and why the last try failed. A reconnect is said above it. */
function tasksSyncText(sync) {
  var parts = [];
  var t = Date.parse((sync && sync.last_pull_ok_at) || '');
  if (tasksSyncing) parts.push('Syncing with Google Tasks…');
  else if (isFinite(t)) {
    var day = ymdLocal(new Date(t));
    parts.push('Last synced ' + (day === ymdLocal(new Date()) ? '' : humanYmd(day) + ', ') +
               clockOf({ at: sync.last_pull_ok_at }) + '.');
  } else parts.push('Not synced yet.');
  var err = String((sync && sync.last_error) || '');
  if (err && err.indexOf('Reconnect Google') !== 0) parts.push('⚠ ' + err);
  var deep = Number(sync && sync.deep_ignored) || 0;
  if (deep > 0) {
    parts.push(deep + (deep === 1 ? ' task is' : ' tasks are') +
               ' nested under a sub-task, which ProBeing does not show.');
  }
  return parts.join(' ');
}

/** Settings: Sync now, the sync line and the whole tree, once a list is picked. */
function paintTasksSettings(v) {
  v = v || googleView(googleStatus, googleSync);
  var on = v.state === 'on' && Boolean(v.list) && typeof mirrorTree === 'function';
  var btn = $('tasksSyncBtn');
  btn.hidden = !on;
  btn.disabled = tasksSyncing;
  btn.textContent = tasksSyncing ? 'Syncing…' : 'Sync now';
  var line = $('tasksSyncLine');
  line.hidden = !on;
  line.textContent = on ? tasksSyncText(googleSync) : '';
  var tree = $('tasksTree');
  tree.textContent = '';
  var projects = on ? mirrorTree(currentNodes()) : [];
  projects.forEach(function (p) {
    var li = document.createElement('li');
    var name = document.createElement('span');
    name.className = 'task-project task-' + p.state;
    // node null: the group of sub-tasks whose project is not in the list.
    name.textContent = p.node ? nodeTitle(p.node) : '(no project)';
    li.appendChild(name);
    if (p.children.length) {
      var sub = document.createElement('ul');
      p.children.forEach(function (c) {
        var cli = document.createElement('li');
        cli.className = 'task-' + c.state;
        var due = dueOf(c.node.due);
        cli.textContent = nodeTitle(c.node) + (due ? ' · due ' + humanYmd(due) : '');
        sub.appendChild(cli);
      });
      li.appendChild(sub);
    }
    tree.appendChild(li);
  });
  tree.hidden = !projects.length;
}

$('tasksSyncBtn').addEventListener('click', async function () {
  var out = $('googleResult');
  out.textContent = '';
  var r = await syncTasks(true);
  if (!r) return;
  if (r.reconnect && googleStatus) { googleStatus.reconnect = true; paintGoogle(); }
  if (!r.ok) out.textContent = '❌ ' + (r.error || 'not synced');
  else if (r.skipped) out.textContent = 'Nothing to sync: ' + r.skipped + '.';
  else out.textContent = 'Synced ' + r.tasks + (r.tasks === 1 ? ' task.' : ' tasks.');
});

/* Its own channel, like watchGoogle's: a task_nodes table not made yet must not
 * take the sync_state feed down with it. A burst of rows is one re-read. */
function watchTasks() {
  watchPlans();
  watchFiling();
  watchItems();
  if (!sb || !sbUser || tasksChannel) return;
  tasksChannel = sb.channel('probeing-tasks')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'task_nodes' },
        function () {
          clearTimeout(taskNodesTimer);
          taskNodesTimer = setTimeout(function () { readTaskNodes().then(paintTasks); }, 1000);
        })
    .subscribe();
}

function stopTasks() {
  clearTimeout(taskNodesTimer);
  stopPlans();
  stopFiling();
  stopItems();
  taskNodes = [];
  googleSync = null;
  googleSyncRead = false;
  lastTasksSyncAt = 0;
  lastTasksCheckAt = 0;
  paintPlan();
  paintTasksPage();
  if (!tasksChannel) return;
  try { sb.removeChannel(tasksChannel); } catch (e) { /* already gone */ }
  tasksChannel = null;
}

// --------------------------------------------------------- the Tasks page

/* Working on, Planned and All tasks, from the mirror above plus task_plans,
 * his own plan for each task: on Planned or not, and when he expects to finish.
 * A plan write goes straight to the table, not the outbox: it is a setting the
 * last change wins, and a copy replayed hours later could undo a newer one from
 * the other device. A failure is said in the box; the next tap retries.
 * Start working on it IS a logging press, so it goes through api() and the outbox. */
var taskPlans = userMap();       // node id -> its task_plans row, as last read
var plansChannel = null;
var plansTimer = 0;
var taskDlg = $('taskDlg');
var taskDlgNode = null;          // the task the box is open on
var taskDlgOpener = null;        // {el, list}: where focus goes back to
var taskDlgBusy = false;

/** This user's plans. False when they could not be read; the last read stands. */
async function readTaskPlans() {
  if (!sb) return false;
  try {
    var res = await sb.from('task_plans').select('node_id,planned,expected_at,updated_at').limit(2000);
    if (res.error) return false;
    var map = userMap();
    (res.data || []).forEach(function (r) { if (r && r.node_id) map[r.node_id] = r; });
    taskPlans = map;
    return true;
  } catch (e) { return false; }
}

function planOf(id) { return taskPlans[id] || null; }

/** His planned finish for a task, in ms; NaN when none is set. */
function expectedMs(id) {
  var plan = planOf(id);
  return plan && plan.expected_at ? Date.parse(plan.expected_at) : NaN;
}

/** The finish shown for a task: his, unless Google's due date was changed
 *  after ProBeing sent it; then Google's date wins (Stage 15). */
function shownFinishMs(node) {
  return typeof dueMovedInGoogle === 'function' && dueMovedInGoogle(node) ? NaN : expectedMs(node.id);
}

/** When the counter day holding `now` ends. 30 hours after its start is always the next day. */
function counterDayEnd(now) {
  return counterDayStart(counterDayStart(now) + 30 * 3600000);
}

/** Every task that can be worked on, in any state: a sub-task, or a project with
 *  no sub-task left (todaysPlan's rule). `up` is its project, or null. */
function taskLeaves(nodes) {
  var byGoogle = userMap();
  var hasKids = userMap();
  (nodes || []).forEach(function (n) {
    byGoogle[n.google_id] = n;
    if (n.kind === 'subtask' && !n.gone_at) hasKids[n.parent_google_id] = 1;
  });
  return (nodes || []).filter(function (n) {
    return n.kind === 'subtask' || (n.kind === 'project' && !hasKids[n.google_id]);
  }).map(function (n) {
    return { node: n, up: n.kind === 'subtask' ? byGoogle[n.parent_google_id] || null : null };
  });
}

/** Open in Google, and not under a deleted project. */
function leafOpen(leaf) {
  return nodeOpen(leaf.node) && !(leaf.up && leaf.up.gone_at);
}

/** Open, and not finished here by its own Done (`done`: doneHere()). */
function leafLive(leaf, done) {
  return leafOpen(leaf) && !done[leaf.node.id];
}

function openLeafById(id) {
  var done = doneHere();
  var hit = taskLeaves(currentNodes()).filter(function (l) { return l.node.id === id && leafLive(l, done); });
  return hit[0] || null;
}

/** Sort key: his expected finish, else the end of Google's due date, else never. */
function taskWhenMs(leaf) {
  var t = shownFinishMs(leaf.node);
  if (isFinite(t)) return t;
  var due = dueOf(leaf.node.due);
  if (!due) return Infinity;
  var p = due.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 23, 59, 59, 999).getTime();
}

/** Soonest first, then Google's own order. */
function byTaskWhen(a, b) {
  var ta = taskWhenMs(a);
  var tb = taskWhenMs(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  var ka = [String((a.up || a.node).position || ''), a.up ? String(a.node.position || '') : '',
            String(a.node.title || '')];
  var kb = [String((b.up || b.node).position || ''), b.up ? String(b.node.position || '') : '',
            String(b.node.title || '')];
  for (var i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return 0;
}

/** Open tasks on Planned, soonest finish first, unset last. */
function plannedLeaves(nodes) {
  var done = doneHere();
  return taskLeaves(nodes).filter(function (l) {
    var plan = planOf(l.node.id);
    return leafLive(l, done) && Boolean(plan && plan.planned);
  }).sort(byTaskWhen);
}

/** Home's card: Planned, due by `today` (the counter date) in Google, or expected
 *  to finish before `endMs`; soonest first. None of those: every open task, as
 *  todaysPlan lists them (13b). */
function homePlanLeaves(nodes, today, endMs) {
  var done = doneHere();
  var open = taskLeaves(nodes).filter(function (l) { return leafLive(l, done); });
  var picked = open.filter(function (l) {
    var plan = planOf(l.node.id);
    var due = dueOf(l.node.due);
    return Boolean(plan && plan.planned) || Boolean(due && due <= today) || shownFinishMs(l.node) < endMs;
  }).sort(byTaskWhen);
  if (picked.length) return picked;
  var byId = userMap();
  open.forEach(function (l) { byId[l.node.id] = l; });
  return todaysPlan(nodes, today).map(function (p) { return byId[p.id]; }).filter(Boolean);
}

function sameTitle(a, b) {
  var norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
  return norm(a) !== '' && norm(a) === norm(b);
}

/**
 * What is being worked on, as tasks. Each open project in the session
 * (replayDay), newest first, matched to open tasks by the node_id its rows
 * carry, then by title: its sub-tasks as projectTasks reads them, or a task
 * named on its own. {running, items: [{name, leaf}]}; leaf null = no match.
 */
function workingOnLeaves(nodes, rows) {
  var day = replayDay(rows);
  var done = doneHere();
  var open = taskLeaves(nodes).filter(leafOpen);
  var byId = userMap();
  open.forEach(function (l) { byId[l.node.id] = l; });
  var seen = userMap();
  var items = [];
  day.activeProjects.slice().reverse().forEach(function (name) {
    var hits = [];
    function add(l) { if (hits.indexOf(l) === -1) hits.push(l); }
    (rows || []).forEach(function (r) {
      if ((r.type !== 'work' && r.type !== 'voice') || !r.node_id || !byId[r.node_id]) return;
      if (String(r.project || r.raw_text || '').trim() === name) add(byId[r.node_id]);
    });
    var tasks = projectTasks(rows, name);
    open.forEach(function (l) {
      if (l.up && sameTitle(l.up.title, name) &&
          tasks.some(function (t) { return sameTitle(t, l.node.title); })) add(l);
    });
    if (!hits.length) open.forEach(function (l) { if (sameTitle(l.node.title, name)) add(l); });
    if (!hits.length) { items.push({ name: name, leaf: null }); return; }
    // Finished by its own Done: off the list. All of them: the project says so.
    var live = hits.filter(function (l) { return !done[l.node.id]; });
    if (!live.length) { items.push({ name: name, leaf: null, finished: true }); return; }
    live.forEach(function (l) {
      if (seen[l.node.id]) return;
      seen[l.node.id] = 1;
      items.push({ name: name, leaf: l });
    });
  });
  return { running: day.running, items: items };
}

/** "today, 17:00" or "3 Oct 2026, 09:30", on this device's clock. "today" is the
 *  counter day, as on Home: at 01:00, 03:00 is today and 23:59 is not. */
function taskWhenLabel(ms) {
  var d = new Date(ms);
  var day = counterDate(ms) === counterDate(Date.now()) ? 'today' : humanYmd(ymdLocal(d));
  return day + ', ' + clockOf({ at: d.toISOString() });
}

/** The line under a task: its project (when asked), and `due`, his expected
 *  finish (drawn by deadlineChip), else Google's due once it has passed. */
function taskMeta(leaf, today, withProject) {
  var parts = [];
  var late = false;
  if (withProject && leaf.up) parts.push(leaf.up.title || '(untitled)');
  var t = shownFinishMs(leaf.node);
  var due = dueOf(leaf.node.due);
  if (isFinite(t)) {
    return { text: parts.join(' · '), late: false, due: t };
  } else if (isFinite(expectedMs(leaf.node.id))) {
    // His finish was sent, then the date was changed in Google: Google's stands.
    late = Boolean(due && due < today);
    parts.push(due ? 'due ' + humanYmd(due) + ' (set in Google)' : 'no date in Google');
  } else if (due && due < today) {
    late = true;
    parts.push('due ' + humanYmd(due));
  }
  return { text: parts.join(' · '), late: late };
}

/** A task as a button that opens its box. Titles are his text (rule 5). */
function taskButton(leaf, listId, meta) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'task-item';
  b.setAttribute('data-node', leaf.node.id);
  var title = document.createElement('div');
  title.className = 'plan-title';
  title.textContent = leaf.node.title || '(untitled)';
  b.appendChild(title);
  var dated = meta && isFinite(meta.due);
  if (meta && (meta.text || dated)) {
    var m = document.createElement('div');
    m.className = 'plan-meta' + (meta.late ? ' overdue' : '');
    m.textContent = meta.text;
    if (dated) m.appendChild(deadlineChip(meta.due, meta.text ? ' · ' : ''));
    b.appendChild(m);
  }
  b.addEventListener('click', function () { openTaskDlg(leaf.node.id, b, listId); });
  return b;
}

/* ── Deadlines (feedback 1): "by 4:30 PM" on a task with an expected finish.
 * Orange while more than an hour is left, red in the last hour, and a blinking
 * red dot once it has passed. paintDeadlines() keeps them current. */
var DEADLINE_NEAR_MS = 3600000;
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'soon' (orange), 'near' (red, the last hour) or 'past' (red, with the dot). */
function deadlineLevel(ms, now) {
  var left = ms - now;
  if (left <= 0) return 'past';
  return left <= DEADLINE_NEAR_MS ? 'near' : 'soon';
}

/** "4:30 PM" on this device's clock. */
function clockAmPm(d) {
  var h = d.getHours();
  return ((h % 12) || 12) + ':' + pad2(d.getMinutes()) + (h < 12 ? ' AM' : ' PM');
}

/** "by 4:30 PM" today (the counter day), "by Thu 4:30 PM" within a week, else "by 12 Oct 4:30 PM". */
function deadlineLabel(ms, now) {
  var d = new Date(ms);
  if (counterDate(ms) === counterDate(now)) return 'by ' + clockAmPm(d);
  if (Math.abs(ms - now) < 6 * 86400000) return 'by ' + WEEKDAYS[d.getDay()] + ' ' + clockAmPm(d);
  var p = ymdLocal(d).split('-');
  return 'by ' + Number(p[2]) + ' ' + 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[Number(p[1]) - 1] +
         ' ' + clockAmPm(d);
}

/** The deadline as a span, after `sep`. Text only: nothing here is markup. */
function deadlineChip(ms, sep) {
  var wrap = document.createElement('span');
  if (sep) wrap.appendChild(document.createTextNode(sep));
  var s = document.createElement('span');
  s.setAttribute('data-due', String(ms));
  var dot = document.createElement('span');
  dot.className = 'dl-dot';
  dot.setAttribute('aria-hidden', 'true');
  var text = document.createElement('span');
  text.className = 'dl-text';
  s.append(dot, text);
  wrap.appendChild(s);
  paintDeadline(s, Date.now());
  return wrap;
}

function paintDeadline(s, now) {
  var ms = Number(s.getAttribute('data-due'));
  if (!isFinite(ms)) return;
  var level = deadlineLevel(ms, now);
  s.className = 'deadline dl-' + level;
  s.lastChild.textContent = deadlineLabel(ms, now);
  if (level === 'past') s.setAttribute('aria-label', 'Past due, ' + deadlineLabel(ms, now));
  else s.removeAttribute('aria-label');
}

/** Every deadline on the page, to the minute. Cheap: no read, no redraw of the lists. */
function paintDeadlines() {
  var now = Date.now();
  Array.prototype.forEach.call(document.querySelectorAll('[data-due]'), function (s) { paintDeadline(s, now); });
}

/** A line that is not a button: an unmatched project, or a done or gone task. */
function taskLine(text, meta, cls) {
  var li = document.createElement('li');
  if (cls) li.className = cls;
  var title = document.createElement('div');
  title.textContent = text;
  li.appendChild(title);
  if (meta) {
    var m = document.createElement('div');
    m.className = 'plan-meta';
    m.textContent = meta;
    li.appendChild(m);
  }
  return li;
}

function paintTasksPage() {
  var on = tasksConnected() && typeof mirrorTree === 'function';
  $('tasksOff').hidden = on;
  ['tasksNowCard', 'tasksPlannedCard', 'tasksAllCard'].forEach(function (id) { $(id).hidden = !on; });
  paintTray();
  if (!on) {
    ['tasksNow', 'tasksPlanned', 'tasksAll'].forEach(function (id) { $(id).textContent = ''; });
    if (taskDlg && taskDlg.open) closeTaskDlg();
    return;
  }
  var nodes = currentNodes();
  var today = counterDate(Date.now());

  var now = workingOnLeaves(nodes, named(sessionLog()));
  var nowList = $('tasksNow');
  nowList.textContent = '';
  now.items.forEach(function (it) {
    if (!it.leaf) {
      nowList.appendChild(taskLine(it.name, (it.finished ? 'its task is done' : 'not in your Tasks list') +
                                            (now.running ? '' : ' · paused')));
      return;
    }
    var meta = taskMeta(it.leaf, today, true);
    if (!now.running) meta.text = (meta.text ? meta.text + ' · ' : '') + 'paused';
    var li = document.createElement('li');
    li.className = 'task-row';
    li.appendChild(taskButton(it.leaf, 'tasksNow', meta));
    var done = taskDoneButton(it.leaf.node);
    if (done) li.appendChild(done);
    nowList.appendChild(li);
  });
  nowList.hidden = !now.items.length;
  $('tasksNowEmpty').hidden = now.items.length > 0;

  var planned = plannedLeaves(nodes);
  var plist = $('tasksPlanned');
  plist.textContent = '';
  planned.forEach(function (l) {
    var li = document.createElement('li');
    li.appendChild(taskButton(l, 'tasksPlanned', taskMeta(l, today, true)));
    plist.appendChild(li);
  });
  plist.hidden = !planned.length;
  $('tasksPlannedEmpty').hidden = planned.length > 0;

  // All tasks: the tree, open tasks as buttons, done and gone ones dimmed.
  var doneIds = doneHere();
  var openIds = userMap();
  taskLeaves(nodes).forEach(function (l) { if (leafLive(l, doneIds)) openIds[l.node.id] = l; });
  var all = $('tasksAll');
  all.textContent = '';
  var projects = mirrorTree(nodes);
  projects.forEach(function (p) {
    var li = document.createElement('li');
    var own = p.node ? openIds[p.node.id] : null;
    if (own) {
      li.appendChild(taskButton(own, 'tasksAll', taskMeta(own, today, false)));
      li.appendChild(itemsBlock(own.node.id));
    } else {
      var name = document.createElement('span');
      name.className = 'task-project task-' + p.state;
      name.textContent = p.node ? nodeTitle(p.node) : '(no project)';
      li.appendChild(name);
      var said = p.node ? shutMeta(p.node) : '';
      if (said) {
        var pm = document.createElement('div');
        pm.className = 'plan-meta';
        pm.textContent = said;
        li.appendChild(pm);
      }
      if (p.node && !p.children.length && hasItems(p.node.id)) li.appendChild(itemsBlock(p.node.id));
    }
    if (p.children.length) {
      var sub = document.createElement('ul');
      p.children.forEach(function (c) {
        var leaf = openIds[c.node.id];
        if (leaf) {
          var cli = document.createElement('li');
          cli.appendChild(taskButton(leaf, 'tasksAll', taskMeta(leaf, today, false)));
          cli.appendChild(itemsBlock(leaf.node.id));
          sub.appendChild(cli);
        } else if (doneIds[c.node.id] && !c.node.gone_at) {
          sub.appendChild(doneHereLine(c.node));
        } else {
          // Done, gone, or open under a deleted project: dimmed, not a button.
          var shut = taskLine(nodeTitle(c.node), shutMeta(c.node),
                              'task-' + (c.state === 'open' ? 'gone' : c.state));
          if (hasItems(c.node.id)) shut.appendChild(itemsBlock(c.node.id));
          sub.appendChild(shut);
        }
      });
      li.appendChild(sub);
    }
    all.appendChild(li);
  });
  all.hidden = !projects.length;
  $('tasksAllEmpty').hidden = projects.length > 0;

  if (taskDlg && taskDlg.open) paintTaskDlg();
}

/** A sub-task finished by its own Done: dimmed, with Reopen while the tick in
 *  Google is ProBeing's or not sent yet. One he completed in Google stays his. */
function doneHereLine(node) {
  var li = document.createElement('li');
  li.className = 'task-row';
  var box = document.createElement('div');
  box.className = 'task-row-title';
  var title = document.createElement('div');
  title.className = 'task-done';
  title.textContent = nodeTitle(node);
  box.appendChild(title);
  var meta = document.createElement('div');
  meta.className = 'plan-meta';
  meta.textContent = shutMeta(node) || (node.g_status === 'completed' ? '' : 'Done in ProBeing');
  box.appendChild(meta);
  if (hasItems(node.id)) box.appendChild(itemsBlock(node.id));
  li.appendChild(box);
  if (node.g_status !== 'completed' || shutMeta(node)) {
    var b = itemLink('Reopen', 'Reopen: ' + nodeTitle(node), function () {
      if (b.disabled) return;
      coolDown(b);
      reopenTask(node.id);
    });
    li.appendChild(b);
  }
  return li;
}

/** Under a finished task: "sent to Google" when ProBeing completed it there. */
function shutMeta(node) {
  return typeof sentToGoogle === 'function' && sentToGoogle(node) ? 'Sent to Google ✓' : '';
}

function hasItems(nodeId) {
  return itemsRead && itemsOf(taskTree(), nodeId).length > 0;
}

/** Arriving on the page: draw what is held, then read the plans again. */
function openTasksPage() {
  paintTasksPage();
  if (!tasksConnected()) return;
  readTaskPlans().then(function (ok) { if (ok) paintTasks(); });
  scheduleFiling(0);
  scheduleItems(0);
}

// ------------------------------------------------------------ the task box

function pad2(n) { return String(n).padStart(2, '0'); }

/** The date and time boxes as an instant, on this device's clock. A date with no
 *  time is 23:59 on it, which is always inside that date's counter day, so it is
 *  "today" (and on Home) on exactly that counter day. Null for a date that is not real. */
function expectedFromInputs(dateStr, timeStr) {
  var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!d) return null;
  var t = /^(\d{2}):(\d{2})/.exec(String(timeStr || ''));
  var at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]),
                    t ? Number(t[1]) : 23, t ? Number(t[2]) : 59);
  if (isNaN(at.getTime()) || ymdLocal(at) !== d[1] + '-' + d[2] + '-' + d[3]) return null;
  return at.toISOString();
}

var taskDlgFilled = { at: null, date: '', time: '' };   // what the boxes were last filled with

function fillTaskWhen(id) {
  var plan = planOf(id);
  var t = expectedMs(id);
  var d = isFinite(t) ? new Date(t) : null;
  $('taskDate').value = d ? ymdLocal(d) : '';
  $('taskTime').value = d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '';
  taskDlgFilled = { at: (plan && plan.expected_at) || null, date: $('taskDate').value, time: $('taskTime').value };
}

/** He is in the boxes, or has changed them since they were filled. */
function taskWhenTouched() {
  var a = document.activeElement;
  return a === $('taskDate') || a === $('taskTime') ||
         $('taskDate').value !== taskDlgFilled.date || $('taskTime').value !== taskDlgFilled.time;
}

function openTaskDlg(id, opener, listId) {
  var leaf = openLeafById(id);
  if (!leaf) return;
  taskDlgNode = id;
  taskDlgOpener = { el: opener, list: listId };
  $('taskDlgTitle').textContent = leaf.node.title || '(untitled)';
  $('taskDlgProject').textContent = leaf.up ? 'In ' + (leaf.up.title || '(untitled)')
                                            : 'A task of its own, with no project above it.';
  fillTaskWhen(id);
  $('taskDlgNote').textContent = '';
  $('taskDoneBtn').hidden = leaf.node.kind !== 'subtask';     // never a project (Stage 15)
  paintTaskDlg();
  taskDlg.showModal();
  $('taskStartBtn').focus();                // not the date box: on a phone that opens a picker
}

/** The Planned button's words, and the plan buttons off while a save is out. */
function paintTaskDlg() {
  var plan = planOf(taskDlgNode);
  $('taskPlanBtn').textContent = plan && plan.planned ? 'Remove from Planned' : 'Add to Planned';
  // A finish changed elsewhere (the other device, say) shows, unless he is typing one.
  if (((plan && plan.expected_at) || null) !== taskDlgFilled.at && !taskWhenTouched()) fillTaskWhen(taskDlgNode);
  ['taskPlanBtn', 'taskWhenSave', 'taskWhenClear'].forEach(function (b) { $(b).disabled = taskDlgBusy; });
}

function closeTaskDlg() {
  if (taskDlg.open) taskDlg.close();
  var back = taskDlgOpener;
  var id = taskDlgNode;
  taskDlgOpener = null;
  taskDlgNode = null;
  if (!back) return;
  // A repaint may have replaced the button; the same task in the same list stands in.
  var el = back.el && back.el.isConnected ? back.el : null;
  if (!el && $(back.list)) {
    Array.prototype.some.call($(back.list).querySelectorAll('.task-item'), function (b) {
      if (b.getAttribute('data-node') === id) { el = b; return true; }
      return false;
    });
  }
  if (el) el.focus();
}

/** Upsert this task's plan with `fields`. Only the fields named change, so
 *  setting a finish keeps Planned as the other device left it. */
async function savePlan(id, fields) {
  if (!supabaseReady()) throw new Error('Sign in first.');
  var row = Object.assign({ user_id: sbUser.id, node_id: id,
                            updated_at: new Date().toISOString() }, fields);
  var res = await sb.from('task_plans').upsert(row, { onConflict: 'user_id,node_id' });
  if (res.error) throw errorFrom(res.error);
  taskPlans[id] = Object.assign({}, planOf(id) || { node_id: id, planned: false, expected_at: null }, fields);
  await readTaskPlans();                    // the table wins where it answers
}

/** Run one plan change from the box, and say there how it went. */
function changePlan(fields, said) {
  var id = taskDlgNode;
  if (!id || taskDlgBusy) return;
  var note = $('taskDlgNote');
  taskDlgBusy = true;
  paintTaskDlg();
  note.textContent = 'Saving…';
  savePlan(id, fields).then(function () {
    note.textContent = said;
    if ('expected_at' in fields && taskDlgNode === id) fillTaskWhen(id);   // the boxes now match the table
  }, function (err) {
    note.textContent = '❌ Not saved: ' + ((err && err.message) || 'no answer') + '. Try again.';
  }).then(function () {
    taskDlgBusy = false;
    paintTasks();
    if (taskDlg.open && taskDlgNode === id) paintTaskDlg();
  });
}

$('taskWhenSave').addEventListener('click', function () {
  var iso = expectedFromInputs($('taskDate').value, $('taskTime').value);
  if (!iso) { $('taskDlgNote').textContent = 'Pick a date first.'; return; }
  changePlan({ expected_at: iso }, 'Saved: finish ' + taskWhenLabel(Date.parse(iso)) + '.');
});

/* Asks the table first: the other device may have set a finish this box never saw.
 * If the table cannot be read, the clear is sent anyway. */
$('taskWhenClear').addEventListener('click', function () {
  var id = taskDlgNode;
  if (!id || taskDlgBusy) return;
  $('taskDate').value = '';
  $('taskTime').value = '';
  readTaskPlans().then(function (ok) {
    if (taskDlgNode !== id) return;
    if (!ok || isFinite(expectedMs(id))) changePlan({ expected_at: null }, 'Expected finish cleared.');
    else { $('taskDlgNote').textContent = 'No finish was set.'; fillTaskWhen(id); }
  });
});

$('taskPlanBtn').addEventListener('click', function () {
  var plan = planOf(taskDlgNode);
  var on = !(plan && plan.planned);
  changePlan({ planned: on }, on ? 'Added to Planned.' : 'Removed from Planned.');
});

/** The work row Start writes, named the way a labelled tracker row is: project,
 *  and the sub-task in detail. So no Gemini call is needed. */
function taskEntry(leaf) {
  var title = String(leaf.node.title || '').trim() || '(untitled)';
  if (!leaf.up) return { project: title, detail: '', raw_text: title };
  var project = String(leaf.up.title || '').trim() || '(untitled)';
  return { project: project, detail: title, raw_text: project + TASK_SEP + title };
}

/** The tracker's own steps (close the night first, then one `work` row through
 *  the outbox), with the project already named and node_id set. */
function startTask(id) {
  var leaf = openLeafById(id);
  if (!leaf) return false;
  var e = taskEntry(leaf);
  // Already the running sub-task: nothing to write (feedback 1). Paused, it starts again.
  var day = replayDay(named(sessionLog()));
  if (day.running && day.currentSubtask === id && toggles.work.state === 'working' &&
      toggles.sleep.state !== 'asleep') {
    flash('Already working on ' + (e.detail ? e.project + ': ' + e.detail : e.project), 'ok');
    return true;
  }
  var undo = beginToggleWrite();
  var steps = wakeSteps(true);
  if (toggles.work.state !== 'working') setToggle('work', 'working');
  noteLocalRow('work', e.raw_text, e.project, e.detail, leaf.node.id);
  steps.push({ type: 'work', raw_text: e.raw_text, project: e.project, detail: e.detail,
               node_id: leaf.node.id, rid: newRid() });
  flash('Working on ' + (e.detail ? e.project + ': ' + e.detail : e.project), 'ok');
  runWrites(steps, undo);
  paintTasksPage();
  return true;
}

$('taskStartBtn').addEventListener('click', function () {
  if (!startTask(taskDlgNode)) {
    $('taskDlgNote').textContent = 'This task is no longer open in Google Tasks.';
    return;
  }
  closeTaskDlg();
});

$('taskDoneBtn').addEventListener('click', function () {
  if (!finishTask(taskDlgNode)) {
    $('taskDlgNote').textContent = 'This task is no longer open.';
    return;
  }
  closeTaskDlg();
});

$('taskCloseBtn').addEventListener('click', closeTaskDlg);
// Escape: closed here, so focus goes back to the task whatever the browser does.
taskDlg.addEventListener('cancel', function (e) { e.preventDefault(); closeTaskDlg(); });

/* Its own channel: a task_plans table not made yet must not take the task_nodes
 * feed down with it. The announcement is only a nudge; the plans are read again. */
function plansChanged() {
  clearTimeout(plansTimer);
  plansTimer = setTimeout(function () { readTaskPlans().then(paintTasks); }, 400);
}

function watchPlans() {
  if (!sb || !sbUser || plansChannel) return;
  plansChannel = sb.channel('probeing-plans')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'task_plans' }, plansChanged)
    .subscribe();
}

function stopPlans() {
  clearTimeout(plansTimer);
  taskPlans = userMap();
  if (taskDlg && taskDlg.open) closeTaskDlg();
  if (!plansChannel) return;
  try { sb.removeChannel(plansChannel); } catch (e) { /* already gone */ }
  plansChannel = null;
}

/* Coming back to the app: at most one check (and pull) per two minutes. */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible' || !sbUser) return;
  if (Date.now() - lastTasksCheckAt < TASKS_SYNC_EVERY_MS) return;
  tasksOnOpen();
});

// ------------------------------------------- filing and the tray (14a)

/* With Google connected, the classify function files each typed entry under a
 * task; entry_filing says how far it got. What it cannot place waits in the
 * Unsorted tray on the Tasks page. Filing from the tray is a press, so it goes
 * through api() and the outbox as `file`. Entry text and titles are his (rule 5). */
var SERVER_FILES_KEY = 'probeing.serverfiles';
var filingByRid = userMap();     // entry rid -> its entry_filing row, for today's blank entries
var filingAsked = userMap();     // rids a read has asked about: no row means not being filed
var trayEntries = [];            // [{rid, text, at, reason, items}], Unsorted, newest first
var trayPick = userMap();        // entry rid -> google_id of the project picked, choosing a task
var filingTimer = 0;
var filingChannel = null;

/** The trigger's rule (docs/classify.sql): connected, with a list. */
function googleFiles(sync) {
  return Boolean(sync && sync.connected && sync.list_id && sync.list_title);
}

/** Does the server file typed entries? Connected, AND this device has seen
 *  filing work (filingConfirmed). Before sync_state is read this visit, the
 *  last answer for this account: an offline launch must not start naming
 *  entries the server will name when they land. */
function serverFiles() {
  if (googleSyncRead) return googleFiles(googleSync) && filingConfirmed();
  return filingConfirmed();
}

/** Remembered per account once an entry_filing read has succeeded. Until then
 *  the browser keeps naming entries, so an app pushed before the server side
 *  is deployed does not leave entries unnamed. */
function filingConfirmed() {
  try {
    var who = currentUserId();
    return Boolean(who) && localStorage.getItem(SERVER_FILES_KEY) === who;
  } catch (e) { return false; }
}

function confirmFiling() {
  try { if (sbUser) localStorage.setItem(SERVER_FILES_KEY, sbUser.id); } catch (e) { /* asked again next time */ }
}

/** After sync_state is read: forget it when not connected; when connected and
 *  not yet confirmed, try one entry_filing read. */
async function rememberServerFiles() {
  if (!googleFiles(googleSync)) {
    try { localStorage.removeItem(SERVER_FILES_KEY); } catch (e) { /* the next read decides */ }
    return;
  }
  if (filingConfirmed() || !sb) return;
  try {
    var res = await sb.from('entry_filing').select('entry_rid').limit(1);
    if (!res.error) confirmFiling();
  } catch (e) { /* not confirmed; asked again on the next read */ }
}

/** Typed entries not named yet: the ones the server may still file. */
function blankEntries(rows) {
  return (rows || []).filter(function (r) {
    return (r.type === 'work' || r.type === 'voice') && r.rid && !r.project && !r.node_id;
  });
}

/** A `file` press this device still holds for that entry, or null. */
function queuedFile(rid) {
  return outboxMine().filter(function (it) {
    return it.action === 'file' && (it.payload || {}).entry_rid === rid;
  })[0] || null;
}

/** "NeuraVue › fix login" for a task node, from the mirror; '' when unknown. */
function nodePath(id) {
  var node = taskNodes.filter(function (n) { return n.id === id; })[0];
  if (!node) return '';
  var up = node.kind === 'subtask' ? taskNodes.filter(function (n) {
    return n.google_id === node.parent_google_id && n.list_id === node.list_id;
  })[0] : null;
  return (up ? (up.title || '(untitled)') + ' › ' : '') + (node.title || '(untitled)');
}

/** The quiet line under a typed entry in Today: where it was filed, or how far
 *  filing got. '' for other rows, v1 labels, and anything while not connected. */
function filingNote(entry) {
  if (entry.type !== 'work' && entry.type !== 'voice') return '';
  if (entry.node_id) {
    return nodePath(entry.node_id) ||
           [entry.project, entry.detail].filter(Boolean).join(' › ');
  }
  if (entry.project || !entry.rid || !serverFiles()) return '';
  var held = queuedFile(entry.rid);
  if (held) return (nodePath(held.payload.node_id) || held.payload.project || 'Filed') + ' · sending';
  var st = filingByRid[entry.rid];
  if (st) return st.state === 'pending' ? 'filing…' : st.state === 'unsorted' ? 'Unsorted' : '';
  return filingAsked[entry.rid] ? '' : 'filing…';
}

/** Tile names that are still a sentence only because filing has not landed. */
function filingKeys() {
  var out = userMap();
  blankEntries(sessionLog()).forEach(function (r) {
    if (filingNote(r) === 'filing…') out[String(r.raw_text || '').trim()] = 1;
  });
  return out;
}

/** Read again shortly: today's filing and the tray. One read for a burst. */
function scheduleFiling(ms) {
  clearTimeout(filingTimer);
  filingTimer = setTimeout(refreshFiling, typeof ms === 'number' ? ms : 400);
}

async function refreshFiling() {
  if (!supabaseReady() || !serverFiles()) {
    trayEntries = [];
    paintFiling();
    return;
  }
  await Promise.all([readFiling(), readTray()]);
  paintFiling();
}

/** How far today's blank entries got. A failed read keeps the last. */
async function readFiling() {
  var rids = blankEntries(sessionLog()).map(function (r) { return r.rid; }).slice(0, 200);
  if (!rids.length) return;
  try {
    var res = await sb.from('entry_filing').select('entry_rid,state,reason').in('entry_rid', rids);
    if (res.error) return;
    confirmFiling();
    var map = userMap();
    (res.data || []).forEach(function (r) { map[r.entry_rid] = r; });
    filingByRid = map;
    rids.forEach(function (rid) { filingAsked[rid] = 1; });
  } catch (e) { /* the last read stands */ }
}

/** The Unsorted entries, with Gemini's proposed items. A failed read keeps the last. */
async function readTray() {
  try {
    var f = await sb.from('entry_filing').select('entry_rid,reason,updated_at')
      .eq('state', 'unsorted').order('updated_at', { ascending: false }).limit(50);
    if (f.error) return;
    var rids = (f.data || []).map(function (r) { return r.entry_rid; });
    if (!rids.length) { trayEntries = []; return; }
    var ev = await sb.from('events').select('rid,at,raw_text,project,node_id').in('rid', rids);
    if (ev.error) return;
    var it = await sb.from('items').select('rid,source_rid,title').in('source_rid', rids).limit(500);
    var byRid = userMap();
    (ev.data || []).forEach(function (e) { byRid[e.rid] = e; });
    var items = userMap();
    if (!it.error) {
      (it.data || []).slice().sort(function (a, b) { return a.rid < b.rid ? -1 : 1; }).forEach(function (x) {
        (items[x.source_rid] = items[x.source_rid] || []).push(String(x.title || ''));
      });
    }
    // An entry named meanwhile (by hand on the other device, say) has left the tray.
    trayEntries = (f.data || []).map(function (r) {
      var e = byRid[r.entry_rid];
      if (!e || e.project || e.node_id) return null;
      return { rid: e.rid, text: String(e.raw_text || ''), at: e.at, reason: r.reason || '',
               items: items[e.rid] || [] };
    }).filter(Boolean);
  } catch (e) { /* the last read stands */ }
}

function paintFiling() {
  renderLogList();
  renderDaySummary();
  paintTray();
}

/** Why an entry is Unsorted, keyed by entry_filing.reason. */
var TRAY_REASONS = {
  'no-match': 'No task matched it.',
  'no-sub-task': 'Gemini found the project, not the task.',
  budget: 'Gemini’s calls for today were used up.',
  'too-old': 'It waited too long to be filed.',
  'no-tasks': 'Your Tasks list had nothing open.',
  'no-answer': 'Gemini did not give a usable answer.'
};

function trayChip(text, onTap) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = text;
  b.addEventListener('click', onTap);
  return b;
}

/** The tray: each entry, then its projects; a project with open tasks, then its tasks. */
function paintTray() {
  var card = $('tasksTrayCard');
  var list = $('tasksTray');
  var on = tasksConnected() && serverFiles() && typeof mirrorTree === 'function';
  var shown = on ? trayEntries.filter(function (e) { return !queuedFile(e.rid); }) : [];
  list.textContent = '';
  card.hidden = !shown.length;
  if (!shown.length) return;
  var projects = mirrorTree(currentNodes()).filter(function (p) { return p.node && p.state === 'open'; });
  shown.forEach(function (e) {
    var li = document.createElement('li');
    li.setAttribute('data-rid', e.rid);
    var text = document.createElement('div');
    text.textContent = e.text;
    li.appendChild(text);
    var meta = document.createElement('div');
    meta.className = 'plan-meta';
    var t = instantOf(e.at);
    meta.textContent = [isFinite(t) ? taskWhenLabel(t) : '', TRAY_REASONS[e.reason] || '']
      .filter(Boolean).join(' · ');
    li.appendChild(meta);
    if (e.items.length) {
      var ul = document.createElement('ul');
      ul.className = 'tray-items';
      e.items.forEach(function (title) {
        var item = document.createElement('li');
        item.textContent = title;
        ul.appendChild(item);
      });
      li.appendChild(ul);
    }
    var pick = document.createElement('div');
    pick.className = 'tray-pick';
    var chosen = projects.filter(function (p) { return p.node.google_id === trayPick[e.rid]; })[0];
    if (chosen) {
      pick.appendChild(trayChip('‹ ' + (chosen.node.title || '(untitled)'), function () {
        delete trayPick[e.rid];
        paintTray();
      }));
      chosen.children.filter(function (c) { return c.state === 'open'; }).forEach(function (c) {
        pick.appendChild(trayChip(c.node.title || '(untitled)', function () {
          fileFromTray(e, { node: c.node, up: chosen.node });
        }));
      });
    } else {
      projects.forEach(function (p) {
        var open = p.children.some(function (c) { return c.state === 'open'; });
        pick.appendChild(trayChip(p.node.title || '(untitled)', function () {
          if (!open) { fileFromTray(e, { node: p.node, up: null }); return; }
          trayPick[e.rid] = p.node.google_id;
          paintTray();
        }));
      });
    }
    li.appendChild(pick);
    list.appendChild(li);
  });
}

/** File one Unsorted entry under `leaf` ({node, up}). The titles go on the entry
 *  only when renaming its tile is safe, the server's own rule (day.js). */
function fileFromTray(entry, leaf) {
  var named = taskEntry(leaf);
  var payload = { entry_rid: entry.rid, node_id: leaf.node.id, entry_at: entry.at, raw_text: entry.text };
  if (canRename(sessionLog(), entry.rid, entry.text.trim(), named.project)) {
    payload.project = named.project;
    payload.detail = named.detail;
  }
  delete trayPick[entry.rid];
  api('file', payload).then(function () {
    scheduleFiling();
    scheduleRefresh(400);
  }, function (err) {
    flash(String((err && err.message) || err), 'err');
    scheduleFiling();
  });
  paintFiling();                            // the held press takes it out of the tray now
  flash('Filed under ' + (named.detail ? named.project + ' › ' + named.detail : named.project), 'ok');
}

/* Its own channel, like the others: a missing entry_filing table must not take
 * another feed down. The announcement is only a nudge; the rows are read again. */
function watchFiling() {
  if (!sb || !sbUser || filingChannel) return;
  filingChannel = sb.channel('probeing-filing')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entry_filing' },
        function () { scheduleFiling(); })
    .subscribe();
}

function stopFiling() {
  clearTimeout(filingTimer);
  filingByRid = userMap();
  filingAsked = userMap();
  trayEntries = [];
  trayPick = userMap();
  if (!filingChannel) return;
  try { sb.removeChannel(filingChannel); } catch (e) { /* already gone */ }
  filingChannel = null;
}

// --------------------------------------------- items: Done and Drop (14b)

/* An item's state is its newest mark (day.js itemStates). Each tap is a new
 * item_marks row through the outbox as `mark`; a hand-added item is `item`.
 * A held press shows at once and comes back after every read, as an M does.
 * Titles are Gemini's or his (rule 5). Nothing here is on the M or prayer
 * path (rule 4). */
var ITEM_TITLE_MAX = 200;                 // the check on items.title
var ITEM_VERBS = { done: 'Done', drop: 'Drop', open: 'Undo' };
var HOME_ITEMS_MAX = 5;                   // open items on the Home tile; the rest on Tasks
var itemRows = [];                        // items filed under a task, as last read
var markRows = [];                        // item_marks, as last read
var itemsPressed = [];                    // pressed on this page, not yet seen in a read
var marksPressed = [];
var directRows = [];                      // Done/Reopen pressed on a sub-task itself, as last read
var directPressed = [];                   // ... and pressed on this page, not yet seen in a read
var itemsRead = false;                    // both read this visit; until then only held presses
var itemsTimer = 0;
var itemsChannel = null;
var marksChannel = null;
var showClosed = userMap();               // node id -> 1: its done and dropped items are shown
var itemDlg = $('itemDlg');
var itemDlgNode = null;

/** Whitespace folded, cut to the column's 200 characters. */
function cleanItemTitle(text) {
  return Array.from(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, ITEM_TITLE_MAX).join('');
}

/**
 * The mirror, items and marks, with every press this page has seen merged in
 * by rid. A press is kept here until a read returns it: once the outbox lets go
 * of it, it is nowhere else until then. A refused one is parked, and leaves.
 */
function taskTree() {
  var have = userMap();
  itemRows.concat(markRows, directRows).forEach(function (r) { have[r.rid] = 1; });
  adopt(itemsPressed, queuedItems(have));
  adopt(marksPressed, queuedMarks(have));
  adopt(directPressed, queuedDirect(have));
  parkedAll().forEach(function (r) { if (r && r.rid) have[r.rid] = 1; });
  function unseen(r) { return !have[r.rid]; }
  return { nodes: taskNodes, items: itemRows.concat(itemsPressed.filter(unseen)),
           marks: markRows.concat(marksPressed.filter(unseen)),
           direct: directRows.concat(directPressed.filter(unseen)) };
}

/** Held Done/Reopen presses on a sub-task (`log` rows with a direct rid). */
function queuedDirect(have) {
  return outboxOurs().filter(function (it) {
    var p = it.payload || {};
    return it.action === 'log' && (p.type === 'subdone' || p.type === 'subopen') && p.node_id &&
           /^sd[do]-/.test(it.rid) && !(have && have[it.rid]);
  }).map(queuedRow);
}

/** Add the held rows `list` does not have yet. */
function adopt(list, held) {
  var known = userMap();
  list.forEach(function (r) { known[r.rid] = 1; });
  held.forEach(function (r) { if (!known[r.rid]) list.push(r); });
}

/** Items and marks together, or neither: an item without its marks would show
 *  Done ones as open. A failed read keeps the last. */
async function readItems() {
  if (!supabaseReady()) return false;
  // Presses still on the device when the read set out, and when it did; see below.
  var held = userMap();
  outboxAll().forEach(function (x) { held[x.rid] = 1; });
  var startedAt = Date.now();
  try {
    var it = await readPages(function () {
      return sb.from('items').select('rid,node_id,title,made_by,at,created_at')
        .not('node_id', 'is', null).order('at', { ascending: false }).order('rid');
    });
    if (it.error) return false;
    // The newest mark of each item (item_mark_latest); before that view exists, the newest marks.
    var mk = await readPages(function () {
      return sb.from('item_mark_latest').select('rid,item_rid,mark,at,local_time,created_at')
        .order('at', { ascending: false }).order('rid');
    });
    if (mk.error) {
      mk = await sb.from('item_marks').select('rid,item_rid,mark,at,local_time,created_at')
        .order('at', { ascending: false }).limit(5000);
    }
    if (mk.error) return false;
    // Feedback 1: Done and Reopen on a sub-task itself; tree.js directMarks keeps only those.
    var dr = await readPages(function () {
      return sb.from('events').select('type,rid,node_id,at').in('type', ['subdone', 'subopen'])
        .not('node_id', 'is', null).order('at', { ascending: false }).order('rid');
    });
    if (dr.error) return false;
    itemRows = it.data || [];
    markRows = mk.data || [];
    directRows = (dr.data || []).filter(function (r) { return /^sd[do]-/.test(String(r.rid || '')); });
    itemsRead = true;
    /* A press the read returned is the table's now. One that had already left
     * the device before the read set out, and is not in it, was refused. */
    var seen = userMap();
    itemRows.concat(markRows, directRows).forEach(function (r) { seen[r.rid] = 1; });
    function pending(r) { return !seen[r.rid] && (held[r.rid] === 1 || !(instantOf(r.at) < startedAt)); }
    itemsPressed = itemsPressed.filter(pending);
    marksPressed = marksPressed.filter(pending);
    directPressed = directPressed.filter(pending);
    return true;
  } catch (e) { return false; }
}

/* PostgREST hands back at most 1000 rows a request (Supabase's default), so a
 * read of every row goes in pages. A page that repeats the last one ends it. */
var ITEMS_PAGE = 1000;
var ITEMS_PAGES_MAX = 50;

async function readPages(query) {
  var rows = [];
  var seen = userMap();
  for (var page = 0; page < ITEMS_PAGES_MAX; page++) {
    var res = await query().range(page * ITEMS_PAGE, page * ITEMS_PAGE + ITEMS_PAGE - 1);
    if (res.error) return { error: res.error };
    var got = (res.data || []).filter(function (r) { return !seen[r.rid]; });
    got.forEach(function (r) { seen[r.rid] = 1; rows.push(r); });
    if ((res.data || []).length < ITEMS_PAGE || !got.length) break;
  }
  return { data: rows };
}

function scheduleItems(ms) {
  clearTimeout(itemsTimer);
  itemsTimer = setTimeout(function () {
    if (!tasksConnected()) return;
    readItems().then(function (ok) { if (ok) paintItems(); });
  }, typeof ms === 'number' ? ms : 400);
}

function paintItems() {
  renderProject();
  paintTasksPage();
  closeFinishedTasks();
  if (typeof doneDlg !== 'undefined' && doneDlg && doneDlg.open) renderDone();   // Stage 16
}

/**
 * Write `subdone` for every task whose items are all closed, one at least Done,
 * with no subdone at or after its newest closing mark. From the merged state, so
 * two devices each closing one of the last two items still end the task: both
 * write the same row (its rid comes from that mark), and the second is a 23505.
 * Only marks in the table or held here count; a parked one is not in taskTree.
 */
var subdoneTried = userMap();            // rids written or tried on this page

function closeFinishedTasks() {
  if (!itemsRead) return;
  var tree = taskTree();
  var newest = itemNewest(tree.marks);
  var since = counterDayStart(Date.now()) - LEAD_MAX_MS;   // older closes are not replayed
  var byNode = userMap();
  tree.items.forEach(function (it) {
    if (it && it.node_id) (byNode[it.node_id] = byNode[it.node_id] || []).push(it);
  });
  var held = userMap();
  outboxMine().forEach(function (x) { held[x.rid] = 1; });
  Object.keys(byNode).forEach(function (nodeId) {
    var marks = byNode[nodeId].map(function (it) { return newest[it.rid] || null; });
    if (marks.some(function (m) { return !m || m.mark === 'open'; })) return;
    if (!marks.some(function (m) { return m.mark === 'done'; })) return;
    var closing = marks.reduce(function (a, m) { return markNewer(m, a) ? m : a; });
    var rid = 'sd-' + closing.rid;
    if (subdoneTried[rid] || held[rid] || !(instantOf(closing.at) >= since)) return;
    var t = instantOf(closing.at);
    var written = sessionLog().some(function (r) {
      return r.type === 'subdone' && (r.rid === rid || (r.node_id === nodeId && instantOf(r.at) >= t));
    });
    subdoneTried[rid] = 1;
    if (!written) subtaskDone(nodeId, closing);
  });
}

/** The items under one task, open ones first; done and dropped ones behind a
 *  toggle. `max` caps the open ones shown (Home). Before a read only presses
 *  held here are known, so nothing is drawn. */
function itemsBlock(nodeId, max) {
  var box = document.createElement('div');
  box.className = 'items';
  if (!itemsRead) return box;
  // Completed (by him or Google) or deleted in Google: Google wins, and its open
  // items close with it. One ProBeing ticked stays live: an Undo unticks it there.
  var node = nodeIndex(taskNodes).byId[nodeId];
  var finished = Boolean(node && (node.gone_at || node.g_status === 'completed'));
  var shut = node && node.gone_at ? 'gone'
           : finished && !(typeof sentToGoogle === 'function' && sentToGoogle(node)) ? 'done' : '';
  var all = itemsOf(taskTree(), nodeId).map(function (it) {
    return shut && it.state === 'open' ? Object.assign({}, it, { state: 'shut', shutBy: shut }) : it;
  });
  var open = all.filter(function (it) { return it.state === 'open'; });
  var closed = all.filter(function (it) { return it.state !== 'open'; });
  var ul = document.createElement('ul');
  ul.className = 'item-list';
  (max ? open.slice(0, max) : open).forEach(function (it) { ul.appendChild(itemLine(it)); });
  if (showClosed[nodeId]) closed.forEach(function (it) { ul.appendChild(itemLine(it)); });
  if (ul.childNodes.length) box.appendChild(ul);

  var foot = document.createElement('div');
  foot.className = 'item-foot';
  if (max && open.length > max) {
    var more = document.createElement('span');
    more.className = 'plan-meta';
    more.textContent = '+' + (open.length - max) + ' more on Tasks';
    foot.appendChild(more);
  }
  if (!finished) foot.appendChild(itemLink('+ item', 'Add an item', function () { openItemDlg(nodeId); }));
  if (closed.length) {
    foot.appendChild(itemLink(showClosed[nodeId] ? 'Hide closed' : closed.length + ' closed',
                              showClosed[nodeId] ? 'Hide done and dropped items' : 'Show done and dropped items',
                              function () {
                                if (showClosed[nodeId]) delete showClosed[nodeId]; else showClosed[nodeId] = 1;
                                paintItems();
                              }));
  }
  box.appendChild(foot);
  return box;
}

function itemLink(text, label, onTap) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'link-btn item-link';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onTap);
  return b;
}

/** One item: its title, then Done and Drop; a closed one dimmed, with Undo. */
function itemLine(it) {
  var li = document.createElement('li');
  li.className = 'item item-' + it.state;
  li.setAttribute('data-item', it.rid);
  var title = document.createElement('span');
  title.className = 'item-title';
  title.textContent = it.title;
  li.appendChild(title);
  if (it.state === 'shut') {
    var why = document.createElement('span');
    why.className = 'plan-meta';
    why.textContent = it.shutBy === 'gone' ? 'dropped: deleted in Google' : 'closed with sub-task';
    li.appendChild(why);
    return li;
  }
  var acts = it.state === 'open' ? ['done', 'drop'] : ['open'];
  acts.forEach(function (mark) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'item-btn item-' + mark + '-btn';
    b.textContent = ITEM_VERBS[mark];
    b.setAttribute('aria-label', ITEM_VERBS[mark] + ': ' + it.title);
    b.addEventListener('click', function () { markItem(it, mark, b); });
    li.appendChild(b);
  });
  return li;
}

/** The sub-task being worked on, under its project on the Home tile. */
function currentSubtaskBlock(node, title) {
  var box = document.createElement('div');
  box.className = 'proj-sub';
  if (node.kind === 'subtask') {               // a project's own items need no second heading
    var row = document.createElement('div');
    row.className = 'proj-sub-head';
    var head = document.createElement('div');
    head.className = 'proj-sub-title';
    head.textContent = '▸ ' + (node.gone_at ? title + ' (deleted in Google)' : title);
    var finish = shownFinishMs(node);
    if (isFinite(finish)) head.appendChild(deadlineChip(finish, ' · '));
    row.appendChild(head);
    // Feedback 1: finish a small task (no items) right here.
    var live = !node.gone_at && node.g_status !== 'completed';
    var done = live ? taskDoneButton(node) : null;
    if (done) row.appendChild(done);
    box.appendChild(row);
  }
  box.appendChild(itemsBlock(node.id, HOME_ITEMS_MAX));
  return box;
}

/** Done, Drop or Undo ('open') on one item, through the outbox. Closing the
 *  last open one may end the task: closeFinishedTasks. */
function markItem(it, mark, btn) {
  if (btn) {
    if (btn.disabled) return;
    coolDown(btn);
  }
  var was = itemsOf(taskTree(), it.node_id).filter(function (x) { return x.rid === it.rid; })[0];
  if (!was || was.state === mark) return;   // a second tap, or the other device got there first
  // A device clock running slow must not make this press older than the last.
  var seenMark = itemNewest(taskTree().marks)[it.rid];
  var at = Math.max(Date.now(), seenMark ? instantOf(seenMark.at) + 1 : 0);
  var payload = { rid: newRid(), at: new Date(at).toISOString(), local_time: humanLocal(),
                  item_rid: it.rid, mark: mark, title: it.title, node_id: it.node_id };
  api('mark', payload).then(function (res) {
    if (res && !res.queued) scheduleItems();
  }, function (err) {
    flash(String((err && err.message) || err), 'err');
    paintItems();                           // a refused press is parked, and the item shows as it was
  });
  paintItems();                             // held on the device already, so it shows now (and may end the task)
  flash(ITEM_VERBS[mark] + ': ' + it.title, 'ok');
}

/** The `subdone` row for task `nodeId`, stamped with its closing mark. */
function subtaskDone(nodeId, mark) {
  var names = nodeNames(nodeIndex(taskNodes), nodeId);
  var project = names ? names.project : '';
  var detail = names ? names.detail : '';
  var text = detail || project || 'Task done';
  noteLocalRow('subdone', text, project, detail, nodeId);
  runWrites([{ type: 'subdone', raw_text: text, project: project, detail: detail, node_id: nodeId,
               rid: 'sd-' + mark.rid, at: mark.at, local_time: mark.local_time || '',
               closing_rid: mark.rid }]);
}

/* ── Done on a sub-task itself (feedback 1) ─────────────────────────────
 * A small task has no items, so it can be finished directly: a `subdone` row
 * through the outbox, its rid from tree.js directRid, so a second tap or the
 * other device writes the same rid and the table keeps one. tasks-sync then
 * ticks it in Google. Reopen writes `subopen`, which unticks only ProBeing's tick. */

/** Every direct Done/Reopen known here: the items read's, presses held or made
 *  on this page, and today's rows (so the other device's press shows on its read). */
function directAll() {
  var rows = taskTree().direct.slice();
  var have = userMap();
  rows.forEach(function (r) { have[r.rid] = 1; });
  parkedAll().forEach(function (x) { if (x && x.rid) have[x.rid] = 1; });   // refused: not a press
  sessionLog().forEach(function (r) {
    if ((r.type !== 'subdone' && r.type !== 'subopen') || !r.node_id || !/^sd[do]-/.test(String(r.rid || ''))) return;
    if (have[r.rid]) return;
    have[r.rid] = 1;
    rows.push(r);
  });
  return rows;
}

/** node id -> true: finished by its own Done (tree.js directDone). */
function doneHere() {
  // Before tree.js, or before this part of the file has run (an early paint): none.
  if (typeof directDone !== 'function' || !Array.isArray(directRows)) return userMap();
  var tree = taskTree();
  return directDone(taskNodes, tree.items, itemNewest(tree.marks), directMarks(directAll()));
}

/** Done on sub-task `id`. False when it is not an open sub-task, or is done already. */
function finishTask(id) {
  if (typeof directRid !== 'function') return false;
  var leaf = openLeafById(id);
  if (!leaf || leaf.node.kind !== 'subtask') return false;
  var d = directMarks(directAll())[id];
  var rid = directRid(DIRECT_DONE, id, d ? d.gen + 1 : 0);
  // Never older than the Reopen it follows, whatever this device's clock says.
  var at = new Date(Math.max(Date.now(), d ? instantOf(d.at) + 1 : 0)).toISOString();
  var e = taskEntry(leaf);
  var text = e.detail || e.project;
  unpark(rid);                        // pressed again after a refusal: this press is the live one
  noteLocalRow('subdone', text, e.project, e.detail, id).rid = rid;
  directPressed.push({ type: 'subdone', rid: rid, node_id: id, at: at });
  runWrites([{ type: 'subdone', raw_text: text, project: e.project, detail: e.detail, node_id: id,
               rid: rid, at: at, local_time: humanLocal() }]);
  paintTasks();
  flash('Done: ' + text + '. Reopen it under All tasks on Tasks.', 'ok');
  return true;
}

/** Reopen a sub-task finished by its own Done. Only one ProBeing finished. */
function reopenTask(id) {
  if (typeof directRid !== 'function' || !doneHere()[id]) return false;
  var d = directMarks(directAll())[id];
  var names = nodeNames(nodeIndex(taskNodes), id);
  if (!d || !names) return false;
  var rid = directRid(DIRECT_OPEN, id, d.gen);
  var at = new Date(Math.max(Date.now(), instantOf(d.at) + 1)).toISOString();
  var title = names.detail || names.project;
  unpark(rid);
  noteLocalRow('subopen', 'Reopened: ' + title, names.project, names.detail, id).rid = rid;
  directPressed.push({ type: 'subopen', rid: rid, node_id: id, at: at });
  runWrites([{ type: 'subopen', raw_text: 'Reopened: ' + title, project: names.project, detail: names.detail,
               node_id: id, rid: rid, at: at, local_time: humanLocal() }]);
  paintTasks();
  flash('Reopened: ' + title, 'ok');
  return true;
}

/** A small Done button for sub-task `id`; nothing for a project. */
function taskDoneButton(node) {
  if (!node || node.kind !== 'subtask') return null;
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'item-btn item-done-btn';
  b.textContent = 'Done';
  b.setAttribute('aria-label', 'Done: ' + (node.title || '(untitled)'));
  b.addEventListener('click', function () {
    if (b.disabled) return;
    coolDown(b);
    finishTask(node.id);
  });
  return b;
}

function openItemDlg(nodeId) {
  var names = nodeNames(nodeIndex(taskNodes), nodeId);
  if (!names) return;
  itemDlgNode = nodeId;
  $('itemDlgTask').textContent = names.detail ? names.project + ' › ' + names.detail : names.project;
  $('itemName').value = '';
  itemDlg.showModal();
  $('itemName').focus();
}

/** Add an item by hand under task `nodeId`, through the outbox. */
function addItem(nodeId, text) {
  var title = cleanItemTitle(text);
  if (!nodeId || !title) return false;
  var payload = { rid: newRid(), at: new Date().toISOString(), local_time: humanLocal(),
                  node_id: nodeId, title: title };
  api('item', payload).then(function (res) {
    if (res && !res.queued) scheduleItems();
  }, function (err) {
    flash(String((err && err.message) || err), 'err');
    paintItems();
  });
  paintItems();
  flash('Added: ' + title, 'ok');
  return true;
}

$('itemForm').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!addItem(itemDlgNode, $('itemName').value)) {
    flash('Type the item first.', 'err');
    return;
  }
  itemDlg.close();
});

$('itemCancelBtn').addEventListener('click', function () { itemDlg.close(); });

/* Their own channels, like the others: a missing item_marks table must not take
 * the items feed down. The announcement is only a nudge; both are read again. */
function watchItems() {
  if (!sb || !sbUser) return;
  if (!itemsChannel) {
    itemsChannel = sb.channel('probeing-items')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' },
          function () { scheduleItems(); })
      .subscribe();
  }
  if (!marksChannel) {
    marksChannel = sb.channel('probeing-marks')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'item_marks' },
          function () { scheduleItems(); })
      .subscribe();
  }
}

function stopItems() {
  clearTimeout(itemsTimer);
  itemRows = [];
  markRows = [];
  itemsPressed = [];
  marksPressed = [];
  directRows = [];
  directPressed = [];
  subdoneTried = userMap();
  itemsRead = false;
  showClosed = userMap();
  if (itemDlg.open) itemDlg.close();
  [itemsChannel, marksChannel].forEach(function (ch) {
    if (!ch) return;
    try { sb.removeChannel(ch); } catch (e) { /* already gone */ }
  });
  itemsChannel = null;
  marksChannel = null;
  stopDone();
}

// ------------------------------------------------- What's done (Stage 16)

/* Finished sub-tasks and items, per project, by counter day. Titles only, from
 * the mirror and the items table (rule 5): never a description or raw_text.
 * Read-only, so nothing here is on the M or prayer path (rule 4). */

/** When sub-task `n` finished, or null: in ProBeing (tree.js finishedAt), else
 *  completed in Google by him. One ProBeing ticked counts only while its own
 *  finish stands, so an Undo takes it off at once. */
function subtaskDoneMs(n, rids, newest, d) {
  var at = finishedAt(n, rids, newest, d);
  if (at !== null) return at;
  if (n.g_status !== 'completed' || oursInGoogle(n)) return null;
  var t = msOf(n.g_completed_at);
  if (!isFinite(t)) t = msOf(n.g_updated);
  return isFinite(t) ? t : null;
}

/**
 * Everything finished, any day: [{project, kind, id, title, under, ms}].
 * `project` is the project's node id; `under` is an item's sub-task title ('' for
 * an item filed on the project itself). An item counts on its newest mark, only
 * when that is Done. A finish counts only if it came before its task or project
 * was deleted in Google. `tree` is {nodes, items, marks, direct}; `direct` are
 * subdone/subopen rows.
 */
function doneEntries(tree) {
  tree = tree || {};
  var nodes = tree.nodes || [];
  var index = nodeIndex(nodes);
  var newest = itemNewest(tree.marks);
  var direct = directMarks(tree.direct);
  var rids = itemsByNode(tree.items);
  function up(n) {
    return n.kind === 'subtask' ? index.byGoogle[(n.list_id || '') + '|' + n.parent_google_id] || null : n;
  }
  function title(n) { return String(n.title || '').trim() || '(untitled)'; }
  /** Finished before the node and its project were deleted (always, when neither was). */
  function beforeGone(n, p, ms) {
    var a = n.gone_at ? instantOf(n.gone_at) : Infinity;
    var b = p.gone_at ? instantOf(p.gone_at) : Infinity;
    return ms < Math.min(isNaN(a) ? Infinity : a, isNaN(b) ? Infinity : b);
  }
  var out = [];
  nodes.forEach(function (n) {
    if (!n || !n.id || n.kind !== 'subtask') return;
    var p = up(n);
    if (!p) return;
    var ms = subtaskDoneMs(n, rids[n.id], newest, direct[n.id]);
    if (ms !== null && beforeGone(n, p, ms)) {
      out.push({ project: p.id, kind: 'subtask', id: n.id, title: title(n), under: '', ms: ms });
    }
  });
  (tree.items || []).forEach(function (it) {
    var m = it && it.rid ? newest[it.rid] : null;
    var n = m && m.mark === 'done' ? index.byId[it.node_id] : null;
    var p = n ? up(n) : null;
    if (!p || !beforeGone(n, p, instantOf(m.at))) return;
    out.push({ project: p.id, kind: 'item', id: it.rid, title: String(it.title || '').trim() || '(untitled)',
               under: n.kind === 'subtask' ? title(n) : '', ms: instantOf(m.at) });
  });
  return out.filter(function (e) { return isFinite(e.ms); });
}

/**
 * The page: one entry per project, in Google's order, each with the counter days
 * it finished something on, newest first: [{id, title, count, days: [{ymd, lines}]}].
 * `windows` bounds the days (their first and last ymd); null is All, with no bound,
 * so nothing is listed day by day. A deleted project is listed only when it has
 * something to show. A line is a doneEntries() entry; a sub-task's also carries
 * `time`, its bySubtask figure over the period.
 */
function whatsDone(tree, windows, bySubtask) {
  if (windows && !windows.length) return [];
  var first = windows ? windows[0].ymd : '';
  var last = windows ? windows[windows.length - 1].ymd : '';
  var times = bySubtask || {};
  var byProject = userMap();
  doneEntries(tree).forEach(function (e) {
    var ymd = counterDate(e.ms);
    if (windows && (ymd < first || ymd > last)) return;
    var line = Object.assign({ ymd: ymd }, e);
    if (e.kind === 'subtask') line.time = times[e.id] || 0;
    (byProject[e.project] = byProject[e.project] || []).push(line);
  });
  return mirrorTree((tree || {}).nodes || []).filter(function (p) {
    return p.node && (!p.node.gone_at || byProject[p.node.id]);
  }).map(function (p) {
    var lines = (byProject[p.node.id] || []).sort(function (a, b) {
      return (b.ms - a.ms) || (a.kind === b.kind ? 0 : a.kind === 'subtask' ? -1 : 1);
    });
    var days = [];
    lines.forEach(function (l) {
      if (!days.length || days[days.length - 1].ymd !== l.ymd) days.push({ ymd: l.ymd, lines: [] });
      days[days.length - 1].lines.push(l);
    });
    var name = String(p.node.title || '').trim() || '(untitled)';
    return { id: p.node.id, title: p.node.gone_at ? name + ' (deleted in Google)' : name,
             count: lines.length, days: days };
  });
}

/** The counter days a filter's TIME covers, as {start, end} local dates: this
 *  week from Monday, this month from the 1st, or All from `firstMs`'s day (the
 *  first row read), at most 400 days back (dayWindows' own stop). */
function doneRangeOf(range, now, firstMs) {
  var today = counterToday(now);
  if (range === 'month') return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: today };
  if (range === 'all') {
    var floor = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 399);
    var from = isFinite(firstMs) ? counterToday(new Date(firstMs)) : today;
    if (from < floor) from = floor;
    return { start: from < today ? from : today, end: today };
  }
  var wk = reviewRangeOf('wk', now);
  return { start: wk.start, end: wk.end };
}

/** A day heading: Today, Yesterday, "Sat 26 Sep", with the year when it is not this one. */
function doneDayName(ymd, todayYmd) {
  if (String(ymd).slice(0, 4) === String(todayYmd).slice(0, 4)) return moneyDayName(ymd, ymdBack(ymd, todayYmd));
  var p = String(ymd).split('-');
  try {
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
      .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) {
    return String(ymd);
  }
}

/* The time read goes newest first, so a hit cap drops the OLDEST rows. 1000 a
 * page (PostgREST's cap); a lower server cap only means more pages, since only
 * an empty page ends the read. Only rows that move the work clock (LEAD_TYPES):
 * replayDay ignores the rest, so bySubtask is unchanged. */
var DONE_PAGE = 1000;
var DONE_PAGES_MAX = 50;
var DONE_COLS = 'id,at,type,raw_text,project,detail,node_id,rid,created_at';
var DONE_RANGES = [['week', 'Week'], ['month', 'Month'], ['all', 'All']];
var DONE_EMPTY = { week: 'this week', month: 'this month', all: 'yet' };
var doneDlg = $('doneDlg');
var doneView = { range: 'week', project: '', sum: null, firstMs: NaN, read: 0, note: '' };

/** Work-clock rows from `startIso` (null: from the first) to before `endIso`,
 *  oldest first. {rows, partial}: partial when the page cap stopped it. */
async function doneRows(startIso, endIso) {
  var rows = [];
  var seen = userMap();
  var from = 0;                          // rows handed back so far: a server cap below 1000 skips none
  for (var page = 0; page < DONE_PAGES_MAX; page++) {
    var q = sb.from('events').select(DONE_COLS).in('type', LEAD_TYPES).lt('at', endIso);
    if (startIso) q = q.gte('at', startIso);
    var res = await q.order('at', { ascending: false }).order('created_at', { ascending: false })
      .order('id', { ascending: false }).range(from, from + DONE_PAGE - 1);
    if (res.error) throw errorFrom(res.error);
    var got = res.data || [];
    if (!got.length) return { rows: rows.reverse(), partial: false };
    from += got.length;
    // A row landing mid-read shifts the pages by one: seen twice, kept once.
    got.forEach(function (r) { if (!seen[r.id]) { seen[r.id] = 1; rows.push(sbRow(r)); } });
  }
  return { rows: rows.reverse(), partial: true };
}

/** The current list's mirror, items and marks with held presses, and every direct Done/Reopen. */
function doneTree() {
  var tree = taskTree();
  return { nodes: currentNodes(), items: tree.items, marks: tree.marks, direct: directAll() };
}

/** The span the filter's time is counted over. */
function doneSpan() {
  return doneRangeOf(doneView.range, new Date(), doneView.firstMs);
}

function renderDone() {
  var span = doneSpan();
  // All groups every finish by its day; Week and Month bound them by their windows.
  var bounds = doneView.range === 'all' ? null : dayWindows(span.start, span.end);
  var projects = whatsDone(doneTree(), bounds, doneView.sum ? doneView.sum.bySubtask : null);
  Array.prototype.forEach.call($('doneRanges').querySelectorAll('button'), function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.range === doneView.range));
  });
  if (!projects.some(function (p) { return p.id === doneView.project; })) {
    var busy = projects.filter(function (p) { return p.count; })[0] || projects[0];
    doneView.project = busy ? busy.id : '';
  }
  var grid = $('doneProjects');
  grid.textContent = '';
  projects.forEach(function (p) {
    grid.appendChild(pickButton(p.title + ' (' + p.count + ')', p.id === doneView.project, false, function () {
      doneView.project = p.id;
      renderDone();
    }));
  });
  grid.hidden = !projects.length;

  var list = $('doneList');
  list.textContent = '';
  var shown = projects.filter(function (p) { return p.id === doneView.project; })[0];
  var todayYmd = counterDate(Date.now());
  (shown ? shown.days : []).forEach(function (d) {
    var head = document.createElement('li');
    head.className = 'day-head';
    head.textContent = doneDayName(d.ymd, todayYmd);
    list.appendChild(head);
    d.lines.forEach(function (l) { list.appendChild(doneLine(l)); });
  });
  if (!shown || !shown.count) {
    var empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = projects.length ? 'Nothing finished ' + DONE_EMPTY[doneView.range] + '.'
                                        : 'No projects in your Tasks list.';
    list.appendChild(empty);
  }
  $('doneNote').textContent = doneView.note;
  $('doneNote').hidden = !doneView.note;
}

/** A sub-task with its time in the range, or an item with the sub-task it was under. */
function doneLine(l) {
  var li = document.createElement('li');
  li.className = 'done-' + l.kind;
  var what = document.createElement('span');
  what.className = 'what';
  what.textContent = (l.kind === 'subtask' ? '✓ ' : '• ') + l.title;
  li.appendChild(what);
  var meta = l.kind === 'subtask' ? (l.time > 0 ? humanDuration(l.time) : '') : l.under;
  if (meta) {
    var m = document.createElement('span');
    m.className = 'when';
    m.textContent = meta;
    li.appendChild(m);
  }
  return li;
}

/** Read the span's work rows for the sub-task times, then draw. The newest read wins. */
async function readDone() {
  var ticket = ++doneView.read;
  doneView.note = 'Reading time…';
  renderDone();
  try {
    if (!supabaseReady()) throw new Error('Sign in to read your time.');
    if (!itemsRead) await readItems();
    var all = doneView.range === 'all';
    var span = doneSpan();
    var bounds = rangeReadBounds(span.start, span.end);
    var got = await doneRows(all ? null : bounds.startIso, bounds.endIso);
    if (ticket !== doneView.read) return;
    if (all && got.rows.length) {
      doneView.firstMs = instantOf(got.rows[0].at);
      span = doneSpan();
    }
    doneView.sum = summariseRange(got.rows, dayWindows(span.start, span.end));
    doneView.note = got.partial ? 'Too many rows to read at once, so times may be short.' : '';
  } catch (e) {
    if (ticket !== doneView.read) return;
    doneView.sum = null;
    doneView.note = 'Time could not be read: ' + ((e && e.message) || e);
  }
  renderDone();
}

function openDone() {
  doneView.sum = null;
  doneView.firstMs = NaN;
  if (!doneDlg.open) doneDlg.showModal();
  readDone();
  $('doneCloseBtn').focus();
}

function stopDone() {
  if (!doneDlg) return;                  // signed out before this block ran
  doneView = { range: 'week', project: '', sum: null, firstMs: NaN, read: doneView.read + 1, note: '' };
  if (doneDlg.open) doneDlg.close();
}

DONE_RANGES.forEach(function (r) {
  var b = pickButton(r[1], r[0] === doneView.range, false, function () {
    if (doneView.range === r[0]) return;
    doneView.range = r[0];
    doneView.sum = null;
    readDone();
  });
  b.dataset.range = r[0];
  $('doneRanges').appendChild(b);
});
$('doneOpenBtn').addEventListener('click', openDone);
$('doneCloseBtn').addEventListener('click', function () {
  doneDlg.close();
  $('doneOpenBtn').focus();
});

// ------------------------------------------------- prayer reminders (29 Sep)
/* The prayer-remind function's on/off, in user_settings so the server reads it.
 * Written directly, like pushPlace: a setting, not a press. */
async function loadPrayerRemind() {
  var box = $('prayerRemindOn');
  var out = $('prayerRemindResult');
  box.disabled = true;
  out.textContent = '';
  try {
    if (!supabaseReady()) { out.textContent = 'Sign in to change this.'; return; }
    var got = await sb.from('user_settings').select('prayer_reminders')
      .eq('user_id', sbUser.id).limit(1);
    if (got.error) throw errorFrom(got.error);
    var row = (got.data || [])[0];
    box.checked = !(row && row.prayer_reminders === false);     // no row: on, the default
    box.disabled = false;
  } catch (e) {
    out.textContent = 'Could not read this setting: ' + ((e && e.message) || e);
  }
}

$('prayerRemindOn').addEventListener('change', async function () {
  var box = this;
  var out = $('prayerRemindResult');
  var want = box.checked;
  box.disabled = true;
  out.textContent = 'Saving…';
  try {
    if (!supabaseReady()) throw new Error('Sign in first.');
    // Only this column, so updated_at (whose prayer place wins) does not move.
    var res = await sb.from('user_settings').upsert({ user_id: sbUser.id, prayer_reminders: want },
                                                     { onConflict: 'user_id' });
    if (res.error) throw errorFrom(res.error);
    out.textContent = want ? 'On, for every device.' : 'Off, for every device.';
  } catch (e) {
    box.checked = !want;
    out.textContent = 'Not saved: ' + ((e && e.message) || e);
  }
  box.disabled = false;
});

/* Feedback 1: the deadline push's own on/off, user_settings.task_reminders.
 * Its own read, so a database without the column leaves the prayer toggle working. */
async function loadTaskRemind() {
  var box = $('taskRemindOn');
  var out = $('taskRemindResult');
  box.disabled = true;
  out.textContent = '';
  try {
    if (!supabaseReady()) { out.textContent = 'Sign in to change this.'; return; }
    var got = await sb.from('user_settings').select('task_reminders').eq('user_id', sbUser.id).limit(1);
    if (got.error) throw errorFrom(got.error);
    var row = (got.data || [])[0];
    box.checked = !(row && row.task_reminders === false);       // no row: on, the default
    box.disabled = false;
  } catch (e) {
    out.textContent = 'Could not read this setting: ' + ((e && e.message) || e);
  }
}

$('taskRemindOn').addEventListener('change', async function () {
  var box = this;
  var out = $('taskRemindResult');
  var want = box.checked;
  box.disabled = true;
  out.textContent = 'Saving…';
  try {
    if (!supabaseReady()) throw new Error('Sign in first.');
    var res = await sb.from('user_settings').upsert({ user_id: sbUser.id, task_reminders: want },
                                                     { onConflict: 'user_id' });
    if (res.error) throw errorFrom(res.error);
    out.textContent = want ? 'On, for every device.' : 'Off, for every device.';
  } catch (e) {
    box.checked = !want;
    out.textContent = 'Not saved: ' + ((e && e.message) || e);
  }
  box.disabled = false;
});

// -------------------------------------------------------------------- boot

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is optional */ });
  });
  // A tapped prayer reminder (sw.js) brings the app forward on Home; a deadline one on Tasks.
  navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && (e.data.goto === 'home' || e.data.goto === 'tasks')) showScreen(e.data.goto);
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

  /* The backstop trigger for the outbox. `online` fires when the radio comes
   * back, but not when a flaky connection starts working again, and not at all
   * on some desktop setups — so anything waiting is retried on a slow timer as
   * well. retrySession() first, because a launch with no signal has no session
   * and nothing can be sent without one. */
  if (outboxCount() && monoNow() - lastDrainAt > DRAIN_RETRY_MS) {
    retrySession();
    drainOutbox('poll');
  }

  if (inFlight > 0 || !isConfigured()) return;
  // A live subscription makes polling redundant; keep a slow heartbeat only, in
  // case the socket has quietly died.
  var every = liveChannel ? LIVE_HEARTBEAT_MS : pollInterval();
  if (Date.now() - lastReconcileAt < every) return;
  // One attempt only; the next tick is the retry.
  refresh({ tries: 1 });
}, 5000);

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  // Coming back to the app is the commonest moment for the network to be back.
  retrySession();
  drainOutbox('visible');
  var now = Date.now();
  if (now - lastVisibleRefresh < VISIBILITY_THROTTLE_MS) return;
  lastVisibleRefresh = now;
  refresh();
});

/* The browser saying the radio is back. It is the fastest trigger there is, and
 * the only one that is allowed to try while navigator.onLine was false a moment
 * ago. A session that expired while offline is recovered first. */
window.addEventListener('online', function () {
  retrySession();
  drainOutbox('online');
  refresh();
});

window.addEventListener('offline', function () {
  paintConn();
});

clearStaleSending();                 // a write the last page was mid-way through
initSupabase();
paintConn();                         // anything left over from the last visit
renderPrayerTicks();
renderProject();
renderDaySummary();
lastVisibleRefresh = Date.now();     // the boot reconcile counts as the first one
refresh();
if (!cfg.supaUrl || !cfg.supaKey) dlg.showModal();
// google-callback.html links back to ./#google: open Settings there.
if (location.hash === '#google') {
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* stays */ }
  $('settingsBtn').click();
}
// A deadline reminder that had to open a fresh window (sw.js) asks for Tasks.
if (location.hash === '#tasks') {
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* stays */ }
  showScreen('tasks');
}
