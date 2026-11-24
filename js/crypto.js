// Criptografia dos tokens: PBKDF2-SHA256 -> AES-GCM 256 (WebCrypto).
// Funciona no navegador e no Node 19+.
const ITERATIONS = 300000;
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function deriveKey(pass, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, ITERATIONS);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { v: 1, iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

/** Retorna o objeto ou null se a senha estiver errada. */
export async function decryptJSON(blob, pass) {
  try {
    const key = await deriveKey(pass, fromB64(blob.salt), blob.iter || ITERATIONS);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

// Sem 0/O, 1/I/L para evitar confusão ao digitar.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomString(len) {
  const out = [];
  const max = 256 - (256 % ALPHABET.length);
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < max && out.length < len) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join('');
}

export function generateTeamId(existing = []) {
  let id;
  do id = randomString(3);
  while (existing.includes(id));
  return id;
}

/** Código de equipe: "ID-XXXXX-XXXXX". O ID é público, o resto é o segredo. */
export function formatCode(id, secret) {
  return `${id}-${secret.slice(0, 5)}-${secret.slice(5)}`;
}

export function parseCode(input) {
  const s = String(input || '').toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-Z0-9]+)-([A-Z0-9-]+)$/);
  if (!m) return null;
  const secret = m[2].replace(/-/g, '');
  return secret ? { id: m[1], secret } : null;
}
