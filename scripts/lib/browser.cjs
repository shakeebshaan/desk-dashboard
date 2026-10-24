// Headless browser for the e2e scripts: a throwaway persistent Playwright profile, deleted on close.
//   const { launchEdge } = require("./lib/browser.cjs");
//   const { page, context, close } = await launchEdge({ headless: true, viewport: { width: 390, height: 844 } });
// PW_CHANNEL picks the browser (default "msedge"; "chrome", or "" for Playwright's bundled Chromium).
// PW_SEED_LOCAL_STATE (optional): a Chromium "Local State" file whose password_manager section is copied into the
// fresh profile. On Windows this stops Chromium 153+ from probing the OS account with a blank password on every new
// profile (repeated probes can lock the account under a lockout policy).
const fs = require("fs");
const os = require("os");
const path = require("path");

function freshProfileDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-dashboard-pw-"));
  const seedFile = process.env.PW_SEED_LOCAL_STATE;
  if (seedFile) {
    const pm = JSON.parse(fs.readFileSync(seedFile, "utf8")).password_manager || {};
    fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ password_manager: pm }));
  }
  return dir;
}

async function launchEdge(opts = {}) {
  const { chromium } = require("playwright");
  const dir = freshProfileDir();
  const channel = process.env.PW_CHANNEL ?? "msedge";
  const { headless = true, ...rest } = opts;
  const context = await chromium.launchPersistentContext(dir, { ...(channel ? { channel } : {}), headless, ...rest });
  const page = context.pages()[0] || (await context.newPage());
  const close = async () => {
    try {
      await context.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  return { context, page, close, dir };
}

module.exports = { launchEdge };
