// Push-to-talk: speech-to-text strictly ON the phone (Android's on-device recognizer, through the OnDeviceSpeech
// plugin in APK 0.3.1+). There is no cloud fallback: if the phone has no on-device recognizer, voice input says so
// and nothing is recorded. The microphone is on only between the tap and the end of the sentence.
import { Capacitor, registerPlugin } from "../../vendor/capacitor-core.js";

const native = Capacitor.isNativePlatform() ? registerPlugin("OnDeviceSpeech") : null;

const REASONS = {
  unavailable: "Voice input needs Android's on-device speech recognition, which this phone does not have (Android 12+ with offline speech).",
  denied: "Microphone permission is off. Allow it for Dashboard in Android settings.",
  nomatch: "I didn't catch that. Tap the mic and try again.",
  language: "The on-device speech pack for English is not installed on this phone.",
  busy: "The speech recognizer is busy. Try again in a moment.",
};

function reason(e) {
  const code = e && (e.code || e.message);
  if (e && e.code === "UNIMPLEMENTED") return "Voice input needs app 0.3.1.";
  return REASONS[code] || `Voice input failed (${String((e && e.message) || e).slice(0, 80)}).`;
}

// -> the recognised text ("" if nothing was said). Throws Error(reason) when voice input cannot work.
export async function listen() {
  if (!native) {
    // browser tests only: a scripted answer; a desktop browser's recognizer would send audio to a cloud
    if (typeof window.__dashTestVoice === "string") return window.__dashTestVoice;
    throw new Error("Voice input works in the phone app only.");
  }
  for (const lang of ["en-IN", "en-US"]) {
    try {
      const r = await native.listen({ lang });
      return String((r && r.text) || "").trim();
    } catch (e) {
      if (e && e.code === "language" && lang !== "en-US") continue; // no Indian English pack: try US English
      if (e && e.code === "nomatch") return "";
      throw new Error(reason(e));
    }
  }
  throw new Error(REASONS.language);
}

export function stopListening() {
  if (native) native.stop().catch(() => {});
}
