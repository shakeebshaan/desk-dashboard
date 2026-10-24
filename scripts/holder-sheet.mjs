// A contact sheet of card pictures with the wall holder drawn over the bottom band, as one PNG.
// Usage: node scripts/holder-sheet.mjs <out.png> "<title>" <band%> <dir>[=<caption>] [<dir>[=<caption>] ...]
//   each dir holds <card>.png or <card>-portrait.png files; several dirs = one row each (before / after)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
const require = createRequire(import.meta.url);
const { launchEdge } = require("./lib/browser.cjs");
const [out, title, bandArg, ...dirs] = process.argv.slice(2);
const band = Number(bandArg);
const MASK = (process.env.MASK ?? "age").split(",").filter(Boolean);
const CARDS = ["age", "clock", "weather", "alarms", "agent", "prayer", "countdown", "board", "photos", "quote", "ambient", "verse", "moon", "sun"];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const rows = dirs.map((d) => {
  const [dir, cap] = d.split("=");
  const cells = CARDS.map((c) => {
    const f = [path.join(dir, `${c}.png`), path.join(dir, `${c}-portrait.png`)].find((x) => fs.existsSync(x));
    if (!f) return "";
    const b64 = fs.readFileSync(f).toString("base64");
    // a browser screenshot already shows the holder; a phone capture gets it drawn here
    const drawn = /phone-captures/.test(dir);
    // the birthday card shows names and ages: blurred by default (MASK=age)
    const blur = MASK.includes(c) ? ' style="filter:blur(7px)"' : "";
    return `<figure><div class="shot"><img src="data:image/png;base64,${b64}"${blur}>${drawn ? `<i style="height:${band}%"></i>` : ""}</div><figcaption>${c}${MASK.includes(c) ? " (blurred: names)" : ""}</figcaption></figure>`;
  }).join("");
  return `<h2>${esc(cap || dir)}</h2><div class="row">${cells}</div>`;
}).join("");
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:18px;background:#14121c;color:#eee;font:15px system-ui,sans-serif}
h1{font-size:20px;margin:0 0 6px} h2{font-size:15px;margin:16px 0 8px;color:#c9c2ea}
.row{display:grid;grid-template-columns:repeat(7,150px);gap:10px}
figure{margin:0} .shot{position:relative;width:150px;height:325px;overflow:hidden;border-radius:12px;background:#000}
.shot img{width:100%;height:100%;object-fit:cover;display:block}
.shot i{position:absolute;left:0;right:0;bottom:0;background:rgba(214,206,236,.85);border-top:2px solid #b9aedc}
figcaption{text-align:center;margin-top:4px;color:#aaa;font-size:13px}
</style><h1>${esc(title)}</h1><p style="margin:0;color:#aaa">Lavender = the wall holder (bottom ${band}% of the screen).</p>${rows}`;
const tmp = path.join(path.dirname(out), "holder-sheet.html");
fs.writeFileSync(tmp, html);
const { page, close } = await launchEdge({ headless: true, viewport: { width: 1130, height: 600 } });
try {
  await page.goto("file:///" + tmp.replace(/\\/g, "/"));
  await page.waitForTimeout(500);
  await page.screenshot({ path: out, fullPage: true });
} finally {
  await close();
}
console.log(out);
