package io.github.saad_jameel.probeing.watch;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.regex.Pattern;

/**
 * The phone watcher's logic (Stage 18c), with no Android in it so a plain JDK
 * can check it (claudeWorkingDocs/tests/java/PhoneRulesCheck.java).
 *
 * classify() and blocks() are a copy of actClassify / actBlocks in
 * supabase/functions/_shared/activity.js, and pass the same selftest.json the
 * laptop's watch.ps1 passes. Change one, change the other.
 *
 * What the phone adds: an app stands in for a website (the YouTube app is
 * youtube.com), a site entry's path is ignored because the phone cannot see one
 * (Saad, 9 Oct: phone YouTube counts whole), and a private block names no app.
 */
public final class PhoneRules {

    public static final long MIN = 60000L;
    static final long MIN_BLOCK_MS = MIN;            // shorter pieces fold into a neighbour
    static final long JOIN_GAP_MS = MIN;             // a gap this small does not split a block
    static final int APP_MAX = 80;
    static final int PROJECT_MAX = 120;
    static final int KEY_MIN = 4;
    static final int KEY_MAX = 40;
    static final int LIST_MAX = 50;
    static final int ENTRY_MAX = 80;

    static final String[] DEFAULT_DISTRACT = {"youtube.com/shorts", "x.com", "twitter.com", "instagram.com",
            "tiktok.com", "facebook.com"};
    static final String[] DEFAULT_PRIVATE = {"bank", "password", "bitwarden", "1password", "lastpass", "keepass",
            "whatsapp", "messenger", "signal", "telegram"};
    static final String[] DEFAULT_MEETING = {"meet.google.com", "zoom.us", "zoom", "teams.microsoft.com", "teams",
            "discord"};

    static final String[] BROWSERS = {"chrome", "msedge", "brave", "firefox", "opera", "vivaldi"};

    /** A browser's own private window, said in its title (ACT_PRIVATE_TITLE). */
    static final Pattern PRIVATE_TITLE = Pattern.compile("incognito|inprivate|private browsing",
            Pattern.CASE_INSENSITIVE);

    /** Apps that are a website on the laptop, so his site entries reach them. */
    static final String[][] APP_SITES = {
            {"com.google.android.youtube", "youtube.com"},
            {"app.revanced.android.youtube", "youtube.com"},
            {"com.instagram.android", "instagram.com"},
            {"com.twitter.android", "x.com"},
            {"com.zhiliaoapp.musically", "tiktok.com"},
            {"com.ss.android.ugc.trill", "tiktok.com"},
            {"com.facebook.katana", "facebook.com"},
            {"com.facebook.lite", "facebook.com"},
            {"com.reddit.frontpage", "reddit.com"},
            {"com.snapchat.android", "snapchat.com"},
            {"com.google.android.apps.tachyon", "meet.google.com"},
            {"com.google.android.apps.meetings", "meet.google.com"},
            {"us.zoom.videomeetings", "zoom.us"},
            {"com.microsoft.teams", "teams.microsoft.com"},
            {"com.discord", "discord.com"},
    };

    /** The phone app and its call screen: a call is a meeting. Only while it is on screen. */
    static final String[] CALL_APPS = {"com.google.android.dialer", "com.android.dialer", "com.android.incallui",
            "com.samsung.android.dialer", "com.samsung.android.incallui"};

    /** Private on the phone on top of his list (matched on the app's name and its package). */
    static final String[] PHONE_PRIVATE = {"wallet", "paypal", "easypaisa", "jazzcash", "sadapay", "nayapay",
            "authenticator", "messages", "messaging"};

    private PhoneRules() {
    }

    /* ── Text, as activity.js has it ─────────────────────────────────────── */

