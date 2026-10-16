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
 * Item 30b (13 Oct): the laptop's virtual desktop. A piece carries its desktop's NAME (the tray
 * samples it); a desktop named after a project (or mapped to one in Settings) is that block's
 * project, ahead of any keyword. A block is sent with `desktop` only when it has one.
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
var ACT_DESKTOP_MAX = 80;
var ACT_DESKTOPS_MAX = 30;               // "Desktop name = Project" pairs in Settings
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
  return [b.category, b.project, b.app, b.domain, b.desktop || '', b.category === 'unclear' ? actNorm(b.title) : ''].join('|');
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
    var c = actDeskClassify(p, cfg);
    var b = { start: p.start, end: p.end, app: actCleanApp(p.app), domain: c.category === 'private' ? '' : (p.host || ''),
              category: c.category, project: c.project, key: c.key,
              desktop: c.category === 'private' ? '' : actCleanDesktop(p.desktop),
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

/** What the laptop sends: no title, ever. `desktop` (item 30b) only when the block has one. */
function actPayload(blocks) {
  return (blocks || []).map(function (b) {
    var o = { start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), app: b.app,
              domain: b.domain, category: b.category, project: b.project, key: b.key };
    if (b.desktop) o.desktop = b.desktop;
    return o;
  });
}

/**
 * One block as the server takes it, or null. Only these seven fields (and item 30b's desktop) are read;
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
  var desk = out.category === 'private' ? '' : actCleanDesktop(b.desktop);
  if (desk) out.desktop = desk;            // item 30b: only when sent
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
 * a Start answer's (ns-, item 28), the distractions it writes as breaks (nd-/ne-, item 30a) and a
 * judged gap's break and resume (jb-/jr-, item 31a). On a tie with his own row they go first, so his row decides. */
var ACT_BACKDATED = /^(ab|ar|aw|kb|kr|qb|qr|nw|nr|ns|nd|ne|jb|jr)-/;

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
        x.app = ''; x.domain = ''; x.key = ''; x.title = ''; x.desktop = '';
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

/* A block's project, first source that has one: the virtual desktop (item 30b), a title keyword,
 * the app, then for a helper the nearest work within ACT_NEAR_MS. */
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

/* ── Item 30b: virtual desktops (laptop) ───────────────────────────────────
 * The tray samples the window in front's desktop every ~10 s into desktops.json:
 * [start, end, name] spans, names only. watch.ps1 Act-DesktopSplit is the twin. */

/** A desktop's name as kept: one line, no control characters, at most ACT_DESKTOP_MAX. */
function actCleanDesktop(s) {
  var t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/ {2,}/g, ' ').replace(/^ +| +$/g, '');
  return actCut(t, ACT_DESKTOP_MAX).replace(/ +$/, '');
}

/** His "Desktop name = Project" pairs, tidied: both named, one per desktop (by its squashed name). */
function actDeskPairs(list) {
  var out = [];
  var seen = Object.create(null);
  (Array.isArray(list) ? list : []).forEach(function (x) {
    if (!x || typeof x !== 'object' || out.length >= ACT_DESKTOPS_MAX) return;
    var d = actCleanDesktop(x.desktop);
    var p = actCut(String(x.project == null ? '' : x.project).trim(), ACT_PROJECT_MAX);
    var k = actNorm(d);
    if (!k || !p || seen[k]) return;
    seen[k] = 1;
    out.push({ desktop: d, project: p });
  });
  return out;
}

/** The project a desktop stands for: his pair for it, else a project of the same name
 *  (case, spaces and punctuation ignored: "BipedRobot_working" is "Biped Robot Working"); else ''.
 *  cfg: {desktops: pairs, projects: names}. */
function actDeskProject(name, cfg) {
  var k = actNorm(actCleanDesktop(name));
  if (!k) return '';
  var pairs = actDeskPairs(cfg && cfg.desktops);
  for (var i = 0; i < pairs.length; i++) if (actNorm(pairs[i].desktop) === k) return pairs[i].project;
  var projects = (cfg && cfg.projects) || [];
  for (var j = 0; j < projects.length; j++) {
    var p = actCut(String(projects[j] == null ? '' : projects[j]).trim(), ACT_PROJECT_MAX);
    if (p && actNorm(p) === k) return p;
  }
  return '';
}

/** actClassify, then the desktop's project ahead of any other (seg.desktop: its name). Only work and
 *  meetings take it: an unknown app on a project's desktop stays unclear (it may be a game). */
function actDeskClassify(seg, cfg) {
  var c = actClassify(seg, cfg);
  if (c.category !== 'work' && c.category !== 'meeting') return c;
  var pick = actPickProject({ desktop: actDeskProject(seg.desktop, cfg), title: c.project });
  if (pick.from !== 'desktop') return c;
  return { category: c.category, project: pick.project,
           key: actNorm(c.project) === actNorm(pick.project) ? c.key : '' };
}

/** Pieces cut at the desktop spans ([start ms, end ms, name]); each part carries `desktop` (its
 *  name, '' where no span covers it). Spans are the tray's: in time order, not overlapping. */
function actDesktopSplit(pieces, spans) {
  var sp = (spans || []).map(function (s, i) {
    return s ? { a: Number(s[0]), b: Number(s[1]), name: actCleanDesktop(s[2]), i: i } : null;
  }).filter(function (s) { return s && s.name && isFinite(s.a) && isFinite(s.b) && s.b > s.a; })
    .sort(function (x, y) { return (x.a - y.a) || (x.i - y.i); });
  var out = [];
  (pieces || []).forEach(function (p) {
    var at = p.start;
    function part(a, z, name) { if (z > a) out.push(Object.assign({}, p, { start: a, end: z, desktop: name })); }
    sp.forEach(function (s) {
      if (s.b <= at || s.a >= p.end) return;
      var x = Math.max(at, s.a);
      var y = Math.min(p.end, s.b);
      part(at, x, '');
      part(x, y, s.name);
      at = y;
    });
    part(at, p.end, '');
  });
  return out;
}

