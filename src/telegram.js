import https from 'node:https';
import { ENV } from './config.js';

// ============================================================================
//  Aviso interno por Telegram. Canal recomendado para notificarte a VOS (dueño)
//  cuando el bot agenda una call: NO depende de la ventana de 24h de WhatsApp ni
//  viola las reglas de Cloud API (mensajes iniciados por el negocio requieren
//  plantilla + opt-in; auto-notificarte por WhatsApp es abuso del canal aunque
//  sea tu propio número). Reutiliza el mismo bot que usa la Ficha de alta.
// ============================================================================
export function notifyTelegram(text) {
  return new Promise((resolve) => {
    if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) return resolve(false);
    const body = JSON.stringify({ chat_id: ENV.TELEGRAM_CHAT_ID, text });
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      }
    );
    req.on('error', (e) => {
      console.error('notifyTelegram error:', e?.message || e);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}
