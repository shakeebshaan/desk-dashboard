// What /devices shows for this phone: battery %, charging, Wi-Fi or mobile data, app version. Sent with the hello and
// every 20-minute heartbeat (no extra relay messages). Native plugins in APK 0.3.2 (@capacitor/device, network),
// the browser's Battery / Network Information APIs elsewhere.
import { Capacitor, registerPlugin } from "../../vendor/capacitor-core.js";

const native = Capacitor.isNativePlatform();
const has = (name) => native && Capacitor.isPluginAvailable(name);
const Device = has("Device") ? registerPlugin("Device") : null;
const Network = has("Network") ? registerPlugin("Network") : null;
const App = has("App") ? registerPlugin("App") : null;

export const status = { bat: null, chg: null, net: "unknown", app: null };

export async function refresh() {
  try {
    if (Device) {
      const b = await Device.getBatteryInfo();
      if (typeof b.batteryLevel === "number" && b.batteryLevel >= 0) status.bat = Math.round(b.batteryLevel * 100);
      if (typeof b.isCharging === "boolean") status.chg = b.isCharging;
    } else if (navigator.getBattery) {
      const b = await navigator.getBattery();
      status.bat = Math.round(b.level * 100);
      status.chg = !!b.charging;
    }
  } catch {}
  try {
    if (Network) {
      const n = await Network.getStatus();
      status.net = n.connected ? (["wifi", "cellular"].includes(n.connectionType) ? n.connectionType : "unknown") : "none";
    } else if (navigator.connection && navigator.connection.type) {
      const t = navigator.connection.type;
      status.net = t === "wifi" ? "wifi" : t === "cellular" ? "cellular" : t === "ethernet" ? "ethernet" : t === "none" ? "none" : "unknown";
    } else status.net = navigator.onLine === false ? "none" : "unknown";
  } catch {}
  try {
    if (App && !status.app) status.app = String((await App.getInfo()).version || "").slice(0, 20) || null;
  } catch {}
  return status;
}

export function current() {
  return { ...status };
}

refresh();
setInterval(refresh, 5 * 60 * 1000);
