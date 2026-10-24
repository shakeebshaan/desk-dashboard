package io.github.shakeebshaan.deskdashboard;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Wraps the dashboard's link key (the phone's X25519 secret) with an AES-256-GCM key that lives in the Android
 * Keystore and never leaves it. The web layer stores only the wrapped blob; without this device's Keystore it is
 * useless. forget() deletes the Keystore key, which makes any stored blob unreadable for good.
 */
@CapacitorPlugin(name = "SecureKey")
public class SecureKeyPlugin extends Plugin {

    private static final String ALIAS = "dashboard-link-key-wrap";

    private SecretKey key(boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        if (!create) throw new IllegalStateException("no key");
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    @PluginMethod
    public void wrap(PluginCall call) {
        try {
            byte[] plain = Base64.decode(call.getString("data", ""), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key(true));
            byte[] ct = c.doFinal(plain);
            JSObject r = new JSObject();
            r.put("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP));
            r.put("data", Base64.encodeToString(ct, Base64.NO_WRAP));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("wrap failed");
        }
    }

    @PluginMethod
    public void unwrap(PluginCall call) {
        try {
            byte[] iv = Base64.decode(call.getString("iv", ""), Base64.NO_WRAP);
            byte[] ct = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
            byte[] plain = c.doFinal(ct);
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(plain, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("unwrap failed");
        }
    }

    @PluginMethod
    public void forget(PluginCall call) {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
            call.resolve();
        } catch (Exception e) {
            call.reject("forget failed");
        }
    }
}
