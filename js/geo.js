import { ACC_GOOD, ACC_OK } from './config.js';

/** Acompanha a posição em alta precisão. Retorna função para parar. */
export function watchPosition(onPos, onErr) {
  if (!('geolocation' in navigator)) {
    onErr({ code: 0, message: 'Geolocation unavailable' });
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (p) =>
      onPos({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: p.coords.accuracy,
        altitude: p.coords.altitude,
        timestamp: p.timestamp || Date.now(),
      }),
    onErr,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

export function accuracyLevel(acc) {
  if (acc == null || Number.isNaN(acc)) return 'none';
  if (acc <= ACC_GOOD) return 'good';
  if (acc <= ACC_OK) return 'ok';
  return 'bad';
}

export function formatAccuracy(acc) {
  if (acc == null) return '—';
  return `±${acc < 10 ? acc.toFixed(1) : Math.round(acc)} m`;
}
