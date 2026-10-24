// Prints the UI-signing public key (creating the key pair in the secrets folder on first use) and the version of the UI
// built into the APK, as JSON. build-apk.ps1 bakes both into the APK's shell/uikey.js. Never prints the secret half.
import { loadConfig } from "../hub/src/config.js";
import { loadSigningKey, BUILTIN_V } from "../hub/src/ui.js";
import * as L from "../app/www/app/src/securelink.js";

const kp = loadSigningKey(loadConfig().ui.keyFile, (m) => console.error(m));
console.log(JSON.stringify({ pub: L.b64u(kp.publicKey), builtin: BUILTIN_V }));
