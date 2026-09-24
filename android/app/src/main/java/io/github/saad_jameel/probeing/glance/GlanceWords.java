package io.github.saad_jameel.probeing.glance;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.Calendar;
import java.util.Locale;

/**
 * The words on the widget, and nothing else — no network, no storage, no
 * Android. Everything here is a pure function of what it is handed, so the one
 * rule that matters can be read in one file.
 *
 * THE RULE, inherited from Stage 7b: a figure must never look fresher than it
 * is. The widget does not compute any figure; it renders the two lines the
 * server handed it, along with the "as of" that came with them. It never
 * extrapolates, never adds elapsed time, and never re-stamps an old reading
 * with a new clock.
 *
 * AND THE SECOND HALF, which is the part that costs something: past two hours,
 * the figures are replaced by WORDS. "Mon 4h 20m · 3 M" is a number, and a
 * number on a home screen reads as current no matter what is printed under it.
 * After two hours it says how old it is instead, in plain language — and the
 * title is weakened with it, because "Working on: NeuraVue" is just as much a
 * claim about right now as the hours are.
 *
 * That makes the widget go quiet for most of the day, and that is not a bug to
 * be fixed later: the reading only moves when ProBeing itself is open, so a
 * widget that kept showing this morning's hours at 6 PM would be lying with a
 * straight face. Saad has been told the widget is only ever as fresh as the last
 * time the app was open.
 */
final class GlanceWords {

    /** Two hours. Past this, figures become words. */
    static final long STALE_AFTER_MS = 2L * 60L * 60L * 1000L;

    /* Sizes from glance_widget_list.xml, used to estimate how many list lines
     * fit. Deliberately generous per line, so the estimate errs towards fewer. */
    static final float LIST_TEXT_SP = 13f;
    static final float BODY_TEXT_SP = 13f;
    static final float FOOT_TEXT_SP = 11f;
    static final float LINE_HEIGHT_EM = 1.3f;
    /** Padding top and bottom, plus the margins above the body and the foot. */
    static final float FIXED_DP = 12f * 2f + 4f + 6f;

    /** Fewer list lines than this and the widget shows title and body instead. */
    static final int LIST_MIN_LINES = 3;

    /** What the widget is currently able to say. */
    enum State {
        /** No secret has ever been typed in. */
        UNPAIRED,
        /**
         * A secret is stored and the server answered with no row.
         *
         * THIS DOES NOT MEAN THE CODE IS WRONG, and the widget must not say it
         * does. `glance_for` returns an empty array for two different
         * situations: a secret it does not recognise, AND a perfectly good
         * secret for an account that has not written a glance line yet. The two
         * are indistinguishable over the wire on purpose — telling them apart
         * would turn the function into an oracle that confirms which codes are
         * valid, one guess at a time.
         *
         * So the wording has to cover both, and the first remedy offered is the
         * one that is free and usually right: open the app once.
         */
        NO_ROW,
        /** Paired, and nothing has been read back yet. */
        NO_READING,
        /** A reading is in hand — fresh or stale, that is decided below. */
        HAVE_READING
    }

    /** What went wrong on the last attempt, if anything. Separate from State
     *  because a problem does not erase a reading already in hand. */
    enum Problem {
        NONE,
        /** Supabase could not be reached, or refused. */
        OFFLINE,
        /** A row came back carrying a timestamp that could not be read. */
        UNDATED
    }

    static final class Lines {
        final String title;
        final String body;
        final String foot;
        /** The list of open projects, or "" when there is none to show. */
        final String list;

        Lines(String title, String body, String foot) {
            this(title, body, foot, "");
        }

        Lines(String title, String body, String foot, String list) {
            this.title = title;
            this.body = body;
            this.foot = foot;
            this.list = list;
        }
    }

    private GlanceWords() {
    }

