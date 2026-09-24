package io.github.saad_jameel.probeing.glance;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.StyleSpan;
import android.widget.RemoteViews;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.github.saad_jameel.probeing.LauncherActivity;
import io.github.saad_jameel.probeing.R;

/**
 * The home-screen widget. LOOK-ONLY, and that is a decision rather than a first
 * version: the widget can read two lines of text and do nothing else.
 *
 * WHY THERE ARE NO M OR PRAYER BUTTONS HERE. Rule 4 says a logging action stays
 * under five seconds, and a widget button would beat that — which is exactly why
 * it is tempting. The cost is the other side of the trade: a button that writes
 * needs a credential that can write, sitting in an APK on a phone, reachable
 * from a lock screen. A secret that can only ever fetch two strings is a secret
 * worth storing on a device. If M-from-the-home-screen is ever wanted, it needs
 * its own decision about what that secret is allowed to do — not an extra
 * button on this one.
 *
 * TAP TARGETS, all three of them openers:
 *   · the two text lines  → open ProBeing (or the pairing screen, but only when
 *                           no code has ever been entered)
 *   · the ↻ chip          → fetch again now
 *   · the "as of" line    → the pairing screen, which is how to replace a code
 *
 * REFRESHING, and what is honestly achievable. Three triggers, in order of how
 * much they can be relied on:
 *   1. Android's own widget update, floored by the platform at 30 minutes.
 *   2. The ↻ chip, which is immediate and always works.
 *   3. Unlocking the phone — best-effort only, see registerUnlock() below.
 */
public class GlanceWidget extends AppWidgetProvider {

    static final String ACTION_REFRESH = "io.github.saad_jameel.probeing.glance.REFRESH";

    /** One thread, so two overlapping updates cannot race to paint. */
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private static BroadcastReceiver unlockReceiver;

