// Shell (built into the APK, never pushed): checks a UI bundle before it may run.
// Plain script so it loads before any module; also require()-able by the hub's tests.
//
// Bundle = UTF-8 JSON text { format: 1, v, entry, builtAt, files: { "src/main.js": "...", ... } }.
// Signature = Ed25519 (TweetNaCl nacl.sign.detached) over
//   "desk-dashboard-ui/v1\n" + v + "\n" + hex(SHA-512(bundle bytes))
// with the hub's UI-signing key. The public key is baked into the APK (shell/uikey.js); a desktop browser without
// one uses the key pinned at pairing.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("tweetnacl"));
  else root.ShellVerify = factory(root.nacl);
})(typeof self !== "undefined" ? self : this, function (nacl) {
  "use strict";
  var MAX_BYTES = 2 * 1024 * 1024;
  var PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

  function utf8(s) { return new TextEncoder().encode(s); }
  function hex(b) { var s = ""; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; }
  function unb64u(str) {
    if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) return null;
    var s;
    try { s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4)); } catch (e) { return null; }
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function signedMessage(v, bytes) {
    return utf8("desk-dashboard-ui/v1\n" + v + "\n" + hex(nacl.hash(bytes)));
  }

  // -> { ok: true, bundle } or { ok: false, why }
  // opts.minV: the version must be above it (no downgrade); opts.v: it must be exactly this one; opts.bad: refused list
  function verify(text, sigB64u, pubB64u, opts) {
    opts = opts || {};
    if (typeof text !== "string" || !text) return { ok: false, why: "empty" };
    var bytes = utf8(text);
    if (bytes.length > MAX_BYTES) return { ok: false, why: "too large" };
    var pub = unb64u(pubB64u);
    if (!pub || pub.length !== 32) return { ok: false, why: "no pinned UI key" };
    var sig = unb64u(sigB64u);
    if (!sig || sig.length !== 64) return { ok: false, why: "unsigned" };
    var b;
    try { b = JSON.parse(text); } catch (e) { return { ok: false, why: "not JSON" }; }
    if (!b || b.format !== 1 || !Number.isSafeInteger(b.v) || b.v < 1 || typeof b.entry !== "string" || !b.files || typeof b.files !== "object") {
      return { ok: false, why: "bad format" };
    }
    if (!nacl.sign.detached.verify(signedMessage(b.v, bytes), sig, pub)) return { ok: false, why: "bad signature" };
    var names = Object.keys(b.files);
    for (var i = 0; i < names.length; i++) {
      if (!PATH.test(names[i]) || typeof b.files[names[i]] !== "string") return { ok: false, why: "bad file " + names[i].slice(0, 40) };
    }
    if (!Object.prototype.hasOwnProperty.call(b.files, b.entry)) return { ok: false, why: "no entry" };
    if (opts.v !== undefined && b.v !== opts.v) return { ok: false, why: "version mismatch" };
    if (opts.minV !== undefined && !(b.v > opts.minV)) return { ok: false, why: "older or same version (v" + b.v + ", have v" + opts.minV + ")" };
    if (opts.bad && opts.bad.indexOf(b.v) >= 0) return { ok: false, why: "v" + b.v + " failed before" };
    return { ok: true, bundle: b };
  }

  return { verify: verify, signedMessage: signedMessage };
});
