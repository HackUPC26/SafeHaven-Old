# SafeHaven Development Guide

This guide covers local setup, iOS builds, and running the current hackathon
demo.

For a product overview, see [README.md](README.md).

## Current Demo Data Flow

Two parallel paths leave the phone for every incident event:

1. Live receiver UI path: `App.js` -> `services/bridge.send()` ->
   `services/broadcast.js` -> WebRTC over the signaling WebSocket in
   `p2p-hello/` -> `receiver/index.html`.
2. Durable on-device log path: `bridge.send()` also forwards entries to a Bare
   Worklet (`mobile/backend/worklet.js`) running Corestore and Hypercore.

The receiver browser currently reads the live WebRTC path. The Hypercore log is
built on-device and is the planned P2P replication target.

## Installation

Expo Go does not work for this app. `react-native-webrtc` and
`react-native-bare-kit` need a custom dev client. The first build has to go
through Xcode.

### 0. Prerequisites

System:

- macOS for iOS builds. Linux/Windows can run the signaling server and receiver
  browser only.
- Node.js >= 20 and npm.
- A physical iPhone, recommended for camera, microphone, and GPS, or an iOS
  simulator runtime.

First-time macOS / Xcode setup:

1. Install Xcode from the Mac App Store. Open it once so it finishes
   post-install components.
2. Install Xcode command-line tools:

   ```bash
   xcode-select --install
   ```

3. Accept the Xcode license:

   ```bash
   sudo xcodebuild -license accept
   ```

4. Install an iOS simulator runtime if needed:
   Xcode -> Settings -> Platforms -> click the `+` next to iOS -> install the
   latest iOS runtime.
5. Install CocoaPods:

   ```bash
   sudo gem install cocoapods
   ```

   Or use Homebrew:

   ```bash
   brew install cocoapods
   ```

6. For physical-device builds, sign in to Xcode with an Apple ID:
   Xcode -> Settings -> Accounts -> `+` -> Apple ID.
7. Trust the developer profile on the iPhone after the first install:
   iPhone Settings -> General -> VPN & Device Management -> your Apple ID ->
   Trust.

### 1. Clone and install JS deps

```bash
git clone <repo-url> safehaven
cd safehaven

cd mobile
npm install

cd ../p2p-hello
npm install
```

### 2. Optional: re-pack the Bare Worklet bundle

A prebuilt `mobile/backend/worklet.bundle.mjs` is checked in, so this is only
needed if you change `mobile/backend/worklet.js`.

```bash
cd mobile
npm run pack:worklet
```

### 3. First iOS build

The `mobile/ios/` Xcode project is committed. `Pods/` and `build/` are not.
`expo run:ios` runs `pod install` for you on first invocation.

Plug in an iPhone, unlock it, and trust the laptop, or pick a simulator:

```bash
cd mobile
npx expo run:ios --device
```

For simulator:

```bash
cd mobile
npx expo run:ios
```

The first build takes several minutes. When it finishes, the custom dev client
app is installed.

If `pod install` fails with Xcode selection or signing errors, point CocoaPods
at the right Xcode once and retry:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

If the build fails with a code-signing error:

1. Open the workspace, not `.xcodeproj`:

   ```bash
   open mobile/ios/mobile.xcworkspace
   ```

2. Select the `mobile` target.
3. Open Signing & Capabilities.
4. Enable Automatically manage signing.
5. Pick your Apple ID team.
6. Re-run:

   ```bash
   npx expo run:ios --device
   ```

You can also build from Xcode by opening the workspace, selecting your device,
and pressing Run. Metro still needs to run separately.

### 4. Subsequent runs

After the first build, only Metro needs to run on the laptop. The dev client on
the phone connects to it.

```bash
cd mobile
npx expo start --dev-client
```

Press `i` to open the simulator, or open the dev client app on the phone.

Repeat the native build when:

