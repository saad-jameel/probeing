package io.github.saad_jameel.probeing.watch;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;

/**
 * One run of the phone watcher, the same steps as the laptop's watch.ps1: ask
 * ProBeing when he was working, read which app was on screen in those minutes,
 * send the blocks. Android runs it every 15 minutes (its floor), and sooner
 * while a distraction is on screen (PhoneRules.followUpMs).
 */
public final class WatchWorker extends Worker {

    private static final String PERIODIC = "probeing-phone-watch";
    private static final String FOLLOW_UP = "probeing-phone-follow-up";
    private static final String NOW = "probeing-phone-now";

    private static final long FIRST_LOOK_MS = 30 * PhoneRules.MIN;      // as watch.ps1
    private static final long LOOK_MAX_MS = 24 * 60 * PhoneRules.MIN;
    private static final long EVENTS_BEFORE_MS = 3 * 60 * PhoneRules.MIN; // to know what was in front at `from`
    private static final int INGEST_MAX = 500;

    // A periodic run and a follow-up may start together; one at a time.
    private static final Object LOCK = new Object();

    public WatchWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** Every 15 minutes, while paired. Safe to call again: it keeps the schedule. */
    public static void ensure(Context context) {
        if (!new PhoneStore(context).hasToken()) return;
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(WatchWorker.class, 15, TimeUnit.MINUTES,
                5, TimeUnit.MINUTES).setConstraints(online()).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, req);
    }

    /** One run now (after pairing, or "Send now"). */
    static void runNow(Context context) {
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(WatchWorker.class).setConstraints(online()).build();
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, req);
    }

    static void stop(Context context) {
        WorkManager wm = WorkManager.getInstance(context);
        wm.cancelUniqueWork(PERIODIC);
        wm.cancelUniqueWork(FOLLOW_UP);
        wm.cancelUniqueWork(NOW);
    }

    private static void followUp(Context context, long delayMs) {
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(WatchWorker.class)
                .setInitialDelay(delayMs, TimeUnit.MILLISECONDS).setConstraints(online()).build();
        WorkManager.getInstance(context).enqueueUniqueWork(FOLLOW_UP, ExistingWorkPolicy.REPLACE, req);
    }

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        long follow;
        synchronized (LOCK) {
            follow = runOnce(ctx);
        }
        if (follow > 0) followUp(ctx, follow);
        return Result.success();
    }

    /** One run; returns the follow-up delay, or -1. Notes what it did in words. */
    static long runOnce(Context ctx) {
        PhoneStore store = new PhoneStore(ctx);
        long now = System.currentTimeMillis();
        String token = store.token();
        if (token.isEmpty()) {
            store.noteRun(now, "Not paired.");
            return -1;
        }
        if (!UsageReader.allowed(ctx)) {
            store.noteRun(now, "Usage access is off, so nothing was read.");
            return -1;
        }
        long from = store.sentUntil() > 0 ? store.sentUntil() : now - FIRST_LOOK_MS;
        if (from < now - LOOK_MAX_MS) from = now - LOOK_MAX_MS;
        if (from > now) from = now;
        try {
            JSONObject cfg = Ingest.config(token, from);
            String label = cfg.optString("device", "");
            if (!label.isEmpty()) store.setLabel(label);
            List<long[]> spans = new ArrayList<>();
            JSONArray s = cfg.optJSONArray("spans");
            for (int i = 0; s != null && i < s.length(); i++) {
                JSONArray p = s.optJSONArray(i);
                if (p == null) continue;
                long a = parseIso(p.optString(0));
                long b = parseIso(p.optString(1));
                if (a > 0 && b > a) spans.add(new long[]{a, b});
            }
            spans = PhoneRules.mergeSpans(spans);
            if (PhoneRules.intersect(from, now, spans).isEmpty()) {
                store.noteSent(now, Math.max(from, now - 2 * PhoneRules.MIN));
                store.noteRun(now, "Not working, so nothing was read.");
                return -1;
            }
            List<PhoneRules.Event> events = UsageReader.events(ctx, from - EVENTS_BEFORE_MS, now);
            List<PhoneRules.Piece> pieces = PhoneRules.pieces(events, UsageReader.ignored(ctx), from, now, spans);
            List<PhoneRules.Block> blocks = PhoneRules.phoneBlocks(pieces, UsageReader.labels(ctx, pieces),
                    cfgOf(cfg));
            int stored = 0;
            for (int i = 0; i < blocks.size(); i += INGEST_MAX) {
                JSONObject res = Ingest.ingest(token, blocks.subList(i, Math.min(blocks.size(), i + INGEST_MAX)));
                stored += res.optInt("stored", 0);
            }
            store.noteSent(now, PhoneRules.nextFrom(blocks, from, now));
            store.noteRun(now, blocks.isEmpty() ? "Working, nothing on screen to send."
                    : "Sent " + blocks.size() + " blocks (" + counts(blocks) + "), stored " + stored + ".");
            return cfg.optBoolean("working", false) ? PhoneRules.followUpMs(blocks, now) : -1;
        } catch (Ingest.Failed f) {
            String why = f.status == 401 || f.status == 403
                    ? "ProBeing does not know this phone any more (revoked?). Pair it again."
                    : "Not sent: " + f.getMessage();
            store.noteRun(now, why);
            return -1;
        } catch (Exception e) {
            store.noteRun(now, "Not sent: something went wrong reading the phone.");
            return -1;
        }
    }

    /** His lists and keyword rules, as the config answer carries them. */
    static PhoneRules.Cfg cfgOf(JSONObject cfg) {
        PhoneRules.Cfg out = new PhoneRules.Cfg();
        JSONObject l = cfg.optJSONObject("lists");
        Map<String, List<String>> lists = new HashMap<>();
        for (String k : new String[]{"distract", "private", "meeting"}) {
            JSONArray a = l == null ? null : l.optJSONArray(k);
            if (a != null) lists.put(k, strings(a));
        }
        out.lists = PhoneRules.lists(lists);
        List<String[]> rules = new ArrayList<>();
        JSONArray r = cfg.optJSONArray("rules");
        for (int i = 0; r != null && i < r.length(); i++) {
            JSONObject x = r.optJSONObject(i);
            if (x != null) rules.add(new String[]{x.optString("keyword", ""), x.optString("project", "")});
        }
        JSONArray p = cfg.optJSONArray("projects");
        out.rules = PhoneRules.rules(rules, p == null ? null : strings(p));
        return out;
    }

    private static List<String> strings(JSONArray a) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.optString(i, ""));
        return out;
    }

    private static long parseIso(String s) {
        try {
            return java.time.Instant.parse(s).toEpochMilli();
        } catch (Exception e) {
            return -1;
        }
    }

    /** "distraction 2, work 1": counts only, never an app's name. */
    private static String counts(List<PhoneRules.Block> blocks) {
        TreeMap<String, Integer> n = new TreeMap<>();
        for (PhoneRules.Block b : blocks) n.put(b.category, (n.containsKey(b.category) ? n.get(b.category) : 0) + 1);
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, Integer> e : n.entrySet()) {
            if (sb.length() > 0) sb.append(", ");
            sb.append(e.getKey()).append(' ').append(e.getValue());
        }
        return sb.toString();
    }
}
