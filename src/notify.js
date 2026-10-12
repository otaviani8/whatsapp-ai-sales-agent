import { ENV } from './config.js';
import { resolveWaJid } from './util.js';

// Avisa al dueño (OWNER_NUMBER) por WhatsApp. No-op si no está configurado.
export async function notifyOwner(sock, text) {
  if (!ENV.OWNER_NUMBER) return;
  try {
    const jid = await resolveWaJid(sock, ENV.OWNER_NUMBER);
    if (!jid) {
      console.warn('notifyOwner: no resolví el JID del dueño');
      return;
    }
    await sock.sendMessage(jid, { text });
  } catch (e) {
    console.error('notifyOwner error:', e?.message || e);
  }
}
