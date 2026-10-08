/* ProBeing — the laptop activity watcher's shared logic (Stage 18b).
 *
 * A classic script like day.js and tree.js: index.html loads it, the
 * activity-ingest Edge Function imports it (globalThis.ProBeingActivity), and
 * watcher/windows/watch.ps1 is a line-by-line copy of the sender half. So: no
 * import/export, strict-mode safe, no page, network or storage. Every name
 * starts with `act` so it cannot collide with the page's globals.
 *
 * Privacy (Saad, 9 Oct): a block is start, end, app, site (host only), project,
 * category and the rule keyword that matched. Never a URL, never page text. A
 * window title stays on the laptop except for an unclear block sent to Gemini.
 */

'use strict';

var ACT_CATEGORIES = ['work', 'meeting', 'distraction', 'unclear', 'private'];

/* The lists Settings can change. A word matches an app or a site name; an entry
 * with a dot is a site (and its sub-domains), and a path after it must start the
 * page's path. Private words also match the window title. */
var ACT_DEFAULT_LISTS = {
  distract: ['youtube.com/shorts', 'x.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'facebook.com'],
  private: ['bank', 'password', 'bitwarden', '1password', 'lastpass', 'keepass', 'whatsapp', 'messenger',
            'signal', 'telegram'],
  meeting: ['meet.google.com', 'zoom.us', 'zoom', 'teams.microsoft.com', 'teams', 'discord']
};

var ACT_MIN_BLOCK_MS = 60000;            // shorter pieces fold into a neighbour
var ACT_JOIN_GAP_MS = 60000;             // a gap this small does not split a block
var ACT_BLOCK_MAX_MS = 12 * 3600000;     // the database refuses a longer block
var ACT_TITLE_MAX = 120;
var ACT_APP_MAX = 80;
var ACT_PROJECT_MAX = 120;
var ACT_KEY_MIN = 4;
var ACT_KEY_MAX = 40;
var ACT_LIST_MAX = 50;
var ACT_ENTRY_MAX = 80;
var ACT_BROWSERS = ['chrome', 'msedge', 'brave', 'firefox', 'opera', 'vivaldi'];

/** Lower case, letters and digits only: "proBeing - VS Code" -> "probeingvscode". */
function actNorm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^0-9a-z\u0080-\uffff]+/g, '');
}

/** Cut to `max` UTF-16 units without leaving half an emoji. */
function actCut(s, max) {
  var t = String(s == null ? '' : s);
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/[\ud800-\udbff]$/, '');
}

/** An app's name, never a path: "C:\x\Code.exe" -> "Code.exe". */
function actCleanApp(a) {
  var parts = String(a == null ? '' : a).split(/[\\/]/);
  return actCut(parts[parts.length - 1].replace(/[\u0000-\u001f]/g, '').trim(), ACT_APP_MAX);
}

/** A host name or ''. Anything with a path, query or port is refused. */
function actCleanDomain(d) {
  var h = String(d == null ? '' : d).trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9.-]{1,253}$/.test(h) ? h : '';
}

/** {host, path} of an http(s) URL, lower case; '' for anything else (file:, chrome:). */
function actUrlParts(url) {
  var m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^\/?#@]*@)?([^\/?#:]*)(?::\d+)?([^?#]*)/i.exec(String(url == null ? '' : url).trim());
  if (!m || !/^https?$/i.test(m[1])) return { host: '', path: '' };
  var host = actCleanDomain(m[2]);
  if (!host) return { host: '', path: '' };
  return { host: host, path: m[3].toLowerCase() || '/' };
}

/** A title fit to leave the laptop for Gemini: no links, paths, addresses, ids or long numbers. */
function actScrubTitle(t) {
  var s = String(t == null ? '' : t)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/\S*[\\\/]\S*/g, ' ')
    .replace(/\S*@\S*/g, ' ')
    .replace(ACT_BARE_DOMAIN, ' ')
    .replace(/[0-9](?:[ .\-]?[0-9]){5,}/g, ' ')
    .replace(/\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}\b/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, ' ')
    .replace(/^ +| +$/g, '');      // the same classes as watch.ps1, so the two agree
  return actCut(s, ACT_TITLE_MAX);
}

