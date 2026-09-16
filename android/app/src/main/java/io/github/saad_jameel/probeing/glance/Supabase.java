package io.github.saad_jameel.probeing.glance;

/**
 * SHIPPED ON PURPOSE, and safe to — these are the same two constants, kept for
 * the same reasons, as DEFAULT_SUPABASE_URL and DEFAULT_SUPABASE_ANON at the top
 * of app.js. The decision was made there first and is mirrored here rather than
 * re-argued: the app hard-codes them, so the APK may too.
 *
 * They identify the project; they do not grant access to it. Row level security
 * is what protects the rows. What this key can reach is exactly one function,
 * glance_for(secret), and only when it is handed a secret that matches a row —
 * which is why the widget can read two lines of text and nothing else.
 *
 * The alternative was asking for them at pairing time. It was rejected for the
 * reason app.js gives: a 209-character key typed on a phone is a key typed
 * wrongly, and the only credential a person should ever handle is the short one
 * they already have on screen.
 *
 * The SERVICE key is the opposite in every way and must never appear here.
 * scripts/secret_scan.sh reads *.java as well as *.js precisely so that this
 * file is covered by the same check.
 */
final class Supabase {

    static final String URL = "https://whxgzdrowvkpzpgfilof.supabase.co";

    static final String ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            + "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndoeGd6ZHJvd3ZrcHpwZ2ZpbG9mIiwicm9sZSI6"
            + "ImFub24iLCJpYXQiOjE3ODc4NDEzNDQsImV4cCI6MjEwMzQxNzM0NH0."
            + "qJyTdirLFpOu5uBsLwOWAnwWUp4lU1Ka0ZwM6Vsz3mE";

    /** The one endpoint this app calls. */
    static final String GLANCE_RPC = URL + "/rest/v1/rpc/glance_for";

    private Supabase() {
    }
}
