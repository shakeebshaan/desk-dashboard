// Shell loader (built into the APK, never pushed). Picks which UI bundle runs, and never bricks the phone:
//   - the built-in bundle (www/app/, shipped in the APK) always exists and is the floor;
//   - a pushed bundle runs only if its Ed25519 signature checks out against the pinned UI key, every start;
//   - a new bundle is on trial until it calls __shell.healthy(); an error, a failed load or no report within
//     WATCHDOG_MS rolls back to the last good bundle (or the built-in one) and reloads; that version is never
//     tried again, and versions only go up (no downgrade).
// Pushed bundles run from blob: URLs, with their relative imports rewritten to the blob URLs (see startBundle).
(function () {
  "use strict";
  var BUILTIN_V = window.__UI_BUILTIN_V || 1;
  var WATCHDOG_MS = window.__UI_WATCHDOG_MS || 20000;
  var K = { st: "dash.ui", pin: "dash.uiPub", b: function (v) { return "dash.ui.b." + v; } };
  var V = window.ShellVerify;

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function store(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function now() { return Date.now(); }

  var st = load(K.st) || {};
  st.max = Math.max(st.max || 0, BUILTIN_V);
  st.lastGood = st.lastGood || 0;
  st.bad = st.bad || [];
  st.events = st.events || [];
  st.trial = st.trial || null;

  function pubKey() { return window.__UI_PUB || localStorage.getItem(K.pin) || ""; }
  function save() { store(K.st, st); }
  function event(e) { e.at = now(); st.events.push(e); st.events = st.events.slice(-10); }

  function prune() {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      var m = /^dash\.ui\.b\.(\d+)$/.exec(k || "");
      if (m && +m[1] !== st.lastGood && !(st.trial && +m[1] === st.trial.v)) localStorage.removeItem(k);
    }
  }

  function markBad(v, reason) {
    if (st.bad.indexOf(v) < 0) st.bad.push(v);
    st.bad = st.bad.slice(-20);
    if (st.trial && st.trial.v === v) st.trial = null;
    if (st.lastGood === v) st.lastGood = 0;
    localStorage.removeItem(K.b(v));
    event({ v: v, ok: false, reason: String(reason).slice(0, 200) });
    save();
  }

  // ---------- choose ----------
  var active = BUILTIN_V;
  var bundle = null;
  if (st.trial) {
    if (st.trial.tries >= 2) markBad(st.trial.v, "no healthy report after 2 starts");
    else { st.trial.tries += 1; active = st.trial.v; }
  }
  if (active === BUILTIN_V && st.lastGood > BUILTIN_V) active = st.lastGood;
  if (active !== BUILTIN_V) {
    var rec = load(K.b(active));
    var r = rec ? V.verify(rec.text, rec.sig, pubKey(), { v: active }) : { ok: false, why: "missing" };
    if (!r.ok) { markBad(active, "check failed at start: " + r.why); active = BUILTIN_V; }
    else bundle = r.bundle;
  }
  if (active === BUILTIN_V) st.trial = null;
  save();
  prune();

  // ---------- watchdog ----------
  var healthy = false;
  var timer = null;
  function fail(reason) {
    if (healthy || active === BUILTIN_V) return;
    clearTimeout(timer);
    markBad(active, reason);
    location.reload();
  }
  if (bundle) {
    timer = setTimeout(function () { fail("no healthy report within " + Math.round(WATCHDOG_MS / 1000) + " s"); }, WATCHDOG_MS);
    window.addEventListener("error", function (e) { fail("error: " + (e.message || "script error")); });
    window.addEventListener("unhandledrejection", function (e) { fail("error: " + ((e.reason && e.reason.message) || e.reason)); });
  }

  // ---------- API for the app ----------
  window.__shell = {
    builtin: BUILTIN_V,
    active: function () { return active; },
    state: function () { return { active: active, builtin: BUILTIN_V, max: st.max, lastGood: st.lastGood, bad: st.bad.slice(), trial: st.trial }; },
    hasKey: function () { return !!pubKey(); },
    // The UI calls this once it has drawn. Ends the trial of a new bundle.
    healthy: function () {
      if (healthy) return;
      healthy = true;
      clearTimeout(timer);
      if (st.trial && st.trial.v === active) {
        st.lastGood = active;
        st.trial = null;
        event({ v: active, ok: true });
        save();
        prune();
      }
    },
    // A downloaded bundle: checked, stored, put on trial for the next start. -> { ok, v } or { ok: false, why }
    stage: function (text, sig) {
      var r = V.verify(text, sig, pubKey(), { minV: st.max, bad: st.bad });
      if (!r.ok) return { ok: false, why: r.why };
      try { store(K.b(r.bundle.v), { text: text, sig: sig }); } catch (e) { return { ok: false, why: "storage full" }; }
      st.max = r.bundle.v;
      st.trial = { v: r.bundle.v, tries: 0 };
      save();
      prune();
      return { ok: true, v: r.bundle.v };
    },
    takeEvents: function () { var e = st.events; st.events = []; save(); return e; },
    // Desktop browser only: there is no baked key, so the key from pairing is pinned (first one wins).
    pinKey: function (pub) { if (!window.__UI_PUB && !localStorage.getItem(K.pin) && typeof pub === "string") localStorage.setItem(K.pin, pub); },
  };

  // ---------- start ----------
  function startBuiltin() {
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "app/styles.css";
    document.head.appendChild(css);
    var s = document.createElement("script");
    s.type = "module";
    s.src = "app/src/main.js";
    document.head.appendChild(s);
  }

  function dirOf(p) { return p.indexOf("/") < 0 ? "" : p.slice(0, p.lastIndexOf("/") + 1); }
  function norm(p) {
    var out = [];
    p.split("/").forEach(function (seg) {
      if (seg === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else out.push(".."); }
      else if (seg !== "." && seg !== "") out.push(seg);
    });
    return out.join("/");
  }

  // Each module becomes one blob: URL. Its relative imports are rewritten to the blob URLs of the modules they
  // name (made first, so the bundle must have no import cycles), or, for files outside the bundle such as
  // "../../vendor/three.module.js", to the shell's own copy. No import map (an inline script the CSP forbids).
  var IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;
  function startBundle(b) {
    var files = b.files;
    var base = new URL(".", document.baseURI);
    var urls = {};
    var visiting = {};
    function resolve(spec, from) {
      if (!/^\.{1,2}\//.test(spec)) return { url: spec };
      var p = norm(dirOf(from) + spec);
      if (Object.prototype.hasOwnProperty.call(files, p)) return { file: p };
      if (p.indexOf("../") === 0) return { url: new URL(p.replace(/^\.\.\//, ""), base).href };
      throw new Error("missing module " + p + " (imported by " + from + ")");
    }
    function blobFor(name) {
      if (urls[name]) return urls[name];
      if (visiting[name]) throw new Error("import cycle at " + name);
      visiting[name] = true;
      var code = files[name].replace(IMPORT, function (m, kw, q, spec) {
        var r = resolve(spec, name);
        return kw + q + (r.file ? blobFor(r.file) : r.url) + q;
      });
      urls[name] = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      return urls[name];
    }
    if (files["styles.css"] !== undefined) {
      var style = document.createElement("style");
      style.textContent = files["styles.css"];
      document.head.appendChild(style);
    }
    var entry;
    try { entry = blobFor(b.entry); } catch (e) { return fail("bundle error: " + e.message); }
    import(entry).catch(function (e) { fail("load error: " + (e && e.message)); });
  }

  if (bundle) startBundle(bundle);
  else startBuiltin();
})();
