# SafeHaven — WebRTC Signaling + Receiver Host

This directory contains the live video/audio streaming pipeline used by the
SafeHaven mobile app:

1. A lightweight WebSocket signaling server.
2. A static host for the browser receiver PWA.
3. A browser sender page for no-phone smoke tests.

---


## WebRTC Streaming Pipeline

Live video + audio from an iPhone sender to any browser or native receiver, with no cloud media relay. Signaling uses a lightweight WebSocket server; media travels directly peer-to-peer over DTLS-SRTP (encrypted by WebRTC by default).

### Architecture

```
iPhone (sender)  ──WebSocket──►  Signaling server  ◄──WebSocket──  Browser / Phone (receiver)
       │                              (token room)                          │
       └──────────────────────── WebRTC P2P (DTLS-SRTP) ──────────────────┘
```

1. Sender connects with `role=sender&token=<token>` and acquires camera/mic.
2. Receiver connects with `role=receiver&token=<token>`.
3. Server sends `receiver-joined` to sender → sender creates SDP offer.
4. SDP offer/answer and ICE candidates are forwarded by the server.
5. WebRTC connection established; server is no longer in the media path.

---

### Quick Start

```bash
cd p2p-hello
npm install
npm run signal
```

Server binds to port **8080** by default (`PORT=<n>` to override).  
It prints its LAN IP on startup — note it for the steps below.

---

### Option A — Browser-only test (no iPhone needed)

Open **two tabs** (or two devices on the same network):

| Tab | URL |
|-----|-----|
| Sender | `http://localhost:8080/sender` |
| Receiver | copy the receiver URL displayed on the sender page |

1. On the sender page click **Start Broadcast** and allow camera + mic.
2. Copy the receiver URL (token in the `#` fragment) and open it.
3. Video and audio appear within 1–2 seconds.

> **Note:** Browsers block `getUserMedia` on plain HTTP from LAN IPs.  
> The **sender** page must be opened via `localhost`, not the LAN IP.  
> The **receiver** page can use either address.

---

### Option B — iPhone sender → Browser receiver

#### Prerequisites

- Bare Expo dev build (not Expo Go) — `react-native-webrtc` requires native modules.
- Xcode installed, iPhone and Mac on the same Wi-Fi network.

#### Steps

1. **Configure the signal host** in `mobile/.env`:
   ```
   EXPO_PUBLIC_SIGNAL_HOST=<your-mac-lan-ip>:8080
   ```
   The LAN IP is printed when the signaling server starts.

2. **Install pods** (first time only):
   ```bash
   cd mobile/ios && pod install && cd ../..
   ```

3. **Build and run:**
   ```bash
   cd mobile
   npx expo run:ios                   # simulator
   npx expo run:ios --device          # physical device
   ```

4. **Activate the sender in-app:**
   - Type `sunny` in the "Search weather…" box → tier 1 activates.
   - Camera opens, invite link appears at the bottom — tap to copy.

5. **Open the receiver URL** in any browser:
   ```
   http://<mac-lan-ip>:8080/#<token>
   ```

6. Video + audio stream within 1–2 seconds.

---

### Option C — Phone-to-phone (native receiver)

On a second phone running the SafeHaven app, type in the search box:
```
recv:<token>
```
where `<token>` is the 16-hex token shown in the sender's invite link. The app enters full-screen receiver mode.

---

### Codeword tiers (sender app)

The app is disguised as a weather app. Codewords unlock emergency tiers:

| Codeword | Effect |
|----------|--------|
| `sunny`  | Tier 1 — starts broadcast + GPS |
| `cloudy` | Tier 2 (from tier 1) |
| `storm`  | Tier 3 (from tier 2) |

A dot appears top-right when active (orange = tiers 1–2, red = tier 3).

---

### File reference

| Path | Purpose |
|------|---------|
| `p2p-hello/signaling.js` | WebSocket signaling server (also hosts the receiver UI at `/`) |
| `receiver/index.html` | Polished React PWA — served at `/` by the signaling server |
| `p2p-hello/receiver-pwa/index.html` | Older minimal receiver — no longer served, kept for reference |
| `p2p-hello/sender-demo.html` | Browser sender for testing |
| `mobile/services/config.js` | Signal server URL (reads `.env`) |
| `mobile/services/broadcast.js` | Sender WebRTC service |
| `mobile/services/receive.js` | Receiver WebRTC service |
| `mobile/App.js` | Main app UI |
| `scripts/demo-stream.sh` | One-command demo launcher |

---

### Troubleshooting

**"No script URL provided" on simulator**  
App was built targeting a physical device. Rebuild: `cd mobile && npx expo run:ios`

**Camera/mic permission denied**  
Check `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` in `mobile/ios/mobile/Info.plist`. The Simulator has no real camera — use a physical device for full A/V.

**Signaling WebSocket closes immediately**  
Verify `npm run signal` is running from `p2p-hello/` and `EXPO_PUBLIC_SIGNAL_HOST` in `mobile/.env` matches the current LAN IP (changes when you switch networks).

**Browser sender shows "HTTPS Required"**  
Open the sender via `http://localhost:8080/sender`, not the LAN IP. The receiver can use either.