    static Lines lines(State state, Problem problem, String title, String body,
                       String list, long asOfMs, long nowMs) {
        if (list == null) {
            list = "";
        }
        switch (state) {
            case UNPAIRED:
                return new Lines("ProBeing",
                        "Not paired yet. Tap here to enter the code from Settings.",
                        "");
            case NO_ROW:
                // Covers both causes without accusing either. The footer is the
                // way back to the pairing screen, since the lines now open the
                // app instead.
                return new Lines("ProBeing",
                        "Nothing came back yet. Open ProBeing once, then check the code.",
                        "Tap here to re-enter the code");
            case NO_READING:
                return new Lines("ProBeing", waitingBody(problem), "");
            default:
                break;
        }

        long age = nowMs - asOfMs;

        // A reading stamped in the future is a clock disagreement, not a fresh
        // reading. app.js refuses to credit anything past now for the same
        // reason; here it would make a stale figure look brand new.
        if (age < 0L) {
            age = 0L;
        }

        String foot = "as of " + clock(asOfMs);
        if (problem == Problem.OFFLINE) {
            foot = foot + " · offline";
        } else if (problem == Problem.UNDATED) {
            foot = foot + " · last update unreadable";
        }

        if (age < STALE_AFTER_MS) {
            return new Lines(title, withoutTrailingAsOf(body), foot, list);
        }
        return new Lines(staleTitle(title),
                figuresAreOld(age) + " — open ProBeing to refresh.",
                foot + " · " + ago(age),
                staleList(list));
    }

    private static String waitingBody(Problem problem) {
        switch (problem) {
            case OFFLINE:
                return "Paired. Could not reach ProBeing — tap the arrow to retry.";
            case UNDATED:
                // Not a network failure, and saying so would send someone to
                // check their signal over a data problem.
                return "A reading arrived without a usable time, so it is not shown.";
            default:
                return "Paired. Waiting for the first reading.";
        }
    }

    /**
     * "Working on: NeuraVue" becomes "Was working on: NeuraVue" once the reading
     * is stale.
     *
     * Without this the widget contradicts itself: the body says the figures are
     * three hours old while the line above it states, in the present tense, what
     * is being worked on right now. The title is a claim about *now* exactly as
     * much as the hours are.
     *
     * A title of an unexpected shape is left alone rather than mangled — the
     * body underneath already says the reading is old.
     */
    static String staleTitle(String title) {
        if (title == null || title.length() == 0) {
            return "ProBeing";
        }
        if (title.regionMatches(true, 0, "Working on", 0, 10)) {
            return "Was w" + title.substring(1);
        }
        return title;
    }

    /** The list's heading gets the title's treatment: "Working on:" becomes
     *  "Was working on:" once the reading is old. Its lines are left alone. */
    static String staleList(String list) {
        if (list == null || list.length() == 0) {
            return "";
        }
        return staleTitle(list);
    }

    /**
     * How many list lines fit in a widget `heightDp` tall, below which sit the
     * two-line body and the foot. `fontScale` is the phone's text-size setting.
     */
    static int listLinesThatFit(int heightDp, float fontScale) {
        if (heightDp <= 0) {
            return 0;
        }
        float scale = fontScale > 0f ? fontScale : 1f;
        float listLine = LIST_TEXT_SP * LINE_HEIGHT_EM * scale;
        float reserved = FIXED_DP
                + 2f * BODY_TEXT_SP * LINE_HEIGHT_EM * scale
                + FOOT_TEXT_SP * LINE_HEIGHT_EM * scale;
        int n = (int) Math.floor((heightDp - reserved) / listLine);
        return Math.max(n, 0);
    }

