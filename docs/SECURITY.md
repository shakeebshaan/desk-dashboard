# Link security: zero open ports, end-to-end encryption through a dumb relay

Goal: no open ports, no VPN and no account anywhere, and a relay that only ever sees ciphertext.

## Shape

```
phone app  --HTTPS POST / WSS-->  ntfy.sh (relay)  <--WSS / HTTPS POST--  hub on your PC (127.0.0.1 only)
           sealed frames only                       sealed frames only
```

- Both ends make **outbound** connections only. The hub's own HTTP/WS listener binds to `127.0.0.1` (old local
  link + serving the page to a desktop browser in tests); no LAN, tailnet or public port, no security-group, DNS,
  domain or certificate change.
- Relay: **ntfy.sh** public server, anonymous, free. Each paired phone gets two random 256-bit topics: `up`
  (phone -> hub) and `down` (hub -> phone). Publishes carry `?firebase=no` so ntfy.sh does not forward them to
  Google FCM. Messages stay in ntfy.sh's cache for 12 h, which lets a phone or hub that was offline catch up.
- Code: `app/www/src/securelink.js` (crypto, shared by hub and app), `app/www/src/ntfy.js` (relay client),
  `app/www/src/relaylink.js` (phone), `hub/src/relay.js` (hub), `app/www/src/keyvault.js` +
  `SecureKeyPlugin.java` (key at rest on the phone).

## Crypto (TweetNaCl 1.0.3 only, audited by Cure53; no home-made primitives)

| What | How |
|---|---|
| Identity keys | X25519. Hub: one key pair, secret in `dashboard-hub.key` in the secrets folder (default `~/.desk-dashboard/`) (generated on first run, never in the repo). Phone: one key pair per pairing, made on the phone. |
| Session keys | `nacl.box.before` (X25519 + HSalsa20) of the two keys, then SHA-512 with a direction label -> one 32-byte key for hub->phone, one for phone->hub. |
| Each message | `nacl.secretbox` (XSalsa20-Poly1305). Nonce = 16 random bytes + 64-bit counter. Frame = `d1.` + base64url(nonce + ciphertext). |
| Replay / reordering | Each side stores the highest counter it accepted per direction and rejects anything not above it. The counter is inside the nonce, so editing it breaks the Poly1305 tag. |
| Key pinning | The phone stores the hub's public key from pairing and only accepts frames sealed with the shared key it derives from it. |
| Phone key at rest | Wrapped with AES-256-GCM by a non-exportable key in the **Android Keystore** (`SecureKeyPlugin`); local storage holds only the wrapped blob. Forget/unpair deletes the Keystore key. In a desktop browser (tests) there is no Keystore and the settings sheet says `key browser`. |
| Size | ntfy.sh keeps bodies under 4096 bytes: bigger messages are split into sealed parts (max 3800 chars each) and reassembled. |

## Pairing

1. `/pair` in the Telegram bot (owner's private chat only) gives a **16-character one-time code** (Crockford
   base32, 80 bits, e.g. `K7QM-2XRP-9TWD-HV4C`), valid 10 minutes.
2. Both sides derive from the code a pairing topic and a pairing key (SHA-512, separate halves). The phone posts
   its public key sealed with the pairing key; the hub answers, sealed, with its public key, the device id and the
   two random topics, bound to that phone key. The code is then dead.
3. Both compute a **fingerprint** (SHA-512 of hub key + phone key, 80 bits, 20 hex digits). The phone shows it
   full screen; the bot sends the same digits. They must match; if not, "They differ" on the phone + `/unpair`.

Why not a PAKE: no audited CPace/SPAKE2 exists for JavaScript in libsodium or TweetNaCl, and writing one would be a
home-made protocol. Instead the code is long: guessing 80 bits offline from what the
relay sees is out of reach (2^80 tries), online guessing would first need the 2^80 topic, and the hub voids the
code and locks pairing for 10 minutes after 5 bad frames on the pairing topic.

## Least privilege

- Phone -> hub: only `hello`, `beat`, `ask` (text, max 2000 chars), `fired` (alarm id), `resync`, `ui` (its UI
  version and install reports), `blob` (an encrypted photo / clip part / live frame, only for a camera job the hub
  started), `cam` / `media` (camera and playback errors, "done"). Anything else is
  dropped and logged; nothing from the relay is executed, evaluated or passed to a shell.
