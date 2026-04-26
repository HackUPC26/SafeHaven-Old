// Tier 0 = inactive, 1 = audio+GPS, 2 = video, 3 = emergency

import { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView, Pressable, TextInput, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { connect, send } from './services/bridge';
import { loadSettings } from './services/settings';
import { startSoundClassification, startVideoAnnotation, stopSoundClassification, stopVideoAnnotation } from './services/ai';
import { startBroadcast, stopBroadcast, setBroadcastTier } from './services/broadcast';
import { getTier, escalate, subscribe, Tier } from './services/TierStateMachine';
import CodewordListener from './components/CodewordListener';
import SettingsScreen from './screens/SettingsScreen';

const DEFAULT_CODEWORDS = { TIER1: 'sunny', TIER2: 'cloudy', TIER3: 'stormy' };

const HOURS = [
  {t:'Now',i:'☀️',c:22},{t:'13h',i:'🌤',c:23},{t:'14h',i:'⛅',c:23},
  {t:'15h',i:'🌥',c:21},{t:'16h',i:'⛅',c:20},{t:'17h',i:'☀️',c:20},
  {t:'18h',i:'🌇',c:18},{t:'19h',i:'🌙',c:16},
];

const DAYS = [
  {d:'Today',i:'☀️',lo:15,hi:23},{d:'Wed',i:'🌤',lo:14,hi:22},
  {d:'Thu',i:'⛅',lo:13,hi:20},{d:'Fri',i:'🌧',lo:12,hi:17},
  {d:'Sat',i:'🌦',lo:14,hi:19},{d:'Sun',i:'☀️',lo:16,hi:24},
  {d:'Mon',i:'☀️',lo:17,hi:26},{d:'Tue',i:'🌤',lo:15,hi:24},
];

const ExpoBattery = requireOptionalNativeModule('ExpoBattery');
const BATTERY_STATE_UNPLUGGED = 1;
const BATTERY_STATE_CHARGING = 2;
const BATTERY_STATE_FULL = 3;

function batteryStateLabel(state) {
  if (state === BATTERY_STATE_CHARGING) return 'charging';
  if (state === BATTERY_STATE_FULL) return 'full';
  if (state === BATTERY_STATE_UNPLUGGED) return 'unplugged';
  return 'unknown';
}

function batteryHealthLabel(level, lowPowerMode) {
  if (lowPowerMode) return 'power-save';
  if (typeof level !== 'number') return 'unknown';
  if (level >= 0.8) return 'excellent';
  if (level >= 0.55) return 'good';
  if (level >= 0.3) return 'fair';
  return 'low';
}

async function getBatterySnapshot() {
  if (!ExpoBattery) {
    return {
      battery: null,
      battery_state: 'unavailable',
      battery_health: 'unavailable',
      low_power_mode: null,
    };
  }

  let level = null;
  let state = null;
  let lowPowerMode = null;

  try { level = await ExpoBattery.getBatteryLevelAsync?.(); } catch {}
  try { state = await ExpoBattery.getBatteryStateAsync?.(); } catch {}
  try { lowPowerMode = await ExpoBattery.isLowPowerModeEnabledAsync?.(); } catch {}

  return {
    battery: typeof level === 'number' ? level : null,
    battery_state: batteryStateLabel(state),
    battery_health: batteryHealthLabel(level, lowPowerMode),
    low_power_mode: typeof lowPowerMode === 'boolean' ? lowPowerMode : null,
  };
}

// hold-press hook — fires onFire after durationMs, shows progress 0→1
function useHold(onFire, durationMs = 3000) {
  const progress = useRef(new Animated.Value(0)).current;
  const timer = useRef(null);
  const anim = useRef(null);

  function begin() {
    anim.current = Animated.timing(progress, {
      toValue: 1, duration: durationMs, useNativeDriver: false,
    });
    anim.current.start();
    timer.current = setTimeout(() => {
      progress.setValue(0);
      onFire();
    }, durationMs);
  }

  function cancel() {
    clearTimeout(timer.current);
    if (anim.current) anim.current.stop();
    Animated.timing(progress, { toValue: 0, duration: 200, useNativeDriver: false }).start();
  }

  return { progress, begin, cancel };
}

export default function App() {
  const [tier, setTier] = useState(getTier());
  const [sent, setSent] = useState(false);
  const [settings, setSettings] = useState({ name: '', codewords: DEFAULT_CODEWORDS, pairingId: '' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codewordInput, setCodewordInput] = useState('');
  const locationRef = useRef(null);

  useEffect(() => {
    connect();
    loadSettings().then(s => setSettings(s));
    // Sound classification has to run from boot — its whole purpose is to
    // ESCALATE the tier on detected sounds (gunshot → T3, scream → T3, etc.
    // per LABEL_TIER in services/ai.js). Gating it on tier >= 1 made it
    // unreachable from idle: nothing could ever trigger the first escalation.
    startSoundClassification();
    const unsub = subscribe((newTier) => setTier(newTier));
    return () => {
      unsub();
      stopSoundClassification();
    };
  }, []);

  // SOS trigger — hold H/L row 3s
  const sos = useHold(() => {
    setSent(true);
    setTimeout(() => setSent(false), 1200);
    escalate(Tier.T1, 'manual');
  }, 3000);

  useEffect(() => {
    if (tier >= 1) startGPS();
    if (tier === 0) stopGPS();
  }, [tier]);

  // Silent broadcast: T1 streams audio only, T2+ adds video. The receiver
  // PWA decides what to render. No UI surface — disguise stays intact.
  // Token = pubkey portion of pairingId so the receiver page's existing
  // /#<token> flow works unchanged.
  useEffect(() => {
    if (!settings.pairingId) {
      if (tier >= 1) console.warn('[App] tier escalated but pairingId is empty — receiver will see nothing. Open settings (long-press Barcelona 2s) and pair.');
      return;
    }
    const token = settings.pairingId.split(':')[0];
    if (tier >= 1) {
      console.log('[App] starting broadcast for tier', tier, 'token=', token.slice(0, 8) + '…');
      startBroadcast(token);
    } else {
      stopBroadcast();
    }
  }, [tier >= 1, settings.pairingId]);

  // Push tier transitions into the broadcast service so it can lazily attach
  // the camera at T2 and renegotiate every active peer.
  useEffect(() => {
    if (tier >= 1) setBroadcastTier(tier);
  }, [tier]);

  useEffect(() => {
    if (tier >= 2) startVideoAnnotation();
    else stopVideoAnnotation();
  }, [tier >= 2]);

  function checkCodeword(text) {
    setCodewordInput(text);
    const word = text.toLowerCase().trim();
    if (!word) return;
    const cw = settings.codewords;
    const t1 = cw.TIER1?.toLowerCase();
    const t2 = cw.TIER2?.toLowerCase();
    const t3 = cw.TIER3?.toLowerCase();
    // Substring match (highest tier first) so the three-stage progression
    // works without manually clearing the field — typing "sunny" then
    // "cloudy" then "stormy" escalates T1→T2→T3 even though each new word
    // appends to the prior text. We clear the input after a match so the
    // next codeword starts fresh.
    let matched = null;
    if (t3 && word.includes(t3)) matched = Tier.T3;
    else if (t2 && word.includes(t2)) matched = Tier.T2;
    else if (t1 && word.includes(t1)) matched = Tier.T1;
    if (matched != null) {
      escalate(matched, 'codeword');
      setCodewordInput('');
    }
  }

  async function startGPS() {
    // Idempotent — a tier change from 1→2→3 must not stack watchers, since
    // the [tier] effect fires on every transition.
    if (locationRef.current) return;
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    if (locationRef.current) return; // re-check after the await
    locationRef.current = await Location.watchPositionAsync(
      { timeInterval: 3000, distanceInterval: 0 },
      async (loc) => {
        const battery = await getBatterySnapshot();
        send({
          event_type: 'gps_update',
          lat:      loc.coords.latitude,
          lng:      loc.coords.longitude,
          accuracy: loc.coords.accuracy,
          altitude: loc.coords.altitude,
          heading:  loc.coords.heading,
          speed:    loc.coords.speed,
          ...battery,
        });
      }
    );
  }

  function stopGPS() {
    if (locationRef.current) { locationRef.current.remove(); locationRef.current = null; }
  }

  function handleSettingsClose(opts) {
    setSettingsOpen(false);
    if (opts?.reset) {
      loadSettings().then(s => setSettings(s));
    }
  }

  const bgColor = sos.progress.interpolate({ inputRange: [0, 1], outputRange: ['transparent', 'rgba(255,255,255,0.15)'] });

  return (
    <>
      <LinearGradient colors={['#1a6da8','#3a9fd6','#6ac4ee','#a8dff5']} style={styles.flex}>
        <ScrollView style={styles.flex} showsVerticalScrollIndicator={false}>
          <View style={styles.topPad} />

          {/* City + temp — long-press 2s opens hidden settings */}
          <View style={styles.center}>
            <Pressable onLongPress={() => setSettingsOpen(true)} delayLongPress={2000}>
              <Text style={styles.city}>Barcelona</Text>
            </Pressable>
            <Text style={styles.temp}>22°</Text>
            <Text style={styles.desc}>Mostly Sunny</Text>

            {/* H/L row — SOS trigger (hold 3s) */}
            <Animated.View style={[styles.hlRow, { backgroundColor: bgColor }]}>
              <Pressable
                onPressIn={sos.begin}
                onPressOut={sos.cancel}
                style={styles.hlPressable}
              >
                <Text style={styles.hlText}>H:24°  L:15°</Text>
              </Pressable>
            </Animated.View>
          </View>

          {/* tiny status dot */}
          {tier > 0 && (
            <View style={[styles.dot, tier === 3 ? styles.dotRed : styles.dotOrange]} />
          )}

          {/* silent sent flash */}
          {sent && <View style={styles.sentFlash} />}


          {/* hourly strip */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>UV INDEX 6 · FEELS LIKE 24°</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {HOURS.map((h, i) => (
                <View key={i} style={styles.hourItem}>
                  <Text style={styles.hourTime}>{h.t}</Text>
                  <Text style={styles.hourIcon}>{h.i}</Text>
                  <Text style={styles.hourTemp}>{h.c}°</Text>
                </View>
              ))}
            </ScrollView>
          </View>

          {/* 10-day */}
          <View style={[styles.card, styles.mt12]}>
            <Text style={styles.cardLabel}>10-DAY FORECAST</Text>
            {DAYS.map((d, i) => (
              <View key={i} style={[styles.dayRow, i > 0 && styles.dayBorder]}>
                <Text style={styles.dayName}>{d.d}</Text>
                <Text style={styles.dayIcon}>{d.i}</Text>
                <Text style={styles.dayLo}>{d.lo}°</Text>
                <View style={styles.dayBar} />
                <Text style={styles.dayHi}>{d.hi}°</Text>
              </View>
            ))}
          </View>

          {/* extra cards grid */}
          <View style={styles.grid}>
            {[['HUMIDITY','62%','Dew point 14°'],['VISIBILITY','24 km','Perfectly clear'],
              ['WIND','14 km/h','NE — sea breeze'],['UV INDEX','6','High. Wear sunscreen']].map(([l,v,s],i)=>(
              <View key={i} style={styles.miniCard}>
                <Text style={styles.miniLabel}>{l}</Text>
                <Text style={styles.miniVal}>{v}</Text>
                <Text style={styles.miniSub}>{s}</Text>
              </View>
            ))}
          </View>

          <View style={styles.bottomPad} />
        </ScrollView>
      </LinearGradient>

      <CodewordListener codewords={settings.codewords} />

      {settingsOpen && (
        <SettingsScreen
          visible={settingsOpen}
          onClose={handleSettingsClose}
          settings={settings}
          onSettingsChange={updated => setSettings(prev => ({ ...prev, ...updated }))}
        />
      )}
    </>
  );
}

const glass = {
  backgroundColor: 'rgba(255,255,255,0.18)',
  borderRadius: 18,
  borderWidth: 0.5,
  borderColor: 'rgba(255,255,255,0.3)',
};

const styles = StyleSheet.create({
  flex:        { flex: 1 },
  topPad:      { height: 60 },
  bottomPad:   { height: 48 },
  center:      { alignItems: 'center' },
  city:        { fontSize: 34, fontWeight: '600', color: 'white' },
  temp:        { fontSize: 96, fontWeight: '200', color: 'white', lineHeight: 100 },
  desc:        { fontSize: 20, color: 'white', opacity: 0.9 },
  hlRow:       { borderRadius: 20, marginTop: 6 },
  hlPressable: { paddingHorizontal: 16, paddingVertical: 6 },
  hlText:      { fontSize: 18, color: 'white', opacity: 0.85 },
  dot:         { position: 'absolute', top: 60, right: 20, width: 8, height: 8, borderRadius: 4 },
  dotOrange:   { backgroundColor: 'orange' },
  dotRed:      { backgroundColor: 'red' },
  sentFlash:   { position: 'absolute', top: '45%', left: '47%', width: 10, height: 10, borderRadius: 5, backgroundColor: 'rgba(0,255,120,0.9)' },
  hiddenInput: { alignSelf: 'center', marginTop: 8, width: 160, textAlign: 'center', color: 'white', fontSize: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.3)' },
  card:        { ...glass, margin: 16, marginBottom: 0, padding: 14 },
  mt12:        { marginTop: 12 },
  cardLabel:   { fontSize: 13, color: 'rgba(255,255,255,0.8)', letterSpacing: 0.3, marginBottom: 10 },
  hourItem:    { width: 52, alignItems: 'center', gap: 6, paddingHorizontal: 2 },
  hourTime:    { color: 'white', fontSize: 15, opacity: 0.9 },
  hourIcon:    { fontSize: 22 },
  hourTemp:    { color: 'white', fontSize: 15 },
  dayRow:      { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  dayBorder:   { borderTopWidth: 0.5, borderTopColor: 'rgba(255,255,255,0.2)' },
  dayName:     { flex: 1, color: 'white', fontSize: 17, fontWeight: '500' },
  dayIcon:     { fontSize: 22, marginRight: 12 },
  dayLo:       { color: 'rgba(255,255,255,0.65)', fontSize: 17, marginRight: 10 },
  dayBar:      { width: 80, height: 5, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.6)', marginRight: 10 },
  dayHi:       { color: 'white', fontSize: 17 },
  grid:        { flexDirection: 'row', flexWrap: 'wrap', margin: 10, marginBottom: 0, gap: 10 },
  miniCard:    { ...glass, width: '47%', padding: 14 },
  miniLabel:   { fontSize: 12, color: 'white', opacity: 0.7, letterSpacing: 0.5 },
  miniVal:     { fontSize: 28, fontWeight: '500', color: 'white', marginTop: 4 },
  miniSub:     { fontSize: 13, color: 'white', opacity: 0.75, marginTop: 4 },
});