/* A site named without http (docs.google.com). */
var ACT_BARE_DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|co|pk|gov|edu|me|ai|info|biz|uk|us|in|xyz|site|online|tech|cloud)\b/gi;

/* Apps whose titles are paths or commands: never sent to Gemini. */
var ACT_NO_TITLE_APPS = ['windowsterminal', 'cmd', 'powershell', 'pwsh', 'powershellise', 'explorer', 'conhost', 'wt',
                         'mintty', 'bash', 'wsl', 'ubuntu', 'terminal', 'alacritty', 'putty', 'kitty', 'gitbash', 'wezterm'];

/** May this unclear title go to Gemini? Not a terminal's or a file window's, and not one that looks like a path. */
function actTitleSendable(app, title) {
  if (ACT_NO_TITLE_APPS.indexOf(actNorm(String(app || '').replace(/\.exe$/i, ''))) !== -1) return false;
  var raw = String(title == null ? '' : title);
  if (/[A-Za-z]:\\|~\/|(^|\s)\/[A-Za-z]|\\\\|@[A-Za-z0-9_.-]+:/.test(raw)) return false;
  return /[A-Za-z\u0080-\uffff]{3}/.test(actScrubTitle(raw));
}

/* A browser's own private window, said in its title. */
var ACT_PRIVATE_TITLE = /incognito|inprivate|private browsing/i;

function actIsBrowser(app) {
  return ACT_BROWSERS.indexOf(actNorm(String(app || '').replace(/\.exe$/i, ''))) !== -1;
}

/** One list, tidied: trimmed, lower case, at most ACT_LIST_MAX entries. */
function actTidyList(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (x) {
    var e = actCut(String(x == null ? '' : x).trim().toLowerCase(), ACT_ENTRY_MAX);
    if (e && out.indexOf(e) === -1 && out.length < ACT_LIST_MAX) out.push(e);
  });
  return out;
}

/** The three lists; a list never set is the default, an empty one stays empty. */
function actLists(l) {
  l = l && typeof l === 'object' ? l : {};
  var out = {};
  ['distract', 'private', 'meeting'].forEach(function (k) {
    out[k] = Array.isArray(l[k]) ? actTidyList(l[k]) : ACT_DEFAULT_LISTS[k].slice();
  });
  return out;
}

/** Does list entry `entry` match piece `seg` ({app, host, path, title})? */
function actEntryHits(entry, seg, withTitle) {
  var e = String(entry || '').trim().toLowerCase();
  if (!e) return false;
  if (/[.\/]/.test(e)) {
    var slash = e.indexOf('/');
    var host = (slash === -1 ? e : e.slice(0, slash)).replace(/^www\./, '');
    var path = slash === -1 ? '' : e.slice(slash);
    var h = String(seg.host || '');
    // A private site (mybank.com) also counts when only the title names it.
    if (withTitle === true && host && String(seg.title || '').toLowerCase().indexOf(host) !== -1) return true;
    // A browser window the extension did not see: the site's name in its title.
    if (!h && host && actIsBrowser(seg.app)) return actTitleNamesSite(host, path, seg.title);
    if (!h || !host) return false;
    if (h !== host && h.slice(-(host.length + 1)) !== '.' + host) return false;
    return !path || String(seg.path || '').indexOf(path) === 0;
  }
  var w = actNorm(e);
  if (w.length < 3) return false;
  return actNorm(seg.app).indexOf(w) !== -1 || actNorm(seg.host).indexOf(w) !== -1 ||
         (withTitle === true && actNorm(seg.title).indexOf(w) !== -1);
}

/** Does a title name a site: its first label as a word ("YouTube" for youtube.com), and its
 *  path's first part too when the entry has one ("Shorts")? Labels under 3 letters never match. */
function actTitleNamesSite(host, path, title) {
  var t = String(title == null ? '' : title).toLowerCase();
  var label = String(host).split('.')[0];
  if (label.length < 3 || !new RegExp('(^|[^a-z0-9])' + label + '([^a-z0-9]|$)').test(t)) return false;
  var part = String(path || '').split('/')[1] || '';
  return !part || (/^[a-z0-9-]{3,}$/.test(part) && new RegExp('(^|[^a-z0-9])' + part + '([^a-z0-9]|$)').test(t));
}

