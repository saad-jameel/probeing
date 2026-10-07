/* ProBeing — the day's counting, shared by the browser and the server.
 *
 * One file, run in two places, so the widget's two lines and the app's own
 * figures cannot count differently. The browser loads it as a classic
 * <script> before app.js, so every declaration below is a global there. The
 * glance-refresh Edge Function imports it as a module and reads the functions
 * off globalThis.ProBeingDay at the bottom.
 *
 * Hence the two constraints: no import/export (a syntax error in a classic
 * script), and valid in strict mode (every module is). Nothing here may touch
 * the page, the network or localStorage.
 */

'use strict';

// Prayer rows name one of these; a prayer logged twice is still one of five.
var PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

/** What the plain Break button writes. Never counted as a chip. */
var PLAIN_BREAK = 'Break';

/* Several reasons can apply at once — dinner AND tea — so a break row carries
 * the whole current set, joined. Reason names have the separator stripped when
 * they are added, so this can never be ambiguous. */
var REASON_SEP = ' + ';

/* Joins a row's sub-tasks in its `detail` column. Not a comma: commas appear
 * inside a task ("fixing the login bug, which broke yesterday") and splitting on
 * them would cut it in half. This does not occur in ordinary typing. */
var TASK_SEP = ' · ';

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

/** ISO timestamp -> milliseconds since epoch, or NaN if it cannot be read. */
function instantOf(at) {
  return Date.parse(String(at));
}

/* ── The counter day ───────────────────────────────────────────────────────
 * M, prayers and the review's days turn at a rollover early in the morning
 * (dayStartFor), not at midnight, so a night that runs past 12 still counts
 * towards the evening it began in.
 * `offsetMin` is minutes east of UTC (the server passes Karachi's 300);
 * omitted, it is the device's own clock. */

/* THE ONLY PLACE THAT KNOWS WHEN THE DAY TURNS: FAJR_MARGIN_MIN before that
 * date's Fajr, at the saved place (Stage 10). Every caller goes through
 * counterDayStart() / counterDate() and none knows the hour.
 *
 * Fajr is a UTC instant, so the browser (device clock) and the server (an
 * offset) get the same answer for the same date. Clamped against solar noon so
 * a far-north summer cannot push it to midnight, then into [00:00, 11:00]
 * local so it stays on its own date and before midday — counterDayOf() and
 * counterStartOf() rely on both. */
function dayStartFor(date, offsetMin) {
  var times = prayerTimes(date, offsetMin);
  var start = times.Fajr - FAJR_MARGIN_MIN * 60000;
  var noon = times.Dhuhr;
  if (!isFinite(start) || !isFinite(noon)) return localClockMs(date, 4, 30, offsetMin);
  start = Math.min(start, noon - ROLLOVER_LATEST_H * 3600000);
  start = Math.max(start, noon - ROLLOVER_EARLIEST_H * 3600000);
  start = Math.min(start, localClockMs(date, 11, 0, offsetMin));
  return Math.max(start, localClockMs(date, 0, 0, offsetMin));
}

/** `date` at hh:mm local — the device's clock, or `offsetMin` east of UTC. */
function localClockMs(date, hh, mm, offsetMin) {
  if (typeof offsetMin === 'number') {
    return Date.UTC(date.y, date.m - 1, date.d, hh, mm) - offsetMin * 60000;
  }
  return new Date(date.y, date.m - 1, date.d, hh, mm).getTime();
}

/* ── Prayer times (Stage 10) ───────────────────────────────────────────────
 * Computed here from the sun's position — no service at runtime. The method
 * is PrayTimes.js's (praytimes.org), which is also what Aladhan runs: Julian
 * day, then the sun's declination and equation of time, then solar noon and
 * the hour angle at which the sun reaches each prayer's angle. */

/** The day turns this long before Fajr, so a Fajr logged on time counts for the new day. */
var FAJR_MARGIN_MIN = 10;

/* Fajr and Isha angles below the horizon. Isha may be minutes after Maghrib
 * instead (Umm al-Qura). Karachi is the default: the usual choice in Pakistan. */
var PRAYER_METHODS = {
  karachi: { label: 'University of Islamic Sciences, Karachi (18° / 18°)', fajr: 18, isha: 18 },
  mwl: { label: 'Muslim World League (18° / 17°)', fajr: 18, isha: 17 },
  isna: { label: 'ISNA, North America (15° / 15°)', fajr: 15, isha: 15 },
  egypt: { label: 'Egyptian General Authority (19.5° / 17.5°)', fajr: 19.5, isha: 17.5 },
  makkah: { label: 'Umm al-Qura, Makkah (18.5° / 90 min)', fajr: 18.5, ishaMin: 90 }
};

/** Asr begins when an object's shadow is `factor` times its length plus its noon shadow. */
var ASR_SCHOOLS = {
  hanafi: { label: 'Hanafi (shadow twice the length)', factor: 2 },
  standard: { label: 'Shafi‘i, Maliki, Hanbali (shadow equal to the length)', factor: 1 }
};

/** Where the times are for when nothing better is known. */
var PRAYER_DEFAULT_PLACE = { lat: 24.8607, lng: 67.0011, zone: 'Asia/Karachi',
                             method: 'karachi', asr: 'hanafi' };

