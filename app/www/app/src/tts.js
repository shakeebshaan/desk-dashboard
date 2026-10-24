// Text-to-speech on the phone itself: Android's own TextToSpeech engine through the Capacitor plugin in the APK,
// the browser's speechSynthesis elsewhere. Nothing is sent to a cloud voice.
import { Capacitor, registerPlugin } from "../../vendor/capacitor-core.js";

const native = Capacitor.isNativePlatform() ? registerPlugin("TextToSpeech") : null;
export const spoken = []; // read by the browser tests

// Rough length of an utterance, used to drive the mouth when the engine gives no word events.
export const estimateMs = (text) => Math.max(1200, (String(text).split(/\s+/).length / 2.6) * 1000);

export async function speak(text, { onWord } = {}) {
  spoken.push({ text, at: Date.now(), engine: native ? "android" : "web" });
  if (native) {
    try {
      await native.speak({ text, lang: "en-IN", rate: 1.0, pitch: 1.0, volume: 1.0, category: "playback" });
    } catch {
      await new Promise((r) => setTimeout(r, estimateMs(text)));
    }
    return;
  }
  const synth = window.speechSynthesis;
  if (!synth) return new Promise((r) => setTimeout(r, estimateMs(text)));
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    const voice = synth.getVoices().find((v) => /en[-_](IN|GB)/i.test(v.lang)) || null;
    if (voice) u.voice = voice;
    // Some engines never fire onend (or have no voices at all): cap the wait.
    const t0 = Date.now();
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, estimateMs(text) + 4000);
    u.onend = done;
    // no voice installed / engine busy: still give the caption and the mouth the length of the sentence
    u.onerror = () => { clearTimeout(t); setTimeout(resolve, Math.max(0, estimateMs(text) - (Date.now() - t0))); };
    u.onboundary = (e) => onWord && e.name === "word" && onWord(e.charIndex);
    synth.cancel();
    synth.speak(u);
  });
}

export function stopSpeaking() {
  if (native) native.stop().catch(() => {});
  else window.speechSynthesis && window.speechSynthesis.cancel();
}