/** The first entry of `list` that matches, or ''. */
function actListHit(list, seg, withTitle) {
  for (var i = 0; i < (list || []).length; i++) {
    if (actEntryHits(list[i], seg, withTitle)) return list[i];
  }
  return '';
}

/**
 * The keyword rules, longest first: his and learned ones ({keyword, project}),
 * then each project's own name squashed ("ProBeing" -> "probeing"). The first
 * rule for a keyword wins.
 */
function actRules(cfg) {
  var seen = {};
  var out = [];
  function add(key, project) {
    var k = actNorm(key);
    var p = actCut(String(project == null ? '' : project).trim(), ACT_PROJECT_MAX);
    if (k.length < ACT_KEY_MIN || k.length > ACT_KEY_MAX || !p || seen['k' + k]) return;
    seen['k' + k] = 1;
    out.push({ key: k, project: p });
  }
  ((cfg && cfg.rules) || []).forEach(function (r) { if (r) add(r.keyword, r.project); });
  ((cfg && cfg.projects) || []).forEach(function (p) { add(p, p); });
  return out.map(function (r, i) { return { key: r.key, project: r.project, i: i }; })
    .sort(function (a, b) { return (b.key.length - a.key.length) || (a.i - b.i); })
    .map(function (r) { return { key: r.key, project: r.project }; });
}

/** The longest rule whose keyword is in the title, the app or the site. */
function actRuleHit(seg, rules) {
  var hay = [actNorm(seg.title), actNorm(seg.app), actNorm(seg.host)];
  for (var i = 0; i < (rules || []).length; i++) {
    var k = rules[i].key;
    if (hay[0].indexOf(k) !== -1 || hay[1].indexOf(k) !== -1 || hay[2].indexOf(k) !== -1) {
      return { project: rules[i].project, key: k };
    }
  }
  return null;
}

/**
 * {category, project, key} for one piece. Private first (never sent), then
 * distraction, then meeting (which may still name a project), then the rules.
 * cfg: {lists, rules, projects, known: {titleKey: project}} (known: Gemini's
 * earlier answers, kept on the laptop).
 */
function actClassify(seg, cfg) {
  var lists = actLists(cfg && cfg.lists);
  if (seg.incognito === true || ACT_PRIVATE_TITLE.test(String(seg.title || '')) || actListHit(lists['private'], seg, true)) {
    return { category: 'private', project: '', key: '' };
  }
  if (actListHit(lists.distract, seg, false)) return { category: 'distraction', project: '', key: '' };
  var hit = actRuleHit(seg, actRules(cfg));
  if (actListHit(lists.meeting, seg, false)) {
    return { category: 'meeting', project: hit ? hit.project : '', key: hit ? hit.key : '' };
  }
  if (hit) return { category: 'work', project: hit.project, key: hit.key };
  var known = cfg && cfg.known ? cfg.known[actTitleKey(seg.app, seg.title)] : '';
  if (known) return { category: 'work', project: actCut(String(known), ACT_PROJECT_MAX), key: '' };
  return { category: 'unclear', project: '', key: '' };
}

/** Which unclear title a block is, for Gemini's answer to come back to. */
function actTitleKey(app, title) {
  return actNorm(String(app || '').replace(/\.exe$/i, '')) + '|' + actNorm(actScrubTitle(title));
}

/* ── Spans: sorted [start, end] pairs in ms ─────────────────────────────── */

function actMergeSpans(list) {
  var s = (list || []).filter(function (x) { return x && x[1] > x[0]; })
    .map(function (x) { return [x[0], x[1]]; }).sort(function (a, b) { return a[0] - b[0]; });
  var out = [];
  s.forEach(function (x) {
    var last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push(x);
  });
  return out;
}

/** Each [a, b] of `list` cut to `spans`, in pieces. */
function actIntersect(a, b, spans) {
  var out = [];
  (spans || []).forEach(function (s) {
    var x = Math.max(a, s[0]);
    var y = Math.min(b, s[1]);
    if (y > x) out.push([x, y]);
  });
  return out;
}

function actSpansMs(spans) {
  return (spans || []).reduce(function (n, s) { return n + Math.max(0, s[1] - s[0]); }, 0);
}

/** An ActivityWatch event's [start, end] in ms, or null. */
function actEventSpan(e) {
  var a = Date.parse(String(e && e.timestamp));
  var d = Number(e && e.duration) * 1000;
  return isFinite(a) && d > 0 ? [a, a + d] : null;
}

