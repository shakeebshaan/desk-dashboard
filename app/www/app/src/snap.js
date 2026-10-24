// A picture of what this phone draws, without native code: the page is cloned into an SVG <foreignObject> with the
// app's stylesheets and drawn onto a canvas (Chrome lets a canvas read that back). Animations are frozen where they
// are right now: each element's current opacity/transform comes along inline, and the clone itself does not animate.
// Canvases and pictures become data URLs (an SVG image loads nothing from outside). Used by the self-test (selftest.js).

const FROZEN = ["opacity", "transform", "visibility", "filter", "clip-path", "stroke-dashoffset", "stroke-dasharray", "fill", "stroke", "color"];
const STILL = "*, *::before, *::after { animation: none !important; transition: none !important; }";
let cssCache = "";

function sheetsText() {
  if (cssCache) return cssCache;
  let css = "";
  for (const s of document.styleSheets) {
    try { for (const r of s.cssRules) css += r.cssText + "\n"; } catch { /* a sheet it may not read */ }
  }
  // inside the SVG the root is <svg>, so :root rules (the theme variables) move to the cloned <html>
  cssCache = css.replace(/:root\b/g, "html");
  return cssCache;
}

function dataUrlOf(img) {
  try {
    if (!img.complete || !img.naturalWidth) return "";
    const c = document.createElement("canvas");
    c.width = Math.min(img.naturalWidth, 480);
    c.height = Math.round((img.naturalHeight * c.width) / img.naturalWidth);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  } catch { return ""; }
}

// Copies what can be seen now onto the clone, element by element; parts that are not displayed are dropped.
function freeze(src, dst) {
  const cs = getComputedStyle(src);
  if (cs.display === "none") return false;
  let style = dst.getAttribute("style") || "";
  for (const p of FROZEN) {
    const v = cs.getPropertyValue(p);
    if (v) style += `;${p}:${v}`;
  }
  // text painted through its background (background-clip: text) does not draw inside an SVG image: plain colour
  // (gradient text such as .grad has a transparent colour of its own: the theme's accent stands in)
  if (cs.getPropertyValue("-webkit-background-clip") === "text" || cs.getPropertyValue("background-clip") === "text") {
    const solid = /^(transparent|rgba\(\d+, \d+, \d+, 0\))$/.test(cs.color) ? getComputedStyle(document.body).getPropertyValue("--a1").trim() || "#fff" : cs.color;
    style += `;color:${solid};-webkit-text-fill-color:${solid};background:none`;
  }
  dst.setAttribute("style", style);
  if (src instanceof HTMLCanvasElement) {
    const img = document.createElement("img");
    // a WebGL canvas is empty once its frame is shown: its owner draws it again and reads it at once (__snap)
    try { img.src = (src.__snap && src.__snap()) || src.toDataURL(); } catch { /* tainted: left empty */ }
    img.setAttribute("style", `${style};width:${src.clientWidth}px;height:${src.clientHeight}px`);
    img.className = src.className;
    dst.replaceWith(img);
    return true;
  }
  if (src instanceof HTMLImageElement && !/^data:/.test(src.currentSrc || src.src)) dst.setAttribute("src", dataUrlOf(src));
  if (src instanceof HTMLVideoElement || src instanceof HTMLIFrameElement) dst.setAttribute("style", `${style};background:#222`);
  const a = [...src.children], b = [...dst.children];
  for (let i = 0; i < a.length; i++) if (b[i] && !freeze(a[i], b[i])) b[i].remove();
  return true;
}

// -> a canvas of the screen as it is now, `scale` of its CSS size; null if this WebView cannot do it
export async function snapScreen(scale = 0.5, skip = "[data-nosnap]") {
  const w = window.innerWidth, h = window.innerHeight;
  const html = document.documentElement;
  const body = document.body.cloneNode(true);
  if (!freeze(document.body, body)) return null;
  for (const n of body.querySelectorAll(`script, ${skip}`)) n.remove();
  const root = document.createElement("html");
  for (const at of html.attributes) root.setAttribute(at.name, at.value);
  root.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const st = document.createElement("style");
  st.textContent = `${sheetsText()}\n${STILL}\nhtml, body { width: ${w}px; height: ${h}px; }`;
  const head = document.createElement("head");
  head.appendChild(st);
  root.appendChild(head);
  root.appendChild(body);
  const xml = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`;
  const img = new Image();
  img.decoding = "sync";
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("the page picture did not load")); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; });
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const g = c.getContext("2d");
  g.fillStyle = getComputedStyle(document.body).backgroundColor || "#05070d";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  c.getContext("2d").getImageData(0, 0, 1, 1); // throws here if the WebView taints it, not later at upload
  return c;
}
