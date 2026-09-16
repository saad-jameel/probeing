package io.github.saad_jameel.probeing.glance;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.HttpsURLConnection;

/**
 * One HTTPS call, to one endpoint, reading two lines of text. That is the whole
 * of what this APK can do to the database.
 *
 * ON CONTENT-TYPE, BECAUSE THE REPO'S RULE 1 SAYS THE OPPOSITE. app.js must post
 * as text/plain, and that rule is about Apps Script: application/json triggers a
 * CORS preflight OPTIONS that an Apps Script web app cannot answer. Neither half
 * of that applies here. This is Supabase's PostgREST, which requires
 * application/json, and it is a native HTTP call with no browser and therefore
 * no preflight at all. Do not "fix" this to text/plain — PostgREST would reject
 * the body.
 *
 * NOTHING HERE IS LOGGED. Not the secret, not the request, not the response.
 * logcat is readable by anything plugged into the phone.
 */
final class GlanceFetcher {

    /** Short on purpose. This runs inside a broadcast, which Android gives about
     *  ten seconds before it kills the process; two of these plus overhead has
     *  to fit inside that. A widget that times out keeps its last reading, which
     *  is a better outcome than a widget that is killed mid-paint. */
    private static final int CONNECT_TIMEOUT_MS = 6000;
    private static final int READ_TIMEOUT_MS = 6000;

    enum Outcome {
        /** A row came back, carrying a timestamp that could be read. */
        OK,
        /**
         * The call succeeded and returned no row.
         *
         * THIS IS NOT "WRONG CODE", however much it looks like it. `glance_for`
         * answers with an empty array both for a secret it does not recognise
         * and for a recognised secret whose account has not written a glance
         * line yet — and the two are deliberately indistinguishable, so that the
         * function cannot be used to confirm valid codes one guess at a time.
         *
         * The name says what was observed rather than what it might mean, so
         * that the screen cannot quietly start accusing people. GlanceWords is
         * where the wording that covers both cases lives.
         */
        NO_ROW,
        /** A row came back whose "as_of" could not be read. Separate from
         *  FAILED because the network was fine, and telling someone to check
         *  their signal over a data problem wastes their time. */
        UNDATED,
        /** Could not reach Supabase, or it refused. */
        FAILED
    }

    static final class Result {
        final Outcome outcome;
        final String title;
        final String body;
        final long asOfMs;

        private Result(Outcome outcome, String title, String body, long asOfMs) {
            this.outcome = outcome;
            this.title = title;
            this.body = body;
            this.asOfMs = asOfMs;
        }

        static Result of(Outcome outcome) {
            return new Result(outcome, "", "", 0L);
        }
    }

    private GlanceFetcher() {
    }

    static Result fetch(String secret) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(Supabase.GLANCE_RPC);
            conn = (HttpsURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setUseCaches(false);
            conn.setDoOutput(true);

            conn.setRequestProperty("apikey", Supabase.ANON_KEY);
            // Sent alongside the apikey because that is what supabase-js sends,
            // and PostgREST reads the role from this header. Both name the anon
            // key, so this grants nothing extra; it only stops the request
            // depending on which of the two the gateway happens to prefer.
            conn.setRequestProperty("Authorization", "Bearer " + Supabase.ANON_KEY);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Accept", "application/json");

            // JSONObject, not string concatenation: the secret is typed by hand
            // and a stray quote would otherwise build a broken request.
            JSONObject payload = new JSONObject();
            payload.put("secret", secret);
            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);

            OutputStream out = conn.getOutputStream();
            try {
                out.write(bytes);
            } finally {
                out.close();
            }

            int status = conn.getResponseCode();
            if (status < 200 || status > 299) {
                return Result.of(Outcome.FAILED);
            }

            String text = readAll(conn.getInputStream());
            return parse(text);
        } catch (Exception e) {
            // Deliberately swallowed without detail: an exception message can
            // carry the URL and the request, and this one is not worth a log
            // line that might carry the secret with it. The widget says
            // "offline" and keeps its last reading, which is all the user needs.
            return Result.of(Outcome.FAILED);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /**
     * A function returning a table comes back as a JSON array of zero or one
     * objects. An object on its own is accepted too, so that a later change from
     * `returns table` to `returns json` does not silently blank the widget.
     */
    private static Result parse(String text) {
        try {
            String t = text.trim();
            JSONObject row;
            if (t.startsWith("[")) {
                JSONArray rows = new JSONArray(t);
                if (rows.length() == 0) {
                    return Result.of(Outcome.NO_ROW);
                }
                row = rows.getJSONObject(0);
            } else if (t.startsWith("{")) {
                row = new JSONObject(t);
                // An error body is also an object; PostgREST puts a message in
                // it and never a title.
                if (!row.has("title") && !row.has("body")) {
                    return Result.of(Outcome.NO_ROW);
                }
            } else {
                return Result.of(Outcome.FAILED);
            }

            String title = row.optString("title", "");
            String body = row.optString("body", "");
            long asOf = GlanceWords.parseAsOf(row.optString("as_of", ""));

            // A row we cannot date is a row we will not show: an undateable
            // figure is exactly what 7b forbids. Reported as its own outcome
            // rather than as a network failure, because the network was fine.
            if (asOf == 0L) {
                return Result.of(Outcome.UNDATED);
            }
            return new Result(Outcome.OK, title, body, asOf);
        } catch (Exception e) {
            return Result.of(Outcome.FAILED);
        }
    }

    private static String readAll(InputStream in) throws Exception {
        try {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) != -1) {
                buffer.write(chunk, 0, n);
                // A glance is two short lines. Anything past this is not an
                // answer we asked for, and is not worth holding in memory.
                if (buffer.size() > 64 * 1024) {
                    break;
                }
            }
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }
}