/**
 * The laptop's pieces of time: window events cut to the minutes he was at the
 * keyboard (afk 'not-afk'), inside `cut.from`..`cut.to` and the server's working
 * spans; a browser's split by the tab it showed.
 * events: {window, afk, web} as ActivityWatch returns them.
 * Returns [{start, end, app, title, host, path, incognito}] in time order.
 */
function actSegments(events, cut) {
  events = events || {};
  var active = actMergeSpans((events.afk || []).filter(function (e) {
    return e && e.data && e.data.status === 'not-afk';
  }).map(actEventSpan));
  var allowed = [];
  actMergeSpans(cut.spans || []).forEach(function (s) {
    actIntersect(Math.max(s[0], cut.from), Math.min(s[1], cut.to), active).forEach(function (p) { allowed.push(p); });
  });
  allowed = actMergeSpans(allowed);
  var web = (events.web || []).map(function (e) {
    var sp = actEventSpan(e);
    if (!sp) return null;
    var u = actUrlParts(e.data && e.data.url);
    return { a: sp[0], b: sp[1], host: u.host, path: u.path, incognito: Boolean(e.data && e.data.incognito) };
  }).filter(Boolean).sort(function (x, y) { return x.a - y.a; });

  var out = [];
  (events.window || []).forEach(function (e) {
    var sp = actEventSpan(e);
    if (!sp) return;
    var app = actCleanApp(e.data && e.data.app);
    var title = String((e.data && e.data.title) || '');
    var browser = actIsBrowser(app);
    actIntersect(sp[0], sp[1], allowed).forEach(function (p) {
      function piece(a, b, w) {
        if (b > a) out.push({ start: a, end: b, app: app, title: title, host: w ? w.host : '',
                              path: w ? w.path : '', incognito: Boolean(w && w.incognito) });
      }
      if (!browser) { piece(p[0], p[1], null); return; }
      var at = p[0];
      web.forEach(function (w) {
        if (w.b <= p[0] || w.a >= p[1]) return;
        var x = Math.max(p[0], w.a);
        var y = Math.min(p[1], w.b);
        if (x > at) piece(at, x, null);
        piece(Math.max(x, at), y, w);
        if (y > at) at = y;
      });
      piece(at, p[1], null);
    });
  });
  return out.sort(function (x, y) { return x.start - y.start; });
}

/** What makes two pieces the same block. Private ones keep only the app. */
function actIdentity(b) {
  if (b.category === 'private') return 'private|' + b.app;
  return [b.category, b.project, b.app, b.domain, b.category === 'unclear' ? actNorm(b.title) : ''].join('|');
}

/** Neighbours with the same identity and a gap of ACT_JOIN_GAP_MS or less become one. */
function actJoin(list) {
  var out = [];
  list.forEach(function (b) {
    var last = out[out.length - 1];
    if (last && last.id === b.id && b.start - last.end <= ACT_JOIN_GAP_MS) {
      last.end = Math.max(last.end, b.end);
    } else {
      out.push(Object.assign({}, b));
    }
  });
  return out;
}

/**
 * Pieces -> blocks of at least a minute. A shorter one folds into the block
 * before it (or the one after, when nothing is before it); with no neighbour
 * within a minute it is dropped. An unclear block keeps its scrubbed title,
 * which stays on the laptop (actPayload leaves it out).
 */
function actBlocks(pieces, cfg) {
  var list = (pieces || []).map(function (p) {
    var c = actClassify(p, cfg);
    var b = { start: p.start, end: p.end, app: actCleanApp(p.app), domain: c.category === 'private' ? '' : (p.host || ''),
              category: c.category, project: c.project, key: c.key,
              title: c.category === 'unclear' && actTitleSendable(p.app, p.title) && !(actIsBrowser(p.app) && !p.host)
                     ? actScrubTitle(p.title) : '' };     // a browser window the extension did not see: never sent
    b.id = actIdentity(b);
    return b;
  }).sort(function (x, y) { return x.start - y.start; });
  list = actJoin(list);
  var kept = [];
  for (var i = 0; i < list.length; i++) {
    var b = list[i];
    if (b.end - b.start >= ACT_MIN_BLOCK_MS) { kept.push(b); continue; }
    var prev = kept[kept.length - 1];
    var next = list[i + 1];
    if (prev && b.start - prev.end <= ACT_JOIN_GAP_MS) prev.end = Math.max(prev.end, b.end);
    else if (next && next.start - b.end <= ACT_JOIN_GAP_MS) next.start = Math.min(next.start, b.start);
  }
  return actJoin(kept).filter(function (b) { return b.end - b.start >= ACT_MIN_BLOCK_MS; });
}