/* ── Item 30b: auto-detected Working on ────────────────────────────────────
 * activity-ingest finds a stretch of work on a project that is not in Working on while the
 * clock runs and keeps it as an activity_nudges row, kind 'auto' (run.project, run.work_min,
 * run.last). Accept writes a work row for it back to the stretch's start (ns-<id>); Reject an
 * actanswer (na-<id>). The server and the app's Home both judge it open with this. */

/** Is an auto-detected stretch still to ask about? Not once answered (ns-/na-), not when the
 *  clock is off, the working stretch it was found in has ended, or the project is in Working on.
 *  n: {id, ref_at (ms), run: {project}}; walk: actWalk; rows: [{at, type, rid}]; active: names. */
function actAutoOpen(n, walk, rows, active) {
  var id = String(n && n.id);
  var p = actNorm(n && n.run && n.run.project);
  if (!p || !walk || !walk.working) return false;
  if ((rows || []).some(function (r) { var rid = String(r.rid || ''); return rid === 'ns-' + id || rid === 'na-' + id; })) return false;
  if ((active || []).some(function (a) { return actNorm(a) === p; })) return false;
  var spans = walk.work || [];
  var cur = spans.length ? spans[spans.length - 1][0] : Infinity;
  return cur <= n.ref_at;
}

/* ── Item 31a: minute signals and the day's judgement ─────────────────────
 * Every device's blocks become one line of signals inside his working time: work (laptop work,
 * helpers, meetings: the laptop sends only minutes with input, so a screen left on is not work),
 * distraction (laptop work halted and a distraction on either device), idle (no device in use),
 * unclear. Phone use while the laptop works is work (music, R7); laptop idle, the phone decides.
 * The gaps between work are then judged (R1-R5); activity-ingest keeps the records, the app's
 * sheet and day-end card read the same judgement. Rules: claudeWorkingDocs/plan-item31.md. */

var ACT_EARN_MS = 40 * 60000;          // R1: this much work with no distraction earns a rest
var ACT_BREAK_MS = 15 * 60000;         // a gap this long is a break (R3, R5)
var ACT_DESERVED_NOTE_MS = 20 * 60000; // a deserved break past this gets a note in the day-end card
var ACT_LOW_MS = 25 * 60000;           // R3: distraction past this in one break is a LOW-tier focus loss
var ACT_HIGH_FIRST_MS = 20 * 60000;    // R4: good work, then distraction past this,
var ACT_HIGH_GOOD_MS = 20 * 60000;     // ...("good work": this much before it)
var ACT_HIGH_LITTLE_MS = 15 * 60000;   // ...a little work (less than this), distraction again,
var ACT_HIGH_CYCLE_MS = 30 * 60000;    // ...and the cycle's distraction past this: HIGH tier
var ACT_CHAT_ONE_MS = 20 * 60000;      // R5: Chit-chat this long at once, or
var ACT_CHAT_DAY_MS = 30 * 60000;      // ...this much in a day, is an external distraction
var ACT_PRAYER_AFTER_MS = 5 * 60000;   // a prayer logged this soon after an idle gap was in it
var ACT_UNWATCHED_MS = 2 * 3600000;    // no laptop block this long: the watchers were off, not him
var ACT_ON_MIN_MS = 60000;
var ACT_CLOCK_ON = { work: 1, voice: 1, resume: 1, wake: 1 };             // a part of a gap still on the clock shorter than this is not written
var ACT_IDLE_REASONS = ['Prayer', 'Washroom', 'Walk', 'Chitchat', 'Food', 'Other'];
var ACT_IDLE_DEFAULT = 'Idle';         // R5: an idle gap nobody explained
/* The rows a judgement writes: jb-/jr- a break and its resume, jw- the reason for an idle gap. */
var ACT_JUDGE_RID = /^(jb|jr|jw)-/;
/* Breaks and resumes written for him or by a sheet answer. Left out when finding the time he
 * meant to work (actJudgeDomain), so a gap stays a gap after its break is written. */
var ACT_JUDGED_RID = /^(ab|ar|aw|qb|qr|kb|kr|nd|ne|jb|jr)-/;

/** The word for a distraction block: its site's well-known name, else a phone app's (the phone
 *  sends "YouTube", no site), else 'distraction'. */
function actDistractName(b) {
  var w = actDistractWord(b);
  if (w !== 'distraction') return w;
  var app = actNorm(String((b && b.app) || '').replace(/\.exe$/i, ''));
  if (!app) return w;
  var keys = Object.keys(ACT_DISTRACT_NAMES);
  for (var i = 0; i < keys.length; i++) {
    var label = keys[i].split('.')[0];
    if (label.length >= 5 && app.indexOf(label) !== -1) return ACT_DISTRACT_NAMES[keys[i]];
  }
  return w;
}

/**
 * The signals over `spans` (his working time): [{start, end, sig, meet, what}] in order, covering
 * the spans whole. sig: work, distraction, idle or unclear; meet: only meetings were on; what: the
 * distraction's word; lap: the laptop reported a block there. blocks: {start, end, category, kind ('phone' or the laptop), domain, app}.
 */
