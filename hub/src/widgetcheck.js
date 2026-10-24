// Static check for generated (custom) widgets before they can reach the phone. The phone also renders them in an
// <iframe sandbox="allow-scripts"> with CSP default-src 'none', so this is the second of two walls, not the only one.

const MAX_BYTES = 60_000;

const BANNED = [
  [/\bfetch\s*\(/i, "network: fetch"],
  [/XMLHttpRequest/i, "network: XMLHttpRequest"],
  [/WebSocket|EventSource|RTCPeerConnection|sendBeacon/i, "network: socket/beacon/WebRTC"],
  [/\bimport\s*\(|\bimport\s+[\w{*]/i, "module import"],
  [/<script[^>]+\bsrc\s*=/i, "external script"],
  [/<(link|iframe|frame|object|embed|base|form|meta)\b/i, "forbidden element"],
  [/\b(src|href|action|poster|srcset)\s*=\s*["']?\s*(https?:|\/\/|data:text\/html|javascript:)/i, "external or script URL"],
  [/url\(\s*["']?\s*(https?:|\/\/)/i, "external CSS url()"],
  [/@import/i, "CSS @import"],
  [/getUserMedia|mediaDevices|geolocation|Notification|serviceWorker|navigator\.(clipboard|share|credentials)/i, "device API"],
  [/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./i, "storage"],
  [/\b(top|parent|opener)\s*\.|window\.open/i, "escape the frame"],
  [/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*["'`]/i, "dynamic code"],
];

export function checkWidgetHtml(html) {
  const problems = [];
  if (typeof html !== "string" || !html.trim()) return { ok: false, problems: ["empty"] };
  if (Buffer.byteLength(html) > MAX_BYTES) problems.push(`too big (${Buffer.byteLength(html)} bytes > ${MAX_BYTES})`);
  for (const [re, why] of BANNED) if (re.test(html)) problems.push(why);
  return { ok: problems.length === 0, problems };
}

// The CSP the phone wraps every custom widget in (also used by the tests).
export const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