/** What the laptop sends: no title, ever. */
function actPayload(blocks) {
  return (blocks || []).map(function (b) {
    return { start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), app: b.app,
             domain: b.domain, category: b.category, project: b.project, key: b.key };
  });
}

/**
 * One block as the server takes it, or null. Only these seven fields are read;
 * a title or URL sent by mistake goes nowhere. Private words are checked again
 * here against the app and the site.
 */
function actSanitize(b, lists, now) {
  if (!b || typeof b !== 'object') return null;
  var a = Date.parse(String(b.start));
  var z = Date.parse(String(b.end));
  if (!isFinite(a) || !isFinite(z) || z <= a || z - a > ACT_BLOCK_MAX_MS) return null;
  if (typeof now === 'number' && (z > now + 5 * 60000 || a < now - 48 * 3600000)) return null;
  var category = String(b.category || '');
  if (ACT_CATEGORIES.indexOf(category) === -1) return null;
  var out = { start: a, end: z, app: actCleanApp(b.app), domain: actCleanDomain(b.domain), category: category,
              project: actCut(String(b.project == null ? '' : b.project).trim(), ACT_PROJECT_MAX),
              key: actNorm(b.key).slice(0, ACT_KEY_MAX) };
  if (actListHit(actLists(lists)['private'], { app: out.app, host: out.domain, title: '' }, false)) out.category = 'private';
  if (out.category === 'private') { out.domain = ''; out.project = ''; out.key = ''; }
  if (out.category === 'distraction' || out.category === 'unclear') { out.project = ''; out.key = ''; }
  return out;
}

/* ── When he was working, from the event rows ──────────────────────────────
 * The same clock as day.js replayDay: work/voice/resume start it, a break stops
 * it unless the day is closed, off/sleep close the day, and an open clock stops
 * ACT_IDLE_MAX_MS after the last tended row. A break whose rid starts 'ab-' is
 * the watcher's own (auto) break: watched, so going back to work can end it. */

var ACT_IDLE_MAX_MS = 12 * 3600000;
var ACT_TENDED = ['work', 'voice', 'done', 'break', 'resume', 'awake', 'subdone', 'subdrop', 'substop', 'pin', 'unpin'];
var ACT_AUTO_RID = /^ab-/;

/* Rows written later for an earlier instant: the watcher's (ab-/ar-/aw-) and the sheet's or
 * a question's (kb-/kr-/qb-/qr-). On a tie with his own row they go first, so his row decides. */
var ACT_BACKDATED = /^(ab|ar|aw|kb|kr|qb|qr)-/;

/** Order of two rows at the same instant: backdated ones first, those by rid; else 0. */
function actTie(x, y) {
  var bx = ACT_BACKDATED.test(String((x && x.rid) || ''));
  var by = ACT_BACKDATED.test(String((y && y.rid) || ''));
  if (bx !== by) return bx ? -1 : 1;
  if (bx) return String(x.rid) < String(y.rid) ? -1 : String(x.rid) > String(y.rid) ? 1 : 0;
  return 0;
}

var ACT_STATE = { work: 1, voice: 1, resume: 1, 'break': 1, off: 1, sleep: 1 };

/** Backdated rows to write (steps {type, at}), less any at an instant where one of his own
 *  state rows already is: his row decides that instant. */
function actSkipTies(steps, rows) {
  var mine = {};
  (rows || []).forEach(function (r) {
    if (r && ACT_STATE[r.type] && !ACT_BACKDATED.test(String(r.rid || ''))) mine['t' + Date.parse(String(r.at))] = 1;
  });
  return (steps || []).filter(function (w) {
    var t = typeof w.at === 'number' ? w.at : Date.parse(String(w.at));
    return !(ACT_STATE[w.type] && mine['t' + t]);
  });
}
var ACT_AUTO_WATCH_MS = 4 * 3600000;     // an auto break is watched this long at most

