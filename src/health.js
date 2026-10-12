import { ENV } from './config.js';
import { allLeads, getSaveStatus, checkWritable } from './store.js';
import { wallToUtc, localParts } from './calendar.js';
import * as alerts from './alerts.js';

// ============================================================================
//  SALUD DEL SISTEMA: estado para el endpoint GET /salud + el chequeo
//  periódico que dispara los avisos de "silencio raro" y "lead sin responder".
//
//  El chequeo de token de WhatsApp y el de escritura a disco son event-driven
//  (cloud.js y store.js avisan acá cuando algo falla de verdad) más un
//  refresco perezoso cacheado, NO polling agresivo: así /salud es barato y no
//  le pega a la Graph API en cada chequeo del cron externo.
//
//  Nada de esto importa cloud.js (para evitar un import circular: cloud.js SÍ
//  importa health.js para avisar de un 401/403 real). El chequeo EN VIVO del
//  token se inyecta desde afuera con setTokenChecker() — lo hace whatsapp.js,
//  que ya tiene ambos módulos a mano.
// ============================================================================

const startedAt = Date.now();

// --- Token de WhatsApp -------------------------------------------------
const TOKEN_CACHE_MS = 10 * 60 * 1000; // 10 min: ver pregunta "chequeo cacheado" al dueño
const token = { ok: null, detail: '', at: 0, alerted: false };
let tokenChecker = null;

// La llama whatsapp.js una vez al arrancar, pasándole cloud.checkTokenLive.
export function setTokenChecker(fn) {
  tokenChecker = fn;
}

// La llama cloud.js apenas la Graph API devuelve 200 en cualquier request real.
export function markTokenOk() {
  token.ok = true;
  token.detail = '';
  token.at = Date.now();
  token.alerted = false; // si se vuelve a romper más adelante, puede re-alertar
}

// La llama cloud.js apenas la Graph API devuelve 401/403 en cualquier request real.
// Es la detección INSTANTÁNEA (no espera al cache de 10 min de /salud).
export function markTokenError(status, detail) {
  if (status !== 401 && status !== 403) return; // solo nos importa auth rota, no cualquier error
  const eraSano = token.ok !== false;
  token.ok = false;
  token.detail = String(detail || '').slice(0, 300);
  token.at = Date.now();
  if (eraSano && !token.alerted) {
    token.alerted = true;
    alerts.alertTokenVencido(token.detail);
  }
}

async function refreshTokenStatus() {
  if (!tokenChecker) return;
  try {
    const r = await tokenChecker();
    if (r?.ok === true) markTokenOk();
    else if (r?.ok === false) markTokenError(r.status, r.detail);
    else token.at = Date.now(); // resultado ambiguo (ej. sin red): no cambiamos el veredicto, pero
    // pateamos el reintento 10 min más para no hamacar la Graph API en un problema de red pasajero.
  } catch {
    token.at = Date.now();
  }
}

// Devuelve el estado del token, refrescando contra la Graph API si el cache
// venció. Si ya sabemos por un envío real que está roto, no esperamos el cache.
async function getTokenStatus() {
  if (token.ok === false) return { ok: false, detail: token.detail };
  if (Date.now() - token.at > TOKEN_CACHE_MS) await refreshTokenStatus();
  return { ok: token.ok, detail: token.detail };
}

// --- Disco / leads.json --------------------------------------------------
let writeAlerted = false;
function checkDisk() {
  const activo = checkWritable(); // prueba de escritura real, ahora mismo
  const pasivo = getSaveStatus(); // resultado del último guardado real de leads
  const ok = activo.ok && pasivo.ok;
  const detalle = !activo.ok ? activo.error : pasivo.error;
  if (!ok) {
    if (!writeAlerted) {
      writeAlerted = true;
      alerts.alertEscrituraFallo(detalle);
    }
  } else {
    writeAlerted = false;
  }
  return { ok, detalle };
}

