package io.github.saad_jameel.probeing.watch;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;

import io.github.saad_jameel.probeing.glance.Supabase;

/**
 * The activity-ingest Edge Function, as the laptop's watch.ps1 calls it: the anon
 * key to pass the gateway, the device token to say which device. Nothing here
 * is logged; an error keeps only the server's own words, which never carry the
 * token.
 */
final class Ingest {

    private static final String PATH = "/functions/v1/activity-ingest";
    private static final int TIMEOUT_MS = 30000;

    /** The server said no (401/403: not paired any more), or it could not be reached. */
    static final class Failed extends Exception {
        final int status;

        Failed(int status, String why) {
            super(why);
            this.status = status;
        }
    }

    private Ingest() {
    }

    static JSONObject config(String token, long from) throws Failed {
        try {
            return call(token, new JSONObject().put("op", "config").put("from", PhoneRules.iso(from)));
        } catch (Failed f) {
            throw f;
        } catch (Exception e) {
            throw new Failed(0, "could not build the request");
        }
    }

    static JSONObject ingest(String token, List<PhoneRules.Block> blocks) throws Failed {
        try {
            JSONArray list = new JSONArray();
            for (PhoneRules.Block b : blocks) {
                // These seven fields and nothing else, as actPayload sends.
                list.put(new JSONObject().put("start", PhoneRules.iso(b.start)).put("end", PhoneRules.iso(b.end))
                        .put("app", b.app).put("domain", b.domain).put("category", b.category)
                        .put("project", b.project).put("key", b.key));
            }
            return call(token, new JSONObject().put("op", "ingest").put("blocks", list));
        } catch (Failed f) {
            throw f;
        } catch (Exception e) {
            throw new Failed(0, "could not build the request");
        }
    }

    private static JSONObject call(String token, JSONObject body) throws Failed {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(Supabase.URL + PATH).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setUseCaches(false);
            conn.setDoOutput(true);
            conn.setRequestProperty("apikey", Supabase.ANON_KEY);
            conn.setRequestProperty("Authorization", "Bearer " + Supabase.ANON_KEY);
            conn.setRequestProperty("x-device-token", token);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream out = conn.getOutputStream();
            try {
                out.write(bytes);
            } finally {
                out.close();
            }
            int status = conn.getResponseCode();
            InputStream in = status >= 200 && status <= 299 ? conn.getInputStream() : conn.getErrorStream();
            String text = in == null ? "" : readAll(in);
            JSONObject res;
            try {
                res = new JSONObject(text);
            } catch (Exception e) {
                res = new JSONObject();
            }
            if (status < 200 || status > 299 || !res.optBoolean("ok", false)) {
                String why = res.optString("error", "");
                throw new Failed(status, why.isEmpty() ? "ProBeing answered " + status : why);
            }
            return res;
        } catch (Failed f) {
            throw f;
        } catch (Exception e) {
            // No detail: an exception's message can carry the request.
            throw new Failed(0, "could not reach ProBeing");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        try {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) != -1) {
                buf.write(chunk, 0, n);
                if (buf.size() > 2_000_000) break;
            }
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }
}
