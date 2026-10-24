// Gets a pushed UI bundle onto the phone. The hub sends a sealed {t:"ui"} frame with a link to an encrypted file on
// the relay plus its one-time key; this downloads and decrypts it and hands it to the shell, which checks the
// Ed25519 signature and version (shell/verify.js) and stores it. The new UI starts at the next quiet moment (no speech,
// no alarm ringing) by reloading; the shell then runs it on trial and rolls back if it does not report healthy.
import { unb64u } from "./securelink.js";

const MAX_WAIT_MS = 10 * 60 * 1000;
let busy = false;

const post = (link, msg) => (link && typeof link.post === "function" ? link.post(msg) : Promise.resolve(false));

function uiState() {
  const s = window.__shell.state();
  return { active: s.active, max: s.max };
}

export async function onUiBundle(m, { link, isQuiet = () => true }) {
  const shell = window.__shell;
  if (busy || !shell) return;
  const st = shell.state();
  if (!Number.isSafeInteger(m.v) || m.v <= st.max || st.bad.includes(m.v)) return; // have it, or it failed before
  busy = true;
  try {
    const base = link.cfg.relay.replace(/\/$/, "");
    if (typeof m.url !== "string" || !m.url.startsWith(`${base}/file/`)) throw new Error("bundle is not on the relay");
    const r = await fetch(m.url, { cache: "no-store" });
    if (!r.ok) throw new Error(`download failed (${r.status})`);
    const sealed = new Uint8Array(await r.arrayBuffer());
    const plain = window.nacl.secretbox.open(sealed, unb64u(m.n), unb64u(m.k));
    if (!plain) throw new Error("could not decrypt the bundle");
    const res = shell.stage(new TextDecoder().decode(plain), m.sig);
    if (!res.ok) throw new Error(`refused: ${res.why}`);
    const t0 = Date.now();
    const go = () => (isQuiet() || Date.now() - t0 > MAX_WAIT_MS ? location.reload() : setTimeout(go, 3000));
    setTimeout(go, 1500);
  } catch (e) {
    post(link, { t: "ui", ...uiState(), events: [{ v: m.v, ok: false, reason: String(e.message).slice(0, 200), at: Date.now() }] });
  } finally {
    busy = false;
  }
}

// After a start: tell the hub what happened (new UI healthy, or rolled back and why). Nothing to say = no message.
export function reportUi(link) {
  const shell = window.__shell;
  if (!shell) return;
  const events = shell.takeEvents();
  if (events.length) post(link, { t: "ui", ...uiState(), events });
}