/**
 * rows: event rows (any types, oldest first; ties keep their order). Returns
 * {work: spans, watch: spans (work plus open auto breaks), working, autoBreak:
 * {at, rid} or null, closed}, spans cut to [fromMs, toMs].
 */
function actWalk(rows, fromMs, toMs) {
  var list = (rows || []).map(function (r, i) { return { r: r, t: Date.parse(String(r && r.at)), i: i }; })
    .filter(function (x) { return isFinite(x.t); })
    .sort(function (a, b) { return (a.t - b.t) || actTie(a.r, b.r) || (a.i - b.i); });
  var clock = false;
  var closed = false;
  var auto = null;
  var tended = 0;
  var prev = -Infinity;
  var work = [];
  var watch = [];
  function emit(a, b) {
    if (b > toMs) b = toMs;
    if (a < fromMs) a = fromMs;
    if (clock) {
      var end = tended ? Math.min(b, tended + ACT_IDLE_MAX_MS) : b;
      if (end > a) { work.push([a, end]); watch.push([a, end]); }
    } else if (auto) {
      var stop = Math.min(b, auto.t + ACT_AUTO_WATCH_MS);
      if (stop > a) watch.push([a, stop]);
    }
  }
  list.forEach(function (x) {
    if (prev > -Infinity) emit(prev, x.t);
    prev = x.t;
    var type = x.r.type;
    if (type === 'work' || type === 'voice' || type === 'resume') {
      clock = true; closed = false; auto = null;
    } else if (type === 'break') {
      if (!closed) {
        clock = false;
        auto = ACT_AUTO_RID.test(String(x.r.rid || '')) ? { t: x.t, rid: String(x.r.rid) } : null;
      }
    } else if (type === 'off' || type === 'sleep') {
      clock = false; closed = true; auto = null;
    }
    if (ACT_TENDED.indexOf(type) !== -1 && x.t > tended) tended = x.t;
  });
  if (prev > -Infinity) emit(prev, toMs);
  var idle = tended && toMs >= tended + ACT_IDLE_MAX_MS;
  return { work: actMergeSpans(work), watch: actMergeSpans(watch), working: clock && !idle,
           autoBreak: auto && !clock ? { at: auto.t, rid: auto.rid } : null, closed: closed };
}

/** Blocks cut to `spans`; a block in two spans becomes two pieces. */
function actClip(blocks, spans) {
  var out = [];
  (blocks || []).forEach(function (b) {
    actIntersect(b.start, b.end, spans).forEach(function (p) {
      out.push(Object.assign({}, b, { start: p[0], end: p[1] }));
    });
  });
  return out;
}

/* ── Corrections and figures ───────────────────────────────────────────────
 * A correction is an events row of type 'actfix': detail = the block ids, comma
 * separated; project = the project now ('' = none). The newest one per block wins. */

var ACT_FIX_TYPE = 'actfix';
var ACT_SEEN_TYPE = 'actseen';
var ACT_ANSWER_TYPE = 'actanswer';

/** block id -> {project}, from actfix rows. */
function actFixMap(rows) {
  var best = {};
  (rows || []).forEach(function (r, i) {
    if (!r || r.type !== ACT_FIX_TYPE) return;
    var t = Date.parse(String(r.at));
    String(r.detail || '').split(',').forEach(function (id) {
      id = id.trim();
      if (!id) return;
      var have = best['b' + id];
      if (!have || t > have.t || (t === have.t && i > have.i)) {
        best['b' + id] = { t: t, i: i, project: String(r.project || '').trim() };
      }
    });
  });
  var out = Object.create(null);
  Object.keys(best).forEach(function (k) { out[k.slice(1)] = { project: best[k].project }; });
  return out;
}

/** A block as corrected: an unclear block given a project is work; a project taken away leaves it unclear. */
function actFixed(b, fixes) {
  var f = fixes && b.id ? fixes[b.id] : null;
  if (!f) return b;
  if (b.category === 'private' || b.category === 'distraction') return b;
  var cat = b.category;
  if (f.project && cat === 'unclear') cat = 'work';
  if (!f.project && cat === 'work') cat = 'unclear';
  return Object.assign({}, b, { project: f.project, category: cat });
}

