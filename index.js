import 'dotenv/config';
import { ENV } from './src/config.js';
import { prepareAuthDir } from './src/authseed.js';
import { hasCredentials } from './src/calendar.js';
import { startBot, beginShutdown } from './src/whatsapp.js';
import { startFollowups } from './src/followups.js';
import { flush } from './src/store.js';
import { alertArranque, alertCaida } from './src/alerts.js';

// Un rechazo de promesa sin handler NO debe tumbar el proceso.
process.on('unhandledRejection', (r) => {
  console.error('⚠️  unhandledRejection:', r?.stack || r?.message || r);
});

// Una excepción sin handler SÍ tumba el proceso (Node no puede seguir en un
// estado desconocido) — pero antes de morir, avisamos por Telegram. Le damos
// unos segundos al aviso para salir antes de cerrar, sin bloquear para siempre
// si Telegram no está configurado o la red está caída.
process.on('uncaughtException', async (err) => {
  console.error('💥 uncaughtException:', err?.stack || err?.message || err);
  try {
    await Promise.race([alertCaida(err), new Promise((r) => setTimeout(r, 4000))]);
  } catch {
    /* una alerta rota nunca puede tapar el motivo real de la caída */
  }
  process.exit(1);
});

console.log('🤖 WhatsApp AI Sales Agent (WhatsApp Cloud API)');
console.log(`   Modelo Claude: ${ENV.CLAUDE_MODEL}`);
console.log(`   Calendario:    ${ENV.CALENDAR_ID} (${ENV.TIMEZONE})`);
console.log(`   Phone Number:  ${ENV.WA_PHONE_NUMBER_ID || '(sin setear)'}`);
console.log(`   Solo anuncios: ${ENV.AD_ONLY ? 'sí (AD_ONLY=1)' : 'NO (AD_ONLY=0 — responde a cualquiera)'}`);
console.log(`   DATA_DIR:      ${ENV.DATA_DIR}`);
console.log(`   Estado:        ${ENV.BOT_PAUSED ? '⏸️ PAUSADO (BOT_PAUSED=1)' : 'activo'}`);

if (!ENV.ANTHROPIC_API_KEY) {
  console.log('⚠️  Falta ANTHROPIC_API_KEY — el bot conecta pero NO va a poder conversar.');
}
if (!hasCredentials()) {
  console.log('⚠️  Faltan credenciales de Google — el bot conversa pero NO va a poder ver/crear horarios.');
}

prepareAuthDir();

// Página web de vinculación por QR (solo si QR_WEB=1). Sirve el QR en $PORT.
if (process.env.QR_WEB === '1') startQrWeb();

startBot()
  .then(() => {
    startFollowups();
    alertArranque();
  })
  .catch(async (e) => {
    console.error('💥 Fallo al iniciar el bot:', e?.message || e);
    try {
      await Promise.race([alertCaida(e), new Promise((r) => setTimeout(r, 4000))]);
    } catch {
      /* ignore */
    }
    process.exit(1);
  });

// Apagado prolijo: persistimos el estado y salimos limpio (exit 0) para que
// Railway no mande "Deploy Crashed".
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log(`\n👋 Recibí ${sig}: persisto estado y cierro prolijo...`);
    beginShutdown();
    try {
      flush();
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 500);
  });
}
