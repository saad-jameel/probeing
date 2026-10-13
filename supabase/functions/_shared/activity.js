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
 * Item 23 (11 Oct): asleep or on a break, a block is only its time, category and
 * project (actQuiet); no app, site or title. Item 28 (12 Oct): the same while awake
 * with the day not started or ended. Item 29 (12 Oct): a work list (no project needed),
 * and the names Teach asks about (actTeachName / actTeachList).
 * Item 30a (13 Oct): browsers are neutral (the site decides), ProBeing's own page is not
 * activity, helpers (terminals, Notepad, Explorer, localhost...) are work that takes its
 * project from the work around it, and a Start answer writes the distractions as breaks.
 */

'use strict';

var ACT_CATEGORIES = ['work', 'meeting', 'distraction', 'unclear', 'private'];

/* The lists Settings can change. A word matches an app or a site name; an entry
 * with a dot is a site (and its sub-domains), and a path after it must start the
 * page's path. Private words also match the window title. A work word must be the
 * app's whole name (actWorkHit), so "code" is Code.exe and never Barcode. */
var ACT_DEFAULT_LISTS = {
  distract: ['youtube.com/shorts', 'x.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'facebook.com'],
  private: ['bank', 'password', 'bitwarden', '1password', 'lastpass', 'keepass', 'whatsapp', 'messenger',
            'signal', 'telegram'],
  meeting: ['meet.google.com', 'zoom.us', 'zoom', 'teams.microsoft.com', 'teams', 'discord'],
  work: ['code', 'claude', 'idea64', 'pycharm64', 'webstorm64', 'phpstorm64', 'clion64', 'rider64', 'goland64',
         'rubymine64', 'datagrip64', 'rustrover64', 'winword', 'excel', 'powerpnt', 'outlook', 'olk'],
  // Item 30a: used for every project, so never asked about; work, with the project of the work around it.
  helpers: ['windowsterminal', 'wt', 'cmd', 'powershell', 'pwsh', 'wsl', 'conhost', 'notepad', 'notepad++', 'explorer',
           'photos', 'systemsettings', 'localhost', '127.0.0.1']
};
var ACT_LIST_KEYS = ['distract', 'private', 'meeting', 'work', 'helpers'];

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

/* Item 30a: ProBeing's own page is neither work nor a distraction: dropped like the lock screen.
 * Its installed window has no site, only its own title, exactly ("ProBeing", maybe a browser's suffix). */
var ACT_NEUTRAL_SITES = ['saad-jameel.github.io/probeing'];
var ACT_NEUTRAL_TITLE = /^ProBeing( - ((Personal|Work|Profile [0-9]+) - )?(Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Opera|Vivaldi))?$/;

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

/* Windows' own screens (item 29 fix). Away: the lock and sign-in screens; time there is not
 * activity, so it is dropped as AFK is. Never asked about: shell parts that host other things
 * (Search, Start, the frame round Settings and Photos), where one answer would file them all. */
var ACT_AWAY_APPS = ['lockapp', 'logonui'];
var ACT_SHELL_APPS = ['lockapp', 'logonui', 'searchhost', 'searchapp', 'searchui', 'shellexperiencehost', 'shellhost',
                      'startmenuexperiencehost', 'textinputhost', 'applicationframehost', 'explorer'];

/** An app as one squashed word without ".exe": "LockApp.exe" -> "lockapp". */
function actAppWord(app) {
  return actNorm(String(app == null ? '' : app).replace(/\.exe$/i, ''));
}

function actIsAway(app) {
  return ACT_AWAY_APPS.indexOf(actAppWord(app)) !== -1;
}

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

/** The app's name as the lists and rules see it: a browser's is nothing, its site decides (item 30a). */
function actAppName(app) {
  return actIsBrowser(app) ? '' : String(app == null ? '' : app);
}

/** ProBeing's own page or window: not activity (item 30a). seg: {app, host, path, title}. */
function actIsNeutral(seg) {
  var h = String(seg.host || '');
  if (!h) return actIsBrowser(seg.app) && ACT_NEUTRAL_TITLE.test(String(seg.title || '').trim());
  var path = String(seg.path || '');
  for (var i = 0; i < ACT_NEUTRAL_SITES.length; i++) {
    var site = ACT_NEUTRAL_SITES[i];
    var slash = site.indexOf('/');
    // The app's own path, or below it: never /probeing-notes.
    if (h === site.slice(0, slash) && (path === site.slice(slash) || path.indexOf(site.slice(slash) + '/') === 0)) return true;
  }
  return false;
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

/** The four lists; a list never set is the default, an empty one stays empty. */
function actLists(l) {
  l = l && typeof l === 'object' ? l : {};
  var out = {};
  ACT_LIST_KEYS.forEach(function (k) {
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
  return actNorm(actAppName(seg.app)).indexOf(w) !== -1 || actNorm(seg.host).indexOf(w) !== -1 ||
         (withTitle === true && actNorm(seg.title).indexOf(w) !== -1);
}

/** Does a title name a site: its first label as a word ("YouTube" for youtube.com), and its
 *  path's first part too when the entry has one ("Shorts")? Labels under 3 letters never match. */
function actTitleNamesSite(host, path, title) {
  var t = String(title == null ? '' : title).toLowerCase();
  var label = String(host).split('.')[0];
  // His entry is text, not a pattern: "(abc.com" must not throw.
  var lit = label.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
  if (label.length < 3 || !new RegExp('(^|[^a-z0-9])' + lit + '([^a-z0-9]|$)').test(t)) return false;
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

/** A work-list name: lower case, letters, digits and '+', no ".exe" ("Notepad++.exe" -> "notepad++",
 *  so plain Notepad is not it). */
function actWorkName(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\.exe$/, '').replace(/[^0-9a-z\u0080-\uffff+]+/g, '');
}

/** The first work-list entry naming the piece, or ''. A site as in the other lists; a name
 *  ("code", or "Code.exe" as typed) only as the app's whole name. On the phone (seg.phone) the
 *  built-in names do not count: they are desktop apps (Saad, 12 Oct). */
function actWorkHit(list, seg) {
  var app = actWorkName(actAppName(seg.app));
  var builtIn = seg.phone === true ? ACT_DEFAULT_LISTS.work.map(actWorkName) : [];
  for (var i = 0; i < (list || []).length; i++) {
    var e = String(list[i] || '').trim().toLowerCase().replace(/\.exe$/, '');
    if (!e) continue;
    if (/[.\/]/.test(e) ? actEntryHits(e, seg, false) : actWorkName(e) === app && app !== '' && builtIn.indexOf(app) === -1) return list[i];
  }
  return '';
}

/** Item 30a: the first helper entry naming the piece, or ''. A site (localhost, 127.0.0.1) by its
 *  host; a name as the app's whole name. Never on the phone: helpers are laptop apps. */
function actHelperHit(list, seg) {
  if (seg.phone === true) return '';
  var app = actWorkName(actAppName(seg.app));
  var host = String(seg.host || '');
  for (var i = 0; i < (list || []).length; i++) {
    var e = String(list[i] == null ? '' : list[i]).trim().toLowerCase().replace(/\.exe$/, '');
    if (!e) continue;
    if (e.indexOf('.') !== -1 || e === 'localhost') {
      if (host && (host === e || host.slice(-(e.length + 1)) === '.' + e)) return list[i];
    } else if (app && actWorkName(e) === app) {
      return list[i];
    }
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
  var hay = [actNorm(seg.title), actNorm(actAppName(seg.app)), actNorm(seg.host)];
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
 * distraction, then meeting (which may still name a project), then the rules,
 * then a helper (work, its project found later from the work around it, item 30a),
 * then Gemini's earlier answer, then the work list (work, no project).
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
  if (actHelperHit(lists.helpers, seg)) return { category: 'work', project: '', key: '' };
  var known = cfg && cfg.known ? cfg.known[actTitleKey(seg.app, seg.title)] : '';
  if (known) return { category: 'work', project: actCut(String(known), ACT_PROJECT_MAX), key: '' };
  if (actWorkHit(lists.work, seg)) return { category: 'work', project: '', key: '' };
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
    if (actIsAway(app)) return;              // the lock screen: away, not activity
    var title = String((e.data && e.data.title) || '');
    var browser = actIsBrowser(app);
    actIntersect(sp[0], sp[1], allowed).forEach(function (p) {
      function piece(a, b, w) {
        var x = { start: a, end: b, app: app, title: title, host: w ? w.host : '',
                  path: w ? w.path : '', incognito: Boolean(w && w.incognito) };
        if (b > a && !actIsNeutral(x)) out.push(x);      // ProBeing itself: not activity (item 30a)
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
  if (actIsAway(out.app)) return null;     // the lock screen, from a watcher before item 29's fix
  // ProBeing's own site, from a watcher before item 30a. The server sees no path; that host serves only ProBeing.
  if (out.domain && actIsNeutral({ app: '', host: out.domain, path: '/probeing', title: '' })) return null;
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

/* Rows written later for an earlier instant: the watcher's (ab-/ar-/aw-), the sheet's or
 * a question's (kb-/kr-/qb-/qr-), an awake or back-to-work answer's (nw-/nr-, item 23),
 * a Start answer's (ns-, item 28) and the distractions it writes as breaks (nd-/ne-, item 30a).
 * On a tie with his own row they go first, so his row decides. */
var ACT_BACKDATED = /^(ab|ar|aw|kb|kr|qb|qr|nw|nr|ns|nd|ne)-/;

/** Order of two rows at the same instant: backdated ones first, those by rid; else 0. */
function actTie(x, y) {
  var bx = ACT_BACKDATED.test(String((x && x.rid) || ''));
  var by = ACT_BACKDATED.test(String((y && y.rid) || ''));
  if (bx !== by) return bx ? -1 : 1;
  if (bx) return String(x.rid) < String(y.rid) ? -1 : String(x.rid) > String(y.rid) ? 1 : 0;
  return 0;
}

var ACT_STATE = { work: 1, voice: 1, resume: 1, 'break': 1, off: 1, sleep: 1, wake: 1 };

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
 * Item 23 adds the quiet spans, watched for time and category only: sleep (a
 * sleep row until a wake) and rest (a break of his, not the day's end, while
 * awake), plus asleep {at, rid}, onBreak {at, since, rid} (since: the break row
 * or the wake after a nap, whichever is later) and sleeps [{at, end, rid}].
 * Item 26: a sleep or break has no age limit; a forgotten Wake is what the checks are for.
 * Item 28: awakeOff spans (awake, the work side off: not started after a wake, or after
 * End day) and offSince {at, rid}, the state row that began the current one.
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
  var ws = 'off';                         // the work side as the app's toggle has it: on, break, off
  var brk = null;                         // the break row that opened the current break
  var since = 0;                          // when the current break became one he is awake for
  var asleep = null;
  var sleepList = [];
  var sleep = [];
  var rest = [];
  var awakeOff = [];
  var off = null;                         // awake with the work side off since this row (item 28)
  var known = false;                      // a state row has been read: before it the work side is a guess
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
    if (asleep) {
      if (b > a) sleep.push([a, b]);
    } else if (!clock && ws === 'break' && brk) {
      var r0 = auto ? Math.max(a, auto.t + ACT_AUTO_WATCH_MS) : a;
      if (b > r0) rest.push([r0, b]);
    } else if (!clock && ws === 'off' && known) {
      if (b > a) awakeOff.push([a, b]);
    }
  }
  list.forEach(function (x) {
    if (prev > -Infinity) emit(prev, x.t);
    prev = x.t;
    var type = x.r.type;
    var rid = String(x.r.rid || '');
    if (type === 'work' || type === 'voice' || type === 'resume') {
      clock = true; closed = false; auto = null;
      ws = 'on'; brk = null;
      if (asleep) { asleep.end = x.t; asleep = null; }
    } else if (type === 'break') {
      if (!closed) {
        clock = false;
        auto = ACT_AUTO_RID.test(rid) ? { t: x.t, rid: rid } : null;
      }
      if (ws !== 'off') { ws = 'break'; brk = { t: x.t, rid: rid }; since = x.t; }
    } else if (type === 'off' || type === 'sleep') {
      clock = false; closed = true; auto = null;
      if (type === 'off') { ws = 'off'; brk = null; }
      if (type === 'sleep') {
        if (ws === 'on') { ws = 'off'; brk = null; }
        if (!asleep) { asleep = { t: x.t, rid: rid, end: null }; sleepList.push(asleep); }
      }
    } else if (type === 'wake') {
      if (asleep) { asleep.end = x.t; asleep = null; since = x.t; }
    }
    if (ACT_TENDED.indexOf(type) !== -1 && x.t > tended) tended = x.t;
    if (ACT_STATE[type]) known = true;
    if (known && !asleep && !clock && ws === 'off') { if (!off) off = { t: x.t, rid: rid }; } else off = null;
  });
  if (prev > -Infinity) emit(prev, toMs);
  var idle = tended && toMs >= tended + ACT_IDLE_MAX_MS;
  var autoBreak = auto && !clock ? { at: auto.t, rid: auto.rid } : null;
  // The watcher's own break is its business for its first hours (18b); after that it is a break like any.
  var autoOn = autoBreak && toMs < autoBreak.at + ACT_AUTO_WATCH_MS;
  var onBreak = !clock && !asleep && !autoOn && ws === 'break' && brk
    ? { at: brk.t, since: Math.max(brk.t, since, autoBreak ? autoBreak.at + ACT_AUTO_WATCH_MS : 0), rid: brk.rid } : null;
  return { work: actMergeSpans(work), watch: actMergeSpans(watch), working: clock && !idle,
           autoBreak: autoBreak, closed: closed,
           sleep: actMergeSpans(sleep), rest: actMergeSpans(rest),
           asleep: asleep ? { at: asleep.t, rid: asleep.rid } : null,
           onBreak: onBreak,
           awakeOff: actMergeSpans(awakeOff),
           offSince: off ? { at: off.t, rid: off.rid } : null,
           sleeps: sleepList.filter(function (s) { return (s.end === null || s.end > fromMs) && s.t < toMs; })
             .map(function (s) { return { at: s.t, end: s.end, rid: s.rid }; }) };
}

/* A row of his of these types after the use a watch question is about ends the question. */
var ACT_ASK_ENDS = ['work', 'voice', 'resume', 'break', 'off', 'sleep', 'wake'];

/**
 * Is a watch question ("awake?", "back to work?", "Up and working?", "start?") still about the
 * state he is in? Not once any state row of his came after the use (its own answer rows aside),
 * nor once the sleep, break or day-off stretch it asked about has ended. activity-ingest and the
 * app's catch-up sheet both judge with this, so they cannot disagree.
 * n: {id, kind, streak_start, ref_at} (ms); walk: actWalk; rows: [{at (ms), type, rid}].
 */
function actAskOpen(n, walk, rows) {
  var own = ['nw-', 'nr-', 'ns-', 'na-'].map(function (x) { return x + n.id; });
  var pairs = new RegExp('^n[de]-' + String(n.id).replace(/[^0-9a-zA-Z-]/g, '') + '-[0-9a-z]+$');   // item 30a's breaks
  var moved = (rows || []).some(function (r) {
    var rid = String(r.rid || '');
    return r.at > n.streak_start && ACT_ASK_ENDS.indexOf(r.type) !== -1 && own.indexOf(rid) === -1 && !pairs.test(rid);
  });
  if (moved) return false;
  if (n.kind === 'awake' || n.kind === 'upwork') return Boolean(walk && walk.asleep && walk.asleep.at === n.ref_at);
  if (n.kind === 'resume') return Boolean(walk && walk.onBreak && walk.onBreak.at === n.ref_at);
  if (n.kind === 'start') return Boolean(walk && walk.offSince && walk.offSince.at === n.ref_at);
  return false;
}

/**
 * Blocks with the parts inside `quiet` (sleep or a break) made bare: no app,
 * site, keyword or title, and only work and meetings keep a project. Bare
 * neighbours alike join. watch.ps1 Act-Quiet and PhoneRules.quiet are copies.
 */
function actQuiet(blocks, quiet) {
  var q = actMergeSpans(quiet || []);
  var out = [];
  (blocks || []).forEach(function (b) {
    var at = b.start;
    function keep(a, z, bare) {
      if (!(z > a)) return;
      var x = Object.assign({}, b, { start: a, end: z });
      if (bare) {
        x.app = ''; x.domain = ''; x.key = ''; x.title = '';
        if (x.category !== 'work' && x.category !== 'meeting') x.project = '';
        x.id = 'quiet|' + x.category + '|' + x.project;
      }
      out.push(x);
    }
    actIntersect(b.start, b.end, q).forEach(function (p) {
      keep(at, p[0], false);
      keep(p[0], p[1], true);
      at = p[1];
    });
    keep(at, b.end, false);
  });
  return actJoin(out);
}

/**
 * Runs of use on one device: blocks (any category) whose gaps are at most
 * `gapMs`, as {start, end, ms (time in use), device}. `blocks` must be one
 * device's; they are sorted here.
 */
function actUseRuns(blocks, gapMs) {
  var out = [];
  (blocks || []).filter(function (b) { return b && b.end > b.start; }).slice()
    .sort(function (a, b) { return a.start - b.start; }).forEach(function (b) {
      var last = out[out.length - 1];
      if (last && b.start - last.end <= gapMs) {
        last.ms += Math.max(0, b.end - Math.max(b.start, last.end));
        last.end = Math.max(last.end, b.end);
      } else {
        out.push({ start: b.start, end: b.end, ms: b.end - b.start, device: b.device_id || '' });
      }
    });
  return out;
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
 * fixes: actFixMap(); work: the working spans. workMs includes meetings. Time in a project, meetings and
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
    // A meeting is work time (item 30a: Discord is a work meeting); meetingMs says how much of it.
    if (b.category === 'meeting') { out.meetingMs += ms; out.workMs += ms; }
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

/* ── Teach ProBeing (item 23; item 29 asks by itself) ────────────────────── */

/** What a block can be taught by: its site, else its app as a squashed word; null for a
 *  browser with no site, a terminal or file window, or a phone app with no name. */
function actTeachName(b) {
  if (b.domain) {
    var d = actCleanDomain(b.domain);
    return d ? { entry: d, label: d, site: true } : null;
  }
  var app = String(b.app || '').replace(/\.exe$/i, '').trim();
  var w = actNorm(app);
  if (w.length < 3 || w === 'otherapp' || actIsBrowser(b.app) || ACT_NO_TITLE_APPS.indexOf(w) !== -1) return null;
  if (ACT_SHELL_APPS.indexOf(w) !== -1) return null;
  return { entry: w, label: app, site: false };
}

/** Unplaced time by name, most first: [{entry, label, site, ms}]. blocks: unclear ones
 *  (start, end ms); cfg: {lists, rules, projects} as the watchers classify with; a name
 *  a rule or list now places, or one he ignored, is left out. */
function actTeachList(blocks, fixes, cfg, ignore) {
  var by = Object.create(null);
  var skip = Object.create(null);
  (ignore || []).forEach(function (e) { skip[String(e)] = 1; });
  (blocks || []).forEach(function (raw) {
    var b = actFixed(raw, fixes);
    if (b.category !== 'unclear' || (b.mode && b.mode !== 'work') || !(b.end > b.start)) return;
    var n = actTeachName(b);
    if (!n || skip[n.entry]) return;
    if (!by[n.entry]) {
      var placed = actClassify({ app: b.app, host: b.domain || '', path: '', title: '' }, cfg).category !== 'unclear';
      by[n.entry] = { entry: n.entry, label: n.label, site: n.site, ms: 0, placed: placed };
    }
    by[n.entry].ms += b.end - b.start;
  });
  return Object.keys(by).map(function (k) { return by[k]; }).filter(function (x) { return !x.placed; })
    .sort(function (a, b) { return (b.ms - a.ms) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0); })
    .map(function (x) { return { entry: x.entry, label: x.label, site: x.site, ms: x.ms }; });
}

/** Has he sorted this name since it was asked (a list, a rule, or Ignore)? n: {entry, what} as a
 *  teach question carries them; cfg: {lists, rules, projects}. The sheet and activity-ingest both ask. */
function actTeachSorted(n, cfg, ignore) {
  var entry = String((n && n.entry) || '');
  if (!entry || (ignore || []).indexOf(entry) !== -1) return true;
  return actClassify(actTeachSeg(n), cfg).category !== 'unclear';
}

/** A teach question's name as a piece to classify: a site has a dot, an app is its name as shown. */
function actTeachSeg(n) {
  var entry = String((n && n.entry) || '');
  return entry.indexOf('.') !== -1 ? { app: '', host: entry, path: '', title: '' }
    : { app: String((n && n.what) || entry), host: '', path: '', title: '' };
}

/* ── Item 30a: where a project comes from, work runs and focus ─────────────── */

/* A block's project, first source that has one: the virtual desktop (item 30b; not sent yet), a
 * title keyword, the app, then for a helper the nearest work within ACT_NEAR_MS. */
var ACT_PROJECT_SOURCES = ['desktop', 'title', 'app', 'near'];
var ACT_NEAR_MS = 10 * 60000;

/** src: {desktop, title, app, near} -> {project, from}; {project: '', from: ''} with none. */
function actPickProject(src) {
  for (var i = 0; i < ACT_PROJECT_SOURCES.length; i++) {
    var p = String((src && src[ACT_PROJECT_SOURCES[i]]) || '').trim();
    if (p) return { project: actCut(p, ACT_PROJECT_MAX), from: ACT_PROJECT_SOURCES[i] };
  }
  return { project: '', from: '' };
}

/* Distraction tiers while working (Saad, 13 Oct): under 2 min a glance (ignored), 2-5 a slip,
 * 5-15 a focus loss, 15 or more a break (the distraction push, unchanged). */
var ACT_GLANCE_MS = 2 * 60000;
var ACT_SLIP_MS = 5 * 60000;
var ACT_LOSS_MS = 15 * 60000;

/** 'glance', 'slip', 'loss' or 'break' for a distraction this long. */
function actTier(ms) {
  return ms < ACT_GLANCE_MS ? 'glance' : ms < ACT_SLIP_MS ? 'slip' : ms < ACT_LOSS_MS ? 'loss' : 'break';
}

/* Distractions named by a word, never more (Saad, 9 Oct): a well-known site, else "distraction". */
var ACT_DISTRACT_NAMES = { 'youtube.com': 'YouTube', 'x.com': 'X', 'twitter.com': 'X', 'instagram.com': 'Instagram',
                           'tiktok.com': 'TikTok', 'facebook.com': 'Facebook', 'reddit.com': 'Reddit',
                           'snapchat.com': 'Snapchat', 'linkedin.com': 'LinkedIn' };

/** The word for a distraction block: its site's name when well known, else 'distraction'. */
function actDistractWord(b) {
  var d = actCleanDomain(b && b.domain);
  while (d) {
    if (Object.prototype.hasOwnProperty.call(ACT_DISTRACT_NAMES, d)) return ACT_DISTRACT_NAMES[d];
    var dot = d.indexOf('.');
    d = dot === -1 ? '' : d.slice(dot + 1);
  }
  return 'distraction';
}

var ACT_RUN_GAP_MS = 15 * 60000;       // non-work this long is a break, whatever it held

/**
 * What a Start (or Resume) answer makes of the time since `from` (item 30a fix): every device's
 * blocks, cut to [from, now]. Between two stretches of work, 15 minutes or more of anything else
 * is a break; a shorter gap's distractions (2 minutes or more, joined across a minute) are.
 * Returns {gaps: [[start, end]], last: the end of the last work, or null with no work}.
 */
function actRunPlan(blocks, from, now) {
  var list = [];
  (blocks || []).forEach(function (b) {
    var a = Math.max(b.start, from);
    var z = Math.min(b.end, now);
    if (z > a) list.push({ start: a, end: z, category: b.category });
  });
  function isWork(b) { return b.category === 'work' || b.category === 'meeting'; }
  var workAll = actMergeSpans(list.filter(isWork).map(function (b) { return [b.start, b.end]; }));
  var work = workAll.filter(function (s) { return s[1] - s[0] >= 60000; });
  if (!work.length) return { gaps: [], last: null };
  var dist = actMergeSpans(list.filter(function (b) { return b.category === 'distraction'; }).map(function (b) { return [b.start, b.end]; }));
  var gaps = [];
  function distIn(a, z) {
    var pieces = [];
    actIntersect(a, z, dist).forEach(function (p) {
      var at = p[0];
      workAll.forEach(function (w) {
        if (w[1] <= at || w[0] >= p[1]) return;
        if (w[0] > at) pieces.push([at, w[0]]);
        at = Math.max(at, w[1]);
      });
      if (p[1] > at) pieces.push([at, p[1]]);
    });
    var joined = [];
    actMergeSpans(pieces).forEach(function (p) {
      var last = joined[joined.length - 1];
      if (last && p[0] - last[1] <= 60000) { last[1] = p[1]; last[2] += p[1] - p[0]; } else joined.push([p[0], p[1], p[1] - p[0]]);
    });
    joined.forEach(function (j) { if (j[2] >= ACT_GLANCE_MS) gaps.push([j[0], j[1]]); });
  }
  for (var i = 0; i < work.length; i++) {
    var end = work[i][1];
    var next = i + 1 < work.length ? work[i + 1][0] : now;
    if (i + 1 < work.length && next - end >= ACT_RUN_GAP_MS) gaps.push([end, next]);
    else distIn(end, next);
  }
  return { gaps: gaps, last: work[work.length - 1][1] };
}

/** ms from a number or an ISO string; NaN otherwise. */
function actMs(v) {
  return typeof v === 'number' ? v : v ? Date.parse(String(v)) : NaN;
}

/**
 * The rows an answer writes after its resume at `after` (item 30a): each gap of `plan`
 * (actRunPlan, or a bare [[start, end]] list) as a break and a resume; and when the last work
 * ended 15 minutes or more before `now`, a break there and a resume now (he says he is working
 * now). Rids carry the gap's start (seconds, base 36), so two answerers write the same rows once.
 */
function actRunSteps(id, plan, after, now) {
  var gaps = Array.isArray(plan) ? plan : (plan && Array.isArray(plan.gaps) ? plan.gaps : []);
  var last = Array.isArray(plan) || !plan ? NaN : actMs(plan.last);
  var tail = isFinite(last) && last > after && now - last >= ACT_RUN_GAP_MS;
  function key(t) { return Math.floor(t / 1000).toString(36); }
  var out = [];
  gaps.forEach(function (g) {
    var a = actMs(g[0]);
    var z = actMs(g[1]);
    if (!(a > after) || !(z > a) || !(z <= now) || (tail && a >= last)) return;
    out.push({ type: 'break', at: a, rid: 'nd-' + id + '-' + key(a), text: z - a >= ACT_RUN_GAP_MS ? 'Away' : 'Distraction' });
    out.push({ type: 'resume', at: z, rid: 'ne-' + id + '-' + key(a), text: 'Resume (after a distraction — answered the check)' });
  });
  if (tail) {
    out.push({ type: 'break', at: last, rid: 'nd-' + id + '-' + key(last), text: 'Away' });
    out.push({ type: 'resume', at: now, rid: 'ne-' + id + '-' + key(last), text: 'Resume (working now — answered the check)' });
  }
  return out.sort(function (x, y) { return x.at - y.at; });
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
  actWorkHit: actWorkHit,
  actWorkName: actWorkName,
  ACT_LIST_KEYS: ACT_LIST_KEYS,
  ACT_NO_TITLE_APPS: ACT_NO_TITLE_APPS,
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
  ACT_ASK_ENDS: ACT_ASK_ENDS,
  actAskOpen: actAskOpen,
  actQuiet: actQuiet,
  actUseRuns: actUseRuns,
  actClip: actClip,
  actFixMap: actFixMap,
  actFixed: actFixed,
  actFigures: actFigures,
  actGroups: actGroups,
  actTeachName: actTeachName,
  actTeachList: actTeachList,
  actTeachSorted: actTeachSorted,
  actTeachSeg: actTeachSeg,
  actIsAway: actIsAway,
  ACT_SHELL_APPS: ACT_SHELL_APPS,
  actAppName: actAppName,
  actIsNeutral: actIsNeutral,
  actHelperHit: actHelperHit,
  ACT_NEAR_MS: ACT_NEAR_MS,
  actPickProject: actPickProject,
  ACT_GLANCE_MS: ACT_GLANCE_MS,
  ACT_SLIP_MS: ACT_SLIP_MS,
  ACT_LOSS_MS: ACT_LOSS_MS,
  actTier: actTier,
  actDistractWord: actDistractWord,
  actRunSteps: actRunSteps,
  actRunPlan: actRunPlan,
  ACT_RUN_GAP_MS: ACT_RUN_GAP_MS
};
