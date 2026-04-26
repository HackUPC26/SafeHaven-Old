import SafeHavenAI from '../modules/safe-haven-ai';
import { send } from './bridge';
import { Tier, escalate } from './TierStateMachine';

const VALID_LABELS = new Set([
  'SHOUTING',
  'SCREAMING',
  'CRYING',
  'IMPACT',
  'GUNSHOT',
  'SLAP',
  'DOOR_SLAM',
  'GLASS_BREAKING',
  'EXTENDED_SILENCE',
]);

// Sound-event → tier mapping. The state machine is monotonic (escalate-only),
// so a quiet T1 sound after a T3 gunshot won't downgrade. GUNSHOT is the
// only label that's allowed to fire below the standard confidence floor —
// false positives there are far less costly than missing a real shot.
const LABEL_TIER = {
  GUNSHOT:        Tier.T3,
  SCREAMING:      Tier.T3,
  GLASS_BREAKING: Tier.T2,
  IMPACT:         Tier.T2,
  SLAP:           Tier.T2,
  SHOUTING:       Tier.T1,
  CRYING:         Tier.T1,
  DOOR_SLAM:      Tier.T1,
  // EXTENDED_SILENCE intentionally absent — too ambiguous to escalate on.
};
const GUNSHOT_CONFIDENCE_FLOOR = 0.4;
const DEFAULT_CONFIDENCE_FLOOR = 0.4;

let labelSubscription = null;
let debugSubscription = null;
let videoAnnotationSubscription = null;
let classifierStarted = false;
let videoAnnotationStarted = false;

function normalizeConfidence(confidence) {
  const value = Number(confidence);
  if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  return 0;
}

function forwardAudioLabel(payload) {
  if (!payload || !VALID_LABELS.has(payload.label)) return false;

  const confidence = normalizeConfidence(payload.confidence);
  const source = payload.source || 'SoundAnalysis';
  const rawIdentifier = payload.rawIdentifier || payload.raw_identifier || payload.label;

  console.log('[ai] audio label:', payload.label, confidence.toFixed(2), rawIdentifier);

  send({
    event_type: 'ai_label',
    label: payload.label,
    confidence,
    source,
    raw_identifier: rawIdentifier,
  });

  // Auto-escalate based on the detected sound. Per-label confidence floor:
  // gunshots get a much lower threshold (a missed shot is worse than a false
  // alarm); other labels need solid confidence to avoid noise-driven jitter.
  const targetTier = LABEL_TIER[payload.label];
  if (targetTier) {
    const floor = payload.label === 'GUNSHOT'
      ? GUNSHOT_CONFIDENCE_FLOOR
      : DEFAULT_CONFIDENCE_FLOOR;
    if (confidence >= floor) {
      escalate(targetTier, `ai:${payload.label.toLowerCase()}`);
    }
  }

  return true;
}

function ensureLabelSubscription() {
  if (labelSubscription) return;

  labelSubscription = SafeHavenAI.addAudioLabelListener((payload) => {
    // Log every label that crosses the native confidence threshold, even ones
    // that don't pass VALID_LABELS — this surfaces "the mic IS hearing things,
    // they're just not in our mapped set" which previously looked like silence.
    console.log('[ai] native ->', payload?.label, payload?.confidence?.toFixed?.(2) ?? payload?.confidence, payload?.rawIdentifier ?? payload?.raw_identifier);
    forwardAudioLabel(payload);
  });
}

function ensureDebugSubscription() {
  // Always subscribe (was previously gated on __DEV__). The native side wraps
  // emission in `#if DEBUG`, so this is still a no-op in Release builds — but
  // when the build IS Debug we now actually see what the classifier hears.
  if (debugSubscription) return;

  debugSubscription = SafeHavenAI.addClassificationDebugListener((payload) => {
    const classifications = Array.isArray(payload?.classifications)
      ? payload.classifications
      : [];
    const summary = classifications
      .map((item) => {
        const confidence = normalizeConfidence(item?.confidence).toFixed(2);
        const mappedLabel = item?.mappedLabel ? ` -> ${item.mappedLabel}` : '';
        return `${item?.identifier ?? 'unknown'} ${confidence}${mappedLabel}`;
      })
      .join(', ');

    if (summary) {
      console.log('[ai:debug] raw classifications:', summary);
    }
  });
}

function normalizeVideoAnnotation(payload) {
  if (!payload) return null;

  const confidence = normalizeConfidence(payload.confidence);
  const poseFlags = Array.isArray(payload.poseFlags) ? payload.poseFlags : [];

  return {
    rapidMotion: !!payload.rapidMotion,
    sceneContext: payload.sceneContext || 'camera',
    poseFlags,
    confidence,
    source: payload.source || 'Vision',
  };
}