function actSignals(blocks, spans) {
  var out = [];
  actMergeSpans(spans || []).forEach(function (s) {
    var ev = [];
    (blocks || []).forEach(function (b) {
      var a = Math.max(b.start, s[0]);
      var z = Math.min(b.end, s[1]);
      if (!(z > a)) return;
      var c = b.category;
      var cls = c === 'distraction' ? 'd' : c === 'work' || c === 'meeting' ? (b.kind === 'phone' ? 'pw' : 'lw') : 'o';
      var x = { cls: cls, meet: c === 'meeting', word: cls === 'd' ? actDistractName(b) : '', lap: b.kind !== 'phone' };
      ev.push({ t: a, x: x, d: 1 });
      ev.push({ t: z, x: x, d: -1 });
    });
    ev.sort(function (p, q) { return p.t - q.t; });
    var n = { lw: 0, pw: 0, d: 0, o: 0, m: 0, lap: 0 };
    var words = Object.create(null);
    var at = s[0];
    var i = 0;
    while (at < s[1]) {
      while (i < ev.length && ev[i].t <= at) {
        var e = ev[i++];
        n[e.x.cls] += e.d;
        if (e.x.meet) n.m += e.d;
        if (e.x.lap) n.lap += e.d;
        if (e.x.word) words[e.x.word] = (words[e.x.word] || 0) + e.d;
      }
      var next = i < ev.length ? Math.min(ev[i].t, s[1]) : s[1];
      var sig = n.lw > 0 ? 'work' : n.d > 0 ? 'distraction' : n.pw > 0 ? 'work' : n.o > 0 ? 'unclear' : 'idle';
      var meet = sig === 'work' && n.m > 0 && n.m === n.lw + n.pw;
      var what = sig === 'distraction' ? Object.keys(words).filter(function (k) { return words[k] > 0; }).sort()[0] || 'distraction' : '';
      var lap = n.lap > 0;
      var last = out[out.length - 1];
      if (last && last.end === at && last.sig === sig && last.meet === meet && last.what === what && last.lap === lap) last.end = next;
      else if (next > at) out.push({ start: at, end: next, sig: sig, meet: meet, what: what, lap: lap });
      at = next;
    }
  });
  return out;
}

/** The time he meant to work: actWalk's work spans over his rows, without the breaks written for
 *  him or by an answer (ACT_JUDGED_RID). rows: [{at, type, rid}]. */
function actJudgeDomain(rows, fromMs, toMs) {
  var own = (rows || []).filter(function (r) { return !ACT_JUDGED_RID.test(String((r && r.rid) || '')); });
  return actWalk(own, fromMs, toMs).work;
}

/** A gap's key, from its start: 'g' + seconds in base 36. Rows written for it carry it. */
function actGapKey(start) {
  return 'g' + Math.floor(start / 1000).toString(36);
}

/** The instant a key stands for, or NaN. */
function actGapKeyAt(key) {
  var m = /^g([0-9a-z]{1,12})$/.exec(String(key || ''));
  return m ? parseInt(m[1], 36) * 1000 : NaN;
}

/**
 * The day judged: every gap of 2 minutes or more between work, inside `d.spans` (actJudgeDomain).
 * d: {signals (actSignals over the spans), spans, work (the clock's own work spans, all rows),
 * prayers [ms], rows (the event rows: where the clock is turned on inside a gap)}. Returns [{start, end, ms, distMs, idleMs, unclearMs, what, earned, kind, low, high,
 * note, head, tail, applied, prayer, key}] in order. kind: rest (earned, R1), slip / distraction
 * (2-5 / 5-15, R2), dbreak / deserved (a distraction break, earned or not, R3), idle (R5), away
 * (unclear), meeting (idle between two meetings: still the meeting), unwatched (nothing from any
 * device for 2 hours or more: never judged). A span with no work at all is not judged: the watchers
 * saw nothing to judge it by. applied: the clock is already off for most of it (a break of his, an
 * auto break, or one written for it).
 */
