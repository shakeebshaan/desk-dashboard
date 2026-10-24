package io.github.shakeebshaan.deskdashboard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Starts the dashboard after a reboot. Android 10+ only lets this through when the app is the Home app or has
 * "Display over other apps"; setting it as the Home app is the reliable way.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(a)) return;
        Intent i = new Intent(context, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        try {
            context.startActivity(i);
        } catch (Exception ignored) {
            // blocked by background-start limits; the Home-app setting covers it
        }
    }
}
