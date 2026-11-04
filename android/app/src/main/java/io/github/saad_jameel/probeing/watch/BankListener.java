package io.github.saad_jameel.probeing.watch;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Item 40: his bank alerts, read off the notifications Android shows (HBL Mobile, easypaisa, JazzCash, and the
 * Messages notification from HBL's SMS sender 14250). Every other notification is ignored unread. Each alert is
 * held on the phone with every run of 7+ digits blanked (account, phone and transaction numbers) and a sha256 of
 * its raw text for dedupe, then sent to activity-ingest (op 'bank'), which reads the amount and the way it went.
 */
public final class BankListener extends NotificationListenerService {

    private static final String FILE = "probeing_bank_queue";
    private static final String KEY_QUEUE = "queue";
    private static final int QUEUE_MAX = 200;
    static final String SMS_SENDER = "14250";
    private static final String[] BANK_WORDS = { "hbl", "easypaisa", "jazzcash" };

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            Notification n = sbn.getNotification();
            if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;   // HBL groups several
            Bundle x = n.extras;
            String title = text(x.getCharSequence(Notification.EXTRA_TITLE));
            CharSequence big = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
            String body = text(big != null ? big : x.getCharSequence(Notification.EXTRA_TEXT));
            String app = label(this, sbn.getPackageName());
            if (!isBank(app, title) || body.isEmpty()) return;
            hold(this, app, title, body, sbn.getPostTime());
            Send.now(this);
        } catch (Exception e) {
            // A notification it cannot read is skipped; the bank's app still has it.
        }
    }

    /** One of his banks' apps, or the SMS sender. */
    static boolean isBank(String app, String title) {
        if (SMS_SENDER.equals(title.trim())) return true;
        String a = app.toLowerCase(Locale.ROOT).replaceAll("[^a-z]", "");
        for (String w : BANK_WORDS) if (a.contains(w)) return true;
        return false;
    }

    private static String text(CharSequence c) {
        return c == null ? "" : c.toString().replaceAll("\\s+", " ").trim();
    }

    private static String label(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(ai));
        } catch (Exception e) {
            return pkg;
        }
    }

    static String blank(String s) {
        return s.replaceAll("[0-9]{7,}", "#");
    }

    static String sha256(String s) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** Held until the server has it: blanked text only, never the raw one. */
    static synchronized void hold(Context ctx, String app, String title, String body, long at) throws Exception {
        JSONArray q = new JSONArray(prefs(ctx).getString(KEY_QUEUE, "[]"));
        String key = sha256(app + "|" + title + "|" + body);
        for (int i = 0; i < q.length(); i++) if (key.equals(q.getJSONObject(i).optString("key"))) return;
        q.put(new JSONObject().put("app", app).put("title", blank(title)).put("text", blank(body))
                .put("at", PhoneRules.iso(at)).put("key", key));
        while (q.length() > QUEUE_MAX) q.remove(0);
        prefs(ctx).edit().putString(KEY_QUEUE, q.toString()).apply();
    }

    static synchronized JSONArray held(Context ctx) throws Exception {
        return new JSONArray(prefs(ctx).getString(KEY_QUEUE, "[]"));
    }

    /** Drop the ones the server took (the first `n`, sent in order). */
    static synchronized void took(Context ctx, JSONArray sent) throws Exception {
        JSONArray q = held(ctx);
        JSONArray keep = new JSONArray();
        for (int i = 0; i < q.length(); i++) {
            String k = q.getJSONObject(i).optString("key");
            boolean gone = false;
            for (int j = 0; j < sent.length(); j++) if (k.equals(sent.getJSONObject(j).optString("key"))) gone = true;
            if (!gone) keep.put(q.getJSONObject(i));
        }
        prefs(ctx).edit().putString(KEY_QUEUE, keep.toString()).apply();
    }

    /** Sends what is held, once the phone is online; also run by every watcher run. */
    public static final class Send extends Worker {
        private static final String NAME = "probeing-bank-send";

        public Send(Context ctx, WorkerParameters params) {
            super(ctx, params);
        }

        static void now(Context ctx) {
            Constraints online = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
            WorkManager.getInstance(ctx).enqueueUniqueWork(NAME, ExistingWorkPolicy.REPLACE,
                    new OneTimeWorkRequest.Builder(Send.class).setConstraints(online).build());
        }

        /** True when nothing is left to send. */
        static boolean flush(Context ctx) {
            try {
                String token = new PhoneStore(ctx).token();
                JSONArray q = held(ctx);
                if (token.isEmpty() || q.length() == 0) return q.length() == 0;
                JSONArray batch = new JSONArray();
                for (int i = 0; i < q.length() && i < 50; i++) batch.put(q.getJSONObject(i));
                Ingest.bank(token, batch);
                took(ctx, batch);
                return held(ctx).length() == 0;
            } catch (Exception e) {
                return false;
            }
        }

        @Override
        public Result doWork() {
            return flush(getApplicationContext()) ? Result.success() : Result.retry();
        }
    }
}
