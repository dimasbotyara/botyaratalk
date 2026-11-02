# botyaratalk

[![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Flask-3.1-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![WebRTC](https://img.shields.io/badge/WebRTC-mesh-333333?logo=webrtc&logoColor=white)](https://webrtc.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-54%20passed-brightgreen.svg)](#tests)
[![Screenshots](https://img.shields.io/badge/screenshots-15-blueviolet.svg)](#screenshots)

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
python run.py                   # → http://0.0.0.0:5000
```

Open `http://localhost:5000` — the onboarding wizard walks you through language → theme → sign-up.

On the very first run botyaratalk creates `instance/secret.key` (session signing key, mode 0600),
`instance/botyaratalk.db` and three rooms with localized names. No migrations, no external services.

To open it from another device on the same LAN use `http://<server-ip>:5000` and read
[HTTPS and LAN](#https-and-lan) — browsers gate media APIs behind secure contexts.

```bash
python scripts/seed_rooms.py        # (re)create the rooms, idempotent
pytest tests/ -q                    # backend test suite
python tests/e2e_two_peers.py       # real WebRTC E2E with two browser contexts
python scripts/take_screenshots.py  # 15 PNGs into screenshots/
```

---

## Screenshots

| Onboarding: language | Onboarding: theme |
|---|---|
| ![Language](screenshots/onboarding-step-lang.png) | ![Theme](screenshots/onboarding-step-theme.png) |

| Onboarding: sign-up | Chat with a message |
|---|---|
| ![Register](screenshots/onboarding-step-register.png) | ![Chat](screenshots/chat-with-message.png) |

| Voice channel | Voice call with camera on |
|---|---|
| ![Voice channel](screenshots/voice-channel.png) | ![Camera](screenshots/app-voice-video-on.png) |

| Screen sharing (peer + audio badge) | Device pickers |
|---|---|
| ![Screen sharing](screenshots/app-screen-sharing.png) | ![Devices](screenshots/settings-devices.png) |

| Settings — devices & RNNoise | Settings on a 768 px screen |
|---|---|
| ![Settings](screenshots/settings-modal.png) | ![Mobile settings](screenshots/settings-mobile.png) |

| Themes — Catppuccin Latte | Gruvbox Dark | Ayu Mirage |
|---|---|---|
| ![Latte](screenshots/app-light-catppuccin-latte.png) | ![Gruvbox](screenshots/app-dark-gruvbox.png) | ![Ayu](screenshots/app-ayu-mirage.png) |

| Theme picker in settings | UI switched to English |
|---|---|
| ![Themes](screenshots/settings-appearance.png) | ![i18n](screenshots/app-i18n-english.png) |

---

## Features

| Area | What it does |
|---|---|
| Onboarding | 3-step wizard: language → theme with a live preview → sign-up |
| Accounts | register / sign in, `pbkdf2:sha256` hashes, signed-cookie sessions |
| Channels | 3 rooms, each with one text channel and one voice channel, grouped into **Text channels** / **Voice channels** categories in the sidebar |
| Text chat | SQLite history (last 100), browser notifications, unread badges |
| Voice | WebRTC mesh, up to 8 peers, speaking indicator, mute |
| Video | 720p camera, toggled live via `replaceTrack` |
| Screen | `getDisplayMedia` **with system audio**, own transceiver, "sharing + audio" badge |
| Audio | native constraints **+ local RNNoise (WASM)** in an AudioWorklet, 0–200 % gain, VU meter, self-monitor |
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
│   ├── models.py              # User, Room, Message, RoomMember
│   ├── db.py                  # init_db(), seed_rooms()
│   ├── auth.py                # /api/auth/*
│   ├── routes.py              # HTML routes
│   ├── api.py                 # /api/rooms, /api/i18n, /api/config, /api/health
│   ├── sockets.py             # Socket.IO handlers (chat + signaling)
│   ├── signaling.py           # VoiceRegistry — voice room state
│   └── i18n.py                # locale loading, language/theme resolution
├── locales/{ru,en}.json
├── static/
│   ├── css/                   # reset, variables, layout, auth, onboarding,
│   │                          # chat, voice, settings + themes/*.css (10 themes)
│   ├── js/                    # 14 ES modules (see below)
│   ├── vendor/
│   │   ├── socket.io.min.js   # local Socket.IO client
│   │   └── rnnoise/           # local RNNoise: workletProcessor.js + 2 × .wasm
│   └── img/{favicon.svg,icons/*.svg}
├── templates/{base,onboarding,auth,app}.html + partials/
├── scripts/{seed_rooms,take_screenshots}.py
├── tests/                     # pytest suite + e2e_two_peers.py
├── AUDIT.md                   # audit log: what was found and fixed
├── DECISIONS.md               # why things are built this way
└── screenshots/               # 15 PNGs produced by Playwright
```

Frontend modules: `main`, `socket`, `rooms`, `textchat`, `voice`, `screen`, `noise`,
`settings`, `notifications`, `onboarding`, `auth`, `theme`, `i18n`, `utils`.

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

Browsers allow `getUserMedia` / `getDisplayMedia` only in a **secure context**
(`https://` or `http://localhost`). Over a LAN IP the media APIs stay blocked — this is a
browser policy, not an app limitation. Options:

**1. Same machine** — `http://localhost:5000` just works.

**2. Chrome / Edge / Opera with an IP address.**
```
chrome://flags/#unsafely-treat-insecure-origin-as-secure
```
Add `http://192.168.1.50:5000`, choose *Enabled*, restart the browser. Or launch with a flag:
```bash
google-chrome --unsafely-treat-insecure-origin-as-secure=http://192.168.1.50:5000
```

**3. Firefox** — in `about:config` set:
```
media.devices.insecure.enabled = true
media.getusermedia.insecure.enabled = true
```

**4. Mobile browsers** — HTTPS only. Quick tunnel:
```bash
cloudflared tunnel --url http://localhost:5000
# or
ngrok http 5000
```
(iOS never exposes system audio for screen sharing — that is an OS limitation.)

**5. Proper HTTPS for the whole LAN** — reverse proxy with an internal certificate, e.g. Caddy:

```
# Caddyfile
192.168.1.50:5443 {
    tls internal
    reverse_proxy 127.0.0.1:5000
}
```
WebSockets are proxied automatically; accept the certificate once in the browser.

The voice panel shows a `voice.secure_context` warning whenever the context is insecure —
the app degrades gracefully instead of breaking silently.

---

## Tests

```bash
pytest tests/ -q
```

54 tests across four files:

* `test_auth.py` — registration, validation, duplicates, login/logout, redirects, i18n endpoint.
* `test_rooms.py` — room seeding, channel keys, history, limits, integrity of all 10 CSS themes.
* `test_socket_chat.py` — `VoiceRegistry` unit tests and Socket.IO chat/signaling checks.
* `test_assets.py` — vendored RNNoise files, no external CDNs, no hardcoded secret key,
  MIT license for `dimasbotyara`, README badges, `.gitignore` coverage, locale key parity,
  no Russian strings or inline styles in templates.

Tests use `TestConfig`: in-memory SQLite and `async_mode="threading"`.

**Real WebRTC E2E** (two browser contexts, spins up its own server):

```bash
python tests/e2e_two_peers.py
```

18 assertions: joining, bidirectional audio, camera, mute badge, screen sharing video,
**screen-sharing audio verified through `getStats()`**, stop sharing, leaving the call.

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
| `BOTYARATALK_PORT` | `5000` | port |
| `BOTYARATALK_DB` | `sqlite:///instance/botyaratalk.db` | database URI |
| `BOTYARATALK_SECRET_KEY` | `instance/secret.key` | session signing key |
| `BOTYARATALK_ASYNC_MODE` | `gevent` | `gevent` or `threading` |
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

| Browser | Voice / video | Screen share | Screen audio | RNNoise |
|---|---|---|---|---|
| Chrome / Edge 110+ | ✅ | ✅ | ✅ (tab/system audio) | ✅ |
| Firefox 115+ | ✅ | ✅ | ⚠️ usually video only | ✅ |
| Safari 16+ | ✅ | ✅ | ❌ | ✅ |
| Chromium on LAN IP | needs the flag above | needs the flag | — | ✅ |

---

## License

MIT © [dimasbotyara](https://github.com/dimasbotyara). See [LICENSE](LICENSE).

The RNNoise build in `static/vendor/rnnoise/` is
[`@sapphi-red/web-noise-suppressor`](https://www.npmjs.com/package/@sapphi-red/web-noise-suppressor)
(wrapping `@shiguredo/rnnoise-wasm`), Apache-2.0 — its license ships next to the binaries.

This is a deliberately local-first project: no TURN, no federation, no TLS on top.
It is not meant to be exposed to the open internet as-is.
