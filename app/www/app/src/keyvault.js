// Keeps the phone's X25519 secret key at rest. On the phone: wrapped (AES-256-GCM) by a non-exportable key in the
// Android Keystore (SecureKeyPlugin.java), so the stored blob is useless off this device. In a desktop browser
// (development and tests only) there is no Keystore and the key is stored as is, labelled "browser".
import { Capacitor, registerPlugin } from "../../vendor/capacitor-core.js";

const native = Capacitor.isNativePlatform() ? registerPlugin("SecureKey") : null;

export const keyVault = native
  ? {
    kind: "android-keystore",
    wrap: async (b64) => ({ v: 1, kind: "keystore", ...(await native.wrap({ data: b64 })) }),
    unwrap: async (w) => {
      if (!w || w.kind !== "keystore") throw new Error("not a keystore blob");
      return (await native.unwrap({ iv: w.iv, data: w.data })).data;
    },
    forget: () => native.forget(),
  }
  : {
    kind: "browser",
    wrap: async (b64) => ({ v: 1, kind: "plain", data: b64 }),
    unwrap: async (w) => {
      if (!w || w.kind !== "plain") throw new Error("not a browser blob");
      return w.data;
    },
    forget: async () => {},
  };