- Hub -> phone: `state` / `patch` (the same public state as before: no device data, no Telegram data, no keys),
  `speak`, `agent`, `revoked`, `ui` (a signed UI bundle, next section), `cam` / `play` / `stop` (only as the result
  of the owner's bot command; each carries the hub's time and the phone drops it if it is more than 2 min old).
  Approved custom widgets still run only in the sandboxed iframe with their own CSP.
- App CSP `connect-src`: `self`, `https://ntfy.sh`, `wss://ntfy.sh`, and `127.0.0.1` for tests. Capacitor now uses
  the `https` scheme with cleartext off. Since 0.3.1 `frame-src` allows `https://www.youtube-nocookie.com` and
  `media-src` allows `https:`, for `/play` only.
- `/unpair <id>`: the phone gets a sealed `revoked` (it wipes its key), the hub deletes the phone's public key and
  topics and stops listening to them, at once. `/unpair all`: every phone, plus a new hub key.

## Relay budget (ntfy.sh anonymous, checked 2026-10-23 with `GET https://ntfy.sh/v1/account`)

250 messages/day per IP, 12 h cache, 4096-byte bodies, 2 MB attachments (3 h; used for UI bundles). Only publishes count.

| Traffic | Per day (one phone) |
|---|---|
| Hub -> phone: state patches (debounced 3 s, only changed keys) | ~5-40, depends on bot use |
| Weather (only when it changed, at most hourly) | <= 24 |
| Speech, agent answer (+ "thinking") | 1-2 per message / question |
| Snapshot on app start (only if the phone's version is stale; at most 1/min) | a few |
| UI push: one encrypted file + one sealed frame per phone | 2 per push |
| Phone -> hub: heartbeat every 20 min + one hello per app start + questions + alarm acks + UI reports (phone's own IP) | ~75-100 |
| Camera (phone's IP; one message per upload, the sealed frame rides on the attachment): `/snap` | 1 |
| `/clip` (about 1 MB per 8 s; 2 MB per file) | 1-5 |
| `/live`: one per frame, every 4 s or more; the phone reads its own `/v1/account` and stretches the gap so 60 messages stay free | 15-150 |

ntfy.sh also caps attachments at 20 MB stored per IP at a time: a clip stops at 12 MB.

The hub counts its publishes per day: above 170 weather and layout patches wait (the phone keeps its last state and
resyncs later), above 235 only the revoke message goes out. Measured: a full browser test run through ntfy.sh
used 21 hub messages. If this ever is not enough, the fallback is a Cloudflare Worker on workers.dev (free, needs a
Cloudflare account).

## UI updates without a new APK (since 0.3.0)

The APK is a permanent native **shell**: `www/index.html`, `www/shell/` (loader + signature check) and the vendor
libraries (three.js, TweetNaCl, Capacitor core) plus every native plugin the dashboard is expected to need. Everything
the user sees is the **UI bundle** `www/app/` (markup, styles, all app modules). The APK carries one bundle (v1);
the hub can replace it with a newer one at any time: `/ui push` in the bot, or `node scripts/ui-push.mjs` on the PC.

| Step | What protects it |
|---|---|
| Build | The hub packs the text files of `app/www/app/` into one JSON bundle (format 1, version v, entry `src/main.js`). |
| Sign | **Ed25519** (`nacl.sign.detached`) over `"desk-dashboard-ui/v1\n" + v + "\n" + hex(SHA-512(bundle))`, with a **separate UI-signing key** in `dashboard-ui-sign.key` in the secrets folder (never in the repo, never sent). The version is inside the signed message, so a signature cannot be moved to another version. |
| Pin | The public key is **baked into the APK** by `build-apk.ps1` (`shell/uikey.js` in the APK copy only). A desktop browser (tests) has no baked key and pins the one sent, sealed, at pairing. |
| Deliver | Encrypted with a fresh one-time key (XSalsa20-Poly1305) and put on the relay as a file (ntfy attachment, 3 h). The file URL and its key travel in a sealed `{t:"ui"}` frame. The relay sees an opaque file of ~95 KB. |
| Accept | The shell (`shell/verify.js`, same code the hub self-checks with) refuses: no signature, a signature by any other key, any changed byte, a version that is not higher than every version it has accepted (**no downgrade, no replay**), a version that failed before, malformed file names, a missing entry. It re-checks the signature **at every start** before any of the bundle runs. |
| Run | Each module of the bundle becomes a `blob:` URL (its relative imports rewritten to the other modules' blob URLs; vendor imports go to the shell's own files). CSP `script-src 'self' blob:`; no inline script, no eval, no import map. |
| Never brick | The new bundle starts **on trial**. It must call `__shell.healthy()` after drawing. A load error, a script error before that, or **no report within 20 s** rolls back to the last good bundle, else to the one built into the APK, and reloads. A bundle that was still on trial after two starts is dropped too. Failed versions are never tried again. The built-in bundle is always there. |
| Report | After the start the UI sends `{t:"ui"}` with its version and what happened; the bot tells the owner "📱 ... is on UI vN" or "⚠️ UI vN did not work ...: reason. The phone runs UI vM." A phone that was away gets the current UI again on its next hello (at most every 10 min; never a version it reported as failed). |
| Install moment | The new UI is staged at once but loads at a quiet moment (no speech, no alarm ringing), or after 10 min at the latest. |

Small changes need no bundle at all: layout, widget order, cycle times, theme, titles (`/title <n> <text>`) and widget
config are hub state, sent as sealed patches.

Only native changes still need an APK: a new Android permission or plugin, a change to the shell itself, or a new
vendor library. 0.3.0 already carries: text-to-speech, keep-awake, local notifications with exact alarms and
full-screen intents (alarms that ring even if the app was killed), app lifecycle, network status, haptics,
preferences, speech recognition (Phase 2 push-to-talk; **RECORD_AUDIO is declared but no UI uses it**, Android asks
at first use) and the Android Keystore key wrap. No Bluetooth (not planned).

Threats specific to UI pushes: whoever holds the UI-signing key can run any UI on the phone (within the app's
permissions and CSP), so it lives only in the secrets folder on the hub PC, like the hub key. The relay cannot change,
replay or downgrade a bundle. A bundle that breaks the UI is rolled back by the shell, which no push can change.
Rotating the UI key needs a new APK (it is baked in).

## Camera, microphone and /play (since 0.3.1)

Rules: off unless the owner commands them from his bot; REC on screen while the camera is on; hard time
limits; nothing kept after delivery; no cloud vision, face recognition or motion trigger.

- **Who can start it:** only the bot, which answers only the owner's Telegram id in his private chat. The hub sends a
  sealed `{t:"cam", op, id, facing, secs, at}` to the phone heard from most recently. The phone accepts camera
  commands only from the hub's sealed channel (never from the relay, a widget or the screen), drops them if `at` is
  more than 2 min off, runs one job at a time, and enforces the limits again (clip <= 60 s, live <= 10 min, frames
  >= 3 s apart). `/stop` ends a clip early (what was recorded is sent), a live view, and playback.
- **REC indicator** (`app/www/app/src/camera.js`): on before `getUserMedia` is called, off only after every track is
  stopped; red dot + "REC · CAMERA" / "REC · CAMERA + MIC" / "LIVE · CAMERA", a timer, a small live preview, a red
  frame round the screen, above every other layer (alarms, pairing, video). The browser test checks that every
  camera open and every track stop happened with REC on screen.
- **Transport:** each photo, clip part (<= 1.9 MB) or live frame is encrypted with a fresh random key
  (XSalsa20-Poly1305) and uploaded as an ntfy attachment to the phone's `up` topic. The same upload's message text is
  a sealed `{t:"blob", id, kind, i, n, key, sha, ...}` frame (counter + Poly1305 as usual), so one relay message
  carries both. The hub accepts it only for a job it started (same id, same phone, kind matching the command),
  downloads only from the relay's own `/file/` URL, checks the SHA-512/256 of the download and the tag, then decrypts.
  The relay sees ciphertext, sizes and timing (it can tell that the camera was used, not what it saw).
- **Delivery:** the hub sends the photo (`sendPhoto`), the clip (`sendVideo` for MP4, `sendDocument` for WebM) or the
  live frames (one photo, replaced with `editMessageMedia`) to the owner's chat, from memory. Nothing is written to disk
  on the hub; buffers are dropped after delivery. On the phone the frames and the recording exist only in memory.
  Telegram keeps what was delivered to the chat, like any message; ntfy.sh deletes the ciphertext after 3 h.
- **Live view, why not WebRTC:** a smooth WebRTC stream needs (1) a viewer page on the web - ntfy.sh serves files only
  as downloads, and free static hosting needs an account, and (2) a TURN relay for
  mobile networks behind carrier NAT, which is a paid or account-bound service. The frames-in-Telegram view needs
  neither, opens no port and works on any network where Telegram works; the price is a picture every 4 s or more
  (the relay's daily message allowance). WebRTC can be added later if the owner approves a host and a TURN service.
- **Microphone:** push-to-talk uses `OnDeviceSpeechPlugin` (in the APK): `SpeechRecognizer.createOnDeviceSpeechRecognizer`
  only (Android 12+ with on-device speech). There is no fallback to the normal recognizer, which may send audio to
  Google; without on-device speech the mic button says so and records nothing. `/clip` records sound unless `mute`.
  The community speech plugin (no on-device guarantee) was removed from the APK.
- **/play:** the phone loads `https://www.youtube-nocookie.com/embed/<id>` (privacy-enhanced embed) or the https video
  link itself, only on the owner's command; errors come back to the bot.
- **Android permissions:** CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS are in the 0.3.1 manifest. Android asks once at
  the first use (the first `/snap` or `/clip`, the first mic tap); "Don't allow" means the camera stays off and the bot
  says so.

## Photo frame, adhan, prayer data, phone status (2026-10-24)

- **Photos and the adhan recording** come from the owner's own chat (owner id only), are stored on the hub only
  (`data/media/`, gitignored, max 24 photos, deleted with `/photo remove` / `/photos clear` / `/adhan clear`). The
  phone asks for the ids in its state (`{t:"get"}`, whitelisted, ids checked) and gets each file the same way the
  phone sends camera uploads, the other way round: a one-time key, ciphertext as a relay attachment, the sealed
  `{t:"file"}` frame (key + SHA-512/256) as that message's text. The phone keeps them in memory only (blob: URLs).
  The hub sends a file at most once per 10 min per phone (relay budget).
- **Hub sends are serialised per phone** (one counter taken and published before the next), so frames reach the
  phone in counter order even when speech, patches and files go out together.
- **Aladhan** (prayer times, Hijri dates) and Open-Meteo are called by the hub only, with the city's coordinates
  and a date; no key, no account, nothing about the owner.
- **Phone status** (battery %, charging, Wi-Fi / mobile data, app version) rides on the hello and the 20-minute
  heartbeat; the hub keeps it with the device for `/devices`; it never leaves the hub.

## Threat model

| Who / what | Can | Cannot |
|---|---|---|
| **The relay (ntfy.sh operator, anyone who logs it)** | See that two IPs talk through random topics, message sizes and timing; drop, delay or replay frames; stop the service (the dashboard then runs on its cached state). | Read anything (all frames are sealed), forge or change a frame (Poly1305), get a replay or reordered frame accepted (counters), learn the pairing code or keys. |
| **Someone who learns a topic** (leaked log, shoulder surfing the settings sheet) | Read ciphertext on it; post junk to it, which is dropped (and could spend the hub's daily relay budget only by making it answer, which junk never does). | Decrypt, inject an accepted command, or impersonate either side: that needs a private key. `/unpair` + `/pair` issues fresh topics. |
| **A stolen, unlocked phone** | Use the dashboard like the owner: see its state (layout, alarms, weather, birthdays, approved widgets) and send the whitelisted messages (ask the agent, capped at 10 USD/month; ack alarms). | Reach the hub any other way, run code on the hub PC, read the Telegram chat, or extract the link key from a copy of the app data (it is wrapped by the phone's Keystore). **Fix: `/unpair <id>` (or `/unpair all`)**: revoked at once. |
| **Someone with the phone in hand, or a malicious custom widget** | Nothing camera-related: the camera starts only on a sealed command from the hub, and widgets run sandboxed without camera access. | Turn the camera on, or hide the REC indicator while it is on. |
| **Someone who takes over the owner's Telegram account** | Use the bot as the owner: photos and live view of the room. | Do it unseen: REC is on screen the whole time. **Fix: secure the Telegram account; `/unpair all` stops every phone.** |
| **A stolen phone that is locked / wiped** | Nothing useful. | Same as above. |
| **Someone who intercepts the `/pair` code** | Pair their own device within 10 minutes, before the owner does. | Do it unnoticed: the owner's phone then fails to pair, the bot announces the other device with its fingerprint, and `/devices` lists it; `/unpair` removes it. |
| **Network attacker (Wi-Fi, ISP)** | See TLS to ntfy.sh. | Read or alter frames (TLS plus the end-to-end layer). |
| **This PC compromised** | Everything (the hub key and state live here). | Out of scope: the hub is trusted. |

Known limits: static X25519 keys give no forward secrecy (if the hub key and a phone key both leak later, recorded
frames can be decrypted; rotate with `/unpair all`). The relay can see when the dashboard is active. The Keystore
path is compiled into the APK but has not run on a real phone yet.

## Tests

- `hub/test/camera.test.js` (5 tests) and `hub/test/help.test.js`: /snap, a 3-part /clip and /live over a fake ntfy
  with the app's real RelayLink as the phone: exact bytes reach (fake) Telegram, live frames edit one message, /stop
  reaches the phone and closes the view, a late frame is dropped, the relay stored only ciphertext; a swapped
  attachment, an upload for no job and a wrong-kind upload are dropped; phone errors reach the bot; one job at a time;
  a command that arrives 10 min late does not fire; /play reaches the phone; argument limits (`/clip 61`, `/live 11`,
  `/play http://...` refused).
- `scripts/e2e-camera.mjs` (headless Edge, Chromium's fake camera and mic, the real app): /snap -> JPEG in Telegram,
  /clip -> MP4 in Telegram, /live -> frames + /stop, REC on screen at every camera open and track stop, camera
  released after each job, YouTube embed, an unplayable link reported, push-to-talk -> agent -> spoken answer, relay
  held only ciphertext, nothing kept in the phone's storage. Only the real phone can prove: the permission prompts,
  its cameras, its WebView's recording format, YouTube in its WebView, and the on-device recognizer.

- `hub/test/relay.test.js` (in `npm test`, 33/33): round trip; replay and reordering rejected; bit flips and a
  forged counter rejected; other pairing's key and other direction's key rejected; 80-bit code format and
  normalisation; chunking under 4096 bytes; full pairing + snapshot + patch + speech + agent question over a fake
  ntfy, with a check that the relay saw no plaintext (not even the topics or the phone name); replayed, tampered,
  wrong-key and non-whitelisted frames do nothing; `/unpair` and `/unpair all`; pairing lockout after 5 bad
  frames, single use, wrong code; daily budget tiers; hub key reuse.
- `hub/test/ui.test.js`: the shell's own verify.js refuses unsigned, other-key, one-byte-changed, same-version,
  older-version, failed-before, signature-moved-to-another-version, path-escape and no-entry bundles, and a junk
  signature without throwing; a push over a fake ntfy reaches a test phone running the app's real updater.js, which
  downloads, decrypts, stages and reloads; the attachment holds no plaintext; reports reach the bot; a failed version
  is not resent; a phone that was away gets the UI on hello; a tampered download is refused and reported; the local
  admin endpoint needs the token and refuses browsers. All hub tests: 40/40.
- `scripts/e2e.mjs` (headless Edge at 390x844, the real shell and app, hub -> relay -> app): pairing, widgets,
  speech, alarms, then UI pushes: starts on the built-in UI v1; `/title` changes a card title without a push;
  `/ui push` v2 -> the phone switches and the bot says "is on UI v2"; a v3 that never reports healthy is rolled back
  by the 20 s watchdog (23-25 s) and reported; a v4 that throws is rolled back at once and reported; the shell stays
  on v2 with 3 and 4 marked bad; a forged bundle is refused. 23/23 with the fake relay (plus "the relay saw only
  sealed frames and encrypted UI files"), 22/22 against the real `https://ntfy.sh` (`E2E_RELAY=https://ntfy.sh`).
