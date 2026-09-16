package io.github.saad_jameel.probeing.glance;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import io.github.saad_jameel.probeing.R;

/**
 * Typing the pairing code in, once. This is the only screen the APK owns; every
 * other screen is the PWA itself, running in Chrome.
 *
 * The code is shown by ProBeing's own Settings screen, on a device that is
 * already signed in. Typing it here is what tells Supabase that this phone may
 * read that account's glance — and reading the glance is the entire extent of
 * what it then permits.
 *
 * THE CODE IS NEVER SHOWN BACK. When one is already stored the screen says so in
 * words and leaves the box empty, rather than filling it in. A widget is looked
 * at over someone's shoulder on a train; the app's own Settings, behind a sign
 * in, is the right place to read a credential.
 */
public class PairingActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.glance_pairing);
        setTitle("Pair the ProBeing widget");

        final GlanceStore store = new GlanceStore(this);
        final EditText input = findViewById(R.id.glance_secret_input);
        TextView status = findViewById(R.id.glance_pair_status);
        Button save = findViewById(R.id.glance_pair_save);
        Button remove = findViewById(R.id.glance_pair_remove);

        if (!store.paired()) {
            status.setText("Not paired yet.");
            remove.setVisibility(View.GONE);
        } else if (!store.sawRow()) {
            /* NOT "the code is wrong" — the server cannot tell us that.
             * glance_for() answers with nothing both for a code it does not know
             * and for a good code whose account has not written a glance line
             * yet, deliberately, so that it cannot be used to confirm valid
             * codes one guess at a time. So this offers the free remedy first
             * and only then suggests the code might be at fault. */
            status.setText("A code is stored, but nothing has come back yet. "
                    + "Open ProBeing once — it writes the line this reads. "
                    + "If it stays empty, re-enter the code below.");
        } else {
            status.setText("A code is already stored. Entering a new one replaces it.");
        }

        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String typed = input.getText().toString().trim();
                if (typed.length() == 0) {
                    Toast.makeText(PairingActivity.this,
                            "Enter the code from ProBeing's Settings screen.",
                            Toast.LENGTH_SHORT).show();
                    return;
                }
                store.pair(typed);
                refreshWidgets();
                Toast.makeText(PairingActivity.this,
                        "Paired. The widget will fill in shortly.",
                        Toast.LENGTH_SHORT).show();
                finish();
            }
        });

        remove.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                store.unpair();
                refreshWidgets();
                Toast.makeText(PairingActivity.this,
                        "Pairing removed. The widget will stop reading.",
                        Toast.LENGTH_SHORT).show();
                finish();
            }
        });
    }

    /** Ask every placed widget to read again, so the screen behind this one is
     *  already right by the time it is visible. */
    private void refreshWidgets() {
        Intent refresh = new Intent(this, GlanceWidget.class);
        refresh.setAction(GlanceWidget.ACTION_REFRESH);
        refresh.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS,
                AppWidgetManager.getInstance(this).getAppWidgetIds(
                        new ComponentName(this, GlanceWidget.class)));
        sendBroadcast(refresh);
    }
}
