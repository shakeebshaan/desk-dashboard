package io.github.shakeebshaan.deskdashboard;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

/**
 * Push-to-talk speech-to-text that never leaves the phone: Android's ON-DEVICE recognizer only
 * (SpeechRecognizer.createOnDeviceSpeechRecognizer, Android 12+). There is deliberately no fallback to the normal
 * recognizer, which may send audio to a cloud service. Phones without an on-device recognizer get
 * "unavailable" and nothing is recorded. The microphone is open only between listen() and the end of the sentence.
 *
 * Errors are rejected with a code the UI understands (voice.js): unavailable, denied, nomatch, language, busy, error.
 */
@CapacitorPlugin(name = "OnDeviceSpeech", permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") })
public class OnDeviceSpeechPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private PluginCall active;

    private boolean onDeviceAvailable() {
        return Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext());
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("onDevice", onDeviceAvailable());
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    @PluginMethod
    public void listen(PluginCall call) {
        if (!onDeviceAvailable()) {
            call.reject("no on-device speech recognizer", "unavailable");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermission");
            return;
        }
        start(call);
    }

    @PermissionCallback
    private void micPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) start(call);
        else call.reject("microphone permission denied", "denied");
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    private void finish() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
        active = null;
    }

    private void start(PluginCall call) {
        final String lang = call.getString("lang", "en-IN");
        getActivity().runOnUiThread(() -> {
            if (active != null) active.reject("listening was restarted", "busy");
            finish();
            active = call;
            recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onResults(Bundle results) {
                    ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    JSObject r = new JSObject();
                    r.put("text", list != null && !list.isEmpty() ? list.get(0) : "");
                    PluginCall c = active;
                    finish();
                    if (c != null) c.resolve(r);
                }

                @Override public void onError(int error) {
                    String code;
                    switch (error) {
                        case SpeechRecognizer.ERROR_NO_MATCH:
                        case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: code = "nomatch"; break;
                        case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: code = "denied"; break;
                        case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: code = "busy"; break;
                        case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                        case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: code = "language"; break;
                        default: code = "error";
                    }
                    PluginCall c = active;
                    finish();
                    if (c != null) c.reject("speech error " + error, code);
                }

                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onPartialResults(Bundle partialResults) {}
                @Override public void onEvent(int eventType, Bundle params) {}
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
            i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            recognizer.startListening(i);
        });
    }

    @Override
    protected void handleOnDestroy() {
        finish();
    }
}
