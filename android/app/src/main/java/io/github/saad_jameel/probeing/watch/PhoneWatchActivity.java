package io.github.saad_jameel.probeing.watch;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.format.DateUtils;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.github.saad_jameel.probeing.R;

/**
 * "Phone activity": the one screen for the phone watcher. Says what is read,
 * opens Android's Usage access page, and pairs the phone. ProBeing's Settings
 * opens it with the new token (probeing://pair-phone, extra "token"); it can
 * also be pasted. A token is checked with the server before it is kept, and is
 * never shown back.
 */
public class PhoneWatchActivity extends Activity {

    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private PhoneStore store;
    private String offered = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.phone_watch);
        setTitle(R.string.phone_watch_title);
        store = new PhoneStore(this);
        takeToken(getIntent());

        findViewById(R.id.phone_usage_btn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openUsageAccess();
            }
        });
        findViewById(R.id.phone_offer_btn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pair(offered);
            }
        });
        findViewById(R.id.phone_paste_btn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                EditText box = findViewById(R.id.phone_token_input);
                pair(box.getText().toString());
            }
        });
        findViewById(R.id.phone_send_btn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                WatchWorker.runNow(PhoneWatchActivity.this);
                say(getString(R.string.phone_send_queued));
            }
        });
        findViewById(R.id.phone_stop_btn).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                WatchWorker.stop(PhoneWatchActivity.this);
                store.unpair();
                say(getString(R.string.phone_stopped));
                refresh();
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeToken(intent);
        refresh();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    /** A token handed over by ProBeing's Settings waits for his Pair press. */
    private void takeToken(Intent intent) {
        String t = intent == null ? null : intent.getStringExtra("token");
        offered = tokenText(t);
        setIntent(new Intent(this, PhoneWatchActivity.class));
    }

    /** As the server reads it: letters and digits, upper case. */
    static String tokenText(String t) {
        return (t == null ? "" : t).replaceAll("[^0-9A-Za-z]", "").toUpperCase(java.util.Locale.ROOT);
    }

    private void refresh() {
        boolean usage = UsageReader.allowed(this);
        boolean paired = store.hasToken();
        TextView status = findViewById(R.id.phone_status);
        StringBuilder sb = new StringBuilder();
        sb.append(usage ? getString(R.string.phone_usage_on) : getString(R.string.phone_usage_off)).append('\n');
        if (paired) {
            String label = store.label();
            sb.append(getString(R.string.phone_paired_as, label.isEmpty() ? "this phone" : label)).append('\n');
        } else {
            sb.append(getString(R.string.phone_not_paired)).append('\n');
        }
        if (store.lastRun() > 0) {
            sb.append(getString(R.string.phone_last_run, ago(store.lastRun()), store.lastNote()));
        }
        status.setText(sb.toString().trim());
        ((Button) findViewById(R.id.phone_usage_btn)).setText(usage ? R.string.phone_usage_btn_again
                : R.string.phone_usage_btn);
        findViewById(R.id.phone_offer_box).setVisibility(offered.length() >= 24 ? View.VISIBLE : View.GONE);
        ((TextView) findViewById(R.id.phone_offer_text)).setText(paired ? R.string.phone_offer_replace
                : R.string.phone_offer);
        findViewById(R.id.phone_send_btn).setVisibility(paired ? View.VISIBLE : View.GONE);
        findViewById(R.id.phone_stop_btn).setVisibility(paired ? View.VISIBLE : View.GONE);
    }

    private CharSequence ago(long ms) {
        return DateUtils.getRelativeTimeSpanString(ms, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS);
    }

    private void say(String text) {
        ((TextView) findViewById(R.id.phone_result)).setText(text);
    }

    /** Asked once of the server ("config" sends nothing), kept only if it knows the token. */
    private void pair(String typed) {
        final String token = tokenText(typed);
        if (token.length() < 24) {
            say(getString(R.string.phone_token_short));
            return;
        }
        say(getString(R.string.phone_checking));
        IO.execute(new Runnable() {
            @Override
            public void run() {
                String msg;
                boolean ok = false;
                try {
                    JSONObject cfg = Ingest.config(token, System.currentTimeMillis());
                    store.pair(token, cfg.optString("device", ""));
                    ok = true;
                    msg = getString(R.string.phone_paired_now, cfg.optString("device", "this phone"));
                } catch (Ingest.Failed f) {
                    msg = getString(R.string.phone_pair_failed, f.status == 401 || f.status == 403
                            ? getString(R.string.phone_pair_unknown) : f.getMessage());
                } catch (Exception e) {
                    msg = getString(R.string.phone_pair_failed, getString(R.string.phone_pair_store));
                }
                final String text = msg;
                final boolean done = ok;
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        if (done) {
                            offered = "";
                            ((EditText) findViewById(R.id.phone_token_input)).setText("");
                            WatchWorker.ensure(PhoneWatchActivity.this);
                            WatchWorker.runNow(PhoneWatchActivity.this);
                        }
                        say(text);
                        refresh();
                    }
                });
            }
        });
    }

    /** Android's own page; straight to ProBeing's switch where the phone allows it. */
    private void openUsageAccess() {
        Intent direct = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
        if (Build.VERSION.SDK_INT >= 29) direct.setData(Uri.parse("package:" + getPackageName()));
        try {
            startActivity(direct);
        } catch (ActivityNotFoundException | SecurityException e) {
            try {
                startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS));
            } catch (ActivityNotFoundException e2) {
                say(getString(R.string.phone_usage_missing));
            }
        }
    }
}