/**
 * The period's figures. blocks: {id, start, end, category, project} (ms);
 * fixes: actFixMap(); work: the working spans. Time in a project, meetings and
 * unclear counts only while working; distraction counts whenever it was
 * watched (an auto break turns it into break time, and it is still distraction).
 */
function actFigures(blocks, fixes, work) {
  var out = { byProject: {}, workMs: 0, meetingMs: 0, unclearMs: 0, distractMs: 0, privateMs: 0, blocks: 0 };
  (blocks || []).forEach(function (raw) {
    var b = actFixed(raw, fixes);
    if (!(b.end > b.start)) return;
    out.blocks += 1;
    if (b.category === 'distraction') { out.distractMs += b.end - b.start; return; }
    var ms = actSpansMs(actIntersect(b.start, b.end, work));
    if (!(ms > 0)) return;
    if (b.category === 'private') { out.privateMs += ms; return; }
    if (b.category === 'meeting') out.meetingMs += ms;
    else if (b.category === 'unclear') out.unclearMs += ms;
    else out.workMs += ms;
    if (b.project) out.byProject['p' + b.project] = (out.byProject['p' + b.project] || 0) + ms;
  });
  var named = Object.create(null);           // keys are his project names: see day.js userMap()
  Object.keys(out.byProject).sort(function (a, b) { return out.byProject[b] - out.byProject[a]; })
    .forEach(function (k) { named[k.slice(1)] = out.byProject[k]; });
  out.byProject = named;
  return out;
}

var ACT_GROUP_GAP_MS = 5 * 60000;

/**
 * The catch-up list: neighbouring blocks with the same (corrected) category and
 * project, any device, as {start, end, ms, category, project, apps, domains, ids}.
 */
function actGroups(blocks, fixes) {
  var out = [];
  (blocks || []).slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (raw) {
    var b = actFixed(raw, fixes);
    var last = out[out.length - 1];
    if (last && last.category === b.category && last.project === (b.project || '') &&
        b.start - last.end <= ACT_GROUP_GAP_MS) {
      last.end = Math.max(last.end, b.end);
      last.ms += b.end - b.start;
    } else {
      last = { start: b.start, end: b.end, ms: b.end - b.start, category: b.category, project: b.project || '',
               apps: [], domains: [], ids: [] };
      out.push(last);
    }
    if (b.app && last.apps.indexOf(b.app) === -1) last.apps.push(b.app);
    if (b.domain && last.domains.indexOf(b.domain) === -1) last.domains.push(b.domain);
    if (b.id) last.ids.push(b.id);
  });
  return out;
}

// What the Edge Function uses. The browser reads the globals directly.
globalThis.ProBeingActivity = {
  ACT_CATEGORIES: ACT_CATEGORIES,
  ACT_DEFAULT_LISTS: ACT_DEFAULT_LISTS,
  ACT_KEY_MIN: ACT_KEY_MIN,
  ACT_KEY_MAX: ACT_KEY_MAX,
  ACT_PROJECT_MAX: ACT_PROJECT_MAX,
  ACT_FIX_TYPE: ACT_FIX_TYPE,
  ACT_ANSWER_TYPE: ACT_ANSWER_TYPE,
  actNorm: actNorm,
  actCut: actCut,
  actCleanApp: actCleanApp,
  actCleanDomain: actCleanDomain,
  actUrlParts: actUrlParts,
  actScrubTitle: actScrubTitle,
  actTitleSendable: actTitleSendable,
  actIsBrowser: actIsBrowser,
  ACT_PRIVATE_TITLE: ACT_PRIVATE_TITLE,
  actTie: actTie,
  actSkipTies: actSkipTies,
  actLists: actLists,
  actTidyList: actTidyList,
  actListHit: actListHit,
  actRules: actRules,
  actClassify: actClassify,
  actTitleKey: actTitleKey,
  actMergeSpans: actMergeSpans,
  actIntersect: actIntersect,
  actSpansMs: actSpansMs,
  actSegments: actSegments,
  actBlocks: actBlocks,
  actPayload: actPayload,
  actSanitize: actSanitize,
  actWalk: actWalk,
  actClip: actClip,
  actFixMap: actFixMap,
  actFixed: actFixed,
  actFigures: actFigures,
  actGroups: actGroups
};
