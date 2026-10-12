// Utilidades puras (sin estado).

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// entero random entre min y max, ambos incluidos
export const randomIntInclusive = (min, max) => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
};

// quita acentos, pasa a minúsculas y recorta
export const normalize = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

// últimos 10 dígitos de cualquier teléfono sucio -> clave canónica del lead
export const last10 = (s) => {
  const digits = String(s ?? '').replace(/\D/g, '');
  return digits.slice(-10);
};

// primer nombre con la inicial en mayúscula
export const firstName = (full) => {
  const f = String(full ?? '').trim().split(/\s+/)[0] || '';
  if (!f) return '';
  return f.charAt(0).toUpperCase() + f.slice(1);
};

// Resuelve el JID real de WhatsApp de un número (AR puede venir sin código de
// país o sin el "9"). Verifica con onWhatsApp. Devuelve el JID o null.
export async function resolveWaJid(sock, rawNumber) {
  const digits = String(rawNumber ?? '').replace(/\D/g, '');
  if (!digits) return null;
  let nsn = digits;
  if (nsn.startsWith('54')) nsn = nsn.slice(2);
  if (nsn.startsWith('9')) nsn = nsn.slice(1);
  while (nsn.startsWith('0')) nsn = nsn.slice(1);
  const candidates = new Set();
  if (nsn.length >= 10) candidates.add('549' + nsn);
  candidates.add(digits);
  for (const c of candidates) {
    try {
      const res = await sock.onWhatsApp(c);
      if (res && res[0] && res[0].exists && res[0].jid) return res[0].jid;
    } catch {
      /* probar siguiente */
    }
  }
  return null;
}