// --- Silencio raro ---------------------------------------------------------
// Horas hábiles transcurridas entre dos instantes, contando SOLO los tramos
// que caen lunes a viernes entre SILENCE_START_HOUR y SILENCE_END_HOUR (hora
// de ENV.TIMEZONE). Así un fin de semana entero de silencio (normal, no entran
// leads) no dispara el aviso el lunes a la mañana por "horas de reloj" acumuladas.
function businessHoursElapsedMs(fromMs, toMs) {
  if (toMs <= fromMs) return 0;
  const days = [1, 2, 3, 4, 5]; // lunes a viernes (getUTCDay: 0=domingo)
  const startH = ENV.SILENCE_START_HOUR;
  const endH = ENV.SILENCE_END_HOUR;
  let total = 0;
  let cursor = fromMs;
  let guard = 0;
  while (cursor < toMs && guard < 60) {
    // tope de 60 días iterados, por las dudas — nunca debería hacer falta tanto
    guard++;
    const p = localParts(new Date(cursor), ENV.TIMEZONE);
    const dayStart = wallToUtc(p.y, p.mo, p.d, startH, 0, ENV.TIMEZONE).getTime();
    const dayEnd = wallToUtc(p.y, p.mo, p.d, endH, 0, ENV.TIMEZONE).getTime();
    const midnightNext = wallToUtc(p.y, p.mo, p.d, 0, 0, ENV.TIMEZONE).getTime() + 24 * 3600 * 1000;
    const segStart = Math.max(cursor, dayStart);
    const segEnd = Math.min(toMs, midnightNext, dayEnd);
    if (days.includes(p.weekday) && segEnd > segStart) total += segEnd - segStart;
    cursor = midnightNext;
  }
  return total;
}

// --- Nunca llegó ni un mensaje ----------------------------------------------
// Caso aparte del silencio de más abajo, y a propósito NO comparte su guard de
// "sin evidencia de campaña, me callo". Ahí el guard existe para no confundir
// una pausa deliberada con una falla — pero acá no hay NINGÚN lead, ni viejo ni
// nuevo: no hay ninguna pausa que confundir, solo dos escenarios posibles: o
// todavía no se prendió nada (el aviso se ignora, dice "ignorá este aviso"), o
// el webhook está mal configurado el día del lanzamiento con plata de pauta
// corriendo. El costo de un aviso de más un rato después de cada redeploy es
// un mensaje de Telegram; el costo de callarse acá es días de pauta pagada sin
// que llegue un lead y nadie se entera. Los dos errores NO pesan lo mismo, así
// que el criterio es asimétrico a propósito: NO "arreglar" este falso positivo.
let neverReceivedAlerted = false;
function checkNeverReceived() {
  const leads = allLeads();
  // Alguna vez entró un mensaje (incluso en un arranque anterior: leads.json
  // persiste). A partir de acá el caso lo cubre checkSilence(), no este aviso.
  const huboAlgunaVez = leads.some((l) => l.lastInboundAt || l.openedAt);
  if (huboAlgunaVez) {
    neverReceivedAlerted = false;
    return;
  }
  const habiles = businessHoursElapsedMs(startedAt, Date.now()) / 3600000;
  if (habiles >= ENV.NEVER_RECEIVED_HOURS && !neverReceivedAlerted) {
    neverReceivedAlerted = true; // una sola vez por arranque
    alerts.alertNuncaLlegoMensaje(habiles, ENV.NEVER_RECEIVED_HOURS);
  }
}