    @Override
    public void onReceive(Context context, Intent intent) {
        // First, so the framework still routes onUpdate/onEnabled/onDeleted.
        super.onReceive(context, intent);

        String action = intent.getAction();
        if (ACTION_REFRESH.equals(action)
                || AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action)) {
            refreshAsync(context);
        }
    }

    /**
     * Paints what is already stored, with no network call. This runs first and
     * finishes instantly, so a widget that has just been added, resized or
     * brought back after a reboot shows its last known reading rather than a
     * blank box while the network is tried.
     */
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        registerUnlock(context);
        paint(context, manager, widgetIds, GlanceWords.Problem.NONE);
    }

    /** Resized: repaint that widget, since its height picks list or two lines. */
    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
                                          int widgetId, Bundle newOptions) {
        paint(context, manager, new int[] {widgetId}, GlanceWords.Problem.NONE);
    }

    @Override
    public void onEnabled(Context context) {
        registerUnlock(context);
    }

    @Override
    public void onDisabled(Context context) {
        unregisterUnlock(context);
    }

    /**
     * Fetch, store, repaint — off the main thread.
     *
     * goAsync() is what buys the time: without it Android considers the
     * broadcast finished the moment onReceive returns and may kill the process
     * mid-request. With it there is roughly ten seconds, which is why the
     * timeouts in GlanceFetcher are six.
     */
    private void refreshAsync(Context context) {
        final PendingResult pending = goAsync();
        final Context app = context.getApplicationContext();
        IO.execute(new Runnable() {
            @Override
            public void run() {
                GlanceWords.Problem problem = GlanceWords.Problem.NONE;
                try {
                    GlanceStore store = new GlanceStore(app);
                    if (store.paired()) {
                        GlanceFetcher.Result result = GlanceFetcher.fetch(store.secret());
                        switch (result.outcome) {
                            case OK:
                                store.saveReading(result.title, result.body,
                                        result.lines, result.asOfMs);
                                break;
                            case NO_ROW:
                                // Recorded as "no row came back", NOT as "wrong
                                // code" — the server cannot tell us which.
                                store.markNoRow();
                                break;
                            case UNDATED:
                                problem = GlanceWords.Problem.UNDATED;
                                break;
                            default:
                                problem = GlanceWords.Problem.OFFLINE;
                                break;
                        }
                    }
                    AppWidgetManager manager = AppWidgetManager.getInstance(app);
                    int[] ids = manager.getAppWidgetIds(
                            new ComponentName(app, GlanceWidget.class));
                    paint(app, manager, ids, problem);
                } finally {
                    // In a finally, always: leaving a PendingResult unfinished
                    // leaks the broadcast and Android eventually complains about
                    // it in a way that looks like a crash.
                    pending.finish();
                }
            }
        });
    }

    private static void paint(Context context, AppWidgetManager manager,
                              int[] widgetIds, GlanceWords.Problem problem) {
        if (widgetIds == null || widgetIds.length == 0) {
            return;
        }
        GlanceStore store = new GlanceStore(context);

        GlanceWords.State state;
        if (!store.paired()) {
            state = GlanceWords.State.UNPAIRED;
        } else if (!store.sawRow()) {
            state = GlanceWords.State.NO_ROW;
        } else if (!store.haveReading()) {
            state = GlanceWords.State.NO_READING;
        } else {
            state = GlanceWords.State.HAVE_READING;
        }

        GlanceWords.Lines lines = GlanceWords.lines(state, problem, store.title(),
                store.body(), store.lines(), store.asOfMs(), System.currentTimeMillis());
        float fontScale = context.getResources().getConfiguration().fontScale;

        /* Only a never-paired widget sends the main tap to the pairing screen.
         * When a code IS stored and nothing came back, the first remedy is to
         * open the app — it may simply not have written a glance line yet — so
         * the lines open ProBeing and the footer offers the code instead. */
        boolean neverPaired = state == GlanceWords.State.UNPAIRED;

        for (int id : widgetIds) {
            // A tall widget shows the list in place of the title; a short one, or
            // a day with nothing open, shows the title and body as before.
            int fit = GlanceWords.listLinesThatFit(heightDp(manager, id), fontScale);
            boolean showList = lines.list.length() > 0 && fit >= GlanceWords.LIST_MIN_LINES;

            RemoteViews views = new RemoteViews(context.getPackageName(),
                    showList ? R.layout.glance_widget_list : R.layout.glance_widget);

            // setTextViewText only ever sets plain text. This is the Android
            // side of rule 5: the project name is something the user typed, and
            // it is never handed to anything that would interpret markup.
            if (showList) {
                views.setTextViewText(R.id.glance_list,
                        boldHeading(GlanceWords.fitList(lines.list, fit)));
            } else {
                views.setTextViewText(R.id.glance_title, lines.title);
            }
            views.setTextViewText(R.id.glance_body, lines.body);
            views.setTextViewText(R.id.glance_foot, lines.foot);

            views.setOnClickPendingIntent(R.id.glance_lines,
                    neverPaired ? pairingIntent(context) : openAppIntent(context));
            views.setOnClickPendingIntent(R.id.glance_reload, refreshIntent(context));
            views.setOnClickPendingIntent(R.id.glance_foot, pairingIntent(context));

            manager.updateAppWidget(id, views);
        }
    }

    /** The widget's height in dp. MAX is the portrait height, which is how a
     *  phone home screen is held; 0 when the launcher has not said. */
    private static int heightDp(AppWidgetManager manager, int widgetId) {
        Bundle options = manager.getAppWidgetOptions(widgetId);
        if (options == null) {
            return 0;
        }
        int tall = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        return tall > 0 ? tall : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
    }

    /** The list's first line in bold, as the title is. A span only styles the
     *  text; nothing in it is read as markup. */
    private static CharSequence boldHeading(String list) {
        SpannableString text = new SpannableString(list);
        int end = list.indexOf('\n');
        if (end < 0) {
            end = list.length();
        }
        text.setSpan(new StyleSpan(Typeface.BOLD), 0, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return text;
    }

    private static PendingIntent openAppIntent(Context context) {
        Intent intent = new Intent(context, LauncherActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 1, intent, flags());
    }

    private static PendingIntent pairingIntent(Context context) {
        Intent intent = new Intent(context, PairingActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 2, intent, flags());
    }

    private static PendingIntent refreshIntent(Context context) {
        Intent intent = new Intent(context, GlanceWidget.class);
        intent.setAction(ACTION_REFRESH);
        return PendingIntent.getBroadcast(context, 3, intent, flags());
    }

    /** IMMUTABLE because nothing outside this app should be able to rewrite
     *  where these go. Required outright from Android 12 on. */
    private static int flags() {
        return PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
    }

    /**
     * Refresh when the phone is unlocked — BEST-EFFORT, and the limit is the
     * platform's rather than an unfinished job here.
     *
     * ACTION_USER_PRESENT cannot be declared in AndroidManifest.xml. Android 8
     * stopped delivering implicit broadcasts to manifest-declared receivers, and
     * this action is not on the exception list, so a <receiver> for it would
     * look right in the manifest and simply never fire. Registering at runtime
     * is the only route the platform leaves, and a runtime registration lives
     * only as long as the process does.
     *
     * So this fires when ProBeing's process happens to still be up — which is
     * the common case right after using the phone, and is exactly when the
     * server-side reading is most likely to have moved. When the process has
     * been reclaimed, the 30-minute update and the ↻ chip are what remain. The
     * alternative, a foreground service to hold the process open, costs a
     * permanent notification and battery for a widget that only looks.
     */
    private static synchronized void registerUnlock(Context context) {
        if (unlockReceiver != null) {
            return;
        }
        unlockReceiver = new UnlockReceiver();
        IntentFilter filter = new IntentFilter(Intent.ACTION_USER_PRESENT);
        Context app = context.getApplicationContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            app.registerReceiver(unlockReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            app.registerReceiver(unlockReceiver, filter);
        }
    }

    private static synchronized void unregisterUnlock(Context context) {
        if (unlockReceiver == null) {
            return;
        }
        try {
            context.getApplicationContext().unregisterReceiver(unlockReceiver);
        } catch (IllegalArgumentException ignored) {
            // Already gone with the process. Not worth reporting.
        }
        unlockReceiver = null;
    }

    /** Turns an unlock into the same refresh the ↻ chip sends. */
    public static final class UnlockReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            Intent refresh = new Intent(context, GlanceWidget.class);
            refresh.setAction(ACTION_REFRESH);
            context.sendBroadcast(refresh);
        }
    }
}
