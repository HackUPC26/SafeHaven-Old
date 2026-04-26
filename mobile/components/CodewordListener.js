import { useEffect, useRef, useCallback } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  AVAudioSessionCategory,
  AVAudioSessionCategoryOptions,
  AVAudioSessionMode,
} from 'expo-speech-recognition';
import { Tier, escalate } from '../services/TierStateMachine';
import { sendEvent } from '../services/broadcast';

// Natural-language distress phrases mapped to tier intent. Highest tier first
// so a T3 phrase always wins even when it contains a T1/T2 substring.
// Order within each list doesn't matter — we substring-match on lowercased,
// trimmed transcript text. These run AFTER the user-configured codewords
// fail to match (codewords are the deliberate, trained trigger; phrases are
// a fallback for organic distress language).
const TIER_INTENT_PHRASES = {
  [Tier.T3]: [
    'help me', 'help help', 'help help help', 'someone help', 'somebody help',
    'please help', 'call the police', 'call police', 'call 911',
    'call nine one one', 'dial 911', 'call an ambulance', 'call for help',
    'somebody call the police', 'get help', 'i need help now', 'emergency',
    "i'm being attacked", 'im being attacked', "they're attacking me",
    'theyre attacking me', "he's attacking me", 'hes attacking me',
    "she's attacking me", 'shes attacking me', "they're hurting me",
    'theyre hurting me', "he's hurting me", 'hes hurting me', 'rape',
  ],
  [Tier.T2]: [
    'stop', 'stop it', 'i said stop', 'leave me alone', 'get away from me',
    'get away', 'stay away', "don't come closer", 'dont come closer',
    "don't touch me", 'dont touch me', 'stop touching me', 'get off me',
    'take your hands off', 'let me go', 'let go of me', 'let go',
    'back off', 'i said no', 'what are you doing', "don't do that",
    'dont do that', "don't grab me", 'dont grab me', "you're hurting me",
    'youre hurting me', 'that hurts', "don't hurt me", 'dont hurt me',
    'why are you doing this',
  ],
  [Tier.T1]: [
    "i don't feel safe", 'i dont feel safe', 'i feel unsafe',
    'i feel uncomfortable', 'something feels off', "something's wrong",
    'somethings wrong', "this doesn't feel right", 'this doesnt feel right',
    "i'm worried", 'im worried', "i'm scared", 'im scared', "i'm not okay",
    'im not okay', 'i need to leave', 'i want to go home', 'take me home',
    'can you come get me', 'can someone come get me', 'pick me up',
    'this is weird', 'please leave me', "don't follow me", 'dont follow me',
    'who are you', 'why are you here', "i don't know you", 'dont know you',
    'please go away',
  ],
};

function matchUserCodeword(transcript, codewords) {
  // Highest tier first so a T3 codeword wins over any T1/T2 substring also
  // present in the same utterance. Empty/missing codewords are skipped.
  const t1 = codewords?.TIER1?.toLowerCase()?.trim();
  const t2 = codewords?.TIER2?.toLowerCase()?.trim();
  const t3 = codewords?.TIER3?.toLowerCase()?.trim();
  if (t3 && transcript.includes(t3)) return Tier.T3;
  if (t2 && transcript.includes(t2)) return Tier.T2;
  if (t1 && transcript.includes(t1)) return Tier.T1;
  return null;
}

function matchIntentPhrase(transcript) {
  for (const tier of [Tier.T3, Tier.T2, Tier.T1]) {
    for (const phrase of TIER_INTENT_PHRASES[tier]) {
      if (transcript.includes(phrase)) return tier;
    }
  }
  return null;
}