function actJudge(d) {
  var sigs = (d && d.signals) || [];
  var out = [];
  actMergeSpans((d && d.spans) || []).forEach(function (sp) {
    var mine = actSilences(sigs.filter(function (x) { return x.start >= sp[0] && x.end <= sp[1]; }));
    // Runs: work, not watched, unclear (actLongUnclear: its own piece, on the clock, never a
    // break, so it never joins a distraction or idle stretch beside it), and the rest between as one piece.
    var runs = [];
    actLongUnclear(mine).forEach(function (x) {
      var c = x.sig === 'none' ? 'none' : x.sig === 'work' ? 'work' : x.longUnclear ? 'clear' : 'gap';
      var last = runs[runs.length - 1];
      if (last && last.c === c) { last.end = x.end; last.segs.push(x); } else runs.push({ c: c, work: c === 'work', start: x.start, end: x.end, segs: [x] });
    });
    // A gap under 2 minutes is a glance: work goes on through it.
    var items = [];
    runs.forEach(function (r) {
      var short = r.c === 'gap' && r.end - r.start < ACT_GLANCE_MS;
      var last = items[items.length - 1];
      var w = r.work || short;
      var ms = r.work ? r.end - r.start : 0;
      if (last && last.work && w) { last.end = r.end; last.ms += ms; last.segs = last.segs.concat(r.segs); }
      else items.push({ work: w, none: r.c === 'none', start: r.start, end: r.end, ms: ms, segs: r.segs });
    });
    if (!items.some(function (it) { return it.work && it.ms > 0; })) return;
    var solid = 0;                       // work since the last distraction or break (R1)
    var gaps = [];
    items.forEach(function (it, k) {
      if (it.work) { solid += it.ms; return; }
      if (it.none) {                     // the laptop said nothing: not judged
        gaps.push({ start: it.start, end: it.end, ms: it.end - it.start, distMs: 0, idleMs: it.end - it.start, unclearMs: 0, what: '',
                    earned: false, kind: 'unwatched', low: false, high: false, note: false, head: k === 0, tail: k === items.length - 1,
                    applied: false, prayer: false, key: actGapKey(it.start), before: k > 0 ? items[k - 1] : null,
                    after: k + 1 < items.length ? items[k + 1] : null });
        return;
      }
      var g = { start: it.start, end: it.end, ms: it.end - it.start, distMs: 0, idleMs: 0, unclearMs: 0, what: '',
                // Right after another non-work piece (a long unclear one): earned as that stretch began.
                earned: k > 0 && !items[k - 1].work && gaps.length ? gaps[gaps.length - 1].earned : solid >= ACT_EARN_MS,
                kind: '', low: false, high: false, note: false,
                head: k === 0, tail: k === items.length - 1, applied: false, prayer: false, key: actGapKey(it.start),
                before: k > 0 ? items[k - 1] : null, after: k + 1 < items.length ? items[k + 1] : null };
      var words = Object.create(null);
      it.segs.forEach(function (x) {
        var ms = x.end - x.start;
        if (x.sig === 'distraction') { g.distMs += ms; words[x.what] = (words[x.what] || 0) + ms; }
        else if (x.sig === 'idle') g.idleMs += ms;
        else g.unclearMs += ms;
      });
      g.what = Object.keys(words).sort(function (a, b) { return (words[b] - words[a]) || (a < b ? -1 : 1); })[0] || '';
      var bseg = g.before ? g.before.segs[g.before.segs.length - 1] : null;
      var aseg = g.after ? g.after.segs[0] : null;
      if (g.idleMs >= ACT_UNWATCHED_MS && g.distMs === 0 && g.unclearMs === 0) {
        g.kind = 'unwatched';
      } else if (g.ms < ACT_BREAK_MS) {
        if (g.distMs < ACT_GLANCE_MS) g.kind = 'pause';        // a short idle or unclear gap: a good break
        else if (g.earned) g.kind = 'rest';
        else g.kind = g.distMs < ACT_SLIP_MS ? 'slip' : 'distraction';
      } else if (g.unclearMs > g.distMs && g.unclearMs > g.idleMs) {
        g.kind = 'away';                                         // mostly unclear: stays on the clock, never a break
      } else if (g.idleMs > g.distMs && g.idleMs >= g.unclearMs && bseg && aseg && bseg.meet && aseg.meet) {
        g.kind = 'meeting';                                      // no input between two meetings: the meeting
      } else if (g.distMs >= ACT_BREAK_MS || (g.distMs >= g.idleMs && g.distMs >= g.unclearMs)) {
        g.kind = g.earned ? 'deserved' : 'dbreak';
        g.low = g.distMs > ACT_LOW_MS;
        g.note = g.earned && g.ms >= ACT_DESERVED_NOTE_MS && g.ms <= ACT_LOW_MS;
      } else {
        g.kind = 'idle';
      }
      if (g.kind !== 'pause' && g.kind !== 'meeting' && g.kind !== 'unwatched') solid = 0;
      gaps.push(g);
    });
    // R4: good work, a long distraction, a little work, distraction again: one HIGH-tier loss.
    for (var i = 0; i < gaps.length; i++) {
      var g1 = gaps[i];
      if (!(g1.distMs > ACT_HIGH_FIRST_MS) || !g1.before || g1.before.ms < ACT_HIGH_GOOD_MS) continue;
      var chain = [g1];
      var dist = g1.distMs;
      for (var j = i + 1; j < gaps.length; j++) {
        var prev = chain[chain.length - 1];
        var between = prev.after;
        if (!between || between !== gaps[j].before || !(between.ms > 0) || between.ms >= ACT_HIGH_LITTLE_MS) break;
        if (gaps[j].distMs < ACT_GLANCE_MS) break;
        chain.push(gaps[j]);
        dist += gaps[j].distMs;
      }
      if (chain.length < 2 || !(dist > ACT_HIGH_CYCLE_MS)) continue;
      chain.forEach(function (g) { g.high = true; g.low = false; });
      g1.highEnd = chain[chain.length - 1].end;
      g1.highMs = dist;
      i += chain.length - 1;
    }
    gaps.forEach(function (g) { delete g.before; delete g.after; out.push(g); });
  });
  var work = actMergeSpans((d && d.work) || []);
  var prayers = ((d && d.prayers) || []).filter(function (t) { return isFinite(t); });
  // Rows that turn the clock on (his, or a watcher's resume): a break written before one would end there.
  var starts = ((d && d.rows) || []).filter(function (r) { return r && ACT_CLOCK_ON[r.type]; })
    .map(function (r) { return actMs(r.at); }).filter(function (t) { return isFinite(t); });
  out.forEach(function (g) {
    // The parts still on the clock, each [a, z, a row is at a]: such a row inside the gap splits it,
    // and each part is applied on its own (actJudgeSteps), so a second run finds nothing left.
    g.on = [];
    actIntersect(g.start, g.end, work).forEach(function (p) {
      var cuts = starts.filter(function (t) { return t > p[0] && t < p[1]; }).sort(function (x, y) { return x - y; })
        .filter(function (t, i, all) { return all.indexOf(t) === i; });
      var a = p[0];
      var row = work.some(function (s) { return s[0] === p[0]; }) || starts.indexOf(p[0]) !== -1;
      cuts.concat([p[1]]).forEach(function (z) {
        g.on.push([a, z, row]);
        a = z;
        row = true;
      });
    });
    g.applied = !g.on.some(function (p) { return p[1] - p[0] >= ACT_ON_MIN_MS; });
    g.prayer = g.kind === 'idle' && prayers.some(function (t) { return t >= g.start && t <= g.end + ACT_PRAYER_AFTER_MS; });
  });
  return out;
}

