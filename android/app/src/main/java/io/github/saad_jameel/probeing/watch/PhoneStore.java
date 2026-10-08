package io.github.saad_jameel.probeing.watch;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The phone watcher's memory, in the app's private storage. The device token is
 * encrypted with a key that lives in the Android Keystore and never leaves it,
 * so a copied prefs file (or a backup restored elsewhere) holds nothing usable:
 * that phone just reads as not paired. The token is never logged or shown.
 */
final class PhoneStore {

    private static final String FILE = "probeing_phone_watch";
    private static final String KEY_ALIAS = "probeing_watch_token";
    private static final String KEY_TOKEN = "token_sealed";
    private static final String KEY_LABEL = "device_label";
    private static final String KEY_SENT_UNTIL = "sent_until_ms";
    private static final String KEY_LAST_RUN = "last_run_ms";
    private static final String KEY_LAST_SENT = "last_sent_ms";
    private static final String KEY_LAST_NOTE = "last_note";

    private final SharedPreferences prefs;

    PhoneStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** "" when not paired, or when the sealed token cannot be opened here. */
    String token() {
        String sealed = prefs.getString(KEY_TOKEN, "");
        if (sealed.isEmpty()) return "";
        try {
            int dot = sealed.indexOf(':');
            byte[] iv = Base64.decode(sealed.substring(0, dot), Base64.NO_WRAP);
            byte[] body = Base64.decode(sealed.substring(dot + 1), Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
            return new String(c.doFinal(body), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    boolean paired() {
        return !token().isEmpty();
    }

    /** A token is stored (not opened: cheap enough for app start). */
    boolean hasToken() {
        return !prefs.getString(KEY_TOKEN, "").isEmpty();
    }

    /** A new pairing starts from scratch: nothing it sends predates it. */
    void pair(String token, String label) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key(true));
        byte[] body = c.doFinal(token.getBytes(StandardCharsets.UTF_8));
        String sealed = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":"
                + Base64.encodeToString(body, Base64.NO_WRAP);
        prefs.edit().clear().putString(KEY_TOKEN, sealed).putString(KEY_LABEL, label == null ? "" : label).apply();
    }

    void unpair() {
        prefs.edit().clear().apply();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(KEY_ALIAS);
        } catch (Exception e) {
            // The prefs are gone, so the token is unreadable either way.
        }
    }

    private static SecretKey key(boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return (SecretKey) ks.getKey(KEY_ALIAS, null);
        if (!create) throw new IllegalStateException("no key");
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    String label() {
        return prefs.getString(KEY_LABEL, "");
    }

    void setLabel(String label) {
        prefs.edit().putString(KEY_LABEL, label == null ? "" : label).apply();
    }

    /** 0 when nothing has been sent yet. */
    long sentUntil() {
        return prefs.getLong(KEY_SENT_UNTIL, 0L);
    }

    long lastRun() {
        return prefs.getLong(KEY_LAST_RUN, 0L);
    }

    long lastSent() {
        return prefs.getLong(KEY_LAST_SENT, 0L);
    }

    /** What the last run did, in words (counts and times, never a name). */
    String lastNote() {
        return prefs.getString(KEY_LAST_NOTE, "");
    }

    void noteRun(long at, String note) {
        prefs.edit().putLong(KEY_LAST_RUN, at).putString(KEY_LAST_NOTE, note).apply();
    }

    void noteSent(long at, long sentUntil) {
        prefs.edit().putLong(KEY_LAST_SENT, at).putLong(KEY_SENT_UNTIL, sentUntil).apply();
    }

    void setSentUntil(long ms) {
        prefs.edit().putLong(KEY_SENT_UNTIL, ms).apply();
    }
}
