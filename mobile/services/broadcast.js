import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
  registerGlobals,
} from 'react-native-webrtc'
import { Camera } from 'expo-camera'
import { SIGNAL_WS } from './config'

registerGlobals()

// States (in order of progression):
//   connecting  → signaling WS being opened
//   ready       → media acquired, waiting for a receiver to join
//   streaming   → WebRTC connected, media flowing
//   reconnecting→ transient failure, will retry
//   permission-error → camera/mic denied (terminal until app restart)

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

const s = {
  ws: null,
  pcs: new Map(), // peerId -> RTCPeerConnection (one per viewer)
  stream: null,
  videoTrack: null, // null until tier ≥ 2 — see setBroadcastTier()
  addingVideo: false, // re-entrancy guard for parallel tier transitions
  currentTier: 0, // last tier seen via setBroadcastTier — re-applied after _acquireMedia
  token: null,
  onState: null,
  active: false,
  reconnectTimer: null,
  reconnectDelay: 2000,
  // Events emitted while the WS is still connecting are buffered here and
  // flushed on open. Without this, the very first tier_changed (e.g. tier 1)
  // is lost because broadcast() is started by the same render that fires the
  // event — the WS hasn't even been constructed yet.
  pending: [],
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function startBroadcast(token, onState) {
  // Idempotent: a re-entry with the same token (e.g. tier 2 → 3) must not
  // open a second sender socket — the signaling server kicks the previous
  // one for that role, which then races its own reconnect timer.
  if (s.active && s.token === token) {
    if (onState) s.onState = onState
    return
  }
  if (s.active) _cleanup()
  s.token = token
  s.onState = onState
  s.active = true
  s.reconnectDelay = 2000
  // Acquire media BEFORE opening the WS so we never race with `receiver-joined`
  // arriving while getUserMedia is still pending. (Previously the first viewer
  // of a fresh sender got an offer with zero tracks.)
  _setState('connecting')
  await _acquireMedia()
  if (!s.active) return
  // If tier escalated past 2 while we were acquiring audio, attach video now
  // before opening the WS so the first offer carries both m-lines.
  if (s.currentTier >= 2) await _ensureVideo()
  _connect()
}

export function stopBroadcast() {
  s.active = false
  clearTimeout(s.reconnectTimer)
  s.pending = []
  _cleanup()
  s.onState?.('idle')
}

// Tier-aware media: at T1 we only stream audio. When the sender escalates to
// T2 we acquire the camera and renegotiate every active peer connection so
// viewers start receiving video. Idempotent — repeated calls at the same tier
// are no-ops, and dropping back below T2 (which the monotonic state machine
// doesn't currently do) intentionally does not stop the camera.
//
// IMPORTANT: this is safe to call BEFORE startBroadcast. When called early
// (s.stream not yet acquired) we just record the tier; startBroadcast's own
// post-_acquireMedia hook reads s.currentTier and will call _ensureVideo()
// once the audio stream lands. Without this contract, a direct T0→T2 jump
// would race: setBroadcastTier(2) runs first, _ensureVideo bails (no stream),
// and the user ends up with audio-only.
export async function setBroadcastTier(tier) {
  s.currentTier = tier
  if (tier >= 2 && s.stream) await _ensureVideo()
}

export function getLocalStream() {
  return s.stream
}

// Event channel piggybacked on the sender's signaling WS. The signaling
// server fans these out to every receiver in the room. Used by the bridge
// to surface tier/GPS/AI events on the demo viewer in real time — Hypercore
// is still the source of truth (event log), this is the live UX channel.
//
// Events emitted while the WS is connecting (or briefly between reconnects)
// are buffered and flushed on the next open — without this, the event that
// triggered the broadcast in the first place (e.g. tier 1 incident_opened)
// is lost because it fires synchronously with the React state change.
export function sendEvent(payload) {
  const msg = JSON.stringify({ type: 'event', payload })
  const evType = payload?.event_type ?? 'unknown'
  if (s.ws?.readyState === WebSocket.OPEN) {
    try {
      s.ws.send(msg)
      console.log('[broadcast] sent event', evType)
      return true
    } catch (err) {
      // WS reported OPEN but send threw (briefly transitioning to CLOSING).
      // Fall through to buffering so the event isn't lost.
      console.warn('[broadcast] ws.send threw, buffering', evType, err?.message ?? err)
    }
  }
  // Always buffer when the WS isn't open. This catches the synchronous race
  // where escalate() fires sendEvent BEFORE the React effect has a chance to
  // call startBroadcast — which would otherwise drop the very first tier
  // change. Capped so an indefinitely-tier-0 session doesn't grow unbounded.
  s.pending.push(msg)
  if (s.pending.length > 100) s.pending.shift()
  console.log('[broadcast] buffered event', evType, 'wsState=', s.ws?.readyState ?? 'no-ws', 'pending=', s.pending.length)
  return true
}

// ─── Signaling connection ─────────────────────────────────────────────────────

function _connect() {
  if (!s.active) return
  _setState('connecting')

  s.ws = new WebSocket(
    `${SIGNAL_WS}/ws?role=sender&token=${encodeURIComponent(s.token)}`
  )

  s.ws.onopen = () => {
    s.reconnectDelay = 2000
    // Media was already acquired in startBroadcast(). If it failed back then
    // we wouldn't have a stream — surface that as permission-error.
    if (!s.stream) { _setState('permission-error'); return }
    _setState('ready')
    // Flush any events buffered while the WS was opening (or while we were
    // briefly between reconnects). This is the path that delivers tier 1's
    // incident_opened to the viewer.
    if (s.pending.length) {
      console.log('[broadcast] flushing', s.pending.length, 'buffered events')
      for (const msg of s.pending) s.ws.send(msg)
      s.pending = []
    }
  }

  s.ws.onmessage = async (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    const { peerId } = msg

    switch (msg.type) {
      case 'receiver-joined':
        // A new viewer joined under this peerId — set up a dedicated PC and
        // push an offer just to them. Other viewers are unaffected.
        if (peerId) await _setupPeer(peerId)
        break

      case 'answer': {
        const pc = peerId && s.pcs.get(peerId)
        if (!pc) break
        try {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }))
        } catch (err) {
          console.error('[broadcast] setRemoteDescription:', err)
        }
        break
      }

      case 'ice-candidate': {
        const pc = peerId && s.pcs.get(peerId)
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)) } catch {}
        }
        break
      }

      case 'peer-disconnected': {
        const pc = peerId && s.pcs.get(peerId)
        if (pc) { try { pc.close() } catch {} }
        if (peerId) s.pcs.delete(peerId)
        if (s.pcs.size === 0) _setState('ready')
        break
      }
    }
  }

  s.ws.onerror = (e) => console.error('[broadcast] ws error:', e.message ?? e)

  s.ws.onclose = () => {
    if (!s.active) return
    _setState('reconnecting')
    s.reconnectTimer = setTimeout(() => {
      s.reconnectDelay = Math.min(s.reconnectDelay * 1.5, 30000)
      _connect()
    }, s.reconnectDelay)
  }
}