/** Item 31: unclear segments that stay on the clock, marked longUnclear: every unclear stretch except
 *  one under 5 minutes beside a distraction (a tab between two videos goes with the distraction). */
function actLongUnclear(segs) {
  var out = segs.slice();
  var i = 0;
  while (i < out.length) {
    if (out[i].sig !== 'unclear') { i++; continue; }
    var j = i;
    while (j + 1 < out.length && out[j + 1].sig === 'unclear' && out[j + 1].start === out[j].end) j++;
    var prev = i > 0 && out[i - 1].end === out[i].start ? out[i - 1] : null;
    var next = j + 1 < out.length && out[j + 1].start === out[j].end ? out[j + 1] : null;
    var inDistraction = (prev && prev.sig === 'distraction') || (next && next.sig === 'distraction');
    if (out[j].end - out[i].start >= ACT_SLIP_MS || !inDistraction) {
      for (var k = i; k <= j; k++) out[k] = Object.assign({}, out[k], { longUnclear: true });
    }
    i = j + 1;
  }
  return out;
}

/** Item 31 (FAIL 3): a stretch of 2 hours or more with no laptop block and no work is not watched
 *  (sig 'none'): the phone alone is no evidence he was idle. Phone distraction inside it is still
 *  judged when it adds up to 15 minutes or more; less is not watched either. */
function actSilences(segs) {
  var out = segs.slice();
  var i = 0;
  while (i < out.length) {
    if (out[i].lap || out[i].sig === 'work') { i++; continue; }
    var j = i;
    while (j + 1 < out.length && !out[j + 1].lap && out[j + 1].sig !== 'work' && out[j + 1].start === out[j].end) j++;
    if (out[j].end - out[i].start >= ACT_UNWATCHED_MS) {
      var dist = 0;
      for (var k = i; k <= j; k++) if (out[k].sig === 'distraction') dist += out[k].end - out[k].start;
      for (var m = i; m <= j; m++) {
        if (out[m].sig !== 'distraction' || dist < ACT_BREAK_MS) out[m] = Object.assign({}, out[m], { sig: 'none', what: '' });
      }
    }
    i = j + 1;
  }
  return out;
}

/** R1 at instant t: 40 minutes of work or more since the last distraction (2 minutes or more), the
 *  last break (15 or more) or his own last break. The non-work just before t is the gap t is in. */
function actEarnedAt(signals, t) {
  var list = actLongUnclear((signals || []).slice().sort(function (a, b) { return a.start - b.start; }))
    .filter(function (x) { return x.start < t; }).sort(function (a, b) { return b.start - a.start; });
  var solid = 0;
  var gap = null;                       // {ms, dist}: the non-work run being walked back through
  var clear = 0;                        // the unclear piece being walked back through (actJudge: on the clock)
  var lead = true;                      // still in the gap t itself is in
  var edge = null;
  function breaks(g) { return g && (g.dist >= ACT_GLANCE_MS || g.ms >= ACT_BREAK_MS); }
  for (var i = 0; i < list.length; i++) {
    var x = list[i];
    var end = Math.min(x.end, t);
    if (edge !== null && end !== edge) break;          // his own break: nothing before it counts
    edge = x.start;
    var ms = end - x.start;
    if (x.sig === 'work') {
      if (breaks(gap) || clear >= ACT_BREAK_MS) break;
      lead = false;
      gap = null;
      clear = 0;
      solid += ms;
    } else if (lead) {
      continue;
    } else if (x.longUnclear) {
      if (breaks(gap)) break;            // the gap after this piece is its own (actJudge splits there)
      gap = null;
      clear += ms;
    } else {
      if (clear >= ACT_BREAK_MS) break;
      clear = 0;
      gap = gap || { ms: 0, dist: 0 };
      gap.ms += ms;
      if (x.sig === 'distraction') gap.dist += ms;
    }
  }
  return solid >= ACT_EARN_MS;
}

/** Does a gap become a break when its recommendation is applied? 15 minutes or more of mostly idle
 *  or mostly distraction. Mostly unclear ('away') is never a break: it may well be work. */
function actJudgeBreaks(g) {
  return g.ms >= ACT_BREAK_MS && (g.kind === 'idle' || g.kind === 'dbreak' || g.kind === 'deserved');
}

/** A gap's recommendation in words, for the sheet and the day-end card. reason: an idle gap's. */
function actJudgeWords(g, reason) {
  if (g.high) return 'Lost focus (high)';
  if (g.low) return 'Lost focus (low)';
  var r = reason || (g.prayer ? 'Prayer' : '');
  return { rest: 'Rest (earned)', slip: 'Slip', distraction: 'Distraction', dbreak: 'Distraction break',
           deserved: 'Deserved break', idle: 'Idle — ' + actIdleWord(r || ACT_IDLE_DEFAULT), away: '? — what was this? (on the clock)',
           meeting: 'Meeting', pause: 'Short break', unwatched: 'Not watched' }[g.kind] || '';
}