/** Sunrise and sunset: the sun's upper edge on the horizon, refraction included. */
var SUNRISE_ANGLE = 0.833;

/* Where the sun never gets 18° below the horizon (London in June), Fajr is
 * at most a share of the night before sunrise and Isha after sunset:
 * 'angle' = angle/60 of the night (Aladhan's default), 'seventh' = 1/7. */
var HIGH_LAT_RULE = 'angle';

/** Beyond this the sun may not rise or set at all; the times of this latitude are used instead. */
var POLAR_LAT_LIMIT = 65;

/* The rollover stays between these many hours before solar noon. Karachi's
 * own sits 7-8.5 h before; London's June angle-based one about 10.5 h. */
var ROLLOVER_EARLIEST_H = 11;
var ROLLOVER_LATEST_H = 4;

/** Last resort, in hours from solar noon, for a time that still cannot be computed. */
var PRAYER_FALLBACK_H = { Fajr: -7, Sunrise: -6, Dhuhr: 0, Asr: 3.5, Maghrib: 6, Isha: 7.5 };

var DEG = Math.PI / 180;

/** The place in use. Set by the app from localStorage and by the server from
 *  user_settings; null means the default. */
var prayerPlace = null;

/** Adopt a place ({lat, lng, zone, method, asr}); anything missing or invalid
 *  takes the default. Returns what is now in use. */
function setPrayerPlace(p) {
  prayerPlace = normalisePlace(p);
  return prayerPlace;
}

function currentPlace() {
  return prayerPlace || normalisePlace(null);
}

/** A number, or NaN for null, '' and anything non-finite (Number(null) is 0). */
function finiteNum(x) {
  if (x === null || x === undefined || x === '') return NaN;
  var n = Number(x);
  return isFinite(n) ? n : NaN;
}

/** A complete place. Coordinates that cannot be read fall back to Karachi's;
 *  the zone is kept whatever the coordinates, because it is the device's clock
 *  that the server has to match. */
function normalisePlace(p) {
  p = p || {};
  var d = PRAYER_DEFAULT_PLACE;
  var lat = finiteNum(p.lat);
  var lng = finiteNum(p.lng);
  var known = !isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  var zone = typeof p.zone === 'string' && p.zone ? p.zone : d.zone;
  var method = Object.prototype.hasOwnProperty.call(PRAYER_METHODS, p.method) ? p.method : d.method;
  var asr = Object.prototype.hasOwnProperty.call(ASR_SCHOOLS, p.asr) ? p.asr : d.asr;
  return { lat: known ? lat : d.lat, lng: known ? lng : d.lng, zone: zone,
           method: method, asr: asr, known: known };
}

/** Julian day at 0h UT of a calendar date. */
function julianDay(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  var a = Math.floor(y / 100);
  var b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + b - 1524.5;
}

/** The sun's declination (degrees) and the equation of time (hours) at Julian day `jd`. */
function sunAt(jd) {
  var n = jd - 2451545.0;
  var g = (357.529 + 0.98560028 * n) * DEG;
  var q = 280.459 + 0.98564736 * n;
  var l = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  var e = (23.439 - 0.00000036 * n) * DEG;
  var ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l)) / DEG / 15;
  var eqt = q / 15 - ra;
  eqt -= 24 * Math.round(eqt / 24);
  return { decl: Math.asin(Math.sin(e) * Math.sin(l)) / DEG, eqt: eqt };
}

/* The hour functions below count hours from local mean midnight at the place's
 * longitude; `jd0` is the Julian day of that midnight and `t` a first guess of
 * the hour, at which the sun's position is taken. */

function solarNoonHour(jd0, t) {
  return 12 - sunAt(jd0 + t / 24).eqt;
}

/** When the sun is `angle` degrees below the horizon, before or after noon.
 *  NaN if it never gets there that day. */
function sunAngleHour(jd0, lat, angle, t, before) {
  var decl = sunAt(jd0 + t / 24).decl * DEG;
  var c = (-Math.sin(angle * DEG) - Math.sin(decl) * Math.sin(lat * DEG)) /
          (Math.cos(decl) * Math.cos(lat * DEG));
  if (!(c >= -1 && c <= 1)) return NaN;
  var h = Math.acos(c) / DEG / 15;
  var noon = solarNoonHour(jd0, t);
  return before ? noon - h : noon + h;
}

function asrHour(jd0, lat, factor, t) {
  var decl = sunAt(jd0 + t / 24).decl;
  var altitude = Math.atan(1 / (factor + Math.tan(Math.abs(lat - decl) * DEG))) / DEG;
  return sunAngleHour(jd0, lat, -altitude, t, false);
}

/** One pass at the guessed hours `g`. */
function prayerPass(jd0, lat, method, factor, g) {
  return {
    Fajr: sunAngleHour(jd0, lat, method.fajr, g.Fajr, true),
    Sunrise: sunAngleHour(jd0, lat, SUNRISE_ANGLE, g.Sunrise, true),
    Dhuhr: solarNoonHour(jd0, g.Dhuhr),
    Asr: asrHour(jd0, lat, factor, g.Asr),
    Maghrib: sunAngleHour(jd0, lat, SUNRISE_ANGLE, g.Maghrib, false),
    Isha: typeof method.isha === 'number' ? sunAngleHour(jd0, lat, method.isha, g.Isha, false) : NaN
  };
}

