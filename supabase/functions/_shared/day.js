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
    dayClosed: dayClosed,                   // ended for the night — not merely paused
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
 *               passes it; without it `notStarted` stays false. */
function dayFigures(log, prayers, endMs, carry) {
  log = log || [];
  prayers = prayers || [];
  var day = replayDay(log, endMs);

  return {
    day: day,                               // the whole replay, for the card's list
    worked: day.worked,
    project: day.project,                   // '' when nothing is open
    running: day.running,
    dayClosed: day.dayClosed,               // the day is over, which is not "paused"
    // A prayer logged twice is still one prayer out of five.
    prayersDone: PRAYER_NAMES.filter(function (n) {
      return prayers.some(function (p) { return p.prayer === n; });
    }).length,
    mCount: log.filter(function (r) { return r.type === 'M'; }).length,
    // No work-clock row today and nothing left open from yesterday. An M, a
    // prayer or a wake at 5 AM does not start the work day.
    notStarted: Array.isArray(carry) &&
                !log.some(function (r) { return movesWorkClock(r.type); }) &&
                !openBeforeToday(carry)
  };
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
 * Was the work day still open at midnight? Reads the rows from before today.
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
 * where "Today" would be false. The day is taken from the same instant, on the
 * same clock, as the time after "as of" — so the two cannot disagree — and is
 * fixed English for the same reason that time is a fixed shape.
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
      ? 'Working on: ' + figures.project + (figures.running ? '' : ' · paused')
      : 'Working on: nothing open';
  }

  var zoned = typeof offsetMin === 'number';
  var weekday = zoned ? shiftedDate(asOfMs, offsetMin).getUTCDay() : new Date(asOfMs).getDay();
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

/* The widget's list is capped so it cannot outgrow the widget: at most
 * 1 + 4 x (1 + 3 + 1) + 1 = 22 lines, and each line short enough to stay one line. */
var GLANCE_LIST_PROJECTS = 4;
var GLANCE_LIST_TASKS = 3;
var GLANCE_LIST_CHARS = 44;

/** Shorten to `max` characters, at a word break where there is one, with "…". */
function clipLine(text, max) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  var cut = t.slice(0, max - 1);
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
 */
function glanceList(log, endMs) {
  var day = replayDay(log, endMs);
  var open = day.activeProjects.slice().reverse();
  if (!open.length) return '';

  var heading = day.dayClosed ? 'Day done · still open:'
              : day.running ? 'Working on:'
              : 'Working on (paused):';
  var lines = [heading];

  open.slice(0, GLANCE_LIST_PROJECTS).forEach(function (name) {
    lines.push('- ' + clipLine(name, GLANCE_LIST_CHARS));
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
  dayFigures: dayFigures,
  openBeforeToday: openBeforeToday,
  glanceText: glanceText,
  glanceList: glanceList
};