/** An idle reason as shown: "Chit-chat" for the stored word. */
function actIdleWord(r) {
  return r === 'Chitchat' ? 'Chit-chat' : r === ACT_IDLE_DEFAULT ? 'Idle (break)' : String(r || '');
}

/** An idle reason as kept, or '' for anything else. */
function actIdleReason(r) {
  var s = String(r == null ? '' : r).replace(/[^A-Za-z]/g, '').toLowerCase();
  var all = ACT_IDLE_REASONS.concat([ACT_IDLE_DEFAULT]);
  for (var i = 0; i < all.length; i++) if (all[i].toLowerCase() === s) return all[i];
  return '';
}

/** Idle reasons from jw- actanswer rows: key -> the newest reason (by `at`, then order). rows:
 *  [{at, type, rid, detail}]. A row's key is the gap's: jw-<key>-<anything>. */
function actIdleReasons(rows) {
  var best = Object.create(null);
  (rows || []).forEach(function (r, i) {
    var m = /^jw-(g[0-9a-z]{1,12})-/.exec(String((r && r.rid) || ''));
    var reason = m ? actIdleReason(r.detail) : '';
    if (!reason) return;
    var t = actMs(r.at);
    var have = best[m[1]];
    if (!have || t > have.t || (t === have.t && i > have.i)) best[m[1]] = { t: t, i: i, reason: reason, auto: /-auto$/.test(r.rid) };
  });
  return best;
}

/** The reason kept for an idle gap: the newest answer whose key falls inside it (blocks that came
 *  later may move its start a little), {reason, auto}; else null. */
function actGapReason(g, reasons) {
  var best = null;
  Object.keys(reasons || {}).forEach(function (k) {
    var t = actGapKeyAt(k);
    if (!(t >= g.start - ACT_GLANCE_MS && t < g.end)) return;
    var r = reasons[k];
    if (!best || r.t > best.t) best = r;
  });
  return best ? { reason: best.reason, auto: best.auto } : null;
}

/**
 * The records the gaps make (activity_focus rows): [{tier, start, end, minutes, what, day}].
 * tiers: slip, loss (a 5-15 min distraction; the name the v41 app knows), rest, dbreak, deserved,
 * low, high, idle (what: the reason), away, external (Chit-chat, R5), stretch (each day's longest
 * work between distractions and breaks). opts: {dayOf(t), keepFrom, reasons (actIdleReasons),
 * signals (for the stretches)}.
 */
function actJudgeRecords(gaps, opts) {
  var o = opts || {};
  var keep = isFinite(o.keepFrom) ? o.keepFrom : -Infinity;
  var dayOf = o.dayOf || function () { return ''; };
  var out = [];
  function rec(tier, a, z, ms, what) {
    if (a < keep) return;
    out.push({ tier: tier, start: a, end: z, minutes: Math.min(1440, Math.max(1, Math.round(ms / 60000))),
               what: String(what || '').replace(/[^A-Za-z ]/g, '').slice(0, 20), day: dayOf(a) });
  }
  var chat = [];
  (gaps || []).forEach(function (g) {
    var tier = { rest: 'rest', slip: 'slip', distraction: 'loss', dbreak: 'dbreak', deserved: 'deserved', away: 'away' }[g.kind];
    if (tier) rec(tier, g.start, g.end, tier === 'slip' || tier === 'loss' ? g.distMs : g.ms, tier === 'rest' || tier === 'away' ? '' : g.what || 'distraction');
    if (g.kind === 'idle') {
      var r = actGapReason(g, o.reasons);
      var why = r ? r.reason : g.prayer ? 'Prayer' : ACT_IDLE_DEFAULT;
      rec('idle', g.start, g.end, g.ms, why);
      if (why === 'Chitchat') chat.push(g);
    }
    if (g.low) rec('low', g.start, g.end, g.distMs, g.what || 'distraction');
    if (g.high && isFinite(g.highEnd)) rec('high', g.start, g.highEnd, g.highMs, g.what || 'distraction');
  });
  // R5: Chit-chat is an external distraction when one is long, or the day's add up.
  var byDay = Object.create(null);
  chat.forEach(function (g) { var k = dayOf(g.start); byDay[k] = (byDay[k] || 0) + g.ms; });
  chat.forEach(function (g) {
    if (g.ms > ACT_CHAT_ONE_MS || byDay[dayOf(g.start)] > ACT_CHAT_DAY_MS) rec('external', g.start, g.end, g.ms, 'Chitchat');
  });
  // Stretches: work between gaps that broke focus (anything but a short pause or a meeting) and
  // between his own breaks (the signals stop there).
  var cut = (gaps || []).filter(function (g) { return g.kind !== 'pause' && g.kind !== 'meeting' && g.kind !== 'unwatched'; });
  var best = Object.create(null);
  var cur = null;
  var prevEnd = null;
  function close(c) {
    if (!c || c.ms < 60000) return;
    var k = dayOf(c.start);
    if (!best[k] || c.ms > best[k].ms) best[k] = c;
  }
  (o.signals || []).forEach(function (x) {
    var broken = cut.some(function (g) { return x.start >= g.start && x.start < g.end; });
    if (broken || (prevEnd !== null && x.start !== prevEnd)) { close(cur); cur = null; }
    prevEnd = x.end;
    if (broken || x.sig !== 'work') return;
    if (!cur) cur = { start: x.start, end: x.end, ms: 0 };
    cur.end = x.end;
    cur.ms += x.end - x.start;
  });
  close(cur);
  Object.keys(best).sort().forEach(function (k) { rec('stretch', best[k].start, best[k].end, best[k].ms, ''); });
  return out.sort(function (x, y) { return (x.start - y.start) || (x.tier < y.tier ? -1 : 1); });
}

