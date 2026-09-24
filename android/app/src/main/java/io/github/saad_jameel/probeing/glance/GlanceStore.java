package io.github.saad_jameel.probeing.glance;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Everything the widget remembers between updates, in the app's own private
 * storage. MODE_PRIVATE means these files live inside the app's sandbox: no
 * other app can read them, and nothing here is ever written to the repo.
 *
 * THE DEVICE SECRET IS THE ONLY CREDENTIAL IN THE APK, and it is typed in by
 * hand once, from the code Settings shows in the app. It is never logged — not
 * at any log level, not inside an error message — because logcat is readable by
 * a plugged-in laptop and by a crash reporter, and this string is the whole of
 * the widget's authority.
 *
 * The last good reading is kept too, WITH the "as of" it arrived with. Keeping
 * the pair together is the point: a figure without the moment it was true is a
 * figure that looks live, and Stage 7b's rule is that one must never appear.
 */
final class GlanceStore {

    private static final String FILE = "probeing_glance";

    private static final String KEY_SECRET = "device_secret";
    private static final String KEY_TITLE = "last_title";
    private static final String KEY_BODY = "last_body";
    private static final String KEY_LINES = "last_lines";
    private static final String KEY_AS_OF = "last_as_of_ms";
    private static final String KEY_SAW_ROW = "last_call_had_row";

    private final SharedPreferences prefs;

    GlanceStore(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    String secret() {
        return prefs.getString(KEY_SECRET, "");
    }

    boolean paired() {
        return secret().length() > 0;
    }

    /** Pairing, or re-pairing. A new secret clears the old reading with it:
     *  showing yesterday's figures under a freshly typed code would be claiming
     *  the new pairing had already worked. */
    void pair(String secret) {
        prefs.edit()
                .putString(KEY_SECRET, secret.trim())
                .putBoolean(KEY_SAW_ROW, true)
                .remove(KEY_TITLE)
                .remove(KEY_BODY)
                .remove(KEY_LINES)
                .remove(KEY_AS_OF)
                .apply();
    }

    void unpair() {
        prefs.edit().clear().apply();
    }

    /** The server answered with a row. */
    void saveReading(String title, String body, String lines, long asOfMs) {
        prefs.edit()
                .putString(KEY_TITLE, title)
                .putString(KEY_BODY, body)
                .putString(KEY_LINES, lines)
                .putLong(KEY_AS_OF, asOfMs)
                .putBoolean(KEY_SAW_ROW, true)
                .apply();
    }

    /**
     * The server answered with no row.
     *
     * NAMED FOR WHAT WAS OBSERVED, not for what it might mean. An earlier
     * version of this method was called markUnrecognised(), and that name walked
     * straight into the screen as an accusation: `glance_for` returns nothing
     * both for a code it does not know AND for a good code whose account has not
     * written a glance line yet. It cannot tell the two apart, and neither can
     * this flag, so it does not pretend to.
     */
    void markNoRow() {
        prefs.edit().putBoolean(KEY_SAW_ROW, false).apply();
    }

    /** Whether the last completed call came back with a row. */
    boolean sawRow() {
        return prefs.getBoolean(KEY_SAW_ROW, true);
    }

    String title() {
        return prefs.getString(KEY_TITLE, "");
    }

    String body() {
        return prefs.getString(KEY_BODY, "");
    }

    /** The list of open projects, or "" — then the widget shows title and body. */
    String lines() {
        return prefs.getString(KEY_LINES, "");
    }

    /** Milliseconds, or 0 when nothing has ever been read. */
    long asOfMs() {
        return prefs.getLong(KEY_AS_OF, 0L);
    }

    boolean haveReading() {
        return asOfMs() > 0L;
    }
}
