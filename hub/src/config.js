// Runtime config. Secrets come from the secrets file (never from git) and are never logged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");

export function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function loadConfig(env = process.env) {
  const secretsDir = env.DASHBOARD_SECRETS_DIR || path.join(os.homedir(), ".desk-dashboard");
  const secretsFile = env.DASHBOARD_SECRETS || path.join(secretsDir, "dashboard-bot.env");
  const s = { ...parseEnvFile(secretsFile), ...env };
  return {
    botToken: s.DASHBOARD_BOT_TOKEN || "",
    ownerId: String(s.DASHBOARD_OWNER_ID || "").trim(),
    telegramApi: s.TELEGRAM_API_BASE || "https://api.telegram.org",
    telegramEnabled: s.DASHBOARD_TELEGRAM !== "0",
    host: s.HUB_HOST || "127.0.0.1",
    port: Number(s.HUB_PORT || 8797),
    serveApp: s.HUB_SERVE_APP === "1",
    dataDir: s.HUB_DATA_DIR || path.join(ROOT, "data"),
    weatherEnabled: s.DASHBOARD_WEATHER !== "0",
    ui: {
      srcDir: s.DASHBOARD_UI_SRC || path.join(ROOT, "app", "www", "app"),
      // Ed25519 key that signs UI bundles; its public half is baked into the APK
      keyFile: s.DASHBOARD_UI_KEY_FILE || path.join(secretsDir, "dashboard-ui-sign.key"),
      adminTokenFile: s.DASHBOARD_ADMIN_TOKEN_FILE || path.join(secretsDir, "dashboard-admin.token"),
    },
    relay: {
      enabled: s.DASHBOARD_RELAY !== "0",
      url: s.DASHBOARD_RELAY_URL || "https://ntfy.sh",
      // the hub's X25519 secret key: generated on first run, kept outside the repo
      hubKeyFile: s.DASHBOARD_HUB_KEY_FILE || path.join(secretsDir, "dashboard-hub.key"),
    },
    agent: {
      // On whenever the key file exists; DASHBOARD_AGENT_ENABLED=0 forces it off. The key itself is read by the agent
      // from this file at run time and never passes through config, env or the secrets .env.
      enabled: s.DASHBOARD_AGENT_ENABLED !== "0",
      keyFile: s.DASHBOARD_ANTHROPIC_KEY_FILE || path.join(secretsDir, "dashboard-anthropic.key"),
      model: s.DASHBOARD_AGENT_MODEL || "claude-haiku-5-5",
      capUsd: Number(s.DASHBOARD_AGENT_CAP_USD || 10),
      warnUsd: Number(s.DASHBOARD_AGENT_WARN_USD || 8),
    },
  };
}