    /** Lower case, letters and digits only (and anything past ASCII), as actNorm. */
    public static String norm(String s) {
        String t = s == null ? "" : s.toLowerCase(Locale.ROOT);
        StringBuilder b = new StringBuilder(t.length());
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || c >= 0x80) b.append(c);
        }
        return b.toString();
    }

    /** Cut to `max` UTF-16 units without leaving half an emoji. */
    static String cut(String s, int max) {
        String t = s == null ? "" : s;
        if (t.length() <= max) return t;
        t = t.substring(0, max);
        if (t.length() > 0 && Character.isHighSurrogate(t.charAt(t.length() - 1))) t = t.substring(0, t.length() - 1);
        return t;
    }

    /** JavaScript's whitespace, which String.trim() does not fully cover. */
    private static boolean jsSpace(char c) {
        return c == ' ' || (c >= '\t' && c <= '\r') || c == ' ' || c == ' ' || (c >= ' ' && c <= ' ')
                || c == ' ' || c == ' ' || c == ' ' || c == ' ' || c == '　' || c == '﻿';
    }

    static String trim(String s) {
        String t = s == null ? "" : s;
        int a = 0;
        int z = t.length();
        while (a < z && jsSpace(t.charAt(a))) a++;
        while (z > a && jsSpace(t.charAt(z - 1))) z--;
        return t.substring(a, z);
    }

    /** An app's name, never a path. */
    static String cleanApp(String a) {
        String[] parts = (a == null ? "" : a).split("[\\\\/]", -1);
        return cut(trim(parts[parts.length - 1].replaceAll("[\\u0000-\\u001f]", "")), APP_MAX);
    }

    /* ── Lists and rules ──────────────────────────────────────────────────── */

    static List<String> tidyList(List<?> list) {
        List<String> out = new ArrayList<>();
        if (list == null) return out;
        for (Object x : list) {
            String e = cut(trim(x == null ? "" : String.valueOf(x)).toLowerCase(Locale.ROOT), ENTRY_MAX);
            if (e.length() > 0 && !out.contains(e) && out.size() < LIST_MAX) out.add(e);
        }
        return out;
    }

    /** The three lists; a list never set is the default, an empty one stays empty. */
    public static Map<String, List<String>> lists(Map<String, ? extends List<?>> l) {
        Map<String, List<String>> out = new HashMap<>();
        out.put("distract", l != null && l.get("distract") != null ? tidyList(l.get("distract"))
                : new ArrayList<>(Arrays.asList(DEFAULT_DISTRACT)));
        out.put("private", l != null && l.get("private") != null ? tidyList(l.get("private"))
                : new ArrayList<>(Arrays.asList(DEFAULT_PRIVATE)));
        out.put("meeting", l != null && l.get("meeting") != null ? tidyList(l.get("meeting"))
                : new ArrayList<>(Arrays.asList(DEFAULT_MEETING)));
        return out;
    }

    /** One stretch of time on one app, before it is a block. */
    public static final class Seg {
        public String app = "";
        public String host = "";
        public String path = "";
        public String title = "";
        public boolean incognito;
        /** The phone sees no page, so a site entry's path cannot rule it out. */
        public boolean anyPath;
    }

    static boolean isBrowser(String app) {
        return Arrays.asList(BROWSERS).contains(norm((app == null ? "" : app).replaceFirst("(?i)\\.exe$", "")));
    }

    /** As actTitleNamesSite: the site's first label as a word in the title, and its path's first part too. */
    static boolean titleNamesSite(String host, String path, String title) {
        String t = (title == null ? "" : title).toLowerCase(Locale.ROOT);
        String label = host.split("\\.", -1)[0];
        try {
            if (label.length() < 3 || !Pattern.compile("(^|[^a-z0-9])" + label + "([^a-z0-9]|$)").matcher(t).find()) {
                return false;
            }
            String[] parts = (path == null ? "" : path).split("/", -1);
            String part = parts.length > 1 ? parts[1] : "";
            return part.isEmpty() || (part.matches("[a-z0-9-]{3,}")
                    && Pattern.compile("(^|[^a-z0-9])" + part + "([^a-z0-9]|$)").matcher(t).find());
        } catch (RuntimeException e) {
            return false;       // an entry that is not a valid pattern names nothing
        }
    }

    static boolean entryHits(String entry, Seg seg, boolean withTitle) {
        String e = trim(entry).toLowerCase(Locale.ROOT);
        if (e.isEmpty()) return false;
        if (e.indexOf('.') != -1 || e.indexOf('/') != -1) {
            int slash = e.indexOf('/');
            String host = (slash == -1 ? e : e.substring(0, slash)).replaceFirst("^www\\.", "");
            String path = slash == -1 ? "" : e.substring(slash);
            String h = seg.host == null ? "" : seg.host;
            // A private site also counts when only the title names it.
            if (withTitle && !host.isEmpty() && (seg.title == null ? "" : seg.title).toLowerCase(Locale.ROOT)
                    .contains(host)) return true;
            // A browser window the extension did not see: the site's name in its title.
            if (h.isEmpty() && !host.isEmpty() && isBrowser(seg.app)) return titleNamesSite(host, path, seg.title);
            if (h.isEmpty() || host.isEmpty()) return false;
            if (!h.equals(host) && !h.endsWith("." + host)) return false;
            return path.isEmpty() || seg.anyPath || (seg.path == null ? "" : seg.path).startsWith(path);
        }
        String w = norm(e);
        if (w.length() < 3) return false;
        return norm(seg.app).contains(w) || norm(seg.host).contains(w) || (withTitle && norm(seg.title).contains(w));
    }

    static String listHit(List<String> list, Seg seg, boolean withTitle) {
        if (list == null) return "";
        for (String e : list) {
            if (entryHits(e, seg, withTitle)) return e;
        }
        return "";
    }

    /** {keyword, project}, longest keyword first; the first rule for a keyword wins. */
    public static List<String[]> rules(List<String[]> keywordRules, List<String> projects) {
        final List<String[]> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        List<String[]> all = new ArrayList<>();
        if (keywordRules != null) all.addAll(keywordRules);
        if (projects != null) {
            for (String p : projects) all.add(new String[]{p, p});
        }
        for (String[] r : all) {
            if (r == null) continue;
            String k = norm(r[0]);
            String p = cut(trim(r[1]), PROJECT_MAX);
            if (k.length() < KEY_MIN || k.length() > KEY_MAX || p.isEmpty() || seen.contains(k)) continue;
            seen.add(k);
            out.add(new String[]{k, p});
        }
        // Stable, so equal lengths keep their order, as activity.js sorts them.
        Collections.sort(out, new Comparator<String[]>() {
            @Override
            public int compare(String[] a, String[] b) {
                return b[0].length() - a[0].length();
            }
        });
        return out;
    }

    static String[] ruleHit(Seg seg, List<String[]> rules) {
        String t = norm(seg.title);
        String a = norm(seg.app);
        String h = norm(seg.host);
        for (String[] r : rules) {
            if (t.contains(r[0]) || a.contains(r[0]) || h.contains(r[0])) return new String[]{r[1], r[0]};
        }
        return null;
    }

    /** What his settings say, ready to classify with. */
    public static final class Cfg {
        public Map<String, List<String>> lists = lists(null);
        public List<String[]> rules = new ArrayList<>();
    }

    /** {category, project, key}: private first, then distraction, then meeting, then the rules. */
    public static String[] classify(Seg seg, Cfg cfg) {
        if (seg.incognito || PRIVATE_TITLE.matcher(seg.title == null ? "" : seg.title).find()
                || !listHit(cfg.lists.get("private"), seg, true).isEmpty()) {
            return new String[]{"private", "", ""};
        }
        if (!listHit(cfg.lists.get("distract"), seg, false).isEmpty()) return new String[]{"distraction", "", ""};
        String[] hit = ruleHit(seg, cfg.rules);
        if (!listHit(cfg.lists.get("meeting"), seg, false).isEmpty()) {
            return new String[]{"meeting", hit != null ? hit[0] : "", hit != null ? hit[1] : ""};
        }
        if (hit != null) return new String[]{"work", hit[0], hit[1]};
        return new String[]{"unclear", "", ""};
    }

    /* ── The phone's own part ─────────────────────────────────────────────── */

    static String siteOf(String pkg) {
        for (String[] s : APP_SITES) {
            if (s[0].equals(pkg)) return s[1];
        }
        return "";
    }

    static boolean isCallApp(String pkg) {
        return Arrays.asList(CALL_APPS).contains(pkg);
    }

    /**
     * One app on the phone as a block's fields: {category, app, project, key}.
     * The package is matched like a laptop title (private words only) and never
     * sent; a private block carries no app name at all.
     */
    public static String[] classifyApp(String pkg, String label, Cfg cfg) {
        String name = cleanApp(label == null || label.isEmpty() ? pkg : label);
        Seg seg = new Seg();
        seg.app = name;
        seg.host = siteOf(pkg);
        seg.title = pkg == null ? "" : pkg;
        seg.anyPath = true;
        List<String> priv = new ArrayList<>(cfg.lists.get("private"));
        priv.addAll(Arrays.asList(PHONE_PRIVATE));
        if (!listHit(priv, seg, true).isEmpty()) return new String[]{"private", "", "", ""};
        if (isCallApp(pkg)) return new String[]{"meeting", "Phone call", "", ""};
        // The package is matched only for privacy: rules see the app's name, like a laptop app.
        seg.title = "";
        String[] c = classify(seg, cfg);
        return new String[]{c[0], seg.app, c[1], c[2]};
    }

    /* ── Blocks ───────────────────────────────────────────────────────────── */

    public static final class Block {
        public long start;
        public long end;
        public String app = "";
        public String domain = "";
        public String category = "";
        public String project = "";
        public String key = "";
        String id = "";

        Block copy() {
            Block b = new Block();
            b.start = start;
            b.end = end;
            b.app = app;
            b.domain = domain;
            b.category = category;
            b.project = project;
            b.key = key;
            b.id = id;
            return b;
        }
    }

    /** What makes two pieces the same block, as actIdentity (the phone has no titles). */
    static String identity(Block b) {
        if (b.category.equals("private")) return "private|" + b.app;
        return b.category + "|" + b.project + "|" + b.app + "|" + b.domain + "|";
    }

    private static List<Block> join(List<Block> list) {
        List<Block> out = new ArrayList<>();
        for (Block b : list) {
            Block last = out.isEmpty() ? null : out.get(out.size() - 1);
            if (last != null && last.id.equals(b.id) && b.start - last.end <= JOIN_GAP_MS) {
                last.end = Math.max(last.end, b.end);
            } else {
                out.add(b.copy());
            }
        }
        return out;
    }

    /**
     * Classified pieces -> blocks of at least a minute, as actBlocks: a shorter
     * one folds into the block before it (or the one after, when nothing is
     * before it); with no neighbour within a minute it is dropped.
     */
    public static List<Block> blocks(List<Block> pieces) {
        List<Block> list = new ArrayList<>();
        for (Block p : pieces) {
            Block b = p.copy();
            b.app = cleanApp(b.app);
            if (b.category.equals("private")) {
                b.domain = "";
                b.project = "";
                b.key = "";
            }
            b.id = identity(b);
            list.add(b);
        }
        Collections.sort(list, new Comparator<Block>() {
            @Override
            public int compare(Block x, Block y) {
                return Long.compare(x.start, y.start);
            }
        });
        list = join(list);
        List<Block> kept = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            Block b = list.get(i);
            if (b.end - b.start >= MIN_BLOCK_MS) {
                kept.add(b);
                continue;
            }
            Block prev = kept.isEmpty() ? null : kept.get(kept.size() - 1);
            Block next = i + 1 < list.size() ? list.get(i + 1) : null;
            if (prev != null && b.start - prev.end <= JOIN_GAP_MS) prev.end = Math.max(prev.end, b.end);
            else if (next != null && next.start - b.end <= JOIN_GAP_MS) next.start = Math.min(next.start, b.start);
        }
        List<Block> out = new ArrayList<>();
        for (Block b : join(kept)) {
            if (b.end - b.start >= MIN_BLOCK_MS) out.add(b);
        }
        return out;
    }

    /* ── Spans ([start, end] in ms) ───────────────────────────────────────── */

    public static List<long[]> mergeSpans(List<long[]> list) {
        List<long[]> s = new ArrayList<>();
        for (long[] x : list) {
            if (x != null && x[1] > x[0]) s.add(new long[]{x[0], x[1]});
        }
        Collections.sort(s, new Comparator<long[]>() {
            @Override
            public int compare(long[] a, long[] b) {
                return Long.compare(a[0], b[0]);
            }
        });
        List<long[]> out = new ArrayList<>();
        for (long[] x : s) {
            long[] last = out.isEmpty() ? null : out.get(out.size() - 1);
            if (last != null && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
            else out.add(x);
        }
        return out;
    }

    static List<long[]> intersect(long a, long b, List<long[]> spans) {
        List<long[]> out = new ArrayList<>();
        for (long[] s : spans) {
            long x = Math.max(a, s[0]);
            long y = Math.min(b, s[1]);
            if (y > x) out.add(new long[]{x, y});
        }
        return out;
    }

    /* ── Usage events -> who was on screen when ──────────────────────────── */

    // UsageEvents.Event's numbers, copied so this file needs no Android.
    public static final int RESUMED = 1;
    public static final int PAUSED = 2;
    public static final int SCREEN_ON = 15;
    public static final int SCREEN_OFF = 16;
    public static final int KEYGUARD_SHOWN = 17;
    public static final int STOPPED = 23;
    public static final int SHUTDOWN = 26;

    /** One usage event: when, what kind, which package. */
    public static final class Event {
        public final long time;
        public final int type;
        public final String pkg;

        public Event(long time, int type, String pkg) {
            this.time = time;
            this.type = type;
            this.pkg = pkg == null ? "" : pkg;
        }
    }

    /** A package in front of the screen from start to end. */
    public static final class Piece {
        public final long start;
        public final long end;
        public final String pkg;

        Piece(long start, long end, String pkg) {
            this.start = start;
            this.end = end;
            this.pkg = pkg;
        }
    }

    /**
     * The app in front, piece by piece, cut to [from, to] and to `spans` (when he
     * was working). An app still in front at the end runs to `to`. The screen
     * going off or locking ends it; a launcher or the system UI (`ignore`) is
     * not time on anything.
     */
    public static List<Piece> pieces(List<Event> events, Set<String> ignore, long from, long to, List<long[]> spans) {
        List<long[]> allowed = new ArrayList<>();
        for (long[] s : mergeSpans(spans)) {
            long a = Math.max(s[0], from);
            long b = Math.min(s[1], to);
            if (b > a) allowed.add(new long[]{a, b});
        }
        List<Piece> raw = new ArrayList<>();
        String cur = null;
        long since = 0;
        for (Event e : events) {
            if (e.time > to) break;
            if (e.type == RESUMED) {
                if (cur != null && cur.equals(e.pkg)) continue;
                if (cur != null) raw.add(new Piece(since, e.time, cur));
                cur = ignore.contains(e.pkg) || e.pkg.isEmpty() ? null : e.pkg;
                since = e.time;
            } else if (e.type == PAUSED || e.type == STOPPED) {
                if (cur != null && cur.equals(e.pkg)) {
                    raw.add(new Piece(since, e.time, cur));
                    cur = null;
                }
            } else if (e.type == SCREEN_OFF || e.type == KEYGUARD_SHOWN || e.type == SHUTDOWN) {
                if (cur != null) raw.add(new Piece(since, e.time, cur));
                cur = null;
            }
        }
        if (cur != null) raw.add(new Piece(since, to, cur));
        List<Piece> out = new ArrayList<>();
        for (Piece p : raw) {
            for (long[] x : intersect(p.start, p.end, allowed)) out.add(new Piece(x[0], x[1], p.pkg));
        }
        return out;
    }

    /** Pieces -> blocks, each app classified once. labels: package -> its name. */
    public static List<Block> phoneBlocks(List<Piece> pieces, Map<String, String> labels, Cfg cfg) {
        Map<String, String[]> seen = new HashMap<>();
        List<Block> list = new ArrayList<>();
        for (Piece p : pieces) {
            String[] c = seen.get(p.pkg);
            if (c == null) {
                c = classifyApp(p.pkg, labels.get(p.pkg), cfg);
                seen.put(p.pkg, c);
            }
            Block b = new Block();
            b.start = p.start;
            b.end = p.end;
            b.category = c[0];
            b.app = c[1];
            b.project = c[2];
            b.key = c[3];
            list.add(b);
        }
        return blocks(list);
    }

    /* ── When to look again ───────────────────────────────────────────────── */

    static final long NUDGE_AFTER_MS = 10 * MIN;     // the server pushes at 10 minutes
    static final long IGNORE_CHECK_MS = 5 * MIN + 30000L;  // and breaks 5 minutes after the push
    static final long STREAK_GAP_MS = 2 * MIN;
    static final long LIVE_MS = 2 * MIN;

    /**
     * Android runs the watcher every 15 minutes at best. While a distraction is
     * on screen now, look again sooner: at its 10-minute mark (so the push is
     * not late), then 5.5 minutes on (so an ignored push becomes a break).
     * Returns the delay in ms, or -1 when nothing is on.
     */
    public static long followUpMs(List<Block> blocks, long now) {
        if (blocks.isEmpty()) return -1;
        Block last = blocks.get(blocks.size() - 1);
        if (!last.category.equals("distraction") || now - last.end > LIVE_MS) return -1;
        long start = last.start;
        for (int i = blocks.size() - 2; i >= 0; i--) {
            Block b = blocks.get(i);
            if (!b.category.equals("distraction") || start - b.end > STREAK_GAP_MS) break;
            start = Math.min(start, b.start);
        }
        long on = now - start;
        if (on >= NUDGE_AFTER_MS) return IGNORE_CHECK_MS;
        return Math.max(MIN, Math.min(IGNORE_CHECK_MS, NUDGE_AFTER_MS - on + 30000L));
    }

    /** Where the next run starts: a block that may still grow is sent again whole. */
    public static long nextFrom(List<Block> blocks, long from, long now) {
        long open = 2 * MIN;
        if (blocks.isEmpty()) return Math.max(from, now - open);
        Block last = blocks.get(blocks.size() - 1);
        return now - last.end > open ? last.end : last.start;
    }

    /** As JavaScript's toISOString. */
    public static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }
}