/** The six hours for one mean day, high-latitude rule applied. Sunrise or
 *  sunset missing (polar day or night) means the POLAR_LAT_LIMIT latitude's. */
function prayerHours(jd0, lat, method, factor) {
  var guess = { Fajr: 5, Sunrise: 6, Dhuhr: 12, Asr: 13, Maghrib: 18, Isha: 18 };
  var h = prayerPass(jd0, lat, method, factor, guess);
  // A second pass, with the sun taken at the first pass's times.
  Object.keys(guess).forEach(function (k) { if (isFinite(h[k])) guess[k] = h[k]; });
  h = prayerPass(jd0, lat, method, factor, guess);

  if ((!isFinite(h.Sunrise) || !isFinite(h.Maghrib)) && Math.abs(lat) > POLAR_LAT_LIMIT) {
    return prayerHours(jd0, lat > 0 ? POLAR_LAT_LIMIT : -POLAR_LAT_LIMIT, method, factor);
  }

  var night = 24 - h.Maghrib + h.Sunrise;
  function share(angle) { return HIGH_LAT_RULE === 'seventh' ? night / 7 : night * angle / 60; }
  var early = share(method.fajr);
  if (!isFinite(h.Fajr) || h.Sunrise - h.Fajr > early) h.Fajr = h.Sunrise - early;
  if (typeof method.ishaMin === 'number') {
    h.Isha = h.Maghrib + method.ishaMin / 60;
  } else {
    var late = share(method.isha);
    if (!isFinite(h.Isha) || h.Isha - h.Maghrib > late) h.Isha = h.Maghrib + late;
  }

  var noon = isFinite(h.Dhuhr) ? h.Dhuhr : 12;
  Object.keys(PRAYER_FALLBACK_H).forEach(function (k) {
    if (!isFinite(h[k])) h[k] = noon + PRAYER_FALLBACK_H[k];
  });
  return h;
}

/**
 * The prayer times of local date `date` ({y, m, d}) at the place in use, as
 * instants in ms, rounded to the minute as timetables print them:
 * {Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha}. Never NaN for a real date.
 *
 * `offsetMin` only picks WHICH solar day is meant — the one whose noon is
 * nearest that date's local noon — so a zone far from its longitude still gets
 * its own day. The device's clock when omitted. `place` overrides the one in use.
 */
function prayerTimes(date, offsetMin, place) {
  var p = place ? normalisePlace(place) : currentPlace();
  var mean = new Date(localClockMs(date, 12, 0, offsetMin) + p.lng * 240000);
  var y = mean.getUTCFullYear();
  var m = mean.getUTCMonth() + 1;
  var d = mean.getUTCDate();
  var jd0 = julianDay(y, m, d) - p.lng / 360;
  var h = prayerHours(jd0, p.lat, PRAYER_METHODS[p.method], ASR_SCHOOLS[p.asr].factor);
  var base = Date.UTC(y, m - 1, d);
  var out = {};
  Object.keys(PRAYER_FALLBACK_H).forEach(function (k) {
    out[k] = Math.round((base + (h[k] - p.lng / 15) * 3600000) / 60000) * 60000;
  });
  return out;
}

/** Minutes east of UTC in IANA `zone` at instant `ms`; `fallback` when the zone
 *  cannot be read. What the server passes as `offsetMin`. */
function zoneOffsetMin(zone, ms, fallback) {
  try {
    var parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric'
    }).formatToParts(new Date(ms)).forEach(function (x) { parts[x.type] = x.value; });
    var asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
                         Number(parts.hour) % 24, Number(parts.minute));
    var off = Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
    return isFinite(off) ? off : fallback;
  } catch (e) {
    return fallback;
  }
}

/** The local calendar date of instant `t`, as {y, m, d}. */
function calendarDateOf(t, offsetMin) {
  if (typeof offsetMin === 'number') {
    var s = shiftedDate(t, offsetMin);
    return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate() };
  }
  var d = new Date(t);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function dayBefore(date) {
  var p = new Date(Date.UTC(date.y, date.m - 1, date.d - 1));
  return { y: p.getUTCFullYear(), m: p.getUTCMonth() + 1, d: p.getUTCDate() };
}

/** The counter day holding `t`: its own date, or the one before when `t` is
 *  earlier than that date's rollover. */
function counterDayOf(t, offsetMin) {
  var date = calendarDateOf(t, offsetMin);
  var start = dayStartFor(date, offsetMin);
  if (t < start) {
    date = dayBefore(date);
    start = dayStartFor(date, offsetMin);
  }
  return { date: date, start: start };
}

/** The instant (ms) the counter day holding `t` began. */
function counterDayStart(t, offsetMin) {
  return counterDayOf(t, offsetMin).start;
}

