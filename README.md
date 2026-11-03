# botyaratalk

[![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.1-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![WebRTC](https://img.shields.io/badge/WebRTC-mesh-333333?logo=webrtc&logoColor=white)](https://webrtc.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-83%20passed-brightgreen.svg)](#tests)
[![Screenshots](https://img.shields.io/badge/screenshots-21-blueviolet.svg)](#screenshots)

A LAN messenger with text channels, voice, video and **screen sharing with system audio**.
Flask + Socket.IO + vanilla ES-modules frontend, SQLite storage, 10 themes, English and Russian UI.
**RNNoise** neural noise suppression runs locally in an `AudioWorklet` — no CDN, no npm.

> The project name is always lowercase: `botyaratalk`.

---

## Quick start

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python run.py                   # → https://0.0.0.0:14098
```

Open the printed `https://…` address (the browser asks you to trust the local certificate once).
The onboarding wizard walks you through language → theme → sign-up.

On the very first run botyaratalk creates everything it needs on its own:

| What | Where | Why |
|---|---|---|
| `secret.key` | `instance/` (mode 0600) | session signing key |
| `cert.pem` + `key.pem` | `instance/` | self-signed TLS so the browser allows mic and camera |
| `botyaratalk.db` + three rooms | `instance/` | SQLite storage, localized room names |
| `avatars/` | `instance/` | uploaded avatars (≤ 2 MB, cropped in the browser) |

No manual migrations, no external services, no certificate commands. Upgrading from an
older build is automatic: `app/db.py::migrate_db()` adds the missing columns
(`messages.reply_to_id`, `users.avatar_*`) and the `reactions` table on start-up,
idempotently — your old database is never recreated. Need plain HTTP (for
localhost-only debugging)? `BOTYARATALK_HTTPS=0 python run.py`.

To open the app from another device on the same LAN just use the `https://<server-ip>:14098`
address printed at startup — see [HTTPS and LAN](#https-and-lan) for certificate details.

```bash
python scripts/seed_rooms.py        # (re)create the rooms, idempotent
pytest tests/ -q                    # backend test suite
python tests/e2e_two_peers.py       # real WebRTC E2E with two browser contexts
python scripts/take_screenshots.py  # 23 PNGs into screenshots/
```

---

## Screenshots

| Onboarding 1/3: language | Onboarding 2/3: sign in |
|---|---|
| ![Language](screenshots/onboarding-step-lang.png) | ![Sign in](screenshots/onboarding-step-login.png) |

| Onboarding 2/3: sign up (strength meter, password reveal) | Onboarding 3/3: theme |
|---|---|
| ![Register](screenshots/onboarding-step-register.png) | ![Theme](screenshots/onboarding-step-theme.png) |

| Chat with a message (avatars everywhere) | Reply, reactions, link card |
|---|---|
| ![Chat](screenshots/chat-with-message.png) | ![Replies and reactions](screenshots/chat-reply-reactions.png) |

| Message context menu | Avatar: crop in the browser |
|---|---|
| ![Context menu](screenshots/chat-context-menu.png) | ![Avatar upload](screenshots/avatar-upload.png) |

| Avatar: generated 32×32 pattern | Settings — devices & RNNoise |
|---|---|
| ![Avatar generator](screenshots/avatar-generate.png) | ![Settings](screenshots/settings-modal.png) |

| Voice call with camera on | Deafen and hang-up controls |
|---|---|
| ![Camera](screenshots/app-voice-video-on.png) | ![Voice channel](screenshots/voice-channel.png) |

| Screen sharing (peer + audio badge) | Same account on a second device («×2») |
|---|---|
| ![Screen sharing](screenshots/app-screen-sharing.png) | ![Multi-device](screenshots/app-voice-multidevice.png) |

| Pinned voice zone (chat hidden, screen on top) | Fullscreen voice stage |
|---|---|
| ![Pinned](screenshots/app-voice-pinned.png) | ![Fullscreen](screenshots/app-voice-fullscreen.png) |

| Device pickers | Theme picker in settings |
|---|---|
| ![Devices](screenshots/settings-devices.png) | ![Themes](screenshots/settings-appearance.png) |

| Themes — Catppuccin Latte | Gruvbox Dark | Ayu Mirage |
|---|---|---|
| ![Latte](screenshots/app-light-catppuccin-latte.png) | ![Gruvbox](screenshots/app-dark-gruvbox.png) | ![Ayu](screenshots/app-ayu-mirage.png) |

| UI switched to English | Mobile (390 px) |
|---|---|
| ![English](screenshots/app-i18n-english.png) | ![Mobile](screenshots/settings-mobile.png) |

---|---|
| ![Language](screenshots/onboarding-step-lang.png) | ![Sign in](screenshots/onboarding-step-login.png) |

| Onboarding 2/3: sign up (strength meter, password reveal) | Onboarding 3/3: theme |
|---|---|
| ![Register](screenshots/onboarding-step-register.png) | ![Theme](screenshots/onboarding-step-theme.png) |

| Chat with a message (avatars everywhere) | Reply, reactions, link card |
|---|---|
| ![Chat](screenshots/chat-with-message.png) | ![Replies and reactions](screenshots/chat-reply-reactions.png) |

| Reply, reactions, link card | Message context menu |
|---|---|
| ![Replies and reactions](screenshots/chat-reply-reactions.png) | ![Context menu](screenshots/chat-context-menu.png) |

| Avatar: crop in the browser | Avatar: generated 32×32 pattern |
|---|---|
| ![Avatar upload](screenshots/avatar-upload.png) | ![Avatar generator](screenshots/avatar-generate.png) |

| Voice call with camera on | Pinned voice zone (chat hidden, screen on top) |
|---|---|
| ![Camera](screenshots/app-voice-video-on.png) | ![Pinned](screenshots/app-voice-pinned.png) |

| Screen sharing (peer + audio badge) | Same account on a second device («×2») |
|---|---|
| ![Screen sharing](screenshots/app-screen-sharing.png) | ![Multi-device](screenshots/app-voice-multidevice.png) |

| Device pickers | Deafen and hang-up controls |
|---|---|
| ![Devices](screenshots/settings-devices.png) | ![Voice channel](screenshots/voice-channel.png) |

| Fullscreen voice stage | Theme picker in settings |
|---|---|
| ![Fullscreen](screenshots/app-voice-fullscreen.png) | ![Themes](screenshots/settings-appearance.png) |

| Settings — devices & RNNoise | | 
|---|---|
| ![Settings](screenshots/settings-modal.png) | |

| Themes — Catppuccin Latte | Gruvbox Dark | Ayu Mirage |
|---|---|---|
| ![Latte](screenshots/app-light-catppuccin-latte.png) | ![Gruvbox](screenshots/app-dark-gruvbox.png) | ![Ayu](screenshots/app-ayu-mirage.png) |

| UI switched to English | Mobile (390 px) |
|---|---|
| ![English](screenshots/app-i18n-english.png) | ![Mobile](screenshots/settings-mobile.png) |

---

## Features

| Area | What it does |
|---|---|
| Onboarding | 3-step wizard in a fixed order: language → account (**sign in or sign up**) → theme with a live preview |
| Accounts | register / sign in with the same form, `pbkdf2:sha256` hashes, signed-cookie sessions |
| Passwords | minimum 6 characters; a live strength meter (length, character classes, repetition penalty) and a show/hide toggle on every password field |
| Channels | 3 rooms, each with one text channel and one voice channel, grouped into **Text channels** / **Voice channels** categories in the sidebar |
| Text chat | SQLite history (last 100), browser notifications, unread badges, date separators («Today» / «Yesterday» / a date) |
| Replies | right-click a message → **Reply**; the quote above the input is clickable and jumps to the original |
| Reactions | 👍 ❤️ 🔥 😂 😮 🙏 from the context menu, one reaction per user per message, toggled by clicking again |
| Message menu | right-click (or long-press on touch) → react / reply / copy text / jump to a quoted message |
| Markdown | `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, fenced blocks, quotes, lists — rendered from escaped text, so no HTML injection |
| Links | bare domains get `https://` (never doubled), clickable; a card with the real page title is fetched through `/api/link-preview` |
| Avatars | upload ≤ 2 MB and crop in the browser (drag + zoom), **or** generate a 32×32 pixel pattern: palette, pixel density, reproducible seed (text seeds allowed), regenerate button |
| Voice | WebRTC mesh, up to 8 people, speaking indicator, mute, **deafen** |
| Multi-device | the same account can join from a phone and a laptop at once — both in the same channel; one person still means one channel, and their devices collapse into a single tile marked «×2» |
| Video | 720p camera, toggled live via `replaceTrack` |
| Screen | `getDisplayMedia` **with system audio**, own transceiver, "sharing + audio" badge |
| Audio | native constraints **+ local RNNoise (WASM)** in an AudioWorklet, 0–200 % gain, VU meter |
| Deafen | one button in the call: your mic is off **and** you cannot hear the others; the previous mute state is restored when you switch it off |
| Voice layout | side panel → **pinned** over the chat → **fullscreen** stage; click a tile to enlarge it, the rest slide down |
| Picture in picture | native PiP button on every video tile (Firefox always, Chromium where the API allows) |
| Devices | microphone / camera / speaker pickers (`setSinkId`), output volume |
| i18n | English + Russian, switching without reload, `t(key, params)` |
| Themes | Catppuccin ×4, Ayu ×3, Gruvbox ×3 |

---

## Architecture

```
botyaratalk/
├── run.py                     # entry point (gevent monkeypatch + socketio.run)
├── config.py                  # Config / TestConfig, SECRET_KEY, themes, limits
├── requirements.txt           # pinned runtime deps
├── requirements-dev.txt       # + pytest, playwright, ruff
├── LICENSE                    # MIT © dimasbotyara
├── app/
│   ├── __init__.py            # create_app(), blueprints, socket handlers
│   ├── models.py              # User, Room, Message, Reaction, RoomMember
│   ├── db.py                  # init_db(), migrate_db(), seed_rooms()
│   ├── avatar.py              # 32×32 pixel generator + upload validation
│   ├── links.py               # URL normalization / extraction (https:// prefix)
│   ├── auth.py                # /api/auth/*
│   ├── routes.py              # HTML routes
│   ├── api.py                 # rooms, i18n, config, avatars, link preview
│   ├── sockets.py             # Socket.IO handlers (chat + signaling)
│   ├── signaling.py           # VoiceRegistry — voice room state
│   ├── tls.py                 # self-signed certificate for LAN + SSLContext
│   └── i18n.py                # locale loading, language/theme resolution
├── locales/{ru,en}.json
├── static/
│   ├── css/                   # reset, variables, layout, auth, onboarding, chat,
│   │                          # voice, settings, avatar, context-menu + themes/*.css
│   ├── js/                    # 19 ES modules (see below)
│   ├── vendor/
│   │   ├── socket.io.min.js   # local Socket.IO client
│   │   └── rnnoise/           # local RNNoise: workletProcessor.js + 2 × .wasm
│   └── img/{favicon.svg,icons/*.svg}
├── templates/{base,onboarding,auth,app}.html + partials/
├── scripts/{seed_rooms,take_screenshots}.py
├── tests/                     # pytest suite + e2e_two_peers.py
├── AUDIT.md                   # audit log: what was found and fixed
├── DECISIONS.md               # why things are built this way
└── screenshots/               # 23 PNGs produced by Playwright
```

Frontend modules: `main`, `socket`, `rooms`, `textchat`, `message`, `markdown`,
`context-menu`, `avatar`, `voice`, `screen`, `noise`, `stage`, `settings`,
`notifications`, `onboarding`, `auth`, `theme`, `i18n`, `utils`.

---

## How it works

### Text chat

`join_room` subscribes the socket to `text-{slug}`; messages are stored in SQLite and
broadcast as `text_message`, while everybody else receives `message_notification`
(the client decides whether to show a browser notification and a badge).
History: `GET /api/rooms/<slug>/messages?limit=100`.

### Voice (WebRTC mesh)

Every participant is connected to every other. A newcomer receives `room_state` and sends
offers to the peers already in the channel; the server only relays `offer` / `answer` /
`ice_candidate` by `user_id` and checks that both peers belong to the same channel.

Each `RTCPeerConnection` has exactly **four transceivers in a fixed order**:

| m-line | kind | purpose |
|---|---|---|
| 0 | audio | microphone |
| 1 | video | camera |
| 2 | video | screen |
| 3 | audio | screen audio |

**Camera and screen never fight for one tile.** The camera stream renders in the participant's own
tile, the screen stream always gets a **separate tile** (even if the camera is off), so both are
visible at the same time. A screen tile is created the moment its video track actually goes live,
which also removes the race between the `screen_state` flag and the track itself.

### Voice layout: side panel → pinned → fullscreen

| Mode | What happens | How to get there |
|---|---|---|
| `normal` | 340 px panel on the right, chat next to it | default |
| `pinned` | panel fills the whole chat area, chat hidden | click a voice channel, or the expand button |
| `stage` | panel covers the entire window | the fullscreen button (or double-click the header) |

Clicking any tile (camera, participant, screen) in `pinned`/`stage` makes it the **spotlight**:
it takes most of the surface and the other participants slide into a small strip below.
`Esc` steps back from fullscreen. Picking a **text** channel returns the chat and the normal layout —
voice channels and text channels are now independent, a voice click never switches the chat.

### Deafen

The ear-off button in the voice controls does two things at once, like *Deafen* in Discord:
the outgoing mic track is disabled (peers stop hearing you) and every incoming audio element is
set to `volume = 0` (you stop hearing them). Your previous mute state is remembered in
`mutedBeforeDeafen`, so leaving deafen restores it instead of force-enabling the mic.
Peers receive a regular `voice_media_state` with `muted: true` — for them it looks like mute.

### Several devices, one account

The signalling registry is keyed by **socket id**, not user id:

```
VoiceRegistry.peers: dict[user_id, dict[sid, VoicePeer]]
```

So a phone and a laptop can sit in the same voice channel under one account. The invariant from
round 4 is intact — a person is still in exactly one voice channel — but inside that channel they
may hold several devices. `offer` / `answer` / `ice_candidate` carry `target_sid` (and the reply
carries `from_sid`), and `voice_device_left` means "one device left, the person is still here"
while `voice_user_left` means "the person went away entirely".

In the UI those devices collapse into **one tile** with a «×2» badge: each tile has a
representative entry, and when that entry leaves the tile moves to the next device instead of
flickering. Participant counters (`groupedRoster`) and the sidebar badge count people, not
connections. The price is a full mesh — two devices per person means more peer connections, and
the 8-person limit is a limit on people.

### Picture in picture

Every tile with live video gets a PiP button (and double-click works as a shortcut).
It uses the native `HTMLVideoElement.requestPictureInPicture()`: Firefox exposes it for any video,
Chromium only for some sources — when the browser refuses, the button simply does not appear
and the app keeps working. Screen-capture tiles use `object-fit: contain`, so shared desktops
are never cropped.

That is why camera and screen sharing coexist, and why toggling media is just
`sender.replaceTrack()` — no SDP renegotiation, no reconnection.

### Screen sharing with audio

`getDisplayMedia({ video, audio })` is always requested; if the browser returns video only we
keep going. Screen tracks go to their own senders, and the receiving side plays screen audio
in a **separate** `<audio>` element (never mixed with the mic). When the sharer stops via the
browser banner, `track.onended` restores everything. The peer UI shows a “Screen sharing”
badge plus a speaker icon when the stream carries audio.

### Noise suppression: RNNoise in an AudioWorklet

```
getUserMedia (noiseSuppression / echoCancellation / autoGainControl)
      │
      ▼
AudioContext(48000) → MediaStreamSource → GainNode (0–200 %)
      │
      ├─ native mode  → high-pass 110 Hz ──────────────┐
      │                                               │
      └─ rnnoise mode → high-pass 70 Hz → AudioWorkletNode (RNNoise WASM)
                                          → presence peak 2.6 kHz
                                                       │
                        ┌──────────────────────────────┘
                        ▼
              MediaStreamDestination → WebRTC track
                        │
                        ├→ AnalyserNode (VU meter, “speaking” indicator)
                        └→ self-monitor gain (local only, never sent)
```

* Assets live in `static/vendor/rnnoise/` — `workletProcessor.js`, `rnnoise.wasm`,
  `rnnoise_simd.wasm` and the upstream `LICENSE`. Nothing is fetched from the internet.
* `static/js/noise.js` picks the SIMD build when `WebAssembly.validate` says the browser
  supports it, loads the worklet once per `AudioContext` and returns `null` on any failure.
* The switch is in **Settings → Audio → Enhanced (RNNoise)**. Flipping it during a call
  rebuilds the graph and swaps the outgoing track via `replaceTrack()` — the connection
  stays alive (verified in `AUDIT.md`).

### Themes and i18n

Each theme is a CSS file with a `[data-theme="…"]` block (not `:root`), so the very same
variables paint the preview cards in onboarding and settings — the mini-layout renders real
theme colours without duplicating values in JS.

Every UI string lives in `locales/*.json` and is applied through
`data-i18n` / `data-i18n-placeholder` / `data-i18n-aria-label`. `t(key, params)` substitutes
`{name}`; switching the language re-renders the DOM without a reload.

---

## HTTPS and LAN

Browsers allow `getUserMedia` / `getDisplayMedia` only in a **secure context** — `https://` or
`http://localhost`. Over a bare `http://192.168.x.x` the camera and mic simply never start.

botyaratalk solves this itself: on the first run `app/tls.py` collects every local IPv4 address,
generates a self-signed certificate with a proper `subjectAltName` list
(`IP:192.168.x.x, IP:127.0.0.1, DNS:localhost`) and serves the app over TLS.
The certificate is stored in `instance/` and ignored by git.

```bash
python run.py                    # HTTPS is the default
BOTYARATALK_HTTPS=0 python run.py   # force plain HTTP (localhost debugging)
BOTYARATALK_HTTPS=1 python run.py   # require HTTPS, fail if no certificate can be made
```

The browser will warn once about the self-signed certificate — choose *Advanced → Proceed*.
To get rid of the warning, add the generated `instance/cert.pem` to your system's trusted roots
(optional, everything works without it).

No `cryptography` package and no `openssl` on the machine? The server logs it clearly and falls
back to HTTP instead of failing silently.

**Older browsers / stubborn setups** — force a single origin to be treated as secure:

```
chrome://flags/#unsafely-treat-insecure-origin-as-secure
```
```bash
google-chrome --unsafely-treat-insecure-origin-as-secure=http://192.168.1.50:14098
```

**Firefox** — in `about:config`:
```
media.devices.insecure.enabled = true
media.getusermedia.insecure.enabled = true
```

**Mobile browsers** only accept HTTPS. Either trust the generated certificate or use a tunnel:
```bash
cloudflared tunnel --url http://localhost:14098
# or
ngrok http 14098
```
(iOS never exposes system audio for screen sharing — that is an OS limitation.)

The voice panel still shows a `voice.secure_context` warning whenever the context is insecure,
so the app degrades gracefully instead of breaking silently.

## Tests

```bash
pytest tests/ -q
```

86 tests across five files:

* `test_auth.py` — registration, validation, duplicates, login/logout, redirects, i18n endpoint,
  and the onboarding order (language → account with both tabs → theme).
* `test_rooms.py` — room seeding, channel keys, history, limits, integrity of all 10 CSS themes.
* `test_socket_chat.py` — `VoiceRegistry` unit tests: sid-keyed devices, the *one user — one voice
  channel* invariant, a second device joining the same channel, per-device leave, per-device flags,
  the people-based participant limit; plus Socket.IO chat/signaling checks and live switching.
* `test_chat_features.py` — link normalization (11 cases, `mailto:`/`v1.2.3` stay plain
  text), reply quoting, reactions add/toggle, cross-room replies rejected, avatar
  generator determinism and clamping, PNG upload/reset, and the schema migration that
  upgrades a 1.0 database in place.
* `test_assets.py` — vendored RNNoise files, no external CDNs, no hardcoded secret key,
  MIT license for `dimasbotyara`, README badges, `.gitignore` coverage, locale key parity,
  no Russian strings or inline styles in templates, **self-signed certificate generation**
  (with a real `subjectAltName`), no hardcoded IPs in `run.py`, and the presence of the
  stage/layout hooks in `stage.js`, `voice.css` and `voice-bar.html`.

Tests use `TestConfig`: in-memory SQLite and `async_mode="threading"`.

**Real WebRTC E2E** (two browser contexts, spins up its own server):

```bash
python tests/e2e_two_peers.py
```

39 assertions: signing up and signing in through the new onboarding, joining, bidirectional
audio, camera, mute badge, screen sharing video, **screen-sharing audio verified through
`getStats()`**, camera and screen living in separate tiles, voice-channel click not touching the
chat, fullscreen stage, tile spotlight, `Esc`, **deafen muting both directions and restoring the
previous mute state**, returning to the chat, stop sharing, leaving the call, and a **multi-device
block**: a second device of the same account joining the same channel, one tile marked «×2», the
counter still showing one person, and the tile dropping back to «×1» when that device leaves.

**Linting**

```bash
ruff check .          # F/E9/I/W, config in pyproject.toml
```

---

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `BOTYARATALK_HOST` | `0.0.0.0` | bind address |
| `BOTYARATALK_PORT` | `14098` | port |
| `BOTYARATALK_DB` | `sqlite:///instance/botyaratalk.db` | database URI |
| `BOTYARATALK_SECRET_KEY` | `instance/secret.key` | session signing key |
| `BOTYARATALK_ASYNC_MODE` | `gevent` | `gevent` or `threading` |
| `BOTYARATALK_HTTPS` | `auto` | `auto` generates a certificate, `0` plain HTTP, `1` require HTTPS |
| `BOTYARATALK_DEBUG` | `0` | `1` enables Flask debug |

---

## API

REST

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | `{username, password, password2}` → session |
| POST | `/api/auth/login` | `{username, password}` → session |
| POST | `/api/auth/logout` | sign out |
| GET | `/api/auth/me` | current user |
| GET | `/api/rooms` | room list |
| GET | `/api/rooms/<slug>/messages?limit=100` | history |
| GET | `/api/i18n?lang=ru` | translations |
| GET | `/api/config` | ICE servers, themes, limits |
| GET | `/api/health` | `{ok: true}` |

Socket.IO (client → server): `join_room`, `leave_room`, `text_message`, `typing`,
`voice_join`, `voice_leave`, `voice_media_state`, `screen_started`, `screen_stopped`,
`offer`, `answer`, `ice_candidate`.

Socket.IO (server → client): `connected`, `room_state`, `voice_user_joined`,
`voice_user_left`, `voice_roster`, `voice_media_state`, `text_message`,
`message_notification`, `typing`, `screen_state`, `offer`, `answer`, `ice_candidate`.

---

## Browser support

| Browser | Voice / video | Screen share | Screen audio | RNNoise | Picture in picture |
|---|---|---|---|---|---|
| Chrome / Edge 110+ | ✅ | ✅ | ✅ (tab/system audio) | ✅ | ⚠️ depends on the source |
| Firefox 115+ | ✅ | ✅ | ⚠️ usually video only | ✅ | ✅ always |
| Safari 16+ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Yandex / Chromium builds | ✅ | ✅ | ✅ | ✅ | ❌ no native API |

---

## License

MIT © [dimasbotyara](https://github.com/dimasbotyara). See [LICENSE](LICENSE).

The RNNoise build in `static/vendor/rnnoise/` is
[`@sapphi-red/web-noise-suppressor`](https://www.npmjs.com/package/@sapphi-red/web-noise-suppressor)
(wrapping `@shiguredo/rnnoise-wasm`), Apache-2.0 — its license ships next to the binaries.

This is a deliberately local-first project: no TURN, no federation, no TLS on top.
It is not meant to be exposed to the open internet as-is.
