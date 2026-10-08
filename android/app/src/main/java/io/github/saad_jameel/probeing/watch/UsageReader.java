package io.github.saad_jameel.probeing.watch;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Process;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Which app was on screen, from Android's usage history ("Usage access"). Only
 * the package and the moments it came and went: Android gives this permission
 * no screen content and no notification text, and none is asked for.
 */
final class UsageReader {

    private UsageReader() {
    }

    /** Has he switched on Usage access for ProBeing? */
    static boolean allowed(Context context) {
        AppOpsManager ops = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        if (ops == null) return false;
        int mode;
        if (Build.VERSION.SDK_INT >= 29) {
            mode = ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(),
                    context.getPackageName());
        } else {
            mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.getPackageName());
        }
        if (mode == AppOpsManager.MODE_DEFAULT) {
            return context.checkCallingOrSelfPermission(android.Manifest.permission.PACKAGE_USAGE_STATS)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    /** The events from `from` to `to`, oldest first, only the kinds PhoneRules reads. */
    static List<PhoneRules.Event> events(Context context, long from, long to) {
        List<PhoneRules.Event> out = new ArrayList<>();
        UsageStatsManager usm = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return out;
        UsageEvents list = usm.queryEvents(from, to);
        if (list == null) return out;
        UsageEvents.Event e = new UsageEvents.Event();
        while (list.hasNextEvent()) {
            list.getNextEvent(e);
            int t = e.getEventType();
            if (t == PhoneRules.RESUMED || t == PhoneRules.PAUSED || t == PhoneRules.STOPPED
                    || t == PhoneRules.SCREEN_OFF || t == PhoneRules.KEYGUARD_SHOWN || t == PhoneRules.SHUTDOWN) {
                out.add(new PhoneRules.Event(e.getTimeStamp(), t, e.getPackageName()));
            }
        }
        return out;
    }

    /** Home screens, the system UI and ProBeing's own screens: not time on anything. */
    static Set<String> ignored(Context context) {
        Set<String> out = new HashSet<>();
        out.add(context.getPackageName());
        out.add("com.android.systemui");
        out.add("android");
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        try {
            for (ResolveInfo r : context.getPackageManager().queryIntentActivities(home, 0)) {
                if (r.activityInfo != null) out.add(r.activityInfo.packageName);
            }
        } catch (Exception e) {
            // Without the list a launcher shows up as an app; nothing worse.
        }
        return out;
    }

    /** Each package's name as the launcher shows it; the package itself when hidden. */
    static Map<String, String> labels(Context context, List<PhoneRules.Piece> pieces) {
        Map<String, String> out = new HashMap<>();
        PackageManager pm = context.getPackageManager();
        for (PhoneRules.Piece p : pieces) {
            if (out.containsKey(p.pkg)) continue;
            String name = p.pkg;
            try {
                ApplicationInfo ai = pm.getApplicationInfo(p.pkg, 0);
                CharSequence l = pm.getApplicationLabel(ai);
                if (l != null && l.length() > 0) name = l.toString();
            } catch (Exception e) {
                // Not visible to this app: keep the package name.
            }
            out.put(p.pkg, name);
        }
        return out;
    }
}