let silenceAlerted = false;
function checkSilence() {
  const now = Date.now();
  const leads = allLeads();
  if (!leads.length) return; // sin ningún lead todavía: lo cubre checkNeverReceived(), no acá

  const lastInbound = leads.reduce((m, l) => Math.max(m, l.lastInboundAt || 0), startedAt);

  // Evidencia de que hay campañas activas: algún lead vino de un anuncio en el
  // lookback. Sin esta señal, no sabemos si el silencio es un problema o
  // Martín pausó las campañas — preferimos callarnos antes que un falso positivo.
  const lookbackMs = ENV.CAMPAIGN_LOOKBACK_DAYS * 24 * 3600 * 1000;
  const hayCampanaActiva = leads.some((l) => l.ad && (l.openedAt || 0) > now - lookbackMs);
  if (!hayCampanaActiva) {
    silenceAlerted = false;
    return;
  }

  const habiles = businessHoursElapsedMs(lastInbound, now) / 3600000;
  if (habiles >= ENV.SILENCE_HOURS) {
    if (!silenceAlerted) {
      silenceAlerted = true;
      alerts.alertSilencio(habiles, ENV.SILENCE_HOURS);
    }
  } else {
    silenceAlerted = false;
  }
}

// --- Lead sin primera respuesta ---------------------------------------------
const unansweredAlerted = new Set();
function checkUnanswered() {
  const now = Date.now();
  const thresholdMs = ENV.UNANSWERED_MIN * 60 * 1000;
  const stillWaiting = new Set();
  for (const l of allLeads()) {
    // status === 'opening' = todavía no salió el opener (el PRIMER mensaje del bot).
    if (l.status !== 'opening' || l.optOut) continue;
    if (now - (l.openedAt || now) <= thresholdMs) continue;
    stillWaiting.add(l.key);
    if (!unansweredAlerted.has(l.key)) {
      unansweredAlerted.add(l.key);
      alerts.alertLeadSinResponder(l, ENV.UNANSWERED_MIN);
    }
  }
  for (const k of unansweredAlerted) if (!stillWaiting.has(k)) unansweredAlerted.delete(k);
}

// --- Monitor periódico: silencio + lead sin responder + disco --------------
// No chequea el token acá adentro: eso lo mantiene fresco cada vez que algo le
// pega a /salud (el latido externo que configura el dueño), así no sumamos
// llamadas propias a la Graph API además de las del cron.
export function startHealthMonitor() {
  const pollSeg = Number(process.env.HEALTH_POLL_SEG) || 300; // cada 5 min por default
  console.log(`🩺 Monitor de salud activado (revisa cada ${pollSeg}s: silencio, leads sin responder, disco).`);
  const tick = () => {
    try {
      checkDisk();
      checkNeverReceived();
      checkSilence();
      checkUnanswered();
    } catch (e) {
      console.error('health monitor tick error:', e?.message || e);
    }
  };
  setInterval(tick, pollSeg * 1000);
}

// --- Reporte para GET /salud -------------------------------------------
// Devuelve SIEMPRE el detalle completo (leads_activos, detalle del error, etc.):
// es whatsapp.js quien decide, según si vino la PANEL_KEY correcta, si le manda
// esto entero al que pidió /salud o solo el campo "ok" — el detalle es
// información del negocio (cuántos leads activos hay) y no debe quedar público.
export async function buildSaludReport() {
  const now = Date.now();
  const leads = allLeads();
  const activos = leads.filter((l) => l.status !== 'lost' && !l.optOut).length;
  const lastInbound = leads.reduce((m, l) => Math.max(m, l.lastInboundAt || 0), 0);

  const tokenStatus = await getTokenStatus();
  const disco = checkDisk();

  const whatsappTokenOk = tokenStatus.ok !== false; // null (desconocido) cuenta como "ok" (beneficio de la duda)
  const discoOk = disco.ok;
  const ok = whatsappTokenOk && discoOk;

  const report = {
    ok,
    arranco_hace_seg: Math.round((now - startedAt) / 1000),
    ultimo_mensaje_hace_seg: lastInbound ? Math.round((now - lastInbound) / 1000) : null,
    leads_activos: activos,
    whatsapp_token_ok: whatsappTokenOk,
    disco_escribible: discoOk,
  };
  if (!whatsappTokenOk) report.whatsapp_token_detalle = tokenStatus.detail || '(sin detalle)';
  if (!discoOk) report.disco_detalle = disco.detalle || '(sin detalle)';
  return report;
}