/** 'YYYY-MM-DD' of the counter day holding `t` — at 02:00 that is yesterday. */
function counterDate(t, offsetMin) {
  var d = counterDayOf(t, offsetMin).date;
  return d.y + '-' + (d.m < 10 ? '0' : '') + d.m + '-' + (d.d < 10 ? '0' : '') + d.d;
}

/* A PRAYER's day turns at Fajr itself, not FAJR_MARGIN_MIN before it (1 Oct:
 * "Isha is open until Fajr"). Only Isha can fall in that gap, since Fajr cannot
 * be logged before its time. Everything else keeps the counter day. */

/** 'YYYY-MM-DD' of the prayer day holding `t`: counterDate(), except in the
 *  minutes between the rollover and Fajr, which belong to the day before. */
function prayerDate(t, offsetMin) {
  if (!isFinite(t)) return '';
  var day = counterDayOf(t, offsetMin);
  var fajr = prayerTimes(day.date, offsetMin).Fajr;
  var d = isFinite(fajr) && t < fajr ? dayBefore(day.date) : day.date;
  return d.y + '-' + (d.m < 10 ? '0' : '') + d.m + '-' + (d.d < 10 ? '0' : '') + d.d;
}

/** The instant the prayer day holding `t` began: that day's Fajr. */
function prayerDayStart(t, offsetMin) {
  var p = prayerDate(t, offsetMin).split('-');
  var fajr = prayerTimes({ y: Number(p[0]), m: Number(p[1]), d: Number(p[2]) }, offsetMin).Fajr;
  return isFinite(fajr) ? fajr : counterDayStart(t, offsetMin);
}

/** The prayer rows ({at, prayer}) whose prayer day is `ymd`. */
function prayersOn(prayers, ymd, offsetMin) {
  return (prayers || []).filter(function (p) {
    return prayerDate(instantOf(p.at), offsetMin) === ymd;
  });
}

/* ── The lead-in ───────────────────────────────────────────────────────────
 * The work session does not reset at the rollover. The counter day's rows are
 * replayed together with this lead-in: the work-clock rows since the last
 * off/sleep before the rollover. Never counted — only replayed. */

/** How far back a lead-in may reach, so a clock left open for days stays bounded. */
var LEAD_MAX_MS = 48 * 3600000;

/** Rows that move the work clock or name a project, plus `awake` for the idle
 *  cap and `subdone`/`subdrop` for the sub-task clock. No M, prayer or wake. */
var LEAD_TYPES = ['work', 'voice', 'done', 'break', 'resume', 'off', 'sleep', 'awake', 'subdone', 'subdrop'];

/** An open clock stops counting this long after the last work-session row: the
 *  night checks span 23:30 to 11:00 (11.5 h), so anything longer was forgotten. */
var IDLE_MAX_MS = 12 * 3600000;

/** Rows that show the session is still being tended. `awake` is a Yes to the
 *  night check (wrapup writes it). Not M, prayer or wake: they say he is up, not
 *  that the clock left running is still work. */
var IDLE_RESET_TYPES = ['work', 'voice', 'done', 'break', 'resume', 'awake', 'subdone', 'subdrop'];

/**
 * The lead-in for a day starting at `beforeMs`: rows of LEAD_TYPES earlier than
 * it, no more than LEAD_MAX_MS earlier, and strictly after the newest `off`.
 * Newest first, as replayDay() takes them. A row sharing the close's instant is
 * dropped with it: a night Sleep writes `off` and `sleep` together, and the close wins.
 * A lone `sleep` is a daytime nap (sleepClosingRow), so it does not end the session.
 */
function sessionLead(rows, beforeMs) {
  var from = beforeMs - LEAD_MAX_MS;
  var keep = [];
  var closedAt = -Infinity;
  (rows || []).forEach(function (r, i) {
    var t = instantOf(r.at);
    if (isNaN(t) || t >= beforeMs || t < from || LEAD_TYPES.indexOf(r.type) === -1) return;
    if (r.type === 'off' && t > closedAt) closedAt = t;
    keep.push({ r: r, t: t, i: i });
  });
  var cut = keep.filter(function (x) { return x.t > closedAt; })
    .sort(function (a, b) { return (b.t - a.t) || (a.i - b.i); })
    .map(function (x) { return x.r; });

  /* replayDay() ignores a break after a close until work starts again. The close
   * is cut off above, so drop those breaks here too, or a chip tapped after
   * End day would reopen the session. */
  if (closedAt === -Infinity) return cut;
  var opened = false;
  return cut.slice().reverse().filter(function (r) {
    if (r.type === 'work' || r.type === 'voice' || r.type === 'resume') opened = true;
    return opened || r.type !== 'break';
  }).reverse();
}