// Invisible component — always listening while foregrounded.
// Configured codewords from settings are the primary trigger; intent phrases
// from the TIER_INTENT_PHRASES map are a fallback.
export default function CodewordListener({ codewords }) {
  const runningRef = useRef(false);
  const mountedRef = useRef(false); // guards against restart after unmount
  const retryRef = useRef(null);
  const audioFailStreakRef = useRef(0);
  const lastLoggedRef = useRef('');

  const scheduleRetry = useCallback((delay) => {
    if (retryRef.current) clearTimeout(retryRef.current);
    retryRef.current = setTimeout(() => {
      retryRef.current = null;
      startListening();
    }, delay);
  }, []);

  const startListening = useCallback(async () => {
    if (!mountedRef.current || runningRef.current) return;
    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!granted) {
      console.warn('[CodewordListener] speech permission denied');
      return;
    }
    // mixWithOthers + voiceChat lets us coexist with react-native-webrtc's
    // AVAudioSession so the broadcast and the recognizer can share the mic.
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      requiresOnDeviceRecognition: true,
      continuous: true,
      interimResults: true,
      iosCategory: {
        category: AVAudioSessionCategory.playAndRecord,
        categoryOptions: [
          AVAudioSessionCategoryOptions.mixWithOthers,
          AVAudioSessionCategoryOptions.allowBluetooth,
          AVAudioSessionCategoryOptions.defaultToSpeaker,
        ],
        mode: AVAudioSessionMode.voiceChat,
      },
    });
    runningRef.current = true;
    console.log('[CodewordListener] listening');
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    startListening();
    return () => {
      mountedRef.current = false;
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
      }
      if (runningRef.current) {
        ExpoSpeechRecognitionModule.stop();
        runningRef.current = false;
      }
    };
  }, [startListening]);

  // iOS stops recognition after ~1 min of silence — restart automatically.
  // mountedRef guard prevents restart after the component has unmounted.
  useSpeechRecognitionEvent('end', () => {
    runningRef.current = false;
    if (!mountedRef.current) return;
    scheduleRetry(300);
  });

  useSpeechRecognitionEvent('result', (event) => {
    audioFailStreakRef.current = 0;
    const transcript = event.results?.[0]?.transcript?.toLowerCase().trim() ?? '';
    if (!transcript) return;

    // Interim results stream the same prefix repeatedly — only log when the
    // transcript actually grows so the console isn't spammed character-by-char.
    if (transcript !== lastLoggedRef.current && transcript.length > lastLoggedRef.current.length) {
      console.log('[CodewordListener] heard:', transcript);
      lastLoggedRef.current = transcript;
    }

    // Push finalized utterances to the receiver. We deliberately skip interim
    // results — they'd flood the WS and cause transcript flicker on the UI.
    // sendEvent is a no-op when no broadcast is active (tier 0), so this
    // safely does nothing pre-incident.
    if (event.isFinal) {
      sendEvent({ event_type: 'transcript', text: transcript, timestamp_iso: new Date().toISOString() });
      lastLoggedRef.current = '';
    }

    // User-configured codewords take priority — fall back to intent phrases
    // only when no codeword matches in the utterance.
    const detected = matchUserCodeword(transcript, codewords) ?? matchIntentPhrase(transcript);
    if (detected) escalate(detected, 'codeword');
  });

  // On recoverable errors, restart after a delay. audio-capture means another
  // session (typically WebRTC) owns the mic — back off exponentially so we
  // don't spam restart attempts during an active broadcast.
  useSpeechRecognitionEvent('error', (event) => {
    runningRef.current = false;
    if (!mountedRef.current) return;
    const retryable = ['no-speech', 'network', 'audio-capture', 'interrupted'];
    if (!retryable.includes(event.error)) {
      console.warn('[CodewordListener] error:', event.error, event.message);
      return;
    }
    if (event.error === 'audio-capture') {
      audioFailStreakRef.current = Math.min(audioFailStreakRef.current + 1, 6);
      const delay = Math.min(1000 * 2 ** (audioFailStreakRef.current - 1), 30000);
      if (audioFailStreakRef.current <= 2) {
        console.warn('[CodewordListener] audio-capture failed, retry in', delay, 'ms');
      }
      scheduleRetry(delay);
    } else {
      audioFailStreakRef.current = 0;
      scheduleRetry(1000);
    }
  });

  return null;
}
