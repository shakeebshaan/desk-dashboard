// Push the current UI (app/www/app) to the phones through the running hub, then wait for the phone's report.
// Same as /ui push in the Telegram bot. Talks only to the hub on 127.0.0.1 with the admin token in the secrets folder.
//   node scripts/ui-push.mjs            push + wait up to 5 min for "phone on UI vN"
//   node scripts/ui-push.mjs --status   show versions only
import fs from "node:fs";

const port = process.env.HUB_PORT || 8797;
const tokenFile = process.env.DASHBOARD_ADMIN_TOKEN_FILE || path.join(process.env.DASHBOARD_SECRETS_DIR || path.join(os.homedir(), ".desk-dashboard"), "dashboard-admin.token");
const token = fs.readFileSync(tokenFile, "utf8").trim();
const api = async (p, method = "GET") => {
  const r = await fetch(`http://127.0.0.1:${port}/api/ui/${p}`, { method, headers: { "x-admin-token": token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `hub said ${r.status}`);
  return j;
};
const show = (s) => console.log(`hub UI v${s.version}; ` + (s.phones.map((p) => `${p.name}: ${p.ui ? `v${p.ui.active}` : "not reported"}`).join(", ") || "no phones"));

try {
  if (process.argv.includes("--status")) {
    show(await api("status"));
  } else {
    const r = await api("push", "POST");
    console.log(`pushed UI v${r.v} (${r.size} bytes) to ${r.phones} phone(s)`);
    const t0 = Date.now();
    for (;;) {
      const s = await api("status");
      if (s.phones.length && s.phones.every((p) => p.ui && p.ui.active >= r.v)) { console.log(`phone on UI v${r.v}`); break; }
      if (Date.now() - t0 > 5 * 60 * 1000) { show(s); console.log("not confirmed within 5 min (the phone may be off; it gets the UI when it connects)"); break; }
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
} catch (e) {
  console.error(`ui-push: ${e.message}`);
  process.exit(1);
}