    /**
     * The list cut to `maxLines` whole lines, never mid-word. When lines are
     * dropped, the last line shown is "…", so the list does not look complete.
     */
    static String fitList(String list, int maxLines) {
        if (list == null || list.length() == 0 || maxLines <= 0) {
            return "";
        }
        String[] rows = list.split("\n", -1);
        if (rows.length <= maxLines) {
            return list;
        }
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < maxLines - 1; i++) {
            out.append(rows[i]).append('\n');
        }
        return out.append('\u2026').toString();
    }

    /**
     * Removes a trailing "· as of 5:42 PM" from the server's body line.
     *
     * The body comes from the same builder as Stage 7b's notification glance
     * (app.js:glanceText), which HAS to carry its own "as of" because the
     * notification shade has no third line to put it on. The widget does have
     * one, so without this the same timestamp is printed twice, one line apart.
     *
     * The fix belongs here rather than in app.js for that reason: the shade
     * still needs it.
     *
     * Deliberately cautious. It only cuts when what follows "as of" is short and
     * contains a digit — i.e. it really is a time — so a body that happens to
     * use the phrase some other way survives intact. Anything unrecognised is
     * returned untouched, because printing a timestamp twice is a blemish while
     * truncating someone's project name is data loss.
     */
    static String withoutTrailingAsOf(String body) {
        if (body == null) {
            return "";
        }
        int at = body.toLowerCase(Locale.US).lastIndexOf("as of");
        if (at < 0) {
            return body;
        }
        String tail = body.substring(at + 5);
        boolean looksLikeATime = tail.trim().length() > 0
                && tail.length() <= 14
                && tail.matches(".*\\d.*");
        if (!looksLikeATime) {
            return body;
        }

        int cut = at;
        while (cut > 0 && Character.isWhitespace(body.charAt(cut - 1))) {
            cut--;
        }
        // One separator, whichever of these was used.
        if (cut > 0 && "·•|,;-–—".indexOf(body.charAt(cut - 1)) >= 0) {
            cut--;
        }
        while (cut > 0 && Character.isWhitespace(body.charAt(cut - 1))) {
            cut--;
        }
        // Never hand back an empty line: if the whole body was the timestamp,
        // the timestamp is all there is to show.
        return cut == 0 ? body : body.substring(0, cut);
    }

    /** "These figures are 3 hours old". Deliberately a sentence: the whole
     *  purpose is to not be a number. */
    static String figuresAreOld(long ageMs) {
        return "These figures are " + ago(ageMs).replace(" ago", " old");
    }

    /** "3 hours ago", "2 days ago". Whole units only — the widget is a glance,
     *  and "3 hours 14 minutes" invites reading it as a measurement. */
    static String ago(long ageMs) {
        long minutes = ageMs / 60000L;
        if (minutes < 1L) {
            return "moments ago";
        }
        if (minutes < 60L) {
            return plural(minutes, "minute") + " ago";
        }
        long hours = minutes / 60L;
        if (hours < 24L) {
            return plural(hours, "hour") + " ago";
        }
        return plural(hours / 24L, "day") + " ago";
    }

    private static String plural(long n, String unit) {
        return n + " " + unit + (n == 1L ? "" : "s");
    }

    /**
     * "5:42 PM" on the device's own clock. A fixed shape rather than the
     * locale's, because that is the wording Saad chose for the notification
     * glance in 7b (app.js:glanceClock) and the two are read side by side.
     */
    static String clock(long ms) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(ms);
        int h = c.get(Calendar.HOUR_OF_DAY);
        int m = c.get(Calendar.MINUTE);
        int twelve = h % 12;
        if (twelve == 0) {
            twelve = 12;
        }
        return twelve + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " AM" : " PM");
    }

    /**
     * The server's "as_of" as milliseconds, or 0 when it cannot be read.
     *
     * Three shapes are tried because the answer comes from Postgres through
     * PostgREST and the column type decides the format: a `timestamptz` arrives
     * as "2026-09-16T17:42:03.123456+00:00", and a plain `timestamp` arrives
     * with no offset at all. Returning 0 rather than guessing is deliberate — a
     * timestamp we cannot read must not become "now", because "now" is exactly
     * the lie this class exists to prevent.
     */
    static long parseAsOf(String text) {
        if (text == null || text.length() == 0) {
            return 0L;
        }
        String t = text.trim();
        try {
            return OffsetDateTime.parse(t).toInstant().toEpochMilli();
        } catch (RuntimeException ignored) {
            // fall through
        }
        try {
            return Instant.parse(t).toEpochMilli();
        } catch (RuntimeException ignored) {
            // fall through
        }
        try {
            // No offset given. Postgres writes these in UTC, so read it as UTC
            // rather than as the phone's zone: guessing the phone's zone would
            // shift the age by hours and could make an old reading look new.
            return LocalDateTime.parse(t.replace(' ', 'T'))
                    .atZone(ZoneId.of("UTC")).toInstant().toEpochMilli();
        } catch (RuntimeException ignored) {
            return 0L;
        }
    }
}