/**
 * The rows that apply a gap's recommendation (R3/R5, at End day or on an idle answer): a break at
 * its start and, unless it ran to the end of the working time, a resume where work came back.
 * Rids carry the gap's key, so the server and every device write them once. Nothing for a gap
 * already off the clock, or one that is not a break. reason: an idle gap's.
 */
function actJudgeSteps(g, reason) {
  if (!actJudgeBreaks(g)) return [];
  var text = g.kind === 'idle' ? actIdleWord(reason || (g.prayer ? 'Prayer' : ACT_IDLE_DEFAULT))
           : g.kind === 'away' ? 'Away (auto)' : g.kind === 'deserved' ? 'Break (deserved — auto)' : 'Distraction (auto)';
  var resume = 'Resume (back at work — auto)';
  if (!g.on) {                           // a gap built by hand (an idle answer): as one piece
    if (g.applied) return [];
    var one = [{ type: 'break', at: g.head ? g.start + 1000 : g.start, rid: 'jb-' + g.key, text: text }];
    if (!g.tail) one.push({ type: 'resume', at: g.end, rid: 'jr-' + g.key, text: resume });
    return one;
  }
  // Each part still on the clock: a break where it starts (a second after the row that turned the
  // clock on there, so that row cannot end it), and a resume only where work came back at the gap's
  // end. Once written the part is off the clock, so a second run writes nothing.
  var out = [];
  g.on.forEach(function (p) {
    if (p[1] - p[0] < ACT_ON_MIN_MS) return;
    var key = p[0] === g.start ? g.key : actGapKey(p[0]);
    out.push({ type: 'break', at: p[2] ? p[0] + 1000 : p[0], rid: 'jb-' + key, text: text });
    if (p[1] === g.end && !g.tail) out.push({ type: 'resume', at: g.end, rid: 'jr-' + key, text: resume });
  });
  return out;
}

/** activity_focus rows (any days) -> the figures the day-end card, Review and the reports show. The
 *  first six are item 30a's, kept so a saved report reads as it did. */
function actJudgeSummary(rows) {
  var s = { losses: 0, lossMin: 0, slips: 0, slipMin: 0, longestMin: 0, top: '',
            rests: 0, restMin: 0, dbreaks: 0, dbreakMin: 0, deserved: 0, deservedMin: 0, deservedLong: 0,
            lows: 0, lowMin: 0, highs: 0, highMin: 0, idles: 0, idleMin: 0, idleBy: {}, aways: 0, awayMin: 0,
            externals: 0, externalMin: 0 };
  var by = Object.create(null);
  var any = false;
  (rows || []).forEach(function (r) {
    var m = Math.round(Number(r && r.minutes));
    if (!(m > 0)) return;
    any = true;
    var w = String(r.what || '');
    switch (r.tier) {
      case 'stretch': s.longestMin = Math.max(s.longestMin, m); return;
      case 'loss': s.losses += 1; s.lossMin += m; break;
      case 'slip': s.slips += 1; s.slipMin += m; break;
      case 'rest': s.rests += 1; s.restMin += m; return;
      case 'dbreak': s.dbreaks += 1; s.dbreakMin += m; break;
      case 'deserved': s.deserved += 1; s.deservedMin += m; if (m >= 20 && m <= 25) s.deservedLong += 1; return;
      case 'low': s.lows += 1; s.lowMin += m; return;
      case 'high': s.highs += 1; s.highMin += m; return;
      case 'idle': s.idles += 1; s.idleMin += m; s.idleBy[w || ACT_IDLE_DEFAULT] = (s.idleBy[w || ACT_IDLE_DEFAULT] || 0) + m; return;
      case 'away': s.aways += 1; s.awayMin += m; return;
      case 'external': s.externals += 1; s.externalMin += m; return;
      default: return;
    }
    by[w || 'distraction'] = (by[w || 'distraction'] || 0) + m;
  });
  s.top = Object.keys(by).sort(function (x, y) { return (by[y] - by[x]) || (x < y ? -1 : 1); })[0] || '';
  return any ? s : null;
}

/* ── Item 31b: the catch-up sheet's lines ─────────────────────────────────
 * Grouped by the laptop's virtual desktop, then merged by what they were, in plain words. */

var ACT_PLAIN_NAMES = { windowsterminal: 'Terminal', wt: 'Terminal', cmd: 'Terminal', powershell: 'Terminal',
  pwsh: 'Terminal', conhost: 'Terminal', wsl: 'Terminal', code: 'VS Code', notepad: 'Notepad', 'notepad++': 'Notepad++',
  explorer: 'File Explorer', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', outlook: 'Outlook', olk: 'Outlook',
  discord: 'Discord', zoom: 'Zoom', teams: 'Teams', msteams: 'Teams', claude: 'Claude', idea64: 'IntelliJ',
  pycharm64: 'PyCharm', webstorm64: 'WebStorm', systemsettings: 'Settings', photos: 'Photos' };
var ACT_NO_DESKTOP = 'No desktop';

/** A block's line name: Meeting, a distraction's word, Private, Browsing (a browser or a site), a phone
 *  app ("Phone · YouTube"), else the app in plain words (WindowsTerminal -> Terminal). */
