package io.github.shakeebshaan.deskdashboard;

import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

/** Kiosk dashboard: screen always on, full screen (immersive), sound allowed without a tap (alarms). */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureKeyPlugin.class); // Android Keystore wrap for the link key (keyvault.js)
        registerPlugin(OnDeviceSpeechPlugin.class); // push-to-talk, on-device speech recognition only (voice.js)
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WebSettings ws = getBridge().getWebView().getSettings();
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setGeolocationEnabled(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        hideSystemBars();
    }

    @Override
    public void onResume() {
        super.onResume();
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    // Back does nothing: this is the desk screen, not an app to leave by accident.
    @Override
    public void onBackPressed() {}

    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View decor = getWindow().getDecorView();
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), decor);
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
