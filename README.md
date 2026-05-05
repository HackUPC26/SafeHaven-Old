# SafeHaven

SafeHaven is a covert safety app for situations where visible help-seeking can
increase danger. It is disguised as an everyday utility app, but can silently
escalate an incident and bring a trusted contact into the situation with live
context.

The hackathon MVP focuses on a sender iPhone app and a trusted-contact browser
dashboard. The sender experience looks like a normal weather app; hidden
triggers and codewords escalate the incident. The receiver dashboard shows the
trusted contact the current tier, location, timeline, and live audio/video
context so they can decide what action to take.

For development setup and demo-running instructions, see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Problem

People in danger often cannot safely call for help.

In domestic abuse and coercive-control contexts, visible SOS behavior can
increase risk. Existing tools are usually either passive location sharing or
overt panic interfaces that can be noticed. SafeHaven targets the missing
middle: discreet, real-time trusted-contact intervention with evidence
continuity.

## Solution

SafeHaven combines:

- Disguised sender app UI, with a weather skin in the MVP.
- Covert activation through codewords and hidden gestures.
- Three-tier escalation through manual triggers and planned AI auto-triggers.
- Trusted-contact browser dashboard with no receiver app install.
- Tamper-evident incident timeline and explicit evidence export.

Positioning: when visible help is dangerous, SafeHaven brings a trusted witness
in silently.

## Target Users

- People at risk of intimate partner violence and coercive control.
- People walking alone at night, students, travelers, and elderly users.
- Trusted contacts who need immediate, interpretable context during an
  incident.

## Product Flow

1. The sender opens an iPhone app that appears to be a weather utility.
2. The sender escalates through monotonic safety tiers using hidden triggers or
   codewords.
3. The trusted contact opens a browser dashboard from a shared pairing link.
4. The dashboard receives incident context: tier state, location, timeline,
   audio/video signals, and risk cues.
5. At the highest tier, the receiver sees a prominent call-assist action with
   the latest known location.
6. The receiver can explicitly save evidence from the browser session.

| Tier | Meaning | MVP behavior |
| --- | --- | --- |
| 0 | Idle | Normal disguise UI only |
| 1 | Monitor | Start audio context and live GPS |
| 2 | Escalated | Add live video |
| 3 | Emergency | High-priority alert and call-assist UX |

## Sender Experience

- The app appears as a normal utility UI.
- The user can trigger escalation through a codeword in the search field or a
  hidden long-press gesture.
- Escalation tiers activate with minimal visible change to the disguise.
- Planned AI layers can detect danger signals when the user cannot act.

## Receiver Experience

The trusted-contact dashboard is designed to make the situation understandable
quickly:

- Live video feed with AI annotation overlays.
- Audio label timeline for signals such as shouting, screaming, impacts, or
  silence.
- Live GPS map with coordinates, address, and movement trail.
- Risk assessment banner that synthesizes tier, GPS, audio, and video signals.
- Chronological incident timeline.
- Call-assist action with the latest location.
- Explicit Save Evidence action.
- Session header with person name, tier, duration, and connection status.

## Privacy And Evidence Model

SafeHaven is designed around data minimization and trusted-contact control.

- Incident chronology is stored in an append-only Hypercore log.
- The target architecture avoids a cloud backend for incident data.
- Post-incident persistence is explicit: the trusted contact chooses whether to
  save evidence.
- Evidence packages are planned to include NDJSON timeline data, media chunk
  references, AI labels with timestamps and confidence, GPS track data, and a
  report with key video frames.

## Architecture Direction

SafeHaven targets a serverless Pear-protocol architecture:

- Sender: React Native / Expo iPhone app with a Bare Worklet P2P runtime.
- Incident log: Hypercore append-only event/media log managed by Corestore.
- Transport: Hyperswarm DHT with encrypted peer connections.
- Receiver: static browser PWA that reads a pairing URL fragment and replicates
  the incident log.
- Backend: no incident-data backend; a static host only serves the receiver
  bundle.

The current hackathon demo uses WebRTC over a small WebSocket signaling server
while the no-server browser-to-Hypercore replication path is built.

## Components

| Component | Directory | Description |
| --- | --- | --- |
| Mobile App | `mobile/` | Expo React Native sender app with weather disguise, settings, pairing, tier state machine, GPS, WebRTC broadcast, and Bare Worklet incident log |
| Receiver PWA | `receiver/` | Browser dashboard for tier state, video, audio levels, GPS map, and incident timeline |
| Signaling Server | `p2p-hello/` | Prototype WebSocket signaling server and static receiver host |
| BMAD Docs | `_bmad-output/` | Product, architecture, market, and story artifacts |
| BMAD Config | `_bmad/` | BMAD method config, agents, workflows, and manifests |

## Safety Notes

- SafeHaven is a prototype, not a production emergency service.
- It should not claim guaranteed police dispatch.
- Emergency actions are call-assist flows unless a verified emergency-service
  integration exists.
- Microphone, camera, location, and evidence export require explicit
  permission.
- Mocked emergency behavior should be marked as demo-only.

## BMAD Sources

- `_bmad-output/planning-artifacts/SafeHaven-MVP-PRD.md`
- `_bmad-output/planning-artifacts/SafeHaven-Architecture.md`
- `_bmad-output/planning-artifacts/SafeHaven-Epics-and-Stories.md`
- `_bmad-output/planning-artifacts/SafeHaven-Product-Brief-v2.md`

## Glossary

- BMAD: the planning workflow used in this repo.
- Sender: the person using the disguised mobile app.
- Receiver: the trusted contact viewing the browser dashboard.
- Tier: the current incident severity level from 0 to 3.
- Hypercore: the append-only log used for the on-device incident record and
  planned P2P replication.
- Hyperswarm: the P2P discovery and connection layer.
- Bare Worklet: the Bare-runtime sandbox embedded in the iOS app via
  `react-native-bare-kit`.
- Signaling server: the prototype WebSocket broker used by the current demo.
- Call assist: helping the receiver call emergency services without promising
  guaranteed dispatch.