function actLineName(b) {
  if (b.category === 'meeting') return 'Meeting';
  if (b.category === 'private') return 'Private';
  if (b.category === 'distraction') {
    var w = actDistractName(b);
    return w === 'distraction' ? (b.kind === 'phone' && b.app ? 'Phone · ' + b.app : b.domain || 'Distraction') : w;
  }
  if (b.kind === 'phone') return 'Phone · ' + (String(b.app || '').trim() || 'app');
  if (b.domain || actIsBrowser(b.app)) return 'Browsing';
  var raw = String(b.app || '').replace(/\.exe$/i, '').trim();
  var k = actWorkName(raw);
  return ACT_PLAIN_NAMES[k] || raw || 'Unknown app';
}

/**
 * The sheet's groups: [{desktop, project (the desktop's), ms, lines: [{name, category, project, rec,
 * ms, start, end, apps, sites, desktops, ids, spans, auto}]}], most time first, "No desktop" last.
 * Inside a desktop, blocks of the same name, category and (corrected) project are one line, however
 * far apart. rec: the project the line should carry (its own, else the desktop's; a meeting or an
 * unplaced line on a project's desktop is offered the desktop's project), '' for none. auto: the
 * project was set by the watchers, not by him. blocks: {id, start, end, category, project, app,
 * domain, desktop, kind}; fixes: actFixMap; cfg: {desktops, projects}.
 */
function actDeskGroups(blocks, fixes, cfg) {
  var groups = Object.create(null);
  var order = [];
  (blocks || []).slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (raw) {
    var b = actFixed(raw, fixes);
    if (!(b.end > b.start)) return;
    var desk = actCleanDesktop(b.desktop) || ACT_NO_DESKTOP;
    var gk = 'd' + actNorm(desk);
    var g = groups[gk];
    if (!g) {
      g = groups[gk] = { desktop: desk, project: desk === ACT_NO_DESKTOP ? '' : actDeskProject(desk, cfg), ms: 0, lines: [], by: Object.create(null) };
      order.push(g);
    }
    var name = actLineName(b);
    var lk = [name, b.category, b.project || ''].join('|');
    var line = g.by[lk];
    if (!line) {
      var placeable = b.category === 'work' || b.category === 'meeting' || b.category === 'unclear';
      line = g.by[lk] = { name: name, category: b.category, project: b.project || '',
                          rec: placeable ? (b.project || g.project || '') : '', ms: 0, start: b.start, end: b.end,
                          apps: [], sites: [], desktops: [], ids: [], spans: [],
                          auto: Boolean(b.project) && !(fixes && b.id && fixes[b.id]) };
      g.lines.push(line);
    }
    line.ms += b.end - b.start;
    line.start = Math.min(line.start, b.start);
    line.end = Math.max(line.end, b.end);
    g.ms += b.end - b.start;
    var app = b.category === 'private' ? '' : String(b.app || '').replace(/\.exe$/i, '');
    if (app && !actIsBrowser(b.app) && line.apps.indexOf(app) === -1) line.apps.push(app);
    if (b.domain && b.category !== 'private' && line.sites.indexOf(b.domain) === -1) line.sites.push(b.domain);
    if (desk !== ACT_NO_DESKTOP && line.desktops.indexOf(desk) === -1) line.desktops.push(desk);
    if (b.id) line.ids.push(b.id);
    var sp = line.spans[line.spans.length - 1];
    if (sp && b.start - sp[1] <= ACT_GROUP_GAP_MS) sp[1] = Math.max(sp[1], b.end);
    else line.spans.push([b.start, b.end, b.id || '']);
  });
  return order.map(function (g) {
    g.lines.sort(function (x, y) { return (y.ms - x.ms) || (x.start - y.start); });
    delete g.by;
    return g;
  }).sort(function (x, y) {
    var nx = x.desktop === ACT_NO_DESKTOP;
    var ny = y.desktop === ACT_NO_DESKTOP;
    return nx !== ny ? (nx ? 1 : -1) : (y.ms - x.ms) || (x.desktop < y.desktop ? -1 : 1);
  });
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
  ACT_RUN_GAP_MS: ACT_RUN_GAP_MS,
  ACT_DESKTOP_MAX: ACT_DESKTOP_MAX,
  ACT_DESKTOPS_MAX: ACT_DESKTOPS_MAX,
  actCleanDesktop: actCleanDesktop,
  actDeskPairs: actDeskPairs,
  actDeskProject: actDeskProject,
  actDeskClassify: actDeskClassify,
  actDesktopSplit: actDesktopSplit,
  actAutoOpen: actAutoOpen,
  ACT_EARN_MS: ACT_EARN_MS,
  ACT_BREAK_MS: ACT_BREAK_MS,
  ACT_LOW_MS: ACT_LOW_MS,
  ACT_IDLE_REASONS: ACT_IDLE_REASONS,
  ACT_IDLE_DEFAULT: ACT_IDLE_DEFAULT,
  ACT_JUDGE_RID: ACT_JUDGE_RID,
  ACT_JUDGED_RID: ACT_JUDGED_RID,
  actDistractName: actDistractName,
  actSignals: actSignals,
  actJudgeDomain: actJudgeDomain,
  actGapKey: actGapKey,
  actGapKeyAt: actGapKeyAt,
  actJudge: actJudge,
  actJudgeBreaks: actJudgeBreaks,
  actEarnedAt: actEarnedAt,
  actJudgeWords: actJudgeWords,
  actIdleWord: actIdleWord,
  actIdleReason: actIdleReason,
  actIdleReasons: actIdleReasons,
  actGapReason: actGapReason,
  actJudgeRecords: actJudgeRecords,
  actJudgeSteps: actJudgeSteps,
  actJudgeSummary: actJudgeSummary,
  actLineName: actLineName,
  actDeskGroups: actDeskGroups,
  ACT_NO_DESKTOP: ACT_NO_DESKTOP
};
