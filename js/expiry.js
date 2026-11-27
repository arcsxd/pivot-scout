// Validade dos pontos: 24 h a partir da chegada na nuvem.
import { POINT_TTL_MS } from './config.js';
import { t } from './i18n.js';

/** Momento (ms) em que o ponto expira. */
export function expiresAt(p) {
  const base = Date.parse(p.uploaded_at || p.synced_at || p.captured_at);
  return base + POINT_TTL_MS;
}

export const isExpired = (p, now = Date.now()) => now >= expiresAt(p);

/** Fração de vida restante (1 = acabou de chegar, 0 = expirou). */
export function lifeLeft(p, now = Date.now()) {
  return Math.max(0, Math.min(1, (expiresAt(p) - now) / POINT_TTL_MS));
}

/** "23 h", "45 min" ou "< 1 min". */
export function formatRemaining(p, now = Date.now()) {
  const ms = expiresAt(p) - now;
  if (ms <= 60000) return t('exp.lessMin');
  const min = Math.round(ms / 60000);
  if (min < 60) return t('exp.min', { n: min });
  return t('exp.hours', { n: Math.floor(min / 60) });
}
