// Envia para o GitHub os pontos que ainda estão só no celular.
import { blobToB64, utf8ToB64 } from './github.js';
import { getPoints, putPoint } from './store.js';

/** Converte o ponto local no registro salvo em points/<id>.json. */
export function toRecord(p) {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    accuracy_m: p.accuracy_m,
    altitude_m: p.altitude_m ?? null,
    captured_at: p.captured_at,
    team_id: p.team_id,
    team_label: p.team_label,
    operator: p.operator || '',
    photo: p.photoBlob ? `photos/${p.id}.jpg` : null,
    uploaded_at: p.uploaded_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

let running = false;

export async function syncPending(gh, onProgress) {
  if (running) return { skipped: true, sent: 0, failed: 0 };
  running = true;
  let sent = 0;
  let failed = 0;
  let lastError = null;
  try {
    const pending = (await getPoints())
      .filter((p) => !p.synced)
      .sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    for (const p of pending) {
      try {
        if (p.photoBlob && !p.photo_uploaded) {
          await gh.upsert(`photos/${p.id}.jpg`, await blobToB64(p.photoBlob), `Foto ${p.name}`);
          p.photo_uploaded = true;
          await putPoint(p);
        }
        p.uploaded_at ||= new Date().toISOString();
        const rec = toRecord(p);
        await gh.upsert(`points/${p.id}.json`, utf8ToB64(JSON.stringify(rec, null, 2) + '\n'), `Ponto ${p.name}`);
        p.synced = true;
        p.synced_at = new Date().toISOString();
        await putPoint(p);
        sent++;
        onProgress?.();
      } catch (e) {
        failed++;
        lastError = e;
        // Sem rede ou token inválido: não adianta tentar os próximos agora.
        if (!e.status || e.status === 401 || e.status === 403) break;
      }
    }
  } finally {
    running = false;
  }
  return { sent, failed, lastError };
}
