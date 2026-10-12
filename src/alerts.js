import { notifyTelegram } from './telegram.js';

// ============================================================================
//  Avisos de SALUD DEL SISTEMA (no de negocio) al dueño, por Telegram. Todo el
//  texto de cada aviso vive acá para tenerlo en un solo lugar. Reutiliza
//  notifyTelegram(), que ya es un no-op silencioso si faltan TELEGRAM_BOT_TOKEN
//  o TELEGRAM_CHAT_ID: una alerta rota nunca puede tirar abajo el bot.
//
//  Quién decide CUÁNDO disparar cada aviso (umbrales, dedup para no repetir)
//  vive en src/health.js. Acá solo se arma el texto y se manda.
// ============================================================================
async function send(text) {
  try {
    const ok = await notifyTelegram(text);
    if (!ok) console.log('🔕 Alerta no enviada (Telegram sin configurar o falló el envío):', text.split('\n')[0]);
  } catch (e) {
    console.error('alerts.send error:', e?.message || e);
  }
}

// --- Arranque: confirma que un despliegue salió bien -----------------------
export function alertArranque(detalle) {
  return send(`🟢 Setter bot arrancó y está escuchando mensajes.${detalle ? '\n' + detalle : ''}`);
}

// --- Caída: el proceso se muere (uncaughtException, o falló al iniciar) ----
export function alertCaida(err) {
  const msg = String(err?.stack || err?.message || err || 'motivo desconocido');
  return send(
    '🔴 El setter bot se cayó.\n' +
      `Motivo: ${msg.slice(0, 500)}\n` +
      'Railway lo reinicia solo (restart policy ON_FAILURE, hasta 10 intentos). ' +
      'Si vuelve a caer seguido, mirá los logs del servicio en Railway.'
  );
}

// --- Token de WhatsApp vencido o rechazado (401/403) ------------------------
export function alertTokenVencido(detalle) {
  return send(
    '🟠 El token de WhatsApp fue rechazado por Meta (401/403).\n' +
      `Detalle: ${String(detalle || '(sin detalle)').slice(0, 300)}\n` +
      'El bot sigue recibiendo mensajes pero NO puede contestar nada, y no se nota desde afuera. ' +
      'Renová el token en Meta (WhatsApp Manager > System Users > Generate new token) y actualizá ' +
      'WA_TOKEN en Railway.'
  );
}

// --- Nunca llegó ni un mensaje desde que arrancó (distinto del silencio: acá NO hay
// historial previo para saber si hay campañas corriendo, así que se avisa igual) ---
export function alertNuncaLlegoMensaje(horasHabiles, umbralHoras) {
  return send(
    `🟠 El bot está vivo hace ${horasHabiles.toFixed(1)}h hábiles y todavía no recibió ni un mensaje (umbral: ${umbralHoras}h).\n` +
      'Si las campañas están corriendo, revisá el webhook en el panel de Meta (WhatsApp > ' +
      'Configuration > Webhook) y que el número esté bien vinculado. Si todavía no prendiste nada, ' +
      'ignorá este aviso.'
  );
}

// --- Silencio raro: nadie escribe hace horas en horario hábil, con campañas activas ---
export function alertSilencio(horasHabiles, umbralHoras) {
  return send(
    `🟡 Pasaron ${horasHabiles.toFixed(1)}h hábiles sin que entre un solo mensaje nuevo (umbral: ${umbralHoras}h).\n` +
      'Hay leads recientes de anuncios, así que las campañas parecen activas: el bot puede estar vivo ' +
      'pero desconectado del anuncio. Revisá que el webhook siga suscripto en Meta (WhatsApp > ' +
      'Configuration > Webhook) y que las campañas sigan corriendo en el Ads Manager.'
  );
}

// --- Error al escribir leads.json (se están perdiendo leads en vivo) -------
export function alertEscrituraFallo(detalle) {
  return send(
    '🔴 Falló el guardado de leads.json — no se puede escribir en el disco.\n' +
      `Detalle: ${String(detalle || '(sin detalle)').slice(0, 300)}\n` +
      'Se están perdiendo leads en vivo. Revisá el volumen de Railway (se llenó el disco ? ' +
      'el volumen sigue montado en DATA_DIR ?).'
  );
}

// --- Lead sin primera respuesta (la métrica que la oferta compromete) -----
export function alertLeadSinResponder(lead, minutos) {
  const quien = lead?.name ? `${lead.name} (${lead.number || '?'})` : `el lead ${lead?.number || '(sin número)'}`;
  return send(
    `🟠 ${quien} entró hace más de ${minutos} minutos y todavía no tuvo primera respuesta.\n` +
      'Puede ser el delay normal del opener trabado, el proceso caído, o el token de WhatsApp vencido. ' +
      'Entrá al panel de conversaciones o mirá los logs del servicio en Railway.'
  );
}
