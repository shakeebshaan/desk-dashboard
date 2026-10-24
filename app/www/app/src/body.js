// The app's markup. Part of the UI bundle, so the hub can change it with a UI push (no new APK).
// Imported first by main.js: it fills the page before any other module touches the DOM.
export const BODY = `
  <div class="sky" aria-hidden="true"><i></i><i></i><i></i><div class="stars"></div></div>

  <header class="topbar" id="topbar">
    <div class="tb-time"><b id="tb-clock">--:--</b><span id="tb-date"></span></div>
    <div class="tb-right"><span id="tb-weather"></span><span class="link" id="tb-link" title="hub link"></span></div>
  </header>

  <main class="stage" id="stage"></main>
  <nav class="dots" id="dots" aria-hidden="true"></nav>

  <section class="sheet hidden" id="pair">
    <div class="pair-card">
      <div class="pair-orb"></div>
      <h1>Pair this phone</h1>
      <p>Send <code>/pair</code> to <b>your dashboard bot</b> and type the 16-character code.</p>
      <label>Code<input id="pair-code" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="24" placeholder="XXXX-XXXX-XXXX-XXXX"></label>
      <details class="adv"><summary>Relay</summary>
        <label>Relay address<input id="pair-relay" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://ntfy.sh"></label>
      </details>
      <button id="pair-go">Pair</button>
      <p class="err" id="pair-err"></p>
    </div>
  </section>

  <section class="sheet hidden" id="paired">
    <div class="pair-card">
      <div class="pair-orb ok"></div>
      <h1>Paired</h1>
      <p>Check that this fingerprint is the same as the one <b>your dashboard bot</b> just sent you.</p>
      <div class="fp" id="paired-fp"></div>
      <button id="paired-ok">They match</button>
      <button id="paired-bad" class="ghost">They differ: forget this pairing</button>
    </div>
  </section>

  <section class="sheet hidden" id="settings">
    <div class="pair-card">
      <h1>Settings</h1>
      <p id="set-info"></p>
      <button id="set-close">Close</button>
      <button id="set-unpair" class="ghost">Forget this hub</button>
    </div>
  </section>

  <section class="alarm hidden" id="alarm">
    <div class="alarm-rings"><i></i><i></i><i></i><b class="alarm-bell">🔔</b></div>
    <div class="alarm-kind" id="alarm-kind">Alarm</div>
    <div class="alarm-label" id="alarm-label"></div>
    <div class="alarm-time" id="alarm-time"></div>
    <button id="alarm-stop">Dismiss</button>
  </section>

  <section class="night hidden" id="night" aria-label="Night mode">
    <div class="night-box" id="night-box"><div class="night-clock" id="night-clock">--:--</div><div class="night-date" id="night-date"></div></div>
  </section>

  <section class="bday hidden" id="bday" aria-live="polite">
    <div class="bs-scene" aria-hidden="true"></div>
    <canvas class="bs-fx" aria-hidden="true"></canvas>
    <div class="bs-text">
      <div class="bs-kicker"></div>
      <div class="bs-big"><b></b><span></span></div>
      <h1 class="bs-title"></h1>
      <p class="bs-line"></p>
    </div>
    <p class="bs-hint">Tap to close</p>
  </section>

  <section class="prayer-call hidden" id="prayer-call">
    <div class="pc-moon">🕌</div><div class="pc-name" id="pc-name"></div><div class="pc-time" id="pc-time"></div>
    <button id="pc-stop">Done</button>
  </section>

  <section class="player hidden" id="player"></section>

  <div class="rec hidden" id="rec" role="status" aria-live="polite">
    <video id="rec-preview" muted playsinline></video>
    <i class="rec-dot"></i><b id="rec-label">REC</b><span id="rec-time"></span>
  </div>
  <div class="rec mic hidden" id="mic" role="status"><i class="rec-dot"></i><b>MIC ON</b><span>listening</span></div>
`;

document.body.dataset.theme = document.body.dataset.theme || "aurora";
document.body.innerHTML = BODY;
