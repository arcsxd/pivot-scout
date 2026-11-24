// Notificações do sistema e som para pontos novos no painel.
const NOTIFY_KEY = 'ps-notify';
const SOUND_KEY = 'ps-sound';

const get = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch { /* ok */ }
};

export const notifySupported = () => 'Notification' in window;
export const notifyPermission = () => (notifySupported() ? Notification.permission : 'unsupported');
export const notifyEnabled = () => get(NOTIFY_KEY) === '1' && notifyPermission() === 'granted';
export const soundEnabled = () => get(SOUND_KEY) !== '0';
export const setSound = (on) => set(SOUND_KEY, on ? '1' : '0');
export const disableNotify = () => set(NOTIFY_KEY, '0');

/** Pede permissão (se precisar) e liga. Retorna 'granted' | 'denied' | 'default' | 'unsupported'. */
export async function enableNotify() {
  if (!notifySupported()) return 'unsupported';
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p === 'granted') set(NOTIFY_KEY, '1');
  return p;
}

// ---------- Som (gerado na hora, sem arquivo) ----------
let ctx;
function audio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx ||= new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// O navegador só libera áudio depois de um clique na página.
document.addEventListener('pointerdown', () => audio(), { once: true });

export function chime() {
  try {
    const ac = audio();
    if (!ac) return;
    const now = ac.currentTime;
    for (const [freq, at] of [[880, 0], [1318.5, 0.16]]) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.3, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.55);
      osc.connect(gain).connect(ac.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.6);
    }
  } catch { /* sem som */ }
}

// ---------- Notificação ----------
export async function showNotification(title, body, { tag, onClick } = {}) {
  const icon = new URL('icons/icon-192.png', location.href).href;
  const opts = { body, icon, badge: icon, tag, renotify: true };
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
    return true;
  } catch {
    // Android/Chrome só permite notificação pelo service worker.
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (!reg) return false;
      await reg.showNotification(title, { ...opts, data: { url: location.href } });
      return true;
    } catch {
      return false;
    }
  }
}
