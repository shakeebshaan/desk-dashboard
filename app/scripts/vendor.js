// Copies the runtime libraries (three.js, Capacitor core, TweetNaCl) into www/vendor so the app loads nothing from a CDN (run after npm install).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(app, "www", "vendor");
fs.mkdirSync(out, { recursive: true });
const copy = (from, to) => {
  fs.copyFileSync(path.join(app, "node_modules", from), path.join(out, to));
  console.log(`vendored ${from} -> www/vendor/${to}`);
};
copy("three/build/three.module.js", "three.module.js");
copy("three/build/three.core.js", "three.core.js");
copy("@capacitor/core/dist/index.js", "capacitor-core.js");
copy("three/LICENSE", "three.LICENSE.txt");
copy("tweetnacl/nacl-fast.min.js", "nacl-fast.min.js");
copy("tweetnacl/LICENSE", "tweetnacl.LICENSE.txt");
