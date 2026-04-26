import { send } from './bridge';

export const Tier = { IDLE: 0, T1: 1, T2: 2, T3: 3 };

let _tier = Tier.IDLE;
const _listeners = new Set();

export function getTier() {
  return _tier;
}

// Monotonic guard: only escalates, never downgrades.
// Returns true if the tier actually changed.
export function escalate(toTier, trigger = 'codeword') {
  if (toTier <= _tier) {
    console.log('[tier] rejected', { toTier, current: _tier, trigger });
    return false;
  }
  const fromTier = _tier;
  _tier = toTier;
  console.log('[tier] escalating', { fromTier, toTier, trigger });

  // Notify React subscribers BEFORE the side-effecting send(): if send()
  // throws synchronously (e.g. WS in a bad state, worklet RPC race), we still
  // want the UI to reflect the new tier and the next escalate() call not to
  // see a phantom-advanced _tier with no listeners ever told. The send() is
  // wrapped in try/catch for the same reason.
  _listeners.forEach(fn => {
    try { fn(_tier, fromTier, trigger); }
    catch (err) { console.warn('[tier] listener threw:', err?.message ?? err); }
  });

  try {
    send({
      event_type: fromTier === Tier.IDLE ? 'incident_opened' : 'tier_changed',
      fromTier,
      toTier,
      trigger,
    });
  } catch (err) {
    console.warn('[tier] send failed:', err?.message ?? err);
  }

  return true;
}

// Returns an unsubscribe function.
export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function resetMachine() {
  _tier = Tier.IDLE;
}