// ─── Media acquisition ────────────────────────────────────────────────────────

async function _acquireMedia() {
  if (s.stream) return true

  // Mic is required from T1; camera is requested up-front so iOS doesn't pop
  // a permission dialog mid-incident at T2 (would defeat the disguise). The
  // actual camera capture is deferred until _ensureVideo() runs.
  const camPerm = await Camera.requestCameraPermissionsAsync()
  const micPerm = await Camera.requestMicrophonePermissionsAsync()
  console.log('[broadcast] cam:', camPerm.status, 'mic:', micPerm.status)

  if (micPerm.status !== 'granted') {
    console.error('[broadcast] microphone permission not granted')
    _setState('permission-error')
    return false
  }

  try {
    s.stream = await mediaDevices.getUserMedia({ audio: true, video: false })
    return true
  } catch (err) {
    console.error('[broadcast] getUserMedia(audio) failed:', err)
    _setState('permission-error')
    return false
  }
}

// Lazily acquire the camera and attach the video track to the active stream
// and every existing PC, then renegotiate. Called by setBroadcastTier() the
// first time tier ≥ 2.
async function _ensureVideo() {
  if (!s.active || !s.stream) return
  if (s.videoTrack || s.addingVideo) return
  s.addingVideo = true
  try {
    const camStream = await mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user' },
    })
    const track = camStream.getVideoTracks()[0]
    if (!track) {
      console.error('[broadcast] camera returned no video track')
      return
    }
    s.videoTrack = track
    s.stream.addTrack(track)
    console.log('[broadcast] video added (tier 2)')

    // Add the new track to every active PC and renegotiate. createOffer here
    // produces an SDP that includes the video m-line; the receiver applies it
    // and answers — no PC teardown needed.
    for (const [peerId, pc] of s.pcs.entries()) {
      try {
        pc.addTrack(track, s.stream)
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        _send({ type: 'offer', peerId, sdp: offer.sdp })
      } catch (err) {
        console.error('[broadcast] renegotiate failed for', peerId, err)
      }
    }
  } catch (err) {
    console.error('[broadcast] camera acquisition failed:', err)
  } finally {
    s.addingVideo = false
  }
}

// ─── WebRTC peer connection (one per viewer) ──────────────────────────────────

async function _setupPeer(peerId) {
  // Tear down any prior PC for this peer (e.g. they reconnected).
  const prev = s.pcs.get(peerId)
  if (prev) { try { prev.close() } catch {} }

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  s.pcs.set(peerId, pc)

  s.stream?.getTracks().forEach(track => pc.addTrack(track, s.stream))

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && s.ws?.readyState === WebSocket.OPEN) {
      _send({ type: 'ice-candidate', peerId, candidate })
    }
  }

  pc.onconnectionstatechange = () => {
    const cs = pc.connectionState
    if (cs === 'connected') _setState('streaming')
    if (cs === 'failed') {
      try { pc.close() } catch {}
      s.pcs.delete(peerId)
      if (s.pcs.size === 0) _setState('ready')
    }
  }

  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    _send({ type: 'offer', peerId, sdp: offer.sdp })
  } catch (err) {
    console.error('[broadcast] createOffer:', err)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _send(obj) {
  if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(obj))
}

function _setState(state) {
  console.log('[broadcast]', state)
  s.onState?.(state)
}

function _cleanup() {
  try { s.stream?.getTracks().forEach(t => t.stop()) } catch {}
  s.stream = null
  s.videoTrack = null
  s.currentTier = 0
  for (const pc of s.pcs.values()) { try { pc.close() } catch {} }
  s.pcs.clear()
  try { s.ws?.close() } catch {}
  s.ws = null
}