function forwardVideoAnnotation(payload) {
  const annotation = normalizeVideoAnnotation(payload);
  if (!annotation) return false;

  console.log(
    '[ai] video annotation:',
    annotation.rapidMotion ? 'rapid motion' : 'calm',
    annotation.confidence.toFixed(2)
  );

  send({
    event_type: 'ai_video_annotation',
    annotation,
  });

  return true;
}

function sendVideoAnnotationStatus(status, reason) {
  send({
    event_type: 'ai_video_status',
    status,
    reason: reason || null,
    source: 'Vision',
  });
}

function ensureVideoAnnotationSubscription() {
  if (videoAnnotationSubscription) return;

  videoAnnotationSubscription = SafeHavenAI.addVideoAnnotationListener((payload) => {
    forwardVideoAnnotation(payload);
  });
}

export async function startSoundClassification() {
  if (classifierStarted) return true;

  // The native module is autolinked from mobile/modules/safe-haven-ai. If
  // SafeHavenAI.isAvailable is false, the build was made before the module
  // was added to package.json — `npm install && pod install && rebuild`
  // is required, hot reload alone won't pick up a new native dep.
  if (!SafeHavenAI.isAvailable) {
    console.error('[ai] SafeHavenAI native module NOT in build — noise recognition disabled. Run npm i + pod install + full rebuild.');
    return false;
  }

  ensureLabelSubscription();
  ensureDebugSubscription();

  try {
    const available = await SafeHavenAI.isSoundClassificationAvailable();
    if (!available) {
      console.warn('[ai] SoundAnalysis unavailable on this device (simulator? iOS<15?)');
      return false;
    }

    classifierStarted = await SafeHavenAI.startSoundClassification();
    console.log('[ai] sound classification started:', classifierStarted);
    if (!classifierStarted) {
      console.warn('[ai] native sound classification did not start (mic permission?)');
    }
    return classifierStarted;
  } catch (err) {
    classifierStarted = false;
    console.warn('[ai] failed to start sound classification:', err?.message ?? err);
    return false;
  }
}

export async function stopSoundClassification() {
  if (!classifierStarted && !labelSubscription) return true;

  try {
    await SafeHavenAI.stopSoundClassification();
  } catch (err) {
    console.warn('[ai] failed to stop sound classification:', err?.message ?? err);
  } finally {
    classifierStarted = false;
    labelSubscription?.remove?.();
    labelSubscription = null;
    debugSubscription?.remove?.();
    debugSubscription = null;
  }

  return true;
}

export async function startVideoAnnotation() {
  if (videoAnnotationStarted) return true;

  ensureVideoAnnotationSubscription();
  sendVideoAnnotationStatus('starting');

  try {
    const available = await SafeHavenAI.isVideoAnnotationAvailable();
    if (!available) {
      console.warn('[ai] native video annotation unavailable');
      sendVideoAnnotationStatus('unavailable', 'Native Vision video annotation is unavailable on this device/build');
      return false;
    }

    videoAnnotationStarted = await SafeHavenAI.startVideoAnnotation();
    if (!videoAnnotationStarted) {
      console.warn('[ai] native video annotation did not start');
      sendVideoAnnotationStatus('failed', 'Native Vision capture did not start. WebRTC may already own the camera.');
    } else {
      sendVideoAnnotationStatus('running');
    }
    return videoAnnotationStarted;
  } catch (err) {
    videoAnnotationStarted = false;
    console.warn('[ai] failed to start video annotation:', err?.message ?? err);
    sendVideoAnnotationStatus('failed', err?.message ?? String(err));
    return false;
  }
}

export async function stopVideoAnnotation() {
  if (!videoAnnotationStarted && !videoAnnotationSubscription) return true;

  try {
    await SafeHavenAI.stopVideoAnnotation();
  } catch (err) {
    console.warn('[ai] failed to stop video annotation:', err?.message ?? err);
  } finally {
    videoAnnotationStarted = false;
    videoAnnotationSubscription?.remove?.();
    videoAnnotationSubscription = null;
    sendVideoAnnotationStatus('stopped');
  }

  return true;
}

export function emitDemoLabel(label, confidence = 0.9) {
  return forwardAudioLabel({
    label,
    confidence,
    source: 'SoundAnalysis',
    rawIdentifier: `demo:${label}`,
  });
}

if (typeof __DEV__ !== 'undefined' && __DEV__) {
  global.__safehavenEmitAiLabel = emitDemoLabel;
  global.__safehavenEmitVideoAnnotation = forwardVideoAnnotation;
}
