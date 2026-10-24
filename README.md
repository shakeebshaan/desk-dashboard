# Desk Dashboard

Turn an old Android phone into an always-on desk dashboard, controlled from a private Telegram bot.

- **Cycling animated cards:** clock styles, weather, sunrise/sunset, moon phase, prayer times, countdowns, birthdays and
  age counters, alarms and reminders, a photo frame, a message board, a daily verse and quote, an ambient scene.
- **Telegram remote:** send text and the phone speaks it; set alarms, birthdays, events, the city, themes and layouts;
  ask for a camera snapshot, a short clip or a live view (with a red REC indicator on screen the whole time).
- **3D voice agent** (optional): an animated character that answers questions, backed by the Anthropic API. The API
  key stays on the hub and never ships in the app.
- **Zero open ports:** the phone and the hub both connect *outbound* to a public relay (ntfy.sh). Every frame is
  end-to-end encrypted (X25519 + XSalsa20-Poly1305, TweetNaCl), keys are pinned at pairing, and the relay only sees
  ciphertext. See [docs/SECURITY.md](docs/SECURITY.md).
- **UI updates without reinstalling:** the APK is a thin native shell; the hub pushes Ed25519-signed UI bundles, with
  no downgrades and an automatic rollback if a new UI fails to start.

```
hub/          Node service on your PC: Telegram bot (owner only), relay link + pairing, weather, agent
app/www/      the dashboard UI (plain ES modules, three.js vendored, no bundler) - also runs in a desktop browser
app/android/  Capacitor 7 Android project (kiosk: keep-on, immersive, can be the Home app, starts on boot)
scripts/      browser e2e tests, APK build, hub runner and boot task (Windows/PowerShell)
data/         hub state (gitignored): layouts, alarms, birthdays, paired devices (token hashes only)
```

## Setup

1. **Telegram bot:** create one with @BotFather and find your numeric Telegram user id.
2. **Secrets folder:** default `~/.desk-dashboard/` (set `DASHBOARD_SECRETS_DIR` to change it). Copy
   `dashboard-bot.env.example` there as `dashboard-bot.env` and fill in `DASHBOARD_BOT_TOKEN` and `DASHBOARD_OWNER_ID`.
   The bot answers only that user id, in a private chat; everything else is dropped.
   The hub creates its own keys in the same folder on first run: `dashboard-hub.key` (X25519 link key),
   `dashboard-ui-sign.key` (Ed25519 UI-signing key) and `dashboard-admin.token` (local admin token for `ui-push`).
   Keep this folder private and out of git.
3. **Agent (optional):** put an Anthropic API key, one line, in `dashboard-anthropic.key` in the secrets folder. The
   hub re-reads it every minute: no file means "agent offline". It is read from that file only, never from env.
   A hub-side spend guard books each call's usage, warns at `DASHBOARD_AGENT_WARN_USD` (default 8) and refuses at
   `DASHBOARD_AGENT_CAP_USD` (default 10) per month. Also give the key a monthly limit in the Anthropic Console.
4. **Run the hub:** `cd hub && npm install && npm start` (or `scripts/setup-hub-task.ps1` for a Windows boot task).
   It listens on `127.0.0.1` only (`HUB_PORT`, default 8797).
5. **Build and install the app:** `cd app && npm install`, then `powershell -File scripts/build-apk.ps1` (needs the
   Android SDK and JDK 17; it bakes the hub's UI-signing *public* key into the APK). Sideload the APK onto the phone.
6. **Pair:** send `/pair` to your bot, type the 16-character code on the phone, and check that the fingerprint on the
   phone matches the one the bot sends.

Other settings (env or `dashboard-bot.env`): `DASHBOARD_AGENT_MODEL` (default `claude-haiku-5-5`),
`DASHBOARD_AGENT_ENABLED=0` to force the agent off, `DASHBOARD_RELAY_URL` (default `https://ntfy.sh`),
`DASHBOARD_RELAY=0` to switch the relay off, `HUB_DATA_DIR`, `HUB_SERVE_APP=1` (serve the UI to a desktop browser).

## Changing the UI (no new APK)

Edit anything under `app/www/app/` (markup in `src/body.js`, styles, widgets, text), run the tests, then send
`/ui push` to the bot (or run `node scripts/ui-push.mjs`). The phone installs it at a quiet moment and the bot reports
"is on UI vN"; a broken UI rolls back by itself within 20 s and the bot says why. Layout, order, cycle time, theme and
card titles (`/title`) need no push at all. Only new Android permissions or plugins, or a change to the shell
(`app/www/index.html`, `app/www/shell/`, `app/www/vendor/`), need a new APK.

## Test

```
cd hub && npm install && npm test             # unit + integration tests (fake Telegram, fake ntfy, mock Anthropic)
npm install && node scripts/e2e.mjs           # browser e2e at 390x844 through a local fake relay (Playwright)
E2E_RELAY=https://ntfy.sh node scripts/e2e.mjs   # the same through the real relay (uses ~25 relay messages)
node scripts/ui-push.mjs --status             # UI version on the hub and on each phone
```

The e2e scripts use Microsoft Edge by default; set `PW_CHANNEL=""` to use Playwright's bundled Chromium.

Dev in a browser: `HUB_SERVE_APP=1 node hub/src/index.js`, open `http://127.0.0.1:8797`, send `/pair` to the bot,
type the code, and compare the fingerprint with the bot's.

## Adding a widget type

One file in `app/www/app/src/widgets/` exporting `{ type, title, mount(el, ctx, widget) }` where `mount` returns
`{ update(state), tick?(state), show?(), hide?() }`, then register it in `widgets/index.js` and add the type to
`WIDGET_TYPES` in `hub/src/store.js`. Generated widgets (`/newwidget`) need no code: the agent drafts HTML, a static
check runs, you approve it with `/approve`, and it renders in a sandboxed iframe.

## Third-party code

`app/www/vendor/` holds three.js (MIT, see `three.LICENSE.txt`), TweetNaCl (public domain, see
`tweetnacl.LICENSE.txt`) and Capacitor core (MIT). External services, all key-less: ntfy.sh (relay), Open-Meteo
(weather), Aladhan (prayer times), alquran.cloud (verses).

## License

MIT, see [LICENSE](LICENSE).