- You change `mobile/package.json` and the new dependency is a native module.
- You edit anything in `mobile/ios/`.
- You re-run `npm run pack:worklet`.
- The dev client crashes on launch with native-module errors.

### 5. Configure the signaling host

In development, the mobile app reads Metro's bundler URL and reuses that IP
with port `8080`. No `.env` is required for the standard LAN demo.

Override only when running outside Metro or signaling from a different machine:

```bash
echo "EXPO_PUBLIC_SIGNAL_HOST=192.168.x.x:8080" > mobile/.env
```

## Running The Demo

Use two terminals and a browser tab.

Terminal 1, signaling server and receiver static host:

```bash
cd p2p-hello
npm run signal
```

This prints the LAN URL:

```text
http://<your-ip>:8080/
```

Terminal 2, mobile app:

```bash
cd mobile
npx expo start --dev-client
```

Browser receiver:

```text
http://<your-ip>:8080/#<token>
```

The easiest path is to scan the QR code shown on the phone:
long-press `Barcelona` for 2 seconds -> Settings -> Trusted Contact Pairing.
The QR encodes the full receiver URL.

Without QR, open `http://<your-ip>:8080/` and paste the token shown under the QR
into the overlay.

## Triggers

- Hold the H/L row on the weather screen for 3 seconds -> Tier 1.
- Type a codeword into the search field:
  - `sunny` -> Tier 1
  - `cloudy` -> Tier 2
  - `stormy` -> Tier 3

Defaults are configurable in Settings.

## No-iPhone Smoke Test

For a browser-only path, open this in a second tab:

```text
http://<your-ip>:8080/sender
```

Click Start Broadcast and use the receiver URL it prints.

## Troubleshooting

### Native module not found

If the app crashes with an error such as:

```text
Cannot find native module 'ExpoSpeechRecognition'
```

The JavaScript bundle is running in a dev client that was built before that
native module was installed. Rebuild the native app:

```bash
cd mobile
npx expo run:ios --device
```

For simulator:

```bash
cd mobile
npx expo run:ios
```

If pods look stale, run:

```bash
cd mobile/ios
pod install
```

Then rebuild with `npx expo run:ios`.

### Port 8080 already in use

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN -t | xargs kill -9
```

### Phone cannot reach the laptop

Use the same Wi-Fi network. Cellular and eduroam are known to fail because of
UDP QoS or AP isolation.

### Receiver shows Tier 0 forever

Make sure the receiver URL includes a token in the fragment, or paste one into
the overlay. Check the signaling log for a `sender connected` line.

### Worklet boot error in Metro

Usually this means a stale build. Re-run:

```bash
cd mobile
npm run pack:worklet
npx expo run:ios
```

### Black video or no audio on the receiver

Safari may block autoplay with audio. The receiver shows a Tap to enable audio
overlay when this happens.

## Known Prototype Limits

- The WebSocket signaling server is a local demo helper, not the final
  no-server design.
- The browser receiver does not yet replicate the on-device Hypercore log.
- AI sound/video labels are documented in BMAD but not fully wired through the
  end-to-end product flow yet.
- Receiver evidence export still needs final implementation.
- Physical-device testing is required for location, microphone, camera, and iOS
  native trigger behavior.
- Cellular and eduroam can break Hyperswarm and the WebRTC fallback. Demo on a
  normal LAN.

## BMAD Build Backlog

The BMAD stories prioritize the riskiest implementation path first:

1. Validate browser-to-Bare/Hypercore replication before building more UX.
2. Implement the Bare Worklet incident log and typed entries.
3. Build the weather disguise and monotonic tier state machine.
4. Add GPS, audio chunks, then video chunks.
5. Add receiver map, timeline, audio labels, and risk banner.
6. Add AI sound classification and auto-trigger policy.
7. Add Save Evidence export from browser IndexedDB.

Key story file:
`_bmad-output/planning-artifacts/SafeHaven-Epics-and-Stories.md`.