/** 8_100_000 -> "2h 15m". Minutes only under an hour; never "0h". */
function humanDuration(ms) {
  var mins = Math.max(0, Math.round(ms / 60000));
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  if (!h) return m + 'm';
  return h + 'h ' + m + 'm';
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
 *
 * @param fromMs where crediting starts. Rows before it only set the state —
 *               the open projects, the clock, the break — so a session that
 *               crossed into this window from the one before is counted from
 *               the line, not dropped. Omit it to credit every row given.
 */
function replayDay(log, endMs, fromMs) {
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
  /* Stage 14b: the one sub-task being worked on (a task_nodes id), and the
   * project key of the row that named it. Credited only while the clock runs,
   * so a break pauses it and resume carries on (C2). */
  var curSub = '';
  var curSubKey = '';
  var bySubtask = userMap();

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
  var floor = (typeof fromMs === 'number' && isFinite(fromMs)) ? fromMs : -Infinity;

  var lastTended = 0;                       // newest IDLE_RESET_TYPES row so far

  /** Credit everything active up to `t`, then move the cursor there. An open
   *  clock or break stops counting IDLE_MAX_MS after the session was last
   *  tended, so a forgotten one cannot fill whole days. */
  function advance(t) {
    if (t > ceiling) t = ceiling;
    var from = Math.max(lastT, floor);
    var until = lastTended ? Math.min(t, lastTended + IDLE_MAX_MS) : t;
    if (lastT && until > from) {
      var span = until - from;
      if (clock) {
        worked += span;
        if (curSub) bySubtask[curSub] = (bySubtask[curSub] || 0) + span;
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
    if (IDLE_RESET_TYPES.indexOf(row.type) !== -1 && t > lastTended) lastTended = t;

    var text = String(row.raw_text || '').trim();

    if (row.type === 'work' || row.type === 'voice') {
      // Adds, never replaces — that is the whole point of multitasking.
      var name = String(row.project || text).trim();
      if (name) { active[name] = 1; remember(name); }
      // A filed entry names its sub-task; one that is not filed ends it.
      curSub = row.node_id ? String(row.node_id) : '';
      curSubKey = curSub ? name : '';
      clock = true;
      underWay = true;
      dayClosed = false;
      reasons = userMap();
    } else if (row.type === 'done') {
      var finished = String(row.project || text).trim();
      delete active[finished];
      if (curSub && finished === curSubKey) curSub = '';   // Stop on its project
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
      /* `off` ends the session, so its projects close with it and the next one
       * starts empty. Every Sleep that ends the day writes `off` too; a lone
       * `sleep` is a nap on a break, which keeps them (Saad, 29 Sep), and its
       * sub-task, which the resume carries on (1 Oct). */
      if (row.type === 'off') {
        active = userMap();
        order = [];
        curSub = '';
      }
    } else if (row.type === 'subdone' || row.type === 'subdrop') {
      // Finished (its Done, or its last item closed) or dropped: only that sub-task stops.
      if (row.node_id && String(row.node_id) === curSub) curSub = '';
    }
    // wake / awake / M / prayer do not move the work clock
  });

  advance(ceiling);                         // bring everything up to now

  var activeProjects = order.filter(function (p) { return active[p]; });
  var current = activeProjects.length ? activeProjects[activeProjects.length - 1] : '';

  return {
    project: current,                       // the most recent one, for a one-line readout
    ms: byProject[current] || 0,
    running: clock,
    dayClosed: dayClosed,                   // ended for the night — not merely paused
    activeProjects: activeProjects,
    byProject: byProject,
    worked: worked,
    unattributed: unattributed,
    paused: paused,
    breakReason: Object.keys(reasons).join(REASON_SEP),
    activeReasons: Object.keys(reasons),
    byReason: byReason,
    bySubtask: bySubtask,                   // task_nodes id -> ms; sum <= worked
    currentSubtask: curSub,                 // '' when none
    subtaskProject: curSub ? curSubKey : '' // the project key it was named under
  };
}

/* The Today card's figures AND the notification-shade glance's (Stage 7b). One
 * function, so the two cannot count differently.
 *
 * They can still differ, and on purpose: the card is the last read PLUS every
 * tap since, with the clock running to now; the glance is the last read alone,
 * with the clock stopped at the moment that read was made (see paintGlance).
 *
 * Rows come in as arguments instead of being read from lastLog / todayPrayers,
 * which is what lets a test hand it any day at all.
 *
 * The M figure is the rows counted, not the Home tile's number. The tile shows
 * the server's reply to a write, and mid-write that lags by whatever taps are
 * still in flight. "Working on" is renderProject's rule: the most recently
 * opened project that is still open, paused whenever the clock is not running.
 *
 * @param endMs  where the work clock stops. Omit it for now, as the card does.
 * @param carry  state rows from before today, newest first. Only the glance
 *               passes it; without it `notStarted` stays false.
 * @param lead   the session's rows from before the rollover (sessionLead()).
 *               Replayed for hours and "working on"; never counted. */
function dayFigures(log, prayers, endMs, carry, lead, tree) {
  log = log || [];
  prayers = prayers || [];
  // No tree (or an empty one), no new code on the path: v1 figures exactly as before 14b.
  var nodes = tree && tree.nodes && tree.nodes.length ? tree.nodes : null;
  var rows = log.concat(lead || []);
  var day = replayDay(nodes ? namedRows(rows, nodes) : rows, endMs);
  var sub = nodes && day.currentSubtask && day.subtaskProject === day.project
          ? nodeIndex(nodes).byId[day.currentSubtask] : null;
  if (sub && sub.kind !== 'subtask') sub = null;         // filed under a project with no sub-tasks

  return {
    day: day,                               // the whole replay, for the card's list
    worked: day.worked,
    project: day.project,                   // '' when nothing is open
    running: day.running,
    dayClosed: day.dayClosed,               // the day is over, which is not "paused"
    // Counts read the counter day's rows only, never the lead-in.
    // A prayer logged twice is still one prayer out of five.
    prayersDone: PRAYER_NAMES.filter(function (n) {
      return prayers.some(function (p) { return p.prayer === n; });
    }).length,
    mCount: log.filter(function (r) { return r.type === 'M'; }).length,
    // No work-clock row today and nothing left open from yesterday. An M, a
    // prayer or a wake at 5 AM does not start the work day.
    notStarted: Array.isArray(carry) &&
                !log.some(function (r) { return movesWorkClock(r.type); }) &&
                !openBeforeToday(carry),
    // The sub-task under `project` being worked on, when the tree is given.
    subtask: sub ? sub.id : '',
    subtaskTitle: sub ? String(sub.title || '').trim() || '(untitled)' : ''
  };
}

/* ── Task names and items (Stage 14b) ──────────────────────────────────────
 * `nodes` are task_nodes rows; `items` and `marks` the items and item_marks
 * rows. A tree is {nodes, items, marks}; every part may be missing. */

/** Nodes by id, and by list + google_id for finding a sub-task's project. */
function nodeIndex(nodes) {
  var byId = userMap();
  var byGoogle = userMap();
  (nodes || []).forEach(function (n) {
    if (!n || !n.id) return;
    byId[n.id] = n;
    byGoogle[(n.list_id || '') + '|' + n.google_id] = n;
  });
  return { byId: byId, byGoogle: byGoogle };
}

/** {project, detail} as the tree names node `id` now; null when unknown. */
function nodeNames(index, id) {
  var n = index.byId[id];
  if (!n) return null;
  var title = String(n.title || '').trim() || '(untitled)';
  if (n.kind !== 'subtask') return { project: title, detail: '' };
  var up = index.byGoogle[(n.list_id || '') + '|' + n.parent_google_id];
  if (!up) return null;
  return { project: String(up.title || '').trim() || '(untitled)', detail: title };
}

/**
 * Rows with each named task's CURRENT titles, so a rename in Google does not
 * split a project in two. Work, voice and done rows only, and only ones that
 * already carry a name: a blank one is keyed on its sentence, and naming it
 * here would reopen a tile its Stop closed (canRename). A row with no node
 * whose name was some task's old name takes the new one too, when that is
 * unambiguous. No nodes: the same array, untouched.
 */
function namedRows(rows, nodes) {
  if (!nodes || !nodes.length || !rows || !rows.length) return rows || [];
  var index = nodeIndex(nodes);
  var alias = userMap();
  var names = rows.map(function (r) {
    if (!r || !r.node_id || !String(r.project || '').trim()) return null;
    if (r.type !== 'work' && r.type !== 'voice' && r.type !== 'done') return null;
    var now = nodeNames(index, r.node_id);
    if (!now) return null;
    var was = String(r.project).trim();
    if (alias[was] === undefined) alias[was] = now.project;
    else if (alias[was] !== now.project) alias[was] = null;      // two answers: use neither
    return now;
  });
  return rows.map(function (r, i) {
    if (names[i]) {
      var out = Object.assign({}, r, { project: names[i].project });
      if (r.type !== 'done') out.detail = names[i].detail;
      return out;
    }
    var was = r && String(r.project || '').trim();
    if (!was || r.node_id || (r.type !== 'work' && r.type !== 'voice' && r.type !== 'done')) return r;
    var to = alias[was];
    return to && to !== was ? Object.assign({}, r, { project: to }) : r;
  });
}

/** When two marks agree on `at`, the one the table took later wins; one still
 *  on this device (no created_at yet) is newer than any that landed. */
function markNewer(a, b) {
  var ta = instantOf(a.at);
  var tb = instantOf(b.at);
  if (ta !== tb) return ta > tb;
  var ca = a.created_at ? instantOf(a.created_at) : Infinity;
  var cb = b.created_at ? instantOf(b.created_at) : Infinity;
  if (ca !== cb) return ca > cb;
  return String(a.rid || '') > String(b.rid || '');
}

var ITEM_MARKS = { done: 1, drop: 1, open: 1 };

/** item rid -> its newest mark row. */
function itemNewest(marks) {
  var newest = userMap();
  (marks || []).forEach(function (m) {
    if (!m || !m.item_rid || ITEM_MARKS[m.mark] !== 1 || isNaN(instantOf(m.at))) return;
    var have = newest[m.item_rid];
    if (!have || markNewer(m, have)) newest[m.item_rid] = m;
  });
  return newest;
}

/** item rid -> 'done' | 'drop' | 'open': its newest mark. No mark is open. */
function itemStates(marks) {
  var newest = itemNewest(marks);
  var out = userMap();
  Object.keys(newest).forEach(function (rid) { out[rid] = newest[rid].mark; });
  return out;
}

/** The items under node `id`, in the order they were made, each with `state`. */
function itemsOf(tree, id) {
  if (!tree || !id) return [];
  var states = itemStates(tree.marks);
  return (tree.items || []).filter(function (it) {
    return it && it.rid && it.node_id === id;
  }).map(function (it) {
    return Object.assign({}, it, { state: states[it.rid] || 'open' });
  }).sort(function (a, b) {
    return (instantOf(a.at) - instantOf(b.at)) ||
           String(a.rid).localeCompare(String(b.rid), 'en', { numeric: true });
  });
}

/** Is the tile keyed `key` still open in these rows (newest first)? */
function isOpenAt(rows, key) {
  return replayDay(rows).activeProjects.indexOf(String(key == null ? '' : key).trim()) !== -1;
}

/**
 * May the entry with `rid`, keyed `key` (its sentence), be renamed `name`?
 * Not when that would open a tile nobody opened: a Stop (`done`) closed the
 * sentence, and no `done` names the new name. A tile closed by End day stays
 * closed under any name, so that rename is safe.
 */
function canRename(rows, rid, key, name) {
  if (isOpenAt(rows, key) || isOpenAt(rows, name)) return true;
  var renamed = (rows || []).map(function (r) {
    return r && r.rid === rid ? Object.assign({}, r, { project: name }) : r;
  });
  return !isOpenAt(renamed, name);
}

/* Row types that say whether the work day was open or closed. `wake` is left
 * out on purpose: like replayDay(), it does not move the work clock. */
var OPEN_TYPES = { work: 1, voice: 1, resume: 1, 'break': 1 };
var CLOSED_TYPES = { off: 1, sleep: 1 };

/** True for a row type that starts, pauses or ends the work day. */
function movesWorkClock(type) {
  return Boolean(OPEN_TYPES[type] || CLOSED_TYPES[type]);
}

/**
 * Was the work day still open at the rollover? Reads the rows from before today.
 *
 * On a tie a closing row wins: Sleep writes `break` then `sleep` in the same
 * instant, and replayDay() reads that pair as a closed day.
 */
function openBeforeToday(carry) {
  var newest = NaN;
  var open = false;
  (carry || []).forEach(function (r) {
    if (!movesWorkClock(r.type)) return;
    var t = instantOf(r.at);
    if (isNaN(t)) return;
    if (isNaN(newest) || t > newest) {
      newest = t;
      open = Boolean(OPEN_TYPES[r.type]);
    } else if (t === newest && CLOSED_TYPES[r.type]) {
      open = false;
    }
  });
  return open;
}

/** The same instant as a Date whose UTC fields read as local time at
 *  `offsetMin` east of UTC. Only called when an offset is given. */
function shiftedDate(ms, offsetMin) {
  return new Date(ms + offsetMin * 60000);
}

/** "5:42 PM". A fixed shape rather than the locale's, because that is the
 *  wording Saad chose. By the device's clock, unless `offsetMin` is given —
 *  the server runs in UTC and passes Karachi's 300. */
function glanceClock(ms, offsetMin) {
  var zoned = typeof offsetMin === 'number';
  var d = zoned ? shiftedDate(ms, offsetMin) : new Date(ms);
  var h = zoned ? d.getUTCHours() : d.getHours();
  var m = zoned ? d.getUTCMinutes() : d.getMinutes();
  return ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' AM' : ' PM');
}

/**
 * The words, from dayFigures() — the Today card's own function — and the moment
 * those figures are true as of. Plain strings throughout: the project name is
 * the user's own text, and it goes out exactly as typed.
 *
 * It opens with the weekday, not "Today" (Saad, 15 Sep). Nothing runs while the
 * app is closed, so a read made at 11:58 PM is still on the lock screen at 7 AM,
 * where "Today" would be false. The day is the counter day of the same instant,
 * on the same clock, as the time after "as of", and is fixed English for the
 * same reason that time is a fixed shape.
 *
 * `offsetMin` as for glanceClock(). Omitted, it is the device's own clock.
 */
function glanceText(figures, asOfMs, offsetMin) {
  /* Three states, the same three the Home pill has: working, paused, day done.
   * "Paused" for a day that is over reads as "back shortly", the opposite of
   * what it means. GlanceWords.staleTitle leaves a title it does not recognise
   * alone, so the widget passes this shape through untouched — no new APK. */
  var title;
  if (figures.notStarted) {
    title = 'Not started yet';
  } else if (figures.dayClosed) {
    title = figures.project ? 'Day done · ' + figures.project : 'Day done';
  } else {
    title = figures.project
      ? 'Working on: ' + figures.project +
        (figures.subtaskTitle ? ' · ' + figures.subtaskTitle : '') +
        (figures.running ? '' : ' · paused')
      : 'Working on: nothing open';
  }

  /* The counter day's weekday, not the calendar's: at 02:00 the M and prayer
   * figures are still yesterday's, so the line is headed with yesterday. */
  var ymd = counterDate(asOfMs, offsetMin).split('-');
  var weekday = new Date(Date.UTC(Number(ymd[0]), Number(ymd[1]) - 1, Number(ymd[2]))).getUTCDay();
  var day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday];
  var body = day + ' ' + humanDuration(figures.worked) +
             ' · ' + figures.mCount + ' M' +
             ' · ' + figures.prayersDone + '/5 prayers' +
             ' · as of ' + glanceClock(asOfMs, offsetMin);

  return { title: title, body: body };
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
 *
 * Here rather than in app.js so the widget's list and the Today screen share it.
 */
function projectTasks(rows, name) {
  var seen = userMap();                     // keyed by task text — see userMap()
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

/* The widget's list is capped so it cannot outgrow the widget: at most
 * 1 + 4 x (1 + 3 + 1) + 1 = 22 lines, and each line short enough to stay one line.
 * The project holding the current sub-task spends the same five: itself, the
 * sub-task, two open items and a "+n more". */
var GLANCE_LIST_PROJECTS = 4;
var GLANCE_LIST_TASKS = 3;
var GLANCE_LIST_ITEMS = 2;
var GLANCE_LIST_CHARS = 44;

/** Shorten to `max` characters, at a word break where there is one, with "…". */
function clipLine(text, max) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  /* Counted in whole characters, not UTF-16 units. A cut through an emoji keeps
   * half of it, Postgres refuses that half as invalid JSON, and the upsert that
   * carries it fails — freezing the widget's title and figures along with the
   * list, for the rest of the day. */
  var chars = Array.from(t);
  if (chars.length <= max) return t;
  var cut = chars.slice(0, max - 1).join('');
  var space = cut.lastIndexOf(' ');
  if (space > max / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:·-]+$/, '') + '…';
}

/**
 * The widget's list: every open project, most recently started first as the
 * Today screen draws them, each with its sub-tasks under it.
 *
 *   Working on:
 *   - tail skill
 *       - write the parser
 *   - OneNet
 *
 * '' when nothing is open, so the widget falls back to its title and body.
 * The heading follows glanceText's three states; the widget rewrites
 * "Working on" to "Was working on" once the reading is old, as it does the title.
 *
 * @param log    today's rows, newest first, as replayDay() takes them.
 * @param endMs  where the day stops; omitted, it is now.
 * @param lead   the session's rows from before the rollover, as for dayFigures.
 * @param tree   optional {nodes, items, marks}: names are the tree's, and the
 *               current sub-task shows as "    ▸ title" with its open items.
 */
function glanceList(log, endMs, lead, tree) {
  log = (log || []).concat(lead || []);
  var nodes = tree && tree.nodes && tree.nodes.length ? tree.nodes : null;
  if (nodes) log = namedRows(log, nodes);
  var day = replayDay(log, endMs);
  var open = day.activeProjects.slice().reverse();
  if (!open.length) return '';
  var subNode = nodes && day.currentSubtask
              ? nodeIndex(nodes).byId[day.currentSubtask] : null;

  var heading = day.dayClosed ? 'Day done · still open:'
              : day.running ? 'Working on:'
              : 'Working on (paused):';
  var lines = [heading];

  open.slice(0, GLANCE_LIST_PROJECTS).forEach(function (name) {
    lines.push('- ' + clipLine(name, GLANCE_LIST_CHARS));
    if (subNode && name === day.subtaskProject) {
      // A project with no sub-tasks lists its items straight under its name.
      if (subNode.kind === 'subtask') {
        lines.push('    ▸ ' + clipLine(String(subNode.title || '').trim() || '(untitled)', GLANCE_LIST_CHARS));
      }
      var items = itemsOf(tree, subNode.id).filter(function (it) { return it.state === 'open'; });
      items.slice(0, GLANCE_LIST_ITEMS).forEach(function (it) {
        lines.push('    - ' + clipLine(it.title, GLANCE_LIST_CHARS));
      });
      if (items.length > GLANCE_LIST_ITEMS) lines.push('    +' + (items.length - GLANCE_LIST_ITEMS) + ' more');
      return;
    }
    var tasks = projectTasks(log, name);
    tasks.slice(0, GLANCE_LIST_TASKS).forEach(function (task) {
      lines.push('    - ' + clipLine(task, GLANCE_LIST_CHARS));
    });
    if (tasks.length > GLANCE_LIST_TASKS) {
      lines.push('    +' + (tasks.length - GLANCE_LIST_TASKS) + ' more');
    }
  });
  if (open.length > GLANCE_LIST_PROJECTS) {
    lines.push('+' + (open.length - GLANCE_LIST_PROJECTS) + ' more');
  }
  return lines.join('\n');
}

// What glance-refresh uses. The browser reads the globals directly.
globalThis.ProBeingDay = {
  setPrayerPlace: setPrayerPlace,
  currentPlace: currentPlace,
  prayerTimes: prayerTimes,
  zoneOffsetMin: zoneOffsetMin,
  counterDayStart: counterDayStart,
  counterDate: counterDate,
  prayerDate: prayerDate,
  prayersOn: prayersOn,
  sessionLead: sessionLead,
  LEAD_MAX_MS: LEAD_MAX_MS,
  LEAD_TYPES: LEAD_TYPES,
  dayFigures: dayFigures,
  isOpenAt: isOpenAt,
  canRename: canRename,
  openBeforeToday: openBeforeToday,
  glanceText: glanceText,
  glanceList: glanceList,
  namedRows: namedRows,
  itemStates: itemStates,
  itemNewest: itemNewest,
  itemsOf: itemsOf
};
