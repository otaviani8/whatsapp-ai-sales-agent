// ============================================================================
//  Capa de WhatsApp — Cloud API de Meta (oficial). Antes era Baileys; ahora los
//  mensajes ENTRAN por un webhook HTTP y SALEN por la Graph API (src/cloud.js).
//  TODA la lógica de negocio (leads, AD_ONLY, modo booked, follow-ups, opener con
//  delay, recordatorios, insights, bandit, CRM) se mantiene igual.
// ============================================================================
import http from 'node:http';
import { ENV } from './config.js';
import { notifyTelegram } from './telegram.js';
import { SETTINGS, OPENER_VARIANTS, FOLLOWUP_ANGLES, AUDIOS, TEMPLATES, PANEL_TEMPLATES, PANEL_TEMPLATE_PARAM } from './persona.js';
import { hasAudio, sendFixedAudio } from './audios.js';
import { resumenTexto, embudoHTML } from './resumen.js';
import { getLead, createLead, updateLead, allLeads, deleteLead } from './store.js';
import { converse, generateOpener } from './brain.js';
import { analyze } from './insights.js';
import * as bandit from './bandit.js';
import { wallToUtc, localParts } from './calendar.js';
import * as crm from './crm.js';
import { last10, firstName, sleep, randomIntInclusive } from './util.js';
import { transcribe } from './transcribe.js';
import { transcodeToOggOpus } from './audio.js';
import * as cloud from './cloud.js';
import * as health from './health.js';

let server = null;
let shuttingDown = false;

export function beginShutdown() {
  shuttingDown = true;
}

// --- Serialización por lead: dos mensajes seguidos no se pisan -------------
const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

// --- Dedup de webhooks: Meta puede reenviar el mismo mensaje ----------------
const processedIds = new Set();
function alreadySeen(id) {
  if (!id) return false;
  if (processedIds.has(id)) return true;
  processedIds.add(id);
  if (processedIds.size > 5000) {
    const it = processedIds.values();
    for (let n = 0; n < 2500; n++) processedIds.delete(it.next().value);
  }
  return false;
}

// Aviso al dueño de una call agendada. Preferimos Telegram (canal interno que NO
// depende de la ventana de 24h de WhatsApp ni viola las reglas de Cloud API de
// mensajes iniciados por el negocio). WhatsApp queda solo como fallback.
async function notifyOwner(text) {
  if (ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID) {
    await notifyTelegram(text);
    return;
  }
  if (!ENV.OWNER_NUMBER) return;
  try {
    await cloud.sendText(ENV.OWNER_NUMBER, text);
  } catch (e) {
    console.error('notifyOwner (probablemente fuera de la ventana de 24h):', e?.message || e);
  }
}

// Señales de "ahora no / después / estoy ocupado": si el lead las manda, NO lo
// apuramos con un follow-up inmediato; le damos aire (>=24h) para no encimarlo.
const LATER_RE = /\b(ahora no|despu[eé]s|m[aá]s tarde|luego|otro d[ií]a|otro momento|estoy ocupad|toy ocupad|manejando|trabajando|en una reuni[oó]n|reuni[oó]n|ocupad[oa]|no puedo (ahora|hablar)|te (escribo|aviso) (yo|luego|despu[eé]s)|hablamos (luego|despu[eé]s|m[aá]s tarde)|cuando pueda|m[aá]s rato)\b/i;
function wantsLater(text) {
  return LATER_RE.test(String(text || ''));
}

// Segundos de pausa según el rango; 0 si INSTANT (modo testing rápido).
function dly(range) {
  return ENV.INSTANT ? 0 : randomIntInclusive(range.minSeg, range.maxSeg);
}

// --- Timing del lead: hora local en que suele estar activo -----------------
function localHour(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: ENV.TIMEZONE, hour: '2-digit', hourCycle: 'h23' });
  return Number(f.format(new Date(ms)));
}
export function bumpHours(map, hour) {
  const m = { ...(map || {}) };
  m[hour] = (m[hour] || 0) + 1;
  return m;
}
export function preferredHour(lead) {
  const h = lead.inboundHours || {};
  let best = null, bestC = -1;
  for (const k of Object.keys(h)) {
    if (h[k] > bestC) { bestC = h[k]; best = +k; }
  }
  return best == null ? SETTINGS.followupFallbackHour : best;
}
// Mueve un instante a la hora preferida del lead (dentro de una ventana sana).
export function shiftToHour(ms, hour) {
  const h = Math.max(SETTINGS.followupEarliestHour, Math.min(SETTINGS.followupLatestHour, hour));
  const p = localParts(new Date(ms), ENV.TIMEZONE);
  let target = wallToUtc(p.y, p.mo, p.d, h, 0, ENV.TIMEZONE).getTime();
  if (target < ms) {
    const p2 = localParts(new Date(ms + 24 * 3600 * 1000), ENV.TIMEZONE);
    target = wallToUtc(p2.y, p2.mo, p2.d, h, 0, ENV.TIMEZONE).getTime();
  }
  return target;
}

// Si un instante cae FUERA de la franja activa (9-21h) lo empuja al próximo 9am;
// si ya está en franja, lo deja igual. Así los follow-ups respetan los gaps cortos
// del día (3h, 6h, 10h) y solo se corren para no caer de madrugada.
export function clampToActiveHours(ms) {
  const lo = SETTINGS.followupEarliestHour;
  const hi = SETTINGS.followupLatestHour;
  const h = localHour(ms);
  if (h >= lo && h < hi) return ms; // ya está en horario sano, no lo toco
  const p = localParts(new Date(ms), ENV.TIMEZONE);
  if (h < lo) return wallToUtc(p.y, p.mo, p.d, lo, 0, ENV.TIMEZONE).getTime();
  const p2 = localParts(new Date(ms + 24 * 3600 * 1000), ENV.TIMEZONE);
  return wallToUtc(p2.y, p2.mo, p2.d, lo, 0, ENV.TIMEZONE).getTime();
}

// --- Próximo follow-up: cadencia incremental × multiplicador por temperatura,
//     DENTRO de la ventana de 24h, solo evitando la madrugada. ----------------
//     Fase 1: toques de texto libre DENTRO de las 24 h (followupCadenceHours).
//     Fase 2: plantillas de Meta a los días de templateFollowups, contados desde el último mensaje
//     del lead (tplCount lleva cuántas salieron). null = se agotó todo.
export function nextFollowupAt(lead) {
  const c = SETTINGS.followupCadenceHours;
  const i = lead.followupCount || 0;
  const anchor = lead.lastInboundAt || lead.openedAt || Date.now();
  if (i < c.length) {
    const temp = lead.profile?.temperature ?? 50;
    const mult =
      temp >= SETTINGS.hotThreshold ? SETTINGS.tempMult.hot
      : temp < SETTINGS.coldThreshold ? SETTINGS.tempMult.cold
      : SETTINGS.tempMult.warm;
    const base = Date.now() + c[i] * 3600 * 1000 * mult;
    const h = localHour(base);
    let at = base;
    // si caería de madrugada/noche, lo pasamos a una hora de la mañana ELEGIDA POR A/B (9-13)
    if (!(h >= SETTINGS.followupEarliestHour && h < SETTINGS.followupLatestHour)) at = shiftToHour(base, bandit.pickFollowupHour());
    if (at - anchor < WINDOW_MS) return at;
    // no entra en la ventana: se pasa a la fase de plantillas
  }
  const tf = SETTINGS.templateFollowups || [];
  const k = lead.tplCount || 0;
  if (k >= tf.length) return null;
  // misma hora del día en que escribió por última vez (suele estar activo), corrida si cae de noche
  const at = clampToActiveHours(anchor + tf[k].day * 24 * 3600 * 1000);
  return Math.max(at, Date.now() + 60 * 1000);
}

// --- Recordatorios anti no-show -------------------------------------------
function bookedStartMs(lead) {
  if (!lead?.bookedStartIso) return null;
  const t = Date.parse(lead.bookedStartIso);
  return Number.isFinite(t) ? t : null;
}
// Señales FUERTES de cancelación/baja (no de reprogramación): si el último mensaje del lead las
// trae, frenamos los recordatorios aunque el status siga en 'booked'. Es la red de seguridad por
// si el cerebro no llegó a usar cancel_booking.
const CANCEL_RE = /\bno,?\s*gracias\b|\bcancel(a|o|ar|en|emos|é|ada|ado)\b|\bno me interesa\b|\bya no (quiero|me interesa|va|voy)\b|\b(la )?doy de baja\b|\bdar de baja\b|\bno cuenten conmigo\b|\bdej[eé]moslo\b|\blo dejo\b|\bmejor lo dejamos\b|\bno voy a poder ir\b/i;
function lastLeadText(lead) {
  const hist = lead?.history || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    if (m.content.startsWith('[nota interna')) continue;
    return m.content;
  }
  return '';
}
function leadRecentlyDeclined(lead) {
  return CANCEL_RE.test(lastLeadText(lead));
}
export function dueReminder(lead, now = Date.now()) {
  if (!ENV.REMINDERS || lead?.status !== 'booked') return null;
  if (lead.cancelled) return null;             // el lead ya canceló: nunca más un recordatorio
  if (lead.replyDueAt) return null;            // hay una respuesta en curso: no le pisamos la charla con un canned
  if (leadRecentlyDeclined(lead)) return null; // su último mensaje fue una cancelación/baja
  const startMs = bookedStartMs(lead);
  if (!startMs) return null;
  const sent = lead.remindersSent || [];
  const bookedAt = lead.bookedAt || 0;
  for (const r of SETTINGS.reminders || []) {
    if (sent.includes(r.id)) continue;
    const trigger = startMs - r.beforeMin * 60000; // beforeMin negativo = DESPUÉS de la call
    if (r.postCall) {
      // recuperación de ausente: dispara después de la call (hasta 3h), PERO solo si el lead no
      // escribió durante/después de la call (proxy de que no apareció; el bot no ve la asistencia).
      if (now >= trigger && now < startMs + 3 * 3600 * 1000 && (lead.lastInboundAt || 0) < startMs) return r;
    } else {
      // recordatorio: SOLO antes de la call
      if (now < startMs && now >= trigger && trigger > bookedAt) return r;
    }
  }
  return null;
}

// --- Análisis IA por lead: corre después de responder, no bloquea ----------
async function runInsights(key) {
  if (!ENV.INSIGHTS || !ENV.ANTHROPIC_API_KEY) return;
  const lead = getLead(key);
  if (!lead || lead.status === 'booked' || lead.status === 'lost') return;
  const profile = await analyze(lead);
  if (!profile) return;
  const fresh = getLead(key);
  if (!fresh) return;
  const patch = { profile };
  if (fresh.nextFollowupAt && fresh.status !== 'booked') {
    patch.nextFollowupAt = nextFollowupAt({ ...fresh, profile });
  }
  updateLead(key, patch);
  crmSync(key);
}

// --- Envío en "globos" ------------------------------------------------------
//  IMPORTANTE (17/08/2026): esta capa YA NO toca la voz.
//  Antes hacía "imperfección humana" de la época del ICP anterior: borraba los
//  acentos el 40% de las veces (por eso salía "anos" en vez de "años"), cambiaba
//  "que" por "q", forzaba a minúscula la primera letra de cada globo y separaba
//  el "?" solo el 35% de las veces. Todo eso deshacía el registro que escribe el
//  prompt. La voz la define persona.js y NADA MÁS. Acá solo queda lo mecánico y
//  determinista: sacar los signos de apertura y garantizar la separación final.

// Deja el texto tal cual lo escribió el modelo, con dos garantías duras:
// sin signos de apertura, y con "?" / "!" siempre separados de la última palabra.
// 07/10/2026 (decisión de producto después de probarlo): que se lea como una persona en WhatsApp.
// Minúscula al arrancar el globo, sin punto final, y el "?" a veces pegado y a veces separado.
const NOMBRES_PROPIOS = /^(Mart[ií]n|Acosta|Acme|Meta|Google|Facebook|Instagram|WhatsApp|Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes)\b/;
function normalizarSignos(s) {
  let t = String(s)
    .replace(/[¿¡]/g, '')              // los signos de apertura no se usan nunca
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!t) return t;
  // "?" y "!": pegados casi siempre, separados una de cada tres veces (como tipea una persona)
  const separar = Math.random() < 0.33;
  t = t.replace(/\s*([?!])/g, separar ? ' $1' : '$1');
  // sin punto final (los "..." quedan)
  if (/[^.]\.$/.test(t)) t = t.slice(0, -1);
  // minúscula al arrancar, salvo nombres propios, siglas o un número
  // (un nombre al principio seguido de coma, "Martín, contame", también queda en mayúscula)
  if (!NOMBRES_PROPIOS.test(t) && !/^[A-ZÁÉÍÓÚÑ]{2,}\b/.test(t) && !/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+,/.test(t)) t = t.charAt(0).toLowerCase() + t.slice(1);
  return t;
}

// Manda la respuesta en máx 3 globos, con una pausa natural entre cada uno.
// Botones: un renglón "[[Opción 1|Opción 2|Opción 3]]" se pega al globo anterior y sale como
// mensaje con botones de respuesta rápida (máx 3, de hasta 20 caracteres).
const BUTTONS_RE = /^\[\[(.+)\]\]$/;
// Red de seguridad para dos vicios del modelo que el prompt no termina de sacar (07/10/2026):
// comentar el presupuesto del lead ("con eso se puede armar algo serio") y corregirse adentro del
// mensaje ("entendido no, perdón, quise decir: ..."). Se borra solo esa oración.
const COMENTA_PAUTA_RE = /[^.?!]*\b(algo serio|con (ese|eso|este|un) (rango|presupuesto|monto|n[uú]mero|mill[oó]n)|ya ten[eé]s margen|(entra|est[aá]s|est[aá]) en el rango|as[ií] que seguimos)[^.?!]*[.?!]?\s*/gi;
export function limpiarGlobo(line) {
  let t = String(line)
    .replace(/^(entendido|ok)\s*,?\s*(no\b[^:]{0,40}:|no,?\s*(perd[oó]n|nada de eso)[^:]{0,30}:?)\s*/i, '')
    .replace(/^[^:]{0,40}\bquise decir:\s*/i, '')
    .replace(COMENTA_PAUTA_RE, '')
    .replace(/^(entendido|perfecto)[,.]\s*/i, '')
    .trim();
  return t;
}
// Globos que son razonamiento o instrucciones filtradas del modelo: nunca le llegan al lead.
export const META_RE = /\brespuesta:|sin emojis|^nota:|\bel lead\b|\bhuecos?\b|^ofrec[ée][ \s:,]|^ofrezco\b|\btoca (coordinar|ofrecer)\b|nota interna|get_available_slots|book_call|cancel_booking/i;
function parseBubbles(text, nombre = '') {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || /^\[fin\]$/i.test(line)) continue; // [fin]: la charla terminó, no se manda nada
    const m = line.match(BUTTONS_RE);
    if (m) {
      const titles = m[1].split('|').map((t) => t.trim()).filter(Boolean);
      if (out.length) out[out.length - 1].buttons = titles;
      continue;
    }
    if (/^\[audio enviado/i.test(line)) continue; // marca interna: nunca se manda como texto
    const limpio = limpiarGlobo(line);
    if (!limpio) continue;
    if (META_RE.test(limpio)) { console.warn(`🚫 globo filtrado (razonamiento o instrucción): "${limpio.slice(0, 80)}"`); continue; }
    let t = normalizarSignos(limpio);
    // Nombres propios siempre con mayúscula (el modelo a veces los baja con la regla de la minúscula)
    t = t.replace(/\bmart[ií]n acosta\b/gi, 'Martín Acosta');
    if (nombre && nombre.length > 2) t = t.replace(new RegExp(`(^|[^\\p{L}])(${nombre})(?![\\p{L}])`, 'giu'), (m, a) => a + nombre);
    if (t) out.push({ text: t, buttons: null });
  }
  return out.slice(0, 3); // máx 3 globos por turno (decisión de producto)
}
// `afterFirst`: función async que corre después del primer globo (ej. el audio de confirmación).
async function sendBubbles(to, text, { afterFirst = null, allowButtons = false } = {}) {
  const leadDe = getLead(last10(String(to).replace(/\D/g, '')));
  const nombre = leadDe?.name ? firstName(leadDe.name) : '';
  const bubbles = parseBubbles(text, nombre);
  if (!allowButtons) bubbles.forEach((b) => { b.buttons = null; }); // botones solo en el A/B de horarios
  let i = 0;
  for (const b of bubbles) {
    await sleep(dly(SETTINGS.typing) * 1000);
    try {
      const r = b.buttons && b.buttons.length
        ? await cloud.sendButtons(to, b.text, b.buttons)
        : await cloud.sendText(to, b.text);
      const mid = r?.messages?.[0]?.id || '(sin id)';
      console.log(`   ➡️  enviado a ${to} [${mid}]: "${b.text.slice(0, 60)}"${b.buttons ? ` [${b.buttons.join(' | ')}]` : ''}`);
    } catch (e) {
      console.error('❌ sendText FALLO:', e?.message || e);
    }
    if (i++ === 0 && afterFirst) {
      try { await afterFirst(); } catch (e) { console.error('afterFirst:', e?.message || e); }
    }
  }
  if (!bubbles.length && afterFirst) await afterFirst();
}

// --- Ventana de 24 horas y plantillas ---------------------------------------
const WINDOW_MS = 23.5 * 3600 * 1000; // media hora de margen antes del corte de Meta
export function windowOpen(lead, now = Date.now()) {
  const last = lead?.lastInboundAt || lead?.openedAt || 0;
  return now - last < WINDOW_MS;
}
function tplText(name, params) {
  let t = TEMPLATES[name] || `[plantilla ${name}]`;
  (params || []).forEach((p, i) => { t = t.replaceAll(`{${i + 1}}`, String(p)); });
  return t;
}
// Manda una plantilla aprobada por Meta. Devuelve true si salió.
async function sendTemplateTo(lead, name, params) {
  try {
    await cloud.sendTemplate(lead.number, name, SETTINGS.templateLang || 'es_AR', params);
    console.log(`   📄 plantilla "${name}" -> ${lead.number}`);
    return true;
  } catch (e) {
    console.error(`❌ plantilla "${name}" a ${lead.number} falló (está aprobada en Meta?):`, e?.message || e);
    return false;
  }
}
const nombreOSaludo = (lead) => (lead?.name ? firstName(lead.name) : 'de nuevo');
const audioNote = (id) => `[audio enviado: "${AUDIOS[id] || id}"]`;

const fillName = (tpl, name) =>
  name ? tpl.replaceAll('{nombre}', firstName(name)) : tpl.replace(/\s*\{nombre\}/g, '');

// Refresca la fila del lead en el CRM (fire-and-forget, no bloquea).
function crmSync(key) {
  const l = getLead(key);
  if (l) crm.upsertLead(l).catch((e) => console.error('crm:', e?.message || e));
}

// ============================================================================
//  Panel web de conversaciones (/panel?k=PANEL_KEY)
// ============================================================================
function histText(m) {
  const c = m?.content;
  if (typeof c === 'string') {
    if (m.role === 'user' && c.startsWith('[nota interna')) return ''; // directiva interna, no es del lead
    return c;
  }
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return '';
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
// Última vez que VOS (humano) le escribiste desde el panel (0 si nunca).
function lastHumanAt(l) {
  let t = 0;
  for (const m of l.history || []) if (m.via === 'human' && (m.ts || 0) > t) t = m.ts;
  return t;
}
// Ventana de 24h cerrada: el lead no te escribe hace +24h, no le podés mandar texto libre.
function windowClosed(l) {
  return !l.lastInboundAt || (Date.now() - l.lastInboundAt) > 24 * 3600 * 1000;
}
// "muerto" para el orden del panel: va al fondo (perdidos + ventana cerrada). NO se hunden los
// agendados ni los que tienen un ⚠️ de entrega pendiente (siguen necesitando tu atención).
function isDeadForSort(l) {
  if (l.optOut) return true;
  if (l.lastSendFailed) return false;
  if (l.status === 'booked') return false;
  return l.status === 'lost' || windowClosed(l);
}
function lastActivity(l) {
  return Math.max(l.lastInboundAt || 0, l.lastBotAt || 0, l.openedAt || 0);
}
function panelData() {
  const leads = allLeads().slice().sort((a, b) => {
    const da = isDeadForSort(a) ? 1 : 0, db = isDeadForSort(b) ? 1 : 0;
    if (da !== db) return da - db;            // perdidos / ventana cerrada -> al fondo
    return lastActivity(b) - lastActivity(a); // el del ÚLTIMO mensaje (entró o salió) -> arriba de todo
  });
  return leads.map((l) => ({
    id: String(l.number || '').replace(/\D/g, ''),
    name: l.name || '',
    number: String(l.number || ''),
    // Campo A9 del registro unico de leads (la spec de medición 6.4): la llave con la que el
    // vendedor del cliente cruza la venta contra el lead. Lo exponemos ya para que el
    // dia que esto se exporte al registro el campo este. Se lee tal cual quedo escrito,
    // no se recalcula al leer (6.7); los leads viejos lo tienen por backfill-telefono.mjs.
    telefonoE164: l.telefonoE164 || '',
    status: l.status || '',
    unqualified: !!l.unqualified,
    dead: isDeadForSort(l),
    last: Math.max(l.lastInboundAt || 0, l.lastBotAt || 0, l.openedAt || 0),
    lastIn: l.lastInboundAt || 0,
    lastBot: l.lastBotAt || 0,
    opened: l.openedAt || 0,
    booked: l.bookedWhen ? String(l.bookedWhen) : '',
    bookedMeet: l.bookedMeetLink || l.bookedLink || '',
    cancelled: !!l.cancelled,
    sendFailed: l.lastSendFailed ? { win24: !!l.lastSendFailed.win24, detail: l.lastSendFailed.detail || '' } : null,
    closed: windowClosed(l),
    ad: l.ad ? (l.ad.title || l.ad.body || 'anuncio') : '',
    adId: l.ad?.sourceId || '',
    // Ficha (perfil que arma la IA por lead): la mostramos en la conversación.
    profile: l.profile ? {
      temperature: l.profile.temperature ?? null,
      style: l.profile.style || '',
      objection: l.profile.objection || '',
      summary: l.profile.summary || '',
    } : null,
    messages: (l.history || []).map((m) => {
      const media = m.media && m.media.id ? { type: m.media.type || '', id: m.media.id, mime: m.media.mime || '', filename: m.media.filename || '' } : null;
      // Con media, el texto visible es solo el epígrafe real (no el marcador que ve el cerebro).
      if (media) {
        return { role: m.role === 'assistant' ? 'bot' : 'lead', text: m.media.caption || '', ts: m.ts || 0, via: m.via || '', media };
      }
      const t = histText(m);
      return t ? { role: m.role === 'assistant' ? 'bot' : 'lead', text: t, ts: m.ts || 0, via: m.via || '' } : null;
    }).filter(Boolean),
  }));
}

// Proxy de media para el panel: descarga el binario de Meta por su id y lo sirve con el mime correcto.
// Caché chico en memoria para no re-descargar en cada refresco (los ids de Meta viven ~14 días).
const mediaCache = new Map(); // id -> { buf, mime }
async function serveMedia(id, res) {
  let hit = mediaCache.get(id);
  if (!hit) {
    const meta = await cloud.getMedia(id);
    const buf = await cloud.downloadMedia(meta.url);
    hit = { buf, mime: meta.mime || 'application/octet-stream' };
    mediaCache.set(id, hit);
    if (mediaCache.size > 60) mediaCache.delete(mediaCache.keys().next().value);
  }
  res.writeHead(200, {
    'Content-Type': hit.mime,
    'Content-Length': hit.buf.length,
    'Cache-Control': 'private, max-age=86400',
  });
  res.end(hit.buf);
}

// Panel estilo WhatsApp Web. El shell es estático (String.raw para no romper los
// escapes del JS de cliente); los datos llegan por fetch a /panel/data y se
// renderizan/actualizan solos cada 5s sin recargar la página.
function renderPanel() {
  return String.raw`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no"><meta name="theme-color" content="#202c33"><title>Acme · Chats</title>
<style>
:root{
  --bg:#0b141a;--panel:#111b21;--header:#202c33;--hover:#202c33;--active:#2a3942;
  --bubin:#202c33;--bubout:#005c4b;--bubouth:#0a4a3e;
  --txt:#e9edef;--txt2:#8696a0;--accent:#00a884;--link:#53bdeb;--tick:#53bdeb;
  --search:#202c33;--composer:#2a3942;--sep:#222d34;--chat:#0b141a;--rail:#202c33;
  --pill:#1d282f;--pilltxt:#8696a0;--dot:rgba(255,255,255,.045);--shadow:rgba(0,0,0,.16);
  --chipon:rgba(0,168,132,.22);--chiptxt:#00d9a3;--enc:#222e35;--enctxt:#ffd279;
}
@media (prefers-color-scheme: light){:root{
  --bg:#eae6df;--panel:#ffffff;--header:#f0f2f5;--hover:#f5f6f6;--active:#f0f2f5;
  --bubin:#ffffff;--bubout:#d9fdd3;--bubouth:#c5edb6;
  --txt:#111b21;--txt2:#667781;--accent:#00a884;--link:#027eb5;--tick:#53bdeb;
  --search:#f0f2f5;--composer:#ffffff;--sep:#e9edef;--chat:#efeae2;--rail:#f7f5f3;
  --pill:#ffffff;--pilltxt:#54656f;--dot:rgba(0,0,0,.035);--shadow:rgba(11,20,26,.13);
  --chipon:#d9fdd3;--chiptxt:#067a52;--enc:#fdf6cd;--enctxt:#54656f;
}}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden;overscroll-behavior:none}
body{font-family:'Segoe UI',Helvetica,Arial,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt);overflow:hidden}
svg{display:block}
#app{display:flex;height:100vh;height:100dvh;width:100%;overflow:hidden}
#rail{width:60px;flex-shrink:0;background:var(--rail);display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:16px 0 18px;border-right:1px solid var(--sep)}
.rail-top,.rail-bot{display:flex;flex-direction:column;align-items:center;gap:8px}
.rail-ic{width:42px;height:42px;border-radius:50%;border:0;background:transparent;color:var(--txt2);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s,color .15s}
.rail-ic:hover{background:rgba(134,150,160,.16)}
.rail-ic.active{background:var(--active);color:var(--txt)}
.rail-av{width:38px;height:38px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer}
#side{width:30%;min-width:330px;max-width:460px;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--sep)}
.side-head{height:60px;flex-shrink:0;background:var(--panel);display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 18px}
.sh-title{font-size:20px;font-weight:700;color:var(--txt);letter-spacing:.2px}
.sh-actions{display:flex;gap:0;color:var(--txt2)}
.filters{display:flex;gap:8px;padding:6px 14px 9px;background:var(--panel);overflow-x:auto;scrollbar-width:none}
.filters::-webkit-scrollbar{display:none}
.chip{flex-shrink:0;border:0;background:var(--active);color:var(--txt2);font-size:13.5px;padding:6px 13px;border-radius:16px;cursor:pointer;transition:background .15s,color .15s}
.chip.active{background:var(--chipon);color:var(--chiptxt)}
.archived{display:flex;align-items:center;gap:25px;padding:13px 14px 13px 16px;color:var(--txt);font-size:14.5px;cursor:pointer;border-bottom:1px solid var(--sep);transition:background .12s}
.archived:hover{background:var(--hover)}
.archived .ar-ic{color:var(--accent);display:flex}
.unread{flex-shrink:0;background:var(--accent);color:#04231b;border-radius:11px;min-width:20px;height:20px;padding:0 6px;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700}
.ch-actions{display:flex;gap:0;color:var(--txt2);margin-left:auto}
.daypill.enc{background:var(--enc);color:var(--enctxt);max-width:80%;font-size:12.5px;line-height:1.55;box-shadow:0 1px 1px var(--shadow)}
#chat.show{animation:chatin .24s ease}
@keyframes chatin{from{opacity:.35}to{opacity:1}}
.search-wrap{flex-shrink:0;padding:7px 12px;background:var(--panel);border-bottom:1px solid var(--sep)}
.search{display:flex;align-items:center;gap:12px;background:var(--search);border-radius:8px;padding:7px 14px;color:var(--txt2)}
.search input{flex:1;background:transparent;border:0;outline:0;color:var(--txt);font-size:14px}
.search input::placeholder{color:var(--txt2)}
#list{flex:1;overflow-y:auto;overflow-x:hidden}
.row{display:flex;align-items:center;gap:14px;padding-left:13px;cursor:pointer;height:72px;transition:background .12s}
.row:hover{background:var(--hover)}.row.active{background:var(--active)}
.row.dead{opacity:.55}.row.dead:hover{opacity:.85}
.tplbtn{margin:4px 2px 0;padding:4px 10px;border-radius:14px;border:1px solid var(--sep);background:var(--composer);color:var(--txt);font:inherit;font-size:12.5px;cursor:pointer}
.listsep{padding:7px 16px;font-size:10.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.6px;opacity:.8;border-bottom:1px solid var(--sep)}
.av{flex-shrink:0;width:49px;height:49px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;color:#fff}
.av.big{width:40px;height:40px;font-size:15px}
.av-me{width:40px;height:40px;background:var(--accent);font-size:20px}
.row-main{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:center;gap:3px;padding-right:14px;border-bottom:1px solid var(--sep)}
.row-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.name{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.time{font-size:12px;color:var(--txt2);flex-shrink:0}
.row-bot{display:flex;justify-content:space-between;align-items:center;gap:8px}
.prev{font-size:13.5px;color:var(--txt2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.badge{font-size:11px;font-weight:600;flex-shrink:0}
.none{padding:28px 16px;color:var(--txt2);font-size:13px;text-align:center}
#main{flex:1;display:flex;flex-direction:column;position:relative;background:var(--chat)}
#main::before{content:"";position:absolute;inset:0;background-image:var(--doodle,radial-gradient(var(--dot) 1px,transparent 1px));background-repeat:repeat;background-size:380px 380px;pointer-events:none;z-index:0}
#welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--txt2);padding:20px;position:relative;z-index:1;border-bottom:6px solid var(--accent)}
.wlogo{font-size:60px;margin-bottom:14px}.wt{font-size:26px;color:var(--txt);font-weight:300}.ws{margin-top:12px;font-size:14px;line-height:1.6;max-width:420px}
.wlock{position:absolute;bottom:26px;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--txt2)}
#chat{display:none;flex-direction:column;height:100%;position:relative;z-index:1}
.chat-head{height:60px;flex-shrink:0;background:var(--header);display:flex;align-items:center;gap:11px;padding:0 12px 0 8px;z-index:2}
.ch-info{min-width:0;flex:1;cursor:default}
.ch-info .t1{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-info .t2{font-size:12.5px;color:var(--txt2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.iconbtn{flex-shrink:0;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--txt2);cursor:pointer;border-radius:50%;transition:background .12s}
.iconbtn:hover{background:rgba(134,150,160,.16)}
.iconbtn:disabled{opacity:.45;cursor:default}
.back-btn{display:none;margin-left:2px}
.chat-body{flex:1;overflow-y:auto;padding:12px 6%;display:flex;flex-direction:column;gap:2px;scroll-behavior:smooth}
.daypill{align-self:center;background:var(--pill);color:var(--pilltxt);font-size:12.5px;padding:6px 13px;border-radius:8px;margin:9px 0;box-shadow:0 1px 1px var(--shadow);text-align:center;max-width:85%}
.daypill.ad{background:var(--pill);color:var(--accent);font-weight:500}
.b{position:relative;max-width:65%;padding:6px 9px 8px 10px;border-radius:8px;font-size:14.2px;line-height:19px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;box-shadow:0 1px .5px var(--shadow);margin:1px 0;animation:pop .16s ease}
@keyframes pop{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.b.in{align-self:flex-start;background:var(--bubin);border-top-left-radius:0}
.b.out{align-self:flex-end;background:var(--bubout);border-top-right-radius:0}
.b.in::before{content:"";position:absolute;top:0;left:-8px;border-top:8px solid var(--bubin);border-left:8px solid transparent}
.b.out::before{content:"";position:absolute;top:0;right:-8px;border-top:8px solid var(--bubout);border-right:8px solid transparent}
.b.out.human{background:var(--bubouth)}
.b.out.human::before{border-top-color:var(--bubouth)}
.b.media{padding:3px 3px 6px 3px;max-width:330px}
.b.media .cap{padding:3px 7px 0 7px;white-space:pre-wrap}
.b.sticker,.b.sticker::before{background:transparent!important;box-shadow:none}
.b .meta{float:right;margin:6px 0 -2px 12px;font-size:11px;color:var(--txt2);display:inline-flex;align-items:center;gap:3px}
.b.out .meta{color:var(--txt2)}
.b .ck{color:var(--txt2)}
.media-img{display:block;border-radius:6px;max-width:100%;cursor:pointer;background:var(--sep)}
.media-img.sticker{max-width:140px;border-radius:0}
.media-vid{display:block;border-radius:6px;max-width:100%;background:#000}
.aud{display:flex;align-items:center;gap:10px;min-width:210px;max-width:270px;padding:4px 6px 4px 2px}
.aud-btn{flex-shrink:0;width:36px;height:36px;border-radius:50%;border:0;background:transparent;color:var(--txt2);display:flex;align-items:center;justify-content:center;cursor:pointer}
.b.out .aud-btn{color:#9fe3cb}
.aud-body{flex:1;min-width:0;padding-top:2px}
.aud-track{position:relative;height:3px;border-radius:3px;background:rgba(134,150,160,.45);cursor:pointer;margin:9px 0 3px}
.b.out .aud-track{background:rgba(255,255,255,.28)}
.aud-fill{position:absolute;left:0;top:0;height:100%;border-radius:3px;background:var(--accent);width:0}
.aud-dot{position:absolute;top:50%;left:0;width:12px;height:12px;border-radius:50%;background:var(--accent);transform:translate(-50%,-50%);box-shadow:0 1px 2px rgba(0,0,0,.3)}
.aud-time{font-size:11px;color:var(--txt2)}
.filecard{display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:7px;background:rgba(0,0,0,.13);color:inherit;text-decoration:none;min-width:200px}
.filecard .fc-ico{color:var(--accent);flex-shrink:0}
.filecard .fc-name{font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.daypill.ficha{background:var(--pill);color:var(--pilltxt);border:1px solid var(--sep);line-height:1.5;max-width:90%}
.daypill.ficha a{color:var(--link)}
.daypill.failwarn{background:#3a1416;color:#ff9a9a;border:1px solid #5a2430;font-weight:600;max-width:92%}
.bt{margin-left:auto;flex-shrink:0;background:var(--active);color:var(--txt);border:0;border-radius:16px;padding:7px 12px;font-size:12px;cursor:pointer;white-space:nowrap;transition:filter .12s}
.bt:hover{filter:brightness(1.1)}
.bt.on{background:#0c3b32;color:#7fe0c8}
.chat-foot{min-height:62px;flex-shrink:0;background:var(--header);display:flex;align-items:flex-end;gap:6px;padding:8px 12px;padding-bottom:calc(8px + env(safe-area-inset-bottom));z-index:2}
.comp-wrap{flex:1;background:var(--composer);border-radius:10px;padding:5px 6px;display:flex}
.composer{flex:1;background:transparent;border:0;outline:0;color:var(--txt);font-size:14.7px;font-family:inherit;padding:6px 8px;resize:none;max-height:120px;line-height:1.4}
.composer::placeholder{color:var(--txt2)}
.circbtn{flex-shrink:0;width:46px;height:46px;border:0;border-radius:50%;background:var(--accent);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .12s,background .12s}
.circbtn:active{transform:scale(.9)}
.circbtn:disabled{opacity:.5;cursor:default}
.rec-bar{display:none;align-items:center;gap:10px;min-height:62px;flex-shrink:0;background:var(--header);padding:8px 14px;padding-bottom:calc(8px + env(safe-area-inset-bottom));z-index:3}
.rec-mid{flex:1;display:flex;align-items:center;gap:10px;color:var(--txt);font-size:15px}
.rec-dot{width:11px;height:11px;border-radius:50%;background:#f15c6d;animation:blink 1.1s steps(2,start) infinite}
.rec-hint{color:var(--txt2);font-size:13px}
@keyframes blink{50%{opacity:.15}}
#profile{position:fixed;top:0;right:0;bottom:0;width:min(420px,100%);background:var(--bg);z-index:40;transform:translateX(100%);transition:transform .26s cubic-bezier(.22,.61,.36,1);display:flex;flex-direction:column;box-shadow:-2px 0 18px rgba(0,0,0,.28)}
#profile.open{transform:translateX(0)}
.prof-head{height:60px;flex-shrink:0;display:flex;align-items:center;gap:20px;padding:0 16px;background:var(--header);color:var(--txt);font-size:16px}
.prof-body{flex:1;overflow-y:auto}
.prof-hero{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 20px 24px;background:var(--panel);margin-bottom:8px}
.prof-av{width:118px;height:118px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:600;color:#fff;margin-bottom:6px}
.prof-name{font-size:21px;color:var(--txt);text-align:center}
.prof-num{font-size:15px;color:var(--txt2)}
.prof-sec{padding:15px 22px;background:var(--panel);margin-bottom:8px}
.prof-sec h4{font-size:12.5px;color:var(--accent);font-weight:600;margin-bottom:9px;text-transform:none}
.prof-row{display:flex;justify-content:space-between;gap:14px;font-size:14px;color:var(--txt);padding:4px 0}
.prof-row .k{color:var(--txt2);flex-shrink:0}
.prof-row .v{text-align:right}
.prof-note{font-size:14px;color:var(--txt);line-height:1.55}
.prof-sec a{color:var(--link)}
.prof-photo-note{font-size:11.5px;color:var(--txt2);text-align:center;padding:0 30px 4px;line-height:1.45}
#lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:50;align-items:center;justify-content:center;padding:18px;animation:fade .15s ease}
#lightbox img{max-width:100%;max-height:100%;border-radius:4px}
@keyframes fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media(max-width:768px){
  html,body{position:fixed;inset:0;width:100%;height:100%;touch-action:pan-y}
  #rail{display:none}
  #side{width:100%;min-width:0;max-width:none;position:absolute;inset:0;z-index:1;border:0;transition:transform .26s ease}
  #main{position:absolute;inset:0;z-index:2;transform:translateX(100%);transition:transform .28s cubic-bezier(.22,.61,.36,1)}
  body.chat-open #main{transform:translateX(0)}
  body.chat-open #side{transform:translateX(-22%)}
  .back-btn{display:flex}
  .b{max-width:82%}.b.media{max-width:78vw}
  .chat-body{padding:10px 4%}
}
</style></head><body>
<div id="app">
  <nav id="rail">
    <div class="rail-top">
      <button class="rail-ic active" title="Chats"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.94 14.46L2 22l5.66-1.47A10 10 0 1 0 12 2"/></svg></button>
      <button class="rail-ic" title="Novedades"><svg viewBox="0 0 24 24" width="23" height="23"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2.4 3.4"/><circle cx="12" cy="12" r="3.4" fill="currentColor"/></svg></button>
      <button class="rail-ic" title="Canales"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M3 10v4h3l5 4V6L6 10zm13 2a4 4 0 0 0-2.5-3.7v7.4A4 4 0 0 0 16 12"/></svg></button>
      <button class="rail-ic" title="Comunidades"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M16.5 11a2.5 2.5 0 1 0-2.5-2.5 2.5 2.5 0 0 0 2.5 2.5m-9 0A2.5 2.5 0 1 0 5 8.5 2.5 2.5 0 0 0 7.5 11m0 1.6C5.3 12.6 1 13.7 1 16v1.8h7.2V16c0-.9.3-1.7.9-2.5a9.6 9.6 0 0 0-1.6-.9m9 0c-.4 0-.9 0-1.4.1a4.6 4.6 0 0 1 1.6 3.3v1.8H23V16c0-2.3-4.3-3.4-6.5-3.4"/></svg></button>
    </div>
    <div class="rail-bot">
      <button class="rail-ic" title="Ajustes"><svg viewBox="0 0 24 24" width="23" height="23"><path fill="currentColor" d="M12 8.5a3.5 3.5 0 1 0 3.5 3.5A3.5 3.5 0 0 0 12 8.5m9.3 3.5a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L16.3 2h-4l-.5 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.3 7.3 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.5 2.6h4l.5-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6a7 7 0 0 0 .1-1.2"/></svg></button>
      <div class="rail-av" title="Acme">🤖</div>
    </div>
  </nav>
  <div id="side">
    <div class="side-head"><div class="sh-title">Acme</div><div class="sh-actions"><button class="iconbtn" title="Nuevo chat"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 3H5a2 2 0 0 0-2 2v16l4-4h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2m-2 9h-4v4h-2v-4H7v-2h4V6h2v4h4z"/></svg></button><button class="iconbtn" title="Menú"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 7a2 2 0 1 0-2-2 2 2 0 0 0 2 2m0 2a2 2 0 1 0 2 2 2 2 0 0 0-2-2m0 6a2 2 0 1 0 2 2 2 2 0 0 0-2-2"/></svg></button></div></div>
    <div class="search-wrap"><div class="search"><svg viewBox="0 0 24 24" width="19" height="19"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14"/></svg><input id="q" placeholder="Buscar un chat o iniciar uno nuevo"></div></div>
    <div class="filters">
      <button class="chip active" data-f="all">Todos</button>
      <button class="chip" data-f="unread">No leídos <span id="unreadCount"></span></button>
      <button class="chip" data-f="booked">Agendados</button>
    </div>
    <div class="archived"><span class="ar-ic"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 5h18v3H3zm2 4h14l-1.2 11H6.2zm5 3v2h4v-2z"/></svg></span>Archivados<span id="count" style="display:none"></span></div>
    <div id="list"><div class="none">cargando…</div></div>
  </div>
  <div id="main">
    <div id="welcome"><div class="wlogo">🤖</div><div class="wt">Acme · Panel de chats</div><div class="ws">Elegí una conversación de la izquierda.<br>Podés responder vos desde acá; cuando escribís, el bot suelta ese chat.</div><div class="wlock"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5m3 8H9V6a3 3 0 0 1 6 0z"/></svg> Tus mensajes están cifrados de extremo a extremo</div></div>
    <div id="chat">
      <div class="chat-head">
        <button class="iconbtn back-btn" id="backBtn" title="Volver"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 4l1.41 1.41L7.83 11H20v2H7.83l5.58 5.59L12 20l-8-8z"/></svg></button>
        <div class="av big" id="chAv"></div>
        <div class="ch-info"><div class="t1" id="chName"></div><div class="t2" id="chSub"></div></div>
        <button id="botToggle" class="bt" style="display:none"></button>
        <div class="ch-actions">
          <button class="iconbtn" title="Buscar"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14"/></svg></button>
          <button class="iconbtn" title="Menú"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 7a2 2 0 1 0-2-2 2 2 0 0 0 2 2m0 2a2 2 0 1 0 2 2 2 2 0 0 0-2-2m0 6a2 2 0 1 0 2 2 2 2 0 0 0-2-2"/></svg></button>
        </div>
      </div>
      <div class="chat-body" id="body"></div>
      <div class="chat-foot" id="foot">
        <input type="file" id="fileInput" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf,.jpg,.jpeg,.png,.webp" style="display:none">
        <button class="iconbtn" id="emojiBtn" title="Emojis"><svg viewBox="0 0 24 24" width="25" height="25"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2m0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8m-3.5-9a1.5 1.5 0 1 0-1.5-1.5A1.5 1.5 0 0 0 8.5 11m7 0A1.5 1.5 0 1 0 14 9.5a1.5 1.5 0 0 0 1.5 1.5M12 17.5a5.5 5.5 0 0 0 5-3.5H7a5.5 5.5 0 0 0 5 3.5"/></svg></button>
        <button class="iconbtn" id="attachBtn" title="Adjuntar imagen o PDF"><svg viewBox="0 0 24 24" width="25" height="25"><path fill="currentColor" d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 0 1 0 2h-6v6a1 1 0 0 1-2 0v-6H5a1 1 0 0 1 0-2h6V5a1 1 0 0 1 1-1"/></svg></button>
        <div class="comp-wrap"><textarea id="composer" class="composer" rows="1" placeholder="Escribe un mensaje"></textarea></div>
        <button class="circbtn sendbtn" id="sendBtn" title="Enviar" style="display:none"><svg viewBox="0 0 24 24" width="23" height="23"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
        <button class="circbtn micbtn" id="micBtn" title="Grabar nota de voz"><svg viewBox="0 0 24 24" width="23" height="23"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3m5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg></button>
      </div>
      <div class="rec-bar" id="recBar">
        <button class="iconbtn rec-cancel" id="recCancel" title="Cancelar"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6 7h12l-1 14H7zm9-4l1 1h4v2H4V4h4l1-1z"/></svg></button>
        <div class="rec-mid"><span class="rec-dot"></span><span id="recTime">0:00</span><span class="rec-hint">grabando…</span></div>
        <button class="circbtn sendbtn" id="recSend" title="Enviar nota de voz"><svg viewBox="0 0 24 24" width="23" height="23"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
      </div>
    </div>
  </div>
</div>
<div id="lightbox" onclick="closeImg()"><img id="lightimg" alt=""></div>
<div id="profile">
  <div class="prof-head"><button class="iconbtn" id="profClose" title="Cerrar"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 4l1.41 1.41L7.83 11H20v2H7.83l5.58 5.59L12 20l-8-8z"/></svg></button><span>Información del contacto</span></div>
  <div class="prof-body" id="profBody"></div>
</div>
<script>
var K=new URLSearchParams(location.search).get('k')||'';
var DATA=[],cur=location.hash.slice(1)||null,lastSig='',openId=null,loaded=false,FILTER='all';
var PAL=['#6a7175','#c0825a','#5a8fc0','#9d5ac0','#5ac09d','#c05a7e','#b0a14f','#5a6ec0','#bd7d3f','#4f9d8a'];
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function hsh(s){var h=0;s=String(s||'');for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h;}
function inits(n){n=String(n||'').trim();if(n){var p=n.split(' ').filter(Boolean);return ((p[0][0]||'')+(p[1]?p[1][0]:'')).toUpperCase();}return '#';}
function col(id){return PAL[hsh(id)%PAL.length];}
function stLabel(s){return {opened:'Nuevo',engaged:'En charla',booked:'Agendó',lost:'Perdido',human:'Vos'}[s]||s||'';}
function stCol(s){return {opened:'#8696a0',engaged:'#53bdeb',booked:'#00a884',lost:'#f15c6d',human:'#e0a458'}[s]||'#8696a0';}
function fmtClock(ts){if(!ts)return '';var d=new Date(ts);return two(d.getHours())+':'+two(d.getMinutes());}
function badgeOf(d){if(d.unqualified)return {t:'No calif.',c:'#e0a458'};if(d.cancelled)return {t:'Canceló',c:'#f15c6d'};if(d.status)return {t:stLabel(d.status),c:stCol(d.status)};return null;}
function two(n){return ('0'+n).slice(-2);}
function fmtTime(ts){if(!ts)return '';var d=new Date(ts),n=new Date();if(d.toDateString()===n.toDateString())return two(d.getHours())+':'+two(d.getMinutes());var y=new Date(n);y.setDate(n.getDate()-1);if(d.toDateString()===y.toDateString())return 'Ayer';return two(d.getDate())+'/'+two(d.getMonth()+1);}
function fmtDate(ts){if(!ts)return '';var d=new Date(ts),n=new Date();if(d.toDateString()===n.toDateString())return 'Hoy';return two(d.getDate())+'/'+two(d.getMonth()+1)+'/'+d.getFullYear();}
function avtag(d){return '<div class="av" style="background:'+col(d.id)+'">'+esc(inits(d.name))+'</div>';}
function clean(t){return String(t||'').split('\n').join(' ');}
function isUnread(d){return (d.lastIn||0)>(d.lastBot||0)&&d.status!=='human';}
function matchFilter(d){if(FILTER==='unread')return isUnread(d);if(FILTER==='booked')return d.status==='booked';return true;}
function buildDoodle(c){
  var s="<svg xmlns='http://www.w3.org/2000/svg' width='380' height='380' viewBox='0 0 380 380' fill='none' stroke='"+c+"' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>";
  s+="<path d='M40 60c-8-10-24-8-24 6 0 10 24 22 24 22s24-12 24-22c0-14-16-16-24-6z'/>";
  s+="<path d='M150 40l6 14 15 1-11 10 3 15-13-8-13 8 3-15-11-10 15-1z'/>";
  s+="<circle cx='250' cy='55' r='20'/><circle cx='243' cy='50' r='1.6' fill='"+c+"'/><circle cx='257' cy='50' r='1.6' fill='"+c+"'/><path d='M241 60c4 5 14 5 18 0'/>";
  s+="<path d='M330 30v34M330 30l16-4v30'/><circle cx='325' cy='66' r='5'/><circle cx='341' cy='62' r='5'/>";
  s+="<path d='M30 150h44a8 8 0 0 1 8 8v22a8 8 0 0 1-8 8H50l-12 10v-10h-8a8 8 0 0 1-8-8v-22a8 8 0 0 1 8-8z'/>";
  s+="<path d='M150 150h34v14a17 17 0 0 1-34 0zM184 154h8a6 6 0 0 1 0 12h-8M150 186h34'/>";
  s+="<rect x='246' y='150' width='44' height='30' rx='4'/><circle cx='268' cy='165' r='8'/><path d='M256 150l4-6h16l4 6'/>";
  s+="<path d='M325 175l30-12-30-12 6 12-12 4 12 4z'/>";
  s+="<path d='M40 250c0 18 18 30 36 30 0-26-18-44-36-44 0 4 0 10 4 14M52 270c8-6 16-10 24-10'/>";
  s+="<path d='M150 250a16 18 0 1 1 32 0c0 13-12 22-16 22s-16-9-16-22zM166 272v12'/>";
  s+="<circle cx='262' cy='262' r='20'/><path d='M262 242v40M242 262h40M249 249l26 26M275 249l-26 26'/>";
  s+="<circle cx='338' cy='262' r='10'/><path d='M338 246v-8M338 286v-8M322 262h-8M362 262h-8M327 251l-6-6M355 279l-6-6M349 251l6-6M321 279l6-6'/>";
  s+="<path d='M150 320a22 22 0 0 1 44 0zM172 320v18a6 6 0 0 0 12 0'/>";
  s+="<path d='M262 320l16 16-16 16-16-16zM262 352v14'/>";
  s+="</svg>";return s;}
function applyDoodle(){
  var light=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches;
  var c=light?'rgba(17,27,33,0.045)':'rgba(233,237,239,0.05)';
  document.documentElement.style.setProperty('--doodle','url("data:image/svg+xml,'+encodeURIComponent(buildDoodle(c))+'")');}
function mediaUrl(id){return '/panel/media?k='+encodeURIComponent(K)+'&id='+encodeURIComponent(id);}
function mediaLabel(m){var t=m.media.type;return t==='image'?'📷 Foto':t==='sticker'?'🩷 Sticker':t==='video'?'🎬 Video':t==='audio'?'🎤 Audio':'📄 Documento';}
function previewOf(last){if(!last)return '(sin mensajes)';var pre=last.role==='bot'?'✓ ':'';if(last.media)return pre+mediaLabel(last)+(last.text?' '+last.text:'');return pre+last.text;}
var ICON_PLAY='<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
var ICON_PAUSE='<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
var audios={},curAid=null;
function fmtDur(s){s=Math.floor(s||0);return (Math.floor(s/60))+':'+two(s%60);}
function audNodes(id){var r=[],list=document.querySelectorAll('.aud');for(var i=0;i<list.length;i++)if(list[i].getAttribute('data-aid')===id)r.push(list[i]);return r;}
function getAud(id,url){if(!audios[id]){var a=new Audio(url);a.preload='metadata';audios[id]=a;
  a.addEventListener('timeupdate',function(){updateAud(id);});
  a.addEventListener('loadedmetadata',function(){updateAud(id);});
  a.addEventListener('play',function(){updateAud(id);});
  a.addEventListener('pause',function(){updateAud(id);});
  a.addEventListener('ended',function(){a.currentTime=0;updateAud(id);});}
  return audios[id];}
function toggleAud(id,url){var a=getAud(id,url);
  if(a.paused){if(curAid&&curAid!==id&&audios[curAid])audios[curAid].pause();curAid=id;var p=a.play();if(p&&p.catch)p.catch(function(){});}
  else a.pause();}
function seekAud(id,url,ratio){var a=getAud(id,url);if(a.duration&&isFinite(a.duration)){a.currentTime=Math.max(0,Math.min(1,ratio))*a.duration;updateAud(id);}}
function updateAud(id){var a=audios[id];if(!a)return;var nodes=audNodes(id);
  var dur=(a.duration&&isFinite(a.duration))?a.duration:0,cur=a.currentTime||0,pct=dur?(cur/dur*100):0;
  for(var i=0;i<nodes.length;i++){var n=nodes[i];
    var b=n.querySelector('.aud-btn');if(b)b.innerHTML=a.paused?ICON_PLAY:ICON_PAUSE;
    var f=n.querySelector('.aud-fill');if(f)f.style.width=pct+'%';
    var d=n.querySelector('.aud-dot');if(d)d.style.left=pct+'%';
    var t=n.querySelector('.aud-time');if(t)t.textContent=fmtDur((a.paused&&!cur)?dur:cur);}}
function syncAudios(){for(var id in audios)if(audios.hasOwnProperty(id))updateAud(id);}
function renderMedia(m){var u=mediaUrl(m.media.id),t=m.media.type;
  if(t==='image'||t==='sticker')return '<img class="media-img'+(t==='sticker'?' sticker':'')+'" loading="lazy" src="'+u+'" onclick="openImg(this.src)" alt="">';
  if(t==='video')return '<video class="media-vid" controls preload="metadata" src="'+u+'"></video>';
  if(t==='audio'){var id=esc(m.media.id);return '<div class="aud" data-aid="'+id+'" data-url="'+esc(u)+'"><button class="aud-btn">'+ICON_PLAY+'</button><div class="aud-body"><div class="aud-track"><div class="aud-fill"></div><div class="aud-dot"></div></div><div class="aud-time">0:00</div></div></div>';}
  var nm=esc(m.media.filename||'documento');
  return '<a class="filecard" href="'+u+'" target="_blank" rel="noopener" download="'+nm+'"><span class="fc-ico"><svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 2 4 4h-4z"/></svg></span><span class="fc-name">'+nm+'</span></a>';}
function renderList(){
  var q=(document.getElementById('q').value||'').toLowerCase(),out='',sepShown=false,nUnread=0;
  for(var i=0;i<DATA.length;i++){if(isUnread(DATA[i]))nUnread++;}
  for(var i=0;i<DATA.length;i++){var d=DATA[i];
    var last=d.messages.length?d.messages[d.messages.length-1]:null;
    var prev=previewOf(last);
    if(!matchFilter(d))continue;
    if(q&&(((d.name||'')+' '+d.number+' '+prev).toLowerCase().indexOf(q)<0))continue;
    if(d.dead&&!sepShown){out+='<div class="listsep">perdidos · fuera de 24h</div>';sepShown=true;}
    var un=isUnread(d);
    out+='<div class="row'+(d.id===cur?' active':'')+(d.dead?' dead':'')+'" onclick="openChat(\''+d.id+'\')">'+avtag(d)
      +'<div class="row-main"><div class="row-top"><span class="name">'+esc(d.name||('+'+d.number))+'</span><span class="time"'+(un?' style="color:var(--accent)"':'')+'>'+fmtTime(d.last)+'</span></div>'
      +'<div class="row-bot"><span class="prev">'+esc(clean(prev).slice(0,52))+'</span>'
      +(d.sendFailed?'<span class="badge" style="color:#ff6b6b" title="tu último mensaje no se entregó">⚠️</span>':'')
      +(function(){var b=badgeOf(d);return b?'<span class="badge" style="color:'+b.c+'">'+esc(b.t)+'</span>':'';})()
      +(un?'<span class="unread" style="min-width:9px;width:9px;height:9px;padding:0"></span>':'')+'</div></div></div>';
  }
  document.getElementById('list').innerHTML=out||'<div class="none">'+(FILTER==='all'?'sin leads todavía':'nada en este filtro')+'</div>';
  document.getElementById('count').textContent=DATA.length;
  var uc=document.getElementById('unreadCount');if(uc)uc.textContent=nUnread?nUnread:'';
}
function findCur(){for(var i=0;i<DATA.length;i++)if(DATA[i].id===cur)return DATA[i];return null;}
function bubble(cls,inner,meta){return '<div class="b '+cls+'">'+inner+'<span class="meta">'+meta+'</span></div>';}
function renderChat(scroll){
  var d=findCur(),W=document.getElementById('welcome'),C=document.getElementById('chat');
  if(!d){W.style.display='flex';C.style.display='none';openId=null;return;}
  W.style.display='none';C.style.display='flex';
  if(scroll){C.classList.remove('show');void C.offsetWidth;C.classList.add('show');}
  var av=document.getElementById('chAv');av.textContent=inits(d.name);av.style.background=col(d.id);
  document.getElementById('chName').textContent=d.name||('+'+d.number);
  var sub='+'+d.number;var bg=badgeOf(d);if(bg)sub+=' · '+bg.t;if(d.booked&&!d.cancelled)sub+=' · 📅 '+d.booked;
  if(d.lastIn&&d.lastBot&&d.lastBot>=d.lastIn){var g=Math.round((d.lastBot-d.lastIn)/1000);sub+=' · respondió en '+(g<90?g+'s':Math.round(g/60)+' min');}
  document.getElementById('chSub').textContent=sub;
  var tg=document.getElementById('botToggle');tg.style.display='';
  if(d.status==='human'){tg.textContent='🤖 reactivar bot';tg.className='bt on';}else{tg.textContent='🙋 atiendo yo';tg.className='bt';}
  var body=document.getElementById('body'),prevTop=body.scrollTop,atBottom=body.scrollHeight-body.scrollTop-body.clientHeight<90,h='';
  if(d.opened)h+='<div class="daypill">Lead desde '+esc(fmtDate(d.opened))+'</div>';
  h+='<div class="daypill enc">🔒 Los mensajes están cifrados de extremo a extremo. Nadie fuera de este chat puede leerlos.</div>';
  if(d.ad)h+='<div class="daypill ad">📣 Vino de un anuncio: '+esc(clean(d.ad).slice(0,70))+(d.adId?' · id '+esc(d.adId):'')+'</div>';
  if(d.profile){var pf=d.profile,bits=[];
    if(pf.temperature!=null)bits.push('🌡️ '+pf.temperature+'/100');
    if(pf.objection&&!/^ningun/i.test(pf.objection))bits.push('objeción: '+pf.objection);
    if(pf.style)bits.push('estilo: '+pf.style);
    var fl=bits.length?esc(bits.join(' · ')):'';
    if(pf.summary)fl+=(fl?'<br>':'')+'📝 '+esc(pf.summary);
    if(fl)h+='<div class="daypill ficha">'+fl+'</div>';}
  if(d.booked&&d.bookedMeet)h+='<div class="daypill ficha">📅 '+esc(d.cancelled?'(cancelada) ':'')+esc(d.booked)+' · <a href="'+esc(d.bookedMeet)+'" target="_blank" rel="noopener">link videollamada</a></div>';
  for(var i=0;i<d.messages.length;i++){var m=d.messages[i];var tm=m.ts?fmtClock(m.ts):'';
    var out=m.role==='bot',hum=out&&m.via==='human';
    if(m.media){
      var cls=(out?'out'+(hum?' human':''):'in')+' media'+(m.media.type==='sticker'?' sticker':'');
      var inner=renderMedia(m)+(m.text?'<div class="cap">'+esc(m.text)+'</div>':'');
      var meta=(out&&hum?'vos · ':'')+(tm?tm+' ':'')+(out?'<span class="ck">✓✓</span>':'');
      h+=bubble(cls,inner,meta);continue;
    }
    if(out){var parts=String(m.text).split(/\n\s*\n|\n/).map(function(s){return s.trim();}).filter(Boolean);if(!parts.length)parts=[m.text];
      for(var j=0;j<parts.length;j++){var lp=j===parts.length-1;
        h+=bubble('out'+(hum?' human':''),esc(parts[j]),lp?((hum?'vos · ':'')+(tm?tm+' ':'')+'<span class="ck">✓✓</span>'):'');}}
    else h+=bubble('in',esc(m.text),tm);
  }
  if(!d.messages.length)h+='<div class="daypill">(sin mensajes aún)</div>';
  if(d.sendFailed)h+='<div class="daypill failwarn">⚠️ Tu último mensaje NO se entregó'+(d.sendFailed.win24?'. El lead no te escribe hace +24h (fuera de ventana): tiene que escribirte primero para que le llegue.':'.')+'</div>';
  if(d.closed){h+='<div class="daypill">Charla cerrada (+24 h): solo salen plantillas. ';for(var ti=0;ti<TPLS.length;ti++){h+='<button class="tplbtn" onclick="sendTpl(\''+TPLS[ti][0]+'\')">'+esc(TPLS[ti][1])+'</button> ';}h+='</div>';}
  body.innerHTML=h;
  body.scrollTop=(scroll||atBottom)?body.scrollHeight:prevTop;
  syncAudios();
  openId=cur;
}
var TPLS=[['propuesta_lista','Plan listo'],['seguimiento_propuesta','Pudiste mirar el plan'],['segunda_llamada','Recordar llamada 2'],['despues_de_pensarlo','Después de pensarlo'],['seguimiento_1','Retomar la llamada'],['retomar','Retomar (30-90 días)'],['retomar_sin_presupuesto','Retomar (sin presupuesto)']];
var TPL_EXTRA={segunda_llamada:'Día y hora de la segunda llamada (ej. jueves 16 a las 10)'};
function sendTpl(name){var d=findCur();if(!d)return;var extra='';if(TPL_EXTRA[name]){extra=prompt(TPL_EXTRA[name])||'';if(!extra)return;}
  if(!confirm('Mandar la plantilla "'+name+'" a '+(d.name||d.number)+'?'))return;
  fetch('/panel/sendtemplate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k:K,num:d.number,name:name,extra:extra})})
    .then(function(r){return r.json();}).then(function(j){if(j&&j.ok){load();}else{alert('No se pudo mandar'+(j&&j.error?': '+j.error:''));}})
    .catch(function(){alert('No se pudo mandar');});}
function openChat(id){cur=id;location.hash=id;document.body.classList.add('chat-open');closeProfile();renderList();renderChat(true);}
function closeChat(){cur=null;if(location.hash)location.hash='';document.body.classList.remove('chat-open');closeProfile();renderList();renderChat(false);}
function openImg(src){document.getElementById('lightimg').src=src;document.getElementById('lightbox').style.display='flex';}
function closeImg(){document.getElementById('lightbox').style.display='none';document.getElementById('lightimg').src='';}
function fmtFull(ts){if(!ts)return '—';var d=new Date(ts);return two(d.getDate())+'/'+two(d.getMonth()+1)+'/'+d.getFullYear()+' '+two(d.getHours())+':'+two(d.getMinutes());}
function profRow(k,v){return '<div class="prof-row"><span class="k">'+esc(k)+'</span><span class="v">'+v+'</span></div>';}
function openProfile(){var d=findCur();if(!d)return;renderProfile(d);document.getElementById('profile').classList.add('open');}
function closeProfile(){document.getElementById('profile').classList.remove('open');}
function renderProfile(d){
  var bg=badgeOf(d),h='';
  h+='<div class="prof-hero"><div class="prof-av" style="background:'+col(d.id)+'">'+esc(inits(d.name))+'</div><div class="prof-name">'+esc(d.name||('+'+d.number))+'</div><div class="prof-num">+'+esc(d.number)+'</div></div>';
  h+='<div class="prof-photo-note">🔒 La API oficial de WhatsApp no permite ver la foto de perfil de los contactos (privacidad de Meta). Se muestra la inicial.</div>';
  h+='<div class="prof-sec"><h4>Estado</h4>'+profRow('Situación', esc(bg?bg.t:(d.status||'—')));
  if(isUnread(d))h+=profRow('Pendiente', 'te escribió y no respondiste');
  h+='</div>';
  if(d.booked){h+='<div class="prof-sec"><h4>Llamada agendada</h4>'+profRow('Cuándo', esc((d.cancelled?'(cancelada) ':'')+d.booked));
    if(d.bookedMeet)h+=profRow('Link', '<a href="'+esc(d.bookedMeet)+'" target="_blank" rel="noopener">videollamada</a>');
    h+='</div>';}
  if(d.ad)h+='<div class="prof-sec"><h4>Vino de un anuncio</h4><div class="prof-note">📣 '+esc(clean(d.ad))+(d.adId?'<br><span style="color:var(--txt2)">id '+esc(d.adId)+'</span>':'')+'</div></div>';
  if(d.profile){var pf=d.profile;h+='<div class="prof-sec"><h4>Ficha (análisis IA)</h4>';
    if(pf.temperature!=null)h+=profRow('Temperatura', '🌡️ '+esc(pf.temperature)+'/100');
    if(pf.style)h+=profRow('Estilo', esc(pf.style));
    if(pf.objection&&!/^ningun/i.test(pf.objection))h+=profRow('Objeción', esc(pf.objection));
    if(pf.summary)h+='<div class="prof-note" style="margin-top:7px">📝 '+esc(pf.summary)+'</div>';
    h+='</div>';}
  h+='<div class="prof-sec"><h4>Actividad</h4>';
  if(d.opened)h+=profRow('Primer contacto', esc(fmtFull(d.opened)));
  if(d.lastIn)h+=profRow('Últ. del lead', esc(fmtFull(d.lastIn)));
  if(d.lastBot)h+=profRow('Últ. del bot', esc(fmtFull(d.lastBot)));
  h+=profRow('Mensajes', String(d.messages?d.messages.length:0))+'</div>';
  document.getElementById('profBody').innerHTML=h;
}
function toggleBot(){var d=findCur();if(!d)return;var mute=d.status!=='human';
  fetch('/admin/mute?k='+encodeURIComponent(K)+'&num='+encodeURIComponent(d.number)+'&on='+(mute?'1':'0')).then(function(){load();}).catch(function(){});}
function syncFoot(){var t=(document.getElementById('composer').value||'').trim();
  document.getElementById('sendBtn').style.display=t?'flex':'none';
  document.getElementById('micBtn').style.display=t?'none':'flex';}
function sendMsg(){var d=findCur();if(!d)return;var ta=document.getElementById('composer'),t=(ta.value||'').trim();if(!t)return;
  var b=document.getElementById('sendBtn');b.disabled=true;
  fetch('/panel/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k:K,num:d.number,msg:t})})
    .then(function(r){return r.json().catch(function(){return {ok:r.ok};});})
    .then(function(j){b.disabled=false;if(j&&j.ok){ta.value='';ta.style.height='auto';syncFoot();load();}else{alert('No se pudo enviar'+(j&&j.error?': '+j.error:''));}})
    .catch(function(){b.disabled=false;alert('No se pudo enviar (problema de red)');});}
function sendFile(file){var d=findCur();if(!d||!file)return;
  var isImg=/^image\//.test(file.type)||/\.(jpe?g|png|webp)$/i.test(file.name);
  var isPdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name);
  if(!isImg&&!isPdf){alert('Por ahora solo imágenes (jpg/png/webp) o PDF');return;}
  if(isImg&&file.size>5*1024*1024){alert('La imagen es muy grande (máx 5MB para WhatsApp)');return;}
  if(file.size>18*1024*1024){alert('El archivo es muy grande (máx 18MB)');return;}
  var ab=document.getElementById('attachBtn');ab.disabled=true;
  var fr=new FileReader();
  fr.onload=function(){var b64=String(fr.result||'').split(',')[1]||'';var cap=(document.getElementById('composer').value||'').trim();
    fetch('/panel/senddoc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k:K,num:d.number,filename:file.name,mime:file.type||'',caption:cap,dataB64:b64})})
      .then(function(r){return r.json().catch(function(){return {ok:r.ok};});})
      .then(function(j){ab.disabled=false;if(j&&j.ok){document.getElementById('composer').value='';syncFoot();load();}else{alert('No se pudo enviar'+(j&&j.error?': '+j.error:''));}})
      .catch(function(){ab.disabled=false;alert('No se pudo enviar (red)');});};
  fr.onerror=function(){ab.disabled=false;alert('No pude leer el archivo');};
  fr.readAsDataURL(file);}
// --- Nota de voz: grabar -> transcodear en el server -> enviar ---
var mediaRec=null,recChunks=[],recStream=null,recTimer=null,recT0=0,recCanceled=false;
function pickMime(){var c=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus','audio/ogg'];
  for(var i=0;i<c.length;i++){try{if(window.MediaRecorder&&MediaRecorder.isTypeSupported(c[i]))return c[i];}catch(e){}}return '';}
function showRec(on){document.getElementById('foot').style.display=on?'none':'flex';document.getElementById('recBar').style.display=on?'flex':'none';}
function recTick(){var s=Math.floor((Date.now()-recT0)/1000);document.getElementById('recTime').textContent=Math.floor(s/60)+':'+two(s%60);}
function startRec(){var d=findCur();if(!d)return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){alert('Tu navegador no permite grabar audio');return;}
  navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
    recStream=stream;recChunks=[];recCanceled=false;
    var mt=pickMime();
    try{mediaRec=mt?new MediaRecorder(stream,{mimeType:mt}):new MediaRecorder(stream);}catch(e){mediaRec=new MediaRecorder(stream);}
    mediaRec.ondataavailable=function(e){if(e.data&&e.data.size)recChunks.push(e.data);};
    mediaRec.onstop=function(){
      if(recStream){recStream.getTracks().forEach(function(t){t.stop();});recStream=null;}
      if(recTimer){clearInterval(recTimer);recTimer=null;}
      showRec(false);
      if(recCanceled||!recChunks.length)return;
      var blob=new Blob(recChunks,{type:(mediaRec&&mediaRec.mimeType)||'audio/webm'});
      var fr=new FileReader();
      fr.onload=function(){var b64=String(fr.result||'').split(',')[1]||'';uploadAudio(b64);};
      fr.readAsDataURL(blob);
    };
    mediaRec.start();recT0=Date.now();recTick();recTimer=setInterval(recTick,500);showRec(true);
  }).catch(function(){alert('No pude acceder al micrófono (revisá los permisos)');});}
function stopAndSend(){if(mediaRec&&mediaRec.state!=='inactive'){recCanceled=false;mediaRec.stop();}else showRec(false);}
function cancelRec(){recCanceled=true;if(mediaRec&&mediaRec.state!=='inactive')mediaRec.stop();else{if(recStream){recStream.getTracks().forEach(function(t){t.stop();});recStream=null;}if(recTimer){clearInterval(recTimer);recTimer=null;}showRec(false);}}
function uploadAudio(b64){var d=findCur();if(!d){return;}
  var rs=document.getElementById('recSend');rs.disabled=true;
  fetch('/panel/sendaudio',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({k:K,num:d.number,dataB64:b64})})
    .then(function(r){return r.json().catch(function(){return {ok:r.ok};});})
    .then(function(j){rs.disabled=false;if(j&&j.ok){load();}else{alert('No se pudo enviar el audio'+(j&&j.error?': '+j.error:''));}})
    .catch(function(){rs.disabled=false;alert('No se pudo enviar el audio (red)');});}
function load(){
  fetch('/panel/data?k='+encodeURIComponent(K),{cache:'no-store'}).then(function(r){
    if(!r.ok)throw 0;return r.json();
  }).then(function(j){
    if(!Array.isArray(j))return; // respuesta rara: conservo el ultimo estado bueno, no blanqueo
    DATA=j;
    var sig=DATA.map(function(d){return d.id+':'+d.messages.length+':'+d.status+':'+d.last+':'+(d.cancelled?1:0)+':'+(d.sendFailed?1:0)+':'+(d.dead?1:0);}).join('|');
    var changed=sig!==lastSig;lastSig=sig;
    if(changed||!loaded){loaded=true;renderList();} // solo repinto la lista si algo cambio
    if(cur&&(openId!==cur||changed))renderChat(openId!==cur);
  }).catch(function(){}); // fetch fallo (blip de red/railway): NO toco DATA ni repinto -> sin parpadeo
}
document.getElementById('q').addEventListener('input',renderList);
document.getElementById('sendBtn').addEventListener('click',sendMsg);
document.getElementById('botToggle').addEventListener('click',toggleBot);
document.getElementById('backBtn').addEventListener('click',closeChat);
document.getElementById('profClose').addEventListener('click',closeProfile);
document.querySelector('.ch-info').addEventListener('click',openProfile);
document.getElementById('chAv').addEventListener('click',openProfile);
document.querySelector('.ch-info').style.cursor='pointer';
document.addEventListener('click',function(e){
  if(!e.target.closest)return;
  var btn=e.target.closest('.aud-btn');
  if(btn){var box=btn.closest('.aud');if(box){toggleAud(box.getAttribute('data-aid'),box.getAttribute('data-url'));}return;}
  var tr=e.target.closest('.aud-track');
  if(tr){var b2=tr.closest('.aud');if(b2){var r=tr.getBoundingClientRect();seekAud(b2.getAttribute('data-aid'),b2.getAttribute('data-url'),(e.clientX-r.left)/r.width);}}
});
document.getElementById('micBtn').addEventListener('click',startRec);
document.getElementById('recSend').addEventListener('click',stopAndSend);
document.getElementById('recCancel').addEventListener('click',cancelRec);
document.getElementById('attachBtn').addEventListener('click',function(){document.getElementById('fileInput').click();});
document.getElementById('fileInput').addEventListener('change',function(e){var f=e.target.files&&e.target.files[0];if(f)sendFile(f);e.target.value='';});
var comp=document.getElementById('composer');
comp.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px';syncFoot();});
comp.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){if(document.getElementById('lightbox').style.display==='flex')closeImg();else if(document.getElementById('profile').classList.contains('open'))closeProfile();else if(document.body.classList.contains('chat-open'))closeChat();}});
window.addEventListener('hashchange',function(){var hh=location.hash.slice(1);if(hh){if(hh!==cur)openChat(hh);}else if(cur)closeChat();});
var chips=document.querySelectorAll('.chip');
for(var ci=0;ci<chips.length;ci++){chips[ci].addEventListener('click',function(){FILTER=this.getAttribute('data-f');for(var k=0;k<chips.length;k++)chips[k].classList.toggle('active',chips[k]===this);renderList();});}
applyDoodle();
if(window.matchMedia){try{window.matchMedia('(prefers-color-scheme: light)').addEventListener('change',applyDoodle);}catch(e){}}
if(cur)document.body.classList.add('chat-open');
syncFoot();load();setInterval(load,5000);
</script></body></html>`;
}

// ============================================================================
//  Webhook: recibe los mensajes de Meta
// ============================================================================
export async function startBot() {
  // El chequeo EN VIVO del token (usado por /salud cuando el cache de 10 min
  // vence) vive en cloud.js; se lo inyectamos a health.js así evitamos un
  // import circular entre los dos módulos.
  health.setTokenChecker(cloud.checkTokenLive);
  health.startHealthMonitor();

  const port = Number(process.env.PORT) || 8080;
  server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // Verificación del webhook (Meta hace un GET con un challenge al configurarlo).
    if (req.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token && token === ENV.WA_VERIFY_TOKEN) {
        console.log('✅ Webhook verificado por Meta.');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge || '');
      } else {
        console.warn('⚠️  Verificación de webhook rechazada (verify token no coincide).');
        res.writeHead(403).end('forbidden');
      }
      return;
    }

    // Mensajes entrantes (POST). Respondemos 200 YA y procesamos async: si tardás,
    // Meta reintenta y se duplican los mensajes.
    if (req.method === 'POST' && url.pathname === '/webhook') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.writeHead(200).end('ok');
        try {
          if (!cloud.verifySignature(raw, req.headers['x-hub-signature-256'])) {
            console.warn('⚠️  Webhook con firma inválida, lo ignoro.');
            return;
          }
          const body = JSON.parse(raw);
          processWebhook(body).catch((e) => console.error('processWebhook:', e?.message || e));
        } catch (e) {
          console.error('webhook parse:', e?.message || e);
        }
      });
      return;
    }

    // Panel web de conversaciones (protegido por clave): /panel?k=<PANEL_KEY>
    if (req.method === 'GET' && url.pathname === '/panel') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderPanel());
      return;
    }

    // Tablero del embudo (mismo PANEL_KEY): /embudo?k=<PANEL_KEY>
    if (req.method === 'GET' && url.pathname === '/embudo') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(embudoHTML(allLeads()));
      return;
    }

    // Datos del panel en JSON (mismo PANEL_KEY): /panel/data?k=<PANEL_KEY>
    if (req.method === 'GET' && url.pathname === '/panel/data') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(panelData()));
      return;
    }

    // Media de una conversación (imagen/audio/doc del lead o que vos enviaste): /panel/media?k=&id=
    if (req.method === 'GET' && url.pathname === '/panel/media') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      const id = String(url.searchParams.get('id') || '').replace(/[^A-Za-z0-9_\-=:.]/g, '');
      if (!id) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('falta id'); return; }
      serveMedia(id, res).catch((e) => {
        console.error('panel/media:', e?.message || e);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('media no disponible');
      });
      return;
    }

    // Enviar un mensaje COMO Martín desde el panel (verbatim, sin humanize). Es un handoff: el
    // lead pasa a 'human' y el bot deja de responderle, para no pisarse con vos (evita el doble-mensaje
    // que ya trajo un ban). Reactivás el bot con el botón del panel (/admin/mute?on=0).
    if (req.method === 'POST' && url.pathname === '/panel/send') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const fail = (code, msg) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: msg }));
        let bodyJson;
        try { bodyJson = JSON.parse(raw || '{}'); } catch { return fail(400, 'json invalido'); }
        if (!ENV.PANEL_KEY || bodyJson.k !== ENV.PANEL_KEY) return fail(403, 'forbidden');
        const num = String(bodyJson.num || '').replace(/\D/g, '');
        const text = String(bodyJson.msg || '').trim();
        const key = last10(num);
        const lead = key && getLead(key);
        if (!lead) return fail(404, 'lead no encontrado');
        if (!text) return fail(400, 'mensaje vacio');
        // Ventana de 24h: si el lead no te escribió en las últimas 24h, la Cloud API rechaza el texto
        // libre (no llega). Te avisamos ANTES en vez de hacerte creer que salió.
        if (lead.lastInboundAt && Date.now() - lead.lastInboundAt > 24 * 3600 * 1000) {
          const hrs = Math.round((Date.now() - lead.lastInboundAt) / 3600000);
          return fail(409, `Este lead no te escribe hace ~${hrs}h (+24h). WhatsApp no deja mandar texto libre fuera de esa ventana, NO le va a llegar. Necesitás que el lead te escriba primero (o una plantilla aprobada de Meta).`);
        }
        try {
          await cloud.sendText(lead.number, text);
          const now = Date.now();
          updateLead(key, {
            history: [...(lead.history || []), { role: 'assistant', content: text, ts: now, via: 'human' }],
            lastBotAt: now,
            status: 'human',
            unqualified: false,
            replyDueAt: null, nextFollowupAt: null, scheduledMsg: null,
          });
          crmSync(key);
          console.log(`✍️  manual (panel) -> ${lead.number}: "${text.slice(0, 60)}"`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('panel/send:', e?.message || e);
          fail(500, e?.message || 'fallo el envio');
        }
      });
      return;
    }

    // Mandar una PLANTILLA aprobada desde el panel (para cuando la charla está cerrada, +24 h).
    // Solo las de PANEL_TEMPLATES. Es un handoff igual que el texto. Body JSON: {k,num,name}.
    if (req.method === 'POST' && url.pathname === '/panel/sendtemplate') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const fail = (code, msg) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: msg }));
        let bodyJson;
        try { bodyJson = JSON.parse(raw || '{}'); } catch { return fail(400, 'json invalido'); }
        if (!ENV.PANEL_KEY || bodyJson.k !== ENV.PANEL_KEY) return fail(403, 'forbidden');
        const name = String(bodyJson.name || '');
        if (!PANEL_TEMPLATES.includes(name)) return fail(400, 'plantilla no permitida');
        const key = last10(String(bodyJson.num || '').replace(/\D/g, ''));
        const lead = key && getLead(key);
        if (!lead) return fail(404, 'lead no encontrado');
        const params = [nombreOSaludo(lead)];
        if (PANEL_TEMPLATE_PARAM[name]) {
          const extra = String(bodyJson.extra || '').trim().slice(0, 60);
          if (!extra) return fail(400, 'falta el dato: ' + PANEL_TEMPLATE_PARAM[name]);
          params.push(extra);
        }
        const ok = await sendTemplateTo(lead, name, params);
        if (!ok) return fail(502, 'Meta rechazó la plantilla (revisá que esté aprobada)');
        const now = Date.now();
        updateLead(key, {
          history: [...(lead.history || []), { role: 'assistant', content: tplText(name, params), ts: now, via: 'human' }],
          lastBotAt: now, status: 'human', replyDueAt: null, nextFollowupAt: null, scheduledMsg: null,
        });
        crmSync(key);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true }));
      });
      return;
    }

    // Enviar un PDF al lead desde el panel (lo sube a Meta y lo manda como documento). Mismo handoff
    // a 'human' y misma ventana de 24h que el texto. Body JSON: {k,num,filename,caption,dataB64}.
    if (req.method === 'POST' && url.pathname === '/panel/senddoc') {
      let size = 0, tooBig = false; const parts = [];
      req.on('data', (c) => { size += c.length; if (size > 25 * 1024 * 1024) tooBig = true; else parts.push(c); });
      req.on('end', async () => {
        const fail = (code, msg) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: msg }));
        if (tooBig) return fail(413, 'el PDF es muy grande (máx ~18MB)');
        let body;
        try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { return fail(400, 'json invalido'); }
        if (!ENV.PANEL_KEY || body.k !== ENV.PANEL_KEY) return fail(403, 'forbidden');
        const num = String(body.num || '').replace(/\D/g, '');
        const key = last10(num);
        const lead = key && getLead(key);
        if (!lead) return fail(404, 'lead no encontrado');
        const b64 = String(body.dataB64 || '');
        if (!b64) return fail(400, 'pdf vacio');
        if (lead.lastInboundAt && Date.now() - lead.lastInboundAt > 24 * 3600 * 1000) {
          const hrs = Math.round((Date.now() - lead.lastInboundAt) / 3600000);
          return fail(409, `Este lead no te escribe hace ~${hrs}h (+24h): WhatsApp no deja mandar archivos fuera de esa ventana. Necesitás que escriba primero.`);
        }
        const filename = (String(body.filename || 'documento.pdf').replace(/[\r\n"]/g, '').slice(0, 120)) || 'documento.pdf';
        const caption = String(body.caption || '').slice(0, 1024);
        // Mime: lo que mande el cliente o lo inferimos del nombre. Si es imagen -> la mandamos como
        // imagen (se ve en el chat); si no, como documento (tarjeta de archivo).
        const guessed = /\.(jpe?g)$/i.test(filename) ? 'image/jpeg'
          : /\.png$/i.test(filename) ? 'image/png'
          : /\.webp$/i.test(filename) ? 'image/webp'
          : /\.pdf$/i.test(filename) ? 'application/pdf'
          : 'application/octet-stream';
        const mime = /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(String(body.mime || '')) ? body.mime : guessed;
        const isImg = /^image\//.test(mime);
        try {
          const buf = Buffer.from(b64, 'base64');
          if (!buf.length) return fail(400, 'archivo invalido');
          const mediaId = await cloud.uploadMedia(buf, mime, filename);
          if (isImg) await cloud.sendImage(lead.number, mediaId, caption);
          else await cloud.sendDocument(lead.number, mediaId, filename, caption);
          const now = Date.now();
          updateLead(key, {
            history: [...(lead.history || []), {
              role: 'assistant',
              content: isImg ? '[le enviaste una imagen]' : `📎 ${filename}${caption ? ' — ' + caption : ''}`,
              ts: now, via: 'human',
              media: { type: isImg ? 'image' : 'document', id: mediaId, mime, filename, caption },
            }],
            lastBotAt: now, status: 'human', unqualified: false,
            replyDueAt: null, nextFollowupAt: null, scheduledMsg: null,
          });
          crmSync(key);
          console.log(`📎 ${isImg ? 'imagen' : 'archivo'} (panel) -> ${lead.number}: ${filename}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('panel/senddoc:', e?.message || e);
          fail(500, e?.message || 'fallo el envio del pdf');
        }
      });
      return;
    }

    // Enviar una NOTA DE VOZ al lead desde el panel: el navegador graba (webm/mp4), acá la transcodeamos
    // a ogg/opus (único formato que acepta la Cloud API como nota de voz), la subimos y la mandamos.
    // Mismo handoff a 'human' y misma ventana de 24h. Body JSON: {k,num,dataB64}.
    if (req.method === 'POST' && url.pathname === '/panel/sendaudio') {
      let size = 0, tooBig = false; const parts = [];
      req.on('data', (c) => { size += c.length; if (size > 25 * 1024 * 1024) tooBig = true; else parts.push(c); });
      req.on('end', async () => {
        const fail = (code, msg) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: msg }));
        if (tooBig) return fail(413, 'el audio es muy grande');
        let body;
        try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { return fail(400, 'json invalido'); }
        if (!ENV.PANEL_KEY || body.k !== ENV.PANEL_KEY) return fail(403, 'forbidden');
        const num = String(body.num || '').replace(/\D/g, '');
        const key = last10(num);
        const lead = key && getLead(key);
        if (!lead) return fail(404, 'lead no encontrado');
        const b64 = String(body.dataB64 || '');
        if (!b64) return fail(400, 'audio vacio');
        if (lead.lastInboundAt && Date.now() - lead.lastInboundAt > 24 * 3600 * 1000) {
          const hrs = Math.round((Date.now() - lead.lastInboundAt) / 3600000);
          return fail(409, `Este lead no te escribe hace ~${hrs}h (+24h): WhatsApp no deja mandar audios fuera de esa ventana. Necesitás que escriba primero.`);
        }
        try {
          const raw = Buffer.from(b64, 'base64');
          if (!raw.length) return fail(400, 'audio invalido');
          const ogg = await transcodeToOggOpus(raw);
          const mediaId = await cloud.uploadMedia(ogg, 'audio/ogg', 'voz.ogg');
          await cloud.sendAudio(lead.number, mediaId);
          const now = Date.now();
          updateLead(key, {
            history: [...(lead.history || []), {
              role: 'assistant', content: '[le enviaste una nota de voz]', ts: now, via: 'human',
              media: { type: 'audio', id: mediaId, mime: 'audio/ogg', filename: 'voz.ogg' },
            }],
            lastBotAt: now, status: 'human', unqualified: false,
            replyDueAt: null, nextFollowupAt: null, scheduledMsg: null,
          });
          crmSync(key);
          console.log(`🎤 nota de voz (panel) -> ${lead.number}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('panel/sendaudio:', e?.message || e);
          fail(500, e?.message || 'fallo el envio del audio');
        }
      });
      return;
    }

    // Programar un mensaje one-off como el bot: /admin/sched?k=KEY&num=...&at=<ISO>&msg=...
    if (req.method === 'GET' && url.pathname === '/admin/sched') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      const num = String(url.searchParams.get('num') || '').replace(/\D/g, '');
      const at = Date.parse(url.searchParams.get('at') || '');
      const msg = url.searchParams.get('msg') || '';
      const key = last10(num);
      const lead = key && getLead(key);
      if (!lead) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('lead no encontrado'); return; }
      if (!msg || !Number.isFinite(at)) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('faltan msg o at validos'); return; }
      updateLead(key, { scheduledMsg: { text: msg, at } });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`OK · programado para ${new Date(at).toISOString()}\n${msg}`);
      return;
    }

    // Corregir el horario agendado de un lead (tras mover la call a mano): /admin/booking?k=&num=&startIso=&when=
    if (req.method === 'GET' && url.pathname === '/admin/booking') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      const num = String(url.searchParams.get('num') || '').replace(/\D/g, '');
      const key = last10(num);
      const lead = key && getLead(key);
      if (!lead) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('lead no encontrado'); return; }
      const startIso = url.searchParams.get('startIso') || lead.bookedStartIso;
      const when = url.searchParams.get('when') || lead.bookedWhen;
      updateLead(key, { status: 'booked', bookedStartIso: startIso, bookedWhen: when, remindersSent: [] });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`OK booking -> ${when} (${startIso})`);
      return;
    }

    // Resultados del A/B de horario de follow-ups: /admin/fustats?k=<PANEL_KEY>
    if (req.method === 'GET' && url.pathname === '/admin/fustats') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      const s = bandit.getFollowupHourStats();
      const rows = Object.keys(s).sort((a, b) => +a - +b).map((h) => {
        const { sent = 0, resp = 0 } = s[h];
        return `${h}hs: ${resp}/${sent} respondieron (${sent ? Math.round((resp / sent) * 100) : 0}%)`;
      });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('A/B horario de follow-ups:\n' + (rows.join('\n') || '(sin datos todavía)'));
      return;
    }

    // Silenciar / reactivar un lead (el bot deja de responderle): /admin/mute?k=&num=&on=1
    // Borra un lead para volver a probar el bot desde cero: /admin/reset?k=<PANEL_KEY>&num=<número>
    if (req.method === 'GET' && url.pathname === '/admin/reset') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      const key = last10(String(url.searchParams.get('num') || '').replace(/\D/g, ''));
      const ok = key && deleteLead(key);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(ok ? 'borrado: la próxima vez que escriba arranca de cero' : 'lead no encontrado');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/mute') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      const num = String(url.searchParams.get('num') || '').replace(/\D/g, '');
      const key = last10(num);
      const lead = key && getLead(key);
      if (!lead) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('lead no encontrado'); return; }
      const on = url.searchParams.get('on') !== '0';
      if (on) updateLead(key, { status: 'human', replyDueAt: null, nextFollowupAt: null, scheduledMsg: null });
      else updateLead(key, { status: 'engaged', unqualified: false });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(on ? `silenciado: el bot ya no le responde a ${lead.name || num}` : `reactivado: ${lead.name || num}`);
      return;
    }

    // Limpiar la marca "no califica" (falsos positivos): /admin/qualify?k=&num=<n> ó num=all
    if (req.method === 'GET' && url.pathname === '/admin/qualify') {
      if (!ENV.PANEL_KEY || url.searchParams.get('k') !== ENV.PANEL_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
        return;
      }
      const numRaw = String(url.searchParams.get('num') || '');
      if (numRaw === 'all') {
        let n = 0;
        for (const l of allLeads()) {
          if (l.unqualified) { updateLead(last10(String(l.number || '').replace(/\D/g, '')), { unqualified: false }); n++; }
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`OK · limpié la marca "no califica" en ${n} leads`);
        return;
      }
      const num = numRaw.replace(/\D/g, '');
      const key = last10(num);
      const lead = key && getLead(key);
      if (!lead) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('lead no encontrado'); return; }
      updateLead(key, { unqualified: false });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`OK · ${lead.name || num} ya no figura como no-califica`);
      return;
    }

    // Salud de verdad: pensado para que le pegue un latido externo (cron-job.org,
    // Apps Script) SIN credenciales, así que el endpoint queda público en el
    // sentido de "no requiere clave" — pero sin PANEL_KEY correcta solo devuelve
    // el campo "ok" y el código de estado, nunca leads_activos ni el detalle del
    // error (eso es información del negocio). Con ?k=<PANEL_KEY> (la misma que
    // usa /panel/data) devuelve el reporte completo. Devuelve 503 si el token de
    // WhatsApp está vencido/rechazado o si no se puede escribir a disco; 200 en
    // cualquier otro caso (incluido "no sé, no hay evidencia de que esté roto").
    if (req.method === 'GET' && url.pathname === '/salud') {
      health
        .buildSaludReport()
        .then((data) => {
          const autorizado = ENV.PANEL_KEY && url.searchParams.get('k') === ENV.PANEL_KEY;
          const body = autorizado ? data : { ok: data.ok };
          res.writeHead(data.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(body, null, 2));
        })
        .catch((e) => {
          const autorizado = ENV.PANEL_KEY && url.searchParams.get('k') === ENV.PANEL_KEY;
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(autorizado ? { ok: false, error: `salud check falló: ${e?.message || e}` } : { ok: false }));
        });
      return;
    }

    // Healthcheck / raíz.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('whatsapp ai sales agent (cloud api) ok');
      return;
    }

    res.writeHead(404).end('not found');
  });

  server.listen(port, () => {
    console.log(`🌐 Webhook escuchando en el puerto ${port} (ruta /webhook).`);
    console.log(`   Verify token: ${ENV.WA_VERIFY_TOKEN}`);
  });

  if (!ENV.WA_TOKEN || !ENV.WA_PHONE_NUMBER_ID) {
    console.log('⚠️  Faltan WA_TOKEN / WA_PHONE_NUMBER_ID — el bot recibe pero NO va a poder responder hasta cargarlos.');
  } else {
    console.log(`📞 Enviando como Phone Number ID ${ENV.WA_PHONE_NUMBER_ID} (Graph ${ENV.GRAPH_VERSION}).`);
  }
  return server;
}

// Mapea el bloque `referral` de un mensaje de Click-to-WhatsApp al formato `ad`.
function mapReferral(ref) {
  if (!ref) return null;
  return {
    title: String(ref.headline || '').slice(0, 200),
    body: String(ref.body || '').slice(0, 300),
    sourceId: ref.source_id || '',
    sourceUrl: ref.source_url || '',
    sourceType: ref.source_type || '',
    // ctwa_clid: el id UNICO DEL CLIC que Meta genera en cada toque sobre un
    // anuncio de Click-to-WhatsApp. `source_id` identifica el ANUNCIO; esto
    // identifica el clic, y es lo unico que permite devolverle a Meta la
    // conversion cuando esa charla termina en venta (API de Conversiones).
    // Hasta el 2026-08-25 se descartaba: se sabia de que anuncio venia el lead
    // pero no se podia cerrar el circuito hasta la venta. Ver la spec de medición §6.3.
    ctwaClid: ref.ctwa_clid || '',
  };
}

// Normaliza un mensaje del webhook a { id, from, name, type, text, caption, ad, audioId, media }.
// `text` es la pista para el cerebro (caption real o un marcador). `caption` es solo el epígrafe
// que escribió el lead. `media` ({type,id,mime,filename}) deja que el panel muestre la media real.
function parseMessage(m, name) {
  const out = { id: m.id, from: m.from, name, type: m.type, text: '', caption: '', ad: mapReferral(m.referral), audioId: null, media: null };
  const mediaOf = (o, type) => (o && o.id ? { type, id: o.id, mime: o.mime_type || '', filename: o.filename || '' } : null);
  switch (m.type) {
    case 'text':
      out.text = m.text?.body || '';
      break;
    case 'button':
      out.text = m.button?.text || '';
      break;
    case 'interactive':
      out.text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
      break;
    case 'image':
      out.caption = m.image?.caption || '';
      out.text = out.caption || '[el lead mandó una imagen]';
      out.media = mediaOf(m.image, 'image');
      break;
    case 'sticker':
      out.text = '[el lead mandó un sticker]';
      out.media = mediaOf(m.sticker, 'sticker');
      break;
    case 'video':
      out.caption = m.video?.caption || '';
      out.text = out.caption || '[el lead mandó un video]';
      out.media = mediaOf(m.video, 'video');
      break;
    case 'document':
      out.caption = m.document?.caption || '';
      out.text = out.caption || `[el lead mandó un documento${m.document?.filename ? ': ' + m.document.filename : ''}]`;
      out.media = mediaOf(m.document, 'document');
      break;
    case 'audio':
    case 'voice':
      out.audioId = m.audio?.id || m.voice?.id || null;
      out.text = '[el lead te mandó un audio y por ahora no lo podés escuchar; pedile corto y al toque que te lo escriba por texto, sin muletillas]';
      out.media = mediaOf(m.audio || m.voice, 'audio');
      break;
    default:
      out.text = '';
  }
  return out;
}

// Marca/limpia en el lead si Meta NO pudo entregar el último mensaje (típicamente 131047 = fuera de
// la ventana de 24h). El panel lo usa para mostrarte un ⚠️ rojo en vez de hacerte creer que salió.
function flagSendFailed(recipientId, errors) {
  const key = last10(String(recipientId || '').replace(/\D/g, ''));
  const lead = key && getLead(key);
  if (!lead) return;
  const err = Array.isArray(errors) ? errors[0] : errors;
  const code = err?.code || 0;
  const detail = String(err?.error_data?.details || err?.message || err?.title || 'falló la entrega');
  const win24 = code === 131047 || code === 131051 || /24\s*hours|re-?engagement/i.test(detail);
  updateLead(key, { lastSendFailed: { at: Date.now(), code, win24, detail: detail.slice(0, 160) } });
}
function clearSendFailed(recipientId) {
  const key = last10(String(recipientId || '').replace(/\D/g, ''));
  const lead = key && getLead(key);
  if (lead && lead.lastSendFailed) updateLead(key, { lastSendFailed: null });
}

async function processWebhook(body) {
  if (body.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // Estados de entrega (sent/delivered/read/FAILED). Logueamos las fallas con el motivo y las
      // marcamos en el lead (para el ⚠️ del panel); un delivered/read posterior limpia la marca.
      if (Array.isArray(value.statuses)) {
        for (const s of value.statuses) {
          if (s.status === 'failed') {
            console.error(`📛 ENTREGA FALLÓ a ${s.recipient_id}: ${JSON.stringify(s.errors || {})}`);
            flagSendFailed(s.recipient_id, s.errors);
          } else {
            console.log(`📨 estado "${s.status}" -> ${s.recipient_id}`);
            if (s.status === 'delivered' || s.status === 'read') clearSendFailed(s.recipient_id);
          }
        }
      }
      // Solo procesamos como conversación los webhooks que traen mensajes entrantes.
      if (!Array.isArray(value.messages)) continue;
      const nameByWaId = {};
      for (const c of value.contacts || []) nameByWaId[c.wa_id] = c.profile?.name || '';
      for (const m of value.messages) {
        if (alreadySeen(m.id)) continue;
        const parsed = parseMessage(m, nameByWaId[m.from] || '');
        try {
          await handleIncoming(parsed);
        } catch (e) {
          console.error('Error procesando mensaje:', e?.message || e);
        }
      }
    }
  }
}

// Ventana de "agrupado": tras el ÚLTIMO mensaje del lead esperamos esto antes de responder,
// para juntar mensajes sueltos y no contestar a fragmentos. Se resetea con cada mensaje nuevo.
const BUNCH_WINDOW_MS = (Number(process.env.BUNCH_WINDOW_SEG) || 40) * 1000;

// el mensaje es solo una cortesía/confirmación corta (para no loopear tras agendar)
function isTrivialAck(t) {
  let s = String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return true; // emoji/sticker solo
  if (s.split(' ').length > 4) return false; // 5+ palabras: ya no es un simple "ok"
  return /^(ok|oka+|okey|okay|dale|dale\s+gracias|listo|perfecto|barbaro|buenisimo|genial|joya|de\s*10|gracias+|muchas\s+gracias|mil\s+gracias|de\s+nada|nos\s+vemos|nos\s+vemos\s+manana|ahi\s+nos\s+vemos|ahi\s+estare|ahi\s+estoy|ahi\s+ando|hasta\s+manana|hasta\s+luego|nos\s+hablamos|saludos|si|sisi+|sii+|va|vale|tas|copado|listo\s+gracias|perfecto\s+gracias|ok\s+gracias|dale\s+listo)$/.test(s);
}

// OPT-OUT DURO: el lead pide explícitamente que no le escribamos más. Si matchea, frenamos TODO
// (respuestas, follow-ups, recordatorios) y no le volvemos a escribir nunca. Es lo que corta el
// círculo reporte/bloqueo -> ban del número. Mejor pasarse de frenar que quedarse corto.
function isOptOut(t) {
  let s = String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/(no|dej[ae]|dejen|dejame|dejenme|par[ae]|para)\s+(me\s+|de\s+)?(escrib|molest|contact|jod|insist|mand|llam)/.test(s)) return true;
  if (/no\s+me\s+(escrib|contact|molest|jod|mand|llam)/.test(s)) return true;
  if (/\b(sacame|bajame|borrame|eliminame|removeme)\b/.test(s)) return true;
  if (/\b(borra|elimina|saca|baja)\w*\b.*\b(numero|lista|contacto|base|difusion)\b/.test(s)) return true;
  if (/\b(basta|stop|unsubscribe|desuscrib|spam|denunci|reportar|reporto)\b/.test(s)) return true;
  if (/no\s+quiero\s+(que\s+me\s+)?(escrib|contact|mand|llam|nada|saber|recib)/.test(s)) return true;
  if (/no\s+me\s+interesa/.test(s) && s.split(/\s+/).length <= 6 &&
      !/(horario|hora|dia|manana|tarde|noche|lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|ese|este)/.test(s)) return true;
  return false;
}

// El bot puede ABSTENERSE de un follow-up: si el lead no es público objetivo, el cerebro devuelve
// el sentinel __SKIP__ (ver FOLLOWUP_DIRECTIVE). Además atajamos por las dudas el caso en que se le
// escape el razonamiento interno como si fuera un "mensaje" (tercera persona sobre el lead), para
// que ESO NUNCA llegue al lead. Un mensaje real va en 2da persona ("tu negocio", "vos"); hablar del
// lead en 3ra ("este lead no es público objetivo") es razonamiento filtrado, no un mensaje.
const META_LEAK_RE = /(\beste lead\b)|(\bel lead\b[^?]*\bno\b)|(no es (el |nuestro )?p[uú]blico objetivo)|(no tiene sentido mandarle)|(mandarle un recordatorio)|(no tiene ning[uú]n negocio)/i;
function shouldSkipFollowup(text) {
  const t = String(text || '').trim();
  if (/__SKIP__/i.test(t)) return true;     // el cerebro pidió abstenerse explícitamente
  if (/^_*skip_*$/i.test(t)) return true;   // variantes (SKIP, _skip_)
  if (META_LEAK_RE.test(t)) return true;    // se le escapó el razonamiento: NO lo mandamos al lead
  return false;
}

// el mensaje es un AUTORESPONDER de empresa ("gracias por contactarnos, un asesor te responderá a la
// brevedad", "mensaje automático", "fuera de horario")? Si lo es, el "lead" es OTRO bot: NO le
// contestamos (contestarle arma un loop bot-a-bot y nos delata como automatizados).
const AUTOREPLY_RE = /(mensaje|respuesta)\s+autom[aá]tic|asesor(?:\s+comercial|\s+de\s+ventas)?\s+(?:te\s+|le\s+)?(?:responder|atender|contactar|comunicar|se\s+comunicar)|(?:te\s+|les?\s+)?responder[eé]?(?:mos|[aá]n|[aá])?\s+(?:a\s+la\s+brevedad|en\s+breve|a\s+la\s+mayor\s+brevedad|lo\s+antes\s+posible)|gracias\s+por\s+(?:ponerte\s+en\s+contacto|contactarnos|comunicart|escribirnos|tu\s+mensaje|tu\s+consulta)|fuera\s+(?:de|del)\s+(?:horario|nuestro\s+horario)|horario\s+de\s+atenci[oó]n|a\s+la\s+brevedad\s+posible|este\s+es\s+un\s+mensaje\s+autom/i;
function isAutoReply(text) {
  return AUTOREPLY_RE.test(String(text || ''));
}

// ============================================================================
//  Flujo principal de un mensaje entrante (misma lógica que con Baileys)
// ============================================================================
async function handleIncoming(parsed) {
  if (shuttingDown) return;
  if (ENV.BOT_PAUSED) {
    console.log(`📩 (PAUSADO) recibí un mensaje de ${String(parsed.from || '').replace(/\D/g, '')}: "${String(parsed.text || '').slice(0, 60)}" — llegó OK, NO respondo (BOT_PAUSED=1).`);
    return;
  }

  const number = String(parsed.from || '').replace(/\D/g, '');
  if (!number) return;
  const key = last10(number);
  if (!key) return;
  let text = parsed.text || '';
  const pushName = parsed.name || '';

  // Si es un audio y STT está activo, lo transcribimos y usamos el texto.
  if (parsed.audioId && ENV.STT) {
    try {
      const mediaUrl = await cloud.getMediaUrl(parsed.audioId);
      const buf = mediaUrl ? await cloud.downloadMedia(mediaUrl) : null;
      const t = buf ? await transcribe(buf) : '';
      if (t) {
        text = t;
        console.log(`🎙️ ${number} audio -> "${t.slice(0, 80)}"`);
      } else {
        console.log(`🎙️ ${number} audio sin transcripción (vacío)`);
      }
    } catch (e) {
      console.error('stt error:', e?.message || e);
    }
  }

  // Si vino un audio y no pudimos sacar texto (STT off o falló), avisamos al cerebro para que
  // pida el texto con buena onda, en vez de responder a un mensaje vacío.
  if (parsed.audioId && !String(text || '').trim()) {
    text = '[nota interna del sistema, no es un mensaje del lead] el lead mandó un audio que no se pudo transcribir, pedile con buena onda que te lo escriba en un mensaje, sin hacer drama';
  }

  await withLock(key, async () => {
    if (shuttingDown || ENV.BOT_PAUSED) return;
    const now = Date.now();
    const hour = localHour(now);
    let lead = getLead(key);

    // Media entrante (imagen/audio/doc/video del lead): la guardamos en la entrada del historial para
    // que el panel la muestre. El cerebro no la ve (brain.js solo manda {role,content}).
    const mediaMeta = parsed.media && parsed.media.id ? { ...parsed.media, caption: parsed.caption || '' } : null;
    const umsg = (content) => (mediaMeta ? { role: 'user', content, ts: now, media: mediaMeta } : { role: 'user', content, ts: now });

    // Si la charla la tomó un humano, el bot NO responde, pero IGUAL guardamos lo que el lead
    // escribe (si no, Martín queda ciego en el panel y cree que el lead lo ignoró / no-show).
    if (lead && lead.status === 'human') {
      updateLead(key, {
        lastInboundAt: now,
        lastMsgId: parsed.id,
        unqualified: false,
        inboundHours: bumpHours(lead.inboundHours, hour),
        history: [...(lead.history || []), umsg(text)],
      });
      console.log(`📥 [human/${lead.name || number}] ${text.slice(0, 80)} (guardado, el bot no responde)`);
      return;
    }

    // OPT-OUT: si el lead YA está fuera (pidió que no le escribamos), guardamos lo que diga pero NO
    // respondemos ni reactivamos nada. Estado terminal.
    if (lead && lead.optOut) {
      updateLead(key, { lastInboundAt: now, lastMsgId: parsed.id, history: [...(lead.history || []), umsg(text)] });
      cloud.markRead(parsed.id);
      console.log(`🔕 [optout/${lead.name || number}] ${text.slice(0, 60)} (fuera, no respondo)`);
      return;
    }

    // OPT-OUT DURO (nuevo): el lead pide que no le escribamos más -> frenamos TODO y NO le contestamos
    // nada (ni siquiera una despedida). Estado terminal, nunca más follow-ups/recordatorios/respuestas.
    if (lead && isOptOut(text)) {
      updateLead(key, {
        status: 'lost', optOut: true,
        cancelled: lead.status === 'booked' ? true : !!lead.cancelled,
        nextFollowupAt: null, replyDueAt: null, scheduledMsg: null, openerDueAt: null, pendingOpener: null,
        lastInboundAt: now, lastMsgId: parsed.id,
        history: [...(lead.history || []), umsg(text)],
      });
      cloud.markRead(parsed.id);
      console.log(`🛑 ${number} pidió opt-out ("${text.slice(0, 40)}") — freno TODO, NO le contesto nada.`);
      return;
    }

    // PRIMER contacto: preparamos el opener (A/B) y lo MANDAMOS tras un delay (~5 min),
    // para parecer una persona. Lo dispara el scheduler.
    if (!lead) {
      if (isOptOut(text)) { console.log(`🛑 ${number} arrancó con un opt-out, no lo engancho.`); return; }
      // SOLO enganchamos leads que vengan de un anuncio (Click-to-WhatsApp). Si el
      // primer mensaje no trae el bloque `referral` del aviso de Meta, NO es lead
      // nuestro: lo ignoramos. (Para probar con el número de test, poné AD_ONLY=0.)
      if (ENV.AD_ONLY && !parsed.ad) {
        console.log(`🚫 ${number} escribió sin venir de un anuncio — lo ignoro (AD_ONLY).`);
        return;
      }
      const variant = bandit.pickOpenerVariant() || OPENER_VARIANTS[0];
      const ad = parsed.ad && (parsed.ad.title || parsed.ad.body) ? parsed.ad : null;
      const openerAudio = variant.audio && hasAudio(variant.audio) ? variant.audio : null;
      let openerText = '';
      if (ENV.PERSONALIZED_OPENER && ENV.ANTHROPIC_API_KEY) {
        try {
          openerText = await generateOpener({ name: pushName, ad }, variant, { primero: text, conAudio: !!openerAudio });
        } catch (e) {
          console.error('opener personalizado falló, uso template:', e?.message || e);
        }
      }
      // Sin audio, la variante "audio" no se presenta: se usa el respaldo de texto completo.
      if (!openerText && variant.audio && !openerAudio) {
        const tv = OPENER_VARIANTS.find((v) => !v.audio);
        if (tv) openerText = tv.globos.map((g) => fillName(g, pushName)).join('\n');
      }
      if (!openerText) openerText = variant.globos.map((g) => fillName(g, pushName)).join('\n');
      const delaySeg = ENV.INSTANT ? 0 : (ENV.OPENER_DELAY_SEG ?? randomIntInclusive(SETTINGS.openerDelay.minSeg, SETTINGS.openerDelay.maxSeg));
      console.log(`🆕 Lead nuevo ${number} (${pushName || 's/n'}) — opener ${variant.id}${parsed.ad ? ' +anuncio' : ''} en ${delaySeg}s.`);
      createLead(key, {
        jid: number, number, name: pushName, status: 'opening', ad: parsed.ad || null,
        lastMsgId: parsed.id,
        history: [umsg(text || '[el lead inició la conversación]')],
        openedAt: now, lastInboundAt: now,
        followupCount: 0, inboundHours: bumpHours({}, hour), openerVariant: variant.id,
        pendingOpener: openerText, openerDueAt: now + delaySeg * 1000, openerAudio,
        abBotones: Math.random() < 0.5, // A/B: botones en los horarios sí o no (lo mide /embudo)
      });
      crmSync(key);
      return;
    }

    // El opener todavía no salió (esperando el delay): guardamos lo que escriba el
    // lead como contexto, pero NO respondemos hasta mandar el opener.
    if (lead.status === 'opening') {
      updateLead(key, {
        lastInboundAt: now,
        lastMsgId: parsed.id,
        inboundHours: bumpHours(lead.inboundHours, hour),
        history: [...(lead.history || []), umsg(text)],
      });
      return;
    }

    // YA hay hilo. NO respondemos al toque: juntamos lo que el lead va escribiendo y
    // respondemos cuando DEJA de escribir (debounce ~40s), para no contestar a fragmentos
    // ni adelantarnos a que termine la idea. La respuesta la dispara el scheduler (handleDueReply).
    console.log(`📥 ${number}: ${text.slice(0, 80)}`);
    const wasBooked = lead.status === 'booked';

    // Autoresponder de empresa: el "lead" es OTRO bot ("un asesor te responderá a la brevedad"). Lo
    // guardamos como contexto pero NO respondemos: evita un loop bot-a-bot y que nos delatemos.
    if (isAutoReply(text)) {
      updateLead(key, {
        lastInboundAt: now, lastMsgId: parsed.id, unqualified: false,
        history: [...(lead.history || []), umsg(text)],
      });
      cloud.markRead(parsed.id);
      console.log(`🤖↔️ ${number} mandó un autoresponder de empresa, no respondo (evito loop bot-a-bot)`);
      return;
    }

    // Si ya agendó y solo manda una cortesía ("ok/dale/gracias/nos vemos"), NO respondemos.
    if (wasBooked && isTrivialAck(text)) {
      updateLead(key, { lastInboundAt: now, lastMsgId: parsed.id });
      cloud.markRead(parsed.id);
      console.log(`🤝 ${number} ya agendó y mandó un ack ("${text.slice(0, 24)}") — no respondo, corto el loop.`);
      return;
    }

    // si veníamos de un follow-up, este mensaje del lead ES la respuesta → A/B de horario
    if (lead.lastFollowupHour != null) bandit.recordFollowupResponse(lead.lastFollowupHour);

    // acumulamos el mensaje y (re)programamos la respuesta ~40s DESPUÉS del último mensaje.
    // si llega otro mensaje antes, este updateLead corre de nuevo y reprograma (resetea el debounce).
    updateLead(key, {
      lastInboundAt: now, lastMsgId: parsed.id, name: lead.name || pushName,
      unqualified: false, lastSendFailed: null,
      inboundHours: bumpHours(lead.inboundHours, hour),
      history: [...(lead.history || []), umsg(text)],
      replyDueAt: now + BUNCH_WINDOW_MS,
      lastFollowupHour: null,
    });
    // Visto humano: NO marcamos leído al instante (delata al bot). Con INSTANT=0 esperamos el
    // readDelay (~10-20s) sin bloquear el lock; con INSTANT=1 (test rápido) se marca al toque.
    const readMs = dly(SETTINGS.readDelay) * 1000;
    if (readMs > 0) setTimeout(() => cloud.markRead(parsed.id), readMs);
    else cloud.markRead(parsed.id);
  });
}

// --- Respuesta "debounced": el lead dejó de escribir, ahora SÍ respondemos (a TODO junto) ---
//  La dispara el scheduler cuando replyDueAt venció (el lead estuvo callado ~40s).
export async function handleDueReply(leadArg) {
  const key = leadArg.key;
  await withLock(key, async () => {
    if (shuttingDown || ENV.BOT_PAUSED) return;
    let lead = getLead(key);
    if (!lead || !lead.replyDueAt || lead.replyDueAt > Date.now()) return; // se reprogramó: aún escribe
    if (lead.status === 'human' || lead.status === 'opening') { updateLead(key, { replyDueAt: null }); return; }
    const now = Date.now();
    updateLead(key, { replyDueAt: null }); // limpiamos PRIMERO para no responder dos veces
    lead = getLead(key);
    const wasBooked = lead.status === 'booked';

    const confirmAudio = hasAudio('confirmacion');
    let result;
    try {
      result = await converse(lead, { userText: null, booked: wasBooked, hasConfirmAudio: confirmAudio });
    } catch (e) {
      console.error('converse(due) error:', e?.message || e);
      return;
    }

    const lastUserText = [...(lead.history || [])].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')?.content || '';
    let nextFu = wasBooked ? null : nextFollowupAt({ ...lead, followupCount: 0 });
    if (nextFu && wantsLater(lastUserText)) {
      nextFu = Math.max(nextFu, clampToActiveHours(now + 8 * 3600 * 1000));
    }
    const patch = {
      history: result.messages,
      status: wasBooked ? 'booked' : 'engaged',
      lastBotAt: Date.now(),
      followupCount: 0,
      tplCount: 0,
      nextFollowupAt: nextFu,
    };
    const withAudio = !!(result.booking && confirmAudio);
    if (withAudio) patch.history = [...result.messages, { role: 'assistant', content: audioNote('confirmacion'), ts: Date.now() }];
    if (result.booking) {
      patch.status = 'booked';
      patch.bookedAt = Date.now();
      patch.eventId = result.booking.eventId;
      patch.bookedWhen = result.booking.when;
      patch.bookedStartIso = result.booking.startIso || null;
      patch.bookedLink = result.booking.htmlLink || '';
      patch.bookedMeetLink = result.booking.meetLink || '';
      patch.remindersSent = [];
      patch.nextFollowupAt = null;
    }
    // El lead canceló la videollamada ya agendada: la damos de baja y CORTAMOS los recordatorios.
    if (result.cancelled && wasBooked) {
      patch.status = 'lost';
      patch.cancelled = true;
      patch.bookedStartIso = null;
      patch.remindersSent = [];
      patch.nextFollowupAt = null;
      console.log(`🗑️  ${lead.number} canceló la videollamada — la doy de baja y corto recordatorios`);
    }
    updateLead(key, patch);
    crmSync(key);

    console.log(`💬 respondiendo a ${lead.number}${result.booking ? ' [AGENDÓ]' : ''}${result.cancelled ? ' [CANCELÓ]' : ''}: "${(result.text || '').slice(0, 90)}"`);
    await sleep(dly(SETTINGS.replyDelay) * 1000);
    await sendBubbles(lead.number, result.text, { allowButtons: !!lead.abBotones, ...(withAudio ? { afterFirst: () => sendFixedAudio(lead.number, 'confirmacion') } : {}) });

    if (result.booking) {
      console.log(`📅 AGENDADO ${lead.number} -> ${result.booking.when}`);
      bandit.recordBooked(lead.openerVariant);
      crm.appendBooking({ ...lead, number: lead.number }, result.booking, 'directo').catch((e) => console.error('crm appendBooking:', e?.message || e));
      await notifyOwner(`📅 nueva llamada agendada\n${lead.name || lead.number} (+${lead.number})\n${result.booking.when}\n${resumenTexto(getLead(key) || lead)}\n${result.booking.htmlLink || ''}`.trim());
    } else {
      runInsights(key).catch((e) => console.error('insights:', e?.message || e));
    }
  });
}

// --- Mensaje programado one-off (lo dispara el scheduler a la hora seteada) ---
//  Se setea con updateLead(key,{scheduledMsg:{text,at}}) vía el endpoint /admin/sched.
export async function handleScheduled(leadArg) {
  const key = leadArg.key || last10(String(leadArg.number || '').replace(/\D/g, ''));
  await withLock(key, async () => {
    if (shuttingDown || ENV.BOT_PAUSED) return;
    const lead = getLead(key);
    if (!lead || !lead.scheduledMsg || !lead.scheduledMsg.text) return;
    const text = lead.scheduledMsg.text;
    updateLead(key, { scheduledMsg: null }); // limpiamos PRIMERO para no reenviar si falla
    try {
      await sendBubbles(lead.number, text);
      updateLead(key, {
        lastBotAt: Date.now(),
        history: [...(lead.history || []), { role: 'assistant', content: text, ts: Date.now(), via: 'human' }],
      });
      console.log(`⏰ programado enviado a ${lead.number}: "${text.slice(0, 60)}"`);
    } catch (e) {
      console.error('handleScheduled error:', e?.message || e);
    }
  });
}

// --- Follow-up (lo llama el scheduler) ------------------------------------
export async function handleFollowup(leadArg) {
  if (shuttingDown || ENV.BOT_PAUSED) return;
  const key = leadArg.key;
  await withLock(key, async () => {
    const lead = getLead(key);
    if (!lead) return;
    if (lead.status !== 'opened' && lead.status !== 'engaged') return;
    if (!lead.nextFollowupAt || lead.nextFollowupAt > Date.now()) return;

    // Fase de plantillas: se agotaron los toques de texto o la charla está cerrada (+24 h).
    if (!windowOpen(lead) || (lead.followupCount || 0) >= SETTINGS.followupCadenceHours.length) {
      const tf = SETTINGS.templateFollowups || [];
      const k = lead.tplCount || 0;
      if (k >= tf.length) { updateLead(key, { status: 'lost', nextFollowupAt: null }); crmSync(key); return; }
      const name = tf[k].name;
      const params = [nombreOSaludo(lead)];
      const ok = await sendTemplateTo(lead, name, params);
      const next = nextFollowupAt({ ...lead, followupCount: SETTINGS.followupCadenceHours.length, tplCount: k + 1 });
      updateLead(key, {
        tplCount: k + 1,
        followupCount: SETTINGS.followupCadenceHours.length,
        lastBotAt: ok ? Date.now() : lead.lastBotAt,
        nextFollowupAt: next,
        status: next ? lead.status : 'lost',
        history: ok ? [...(lead.history || []), { role: 'assistant', content: tplText(name, params), ts: Date.now(), via: 'plantilla' }] : lead.history,
      });
      crmSync(key);
      return;
    }

    const fc = (lead.followupCount || 0) + 1;
    const willBeLast = nextFollowupAt({ ...lead, followupCount: fc }) == null;
    const angle = FOLLOWUP_ANGLES[(lead.followupCount || 0) % FOLLOWUP_ANGLES.length];
    console.log(`🔔 Follow-up #${fc} a ${lead.number} (${willBeLast ? 'ruptura/cierre' : 'ángulo ' + angle?.id})`);
    let result;
    try {
      result = await converse(lead, { follow: true, angle, breakup: willBeLast, hasConfirmAudio: hasAudio('confirmacion') });
    } catch (e) {
      console.error('converse(follow) error:', e?.message || e);
      return;
    }

    // Si el texto salió como razonamiento filtrado (o sentinel), NO lo mandamos al lead, PERO tampoco
    // lo descartamos como "no califica" (eso marcaba buenos leads, incluso agendados, por error).
    // Avanzamos la cadencia normal: si de verdad no es público, cae 'lost' solo al no responder.
    if (shouldSkipFollowup(result.text)) {
      const next = nextFollowupAt({ ...lead, followupCount: fc });
      updateLead(key, { followupCount: fc, nextFollowupAt: next, status: next ? lead.status : 'lost' });
      console.log(`⏭️  follow-up OMITIDO a ${lead.number} (texto inválido, no envío; sigo la cadencia, no lo descarto)`);
      return;
    }

    const patch = {
      history: result.messages,
      lastBotAt: Date.now(),
      followupCount: fc,
      nextFollowupAt: nextFollowupAt({ ...lead, followupCount: fc }),
    };
    if (!patch.nextFollowupAt && !result.booking) patch.status = 'lost'; // se agotaron
    if (result.booking) {
      patch.status = 'booked';
      patch.bookedAt = Date.now();
      patch.eventId = result.booking.eventId;
      patch.bookedWhen = result.booking.when;
      patch.bookedStartIso = result.booking.startIso || null;
      patch.bookedLink = result.booking.htmlLink || '';
      patch.bookedMeetLink = result.booking.meetLink || '';
      patch.remindersSent = [];
      patch.nextFollowupAt = null;
    }
    // A/B de horario: registramos a qué hora salió este follow-up (cuenta solo si es 9-13)
    const fuHour = localHour(Date.now());
    bandit.recordFollowupSent(fuHour);
    patch.lastFollowupHour = fuHour;
    updateLead(key, patch);
    crmSync(key);

    const fuAudio = !!(result.booking && hasAudio('confirmacion'));
    if (fuAudio) updateLead(key, { history: [...(getLead(key)?.history || []), { role: 'assistant', content: audioNote('confirmacion'), ts: Date.now() }] });
    await sendBubbles(lead.jid, result.text, { allowButtons: !!lead.abBotones, ...(fuAudio ? { afterFirst: () => sendFixedAudio(lead.number, 'confirmacion') } : {}) });

    if (result.booking) {
      bandit.recordBooked(lead.openerVariant);
      crm.appendBooking(lead, result.booking, 'follow-up').catch((e) => console.error('crm appendBooking:', e?.message || e));
      await notifyOwner(
        `📅 nueva llamada agendada (en follow-up)\n${lead.name || lead.number} (+${lead.number})\n${result.booking.when}\n${resumenTexto(getLead(key) || lead)}\n${result.booking.htmlLink || ''}`.trim()
      );
    } else if (patch.status !== 'lost') {
      runInsights(key).catch((e) => console.error('insights:', e?.message || e));
    }
  });
}

// --- Recordatorio anti no-show (lo llama el scheduler) ---------------------
export async function handleReminder(leadArg) {
  if (shuttingDown || ENV.BOT_PAUSED || !ENV.REMINDERS) return;
  const key = leadArg.key;
  await withLock(key, async () => {
    const lead = getLead(key);
    if (!lead) return;
    const r = dueReminder(lead); // re-chequeo dentro del lock (pudo cambiar)
    if (!r) return;

    console.log(`⏰ Recordatorio ${r.id} a ${lead.number} (llamada ${lead.bookedWhen})`);
    const sentIds = [...(lead.remindersSent || []), r.id];

    // Charla cerrada (+24 h): WhatsApp solo deja mandar plantillas.
    if (!windowOpen(lead)) {
      const name = (SETTINGS.templateReminders || {})[r.id];
      const second = r.id === 'm30' ? lead.bookedMeetLink : lead.bookedWhen;
      if (!name || !second) {
        updateLead(key, { remindersSent: sentIds });
        console.log(`   ⏭️  ${r.id} sin plantilla posible (charla cerrada), lo salteo`);
        return;
      }
      const params = [nombreOSaludo(lead), second];
      const ok = await sendTemplateTo(lead, name, params);
      updateLead(key, {
        remindersSent: sentIds,
        lastBotAt: ok ? Date.now() : lead.lastBotAt,
        history: ok ? [...(lead.history || []), { role: 'assistant', content: tplText(name, params), ts: Date.now(), via: 'plantilla' }] : lead.history,
      });
      crmSync(key);
      return;
    }

    // 30 minutos antes: si no contestó desde el recordatorio que pedía confirmar, aviso al operador.
    if (r.id === 'm30' && lead.reminderAskedAt && (lead.lastInboundAt || 0) < lead.reminderAskedAt) {
      notifyOwner(`⚠️ ${lead.name || lead.number} (+${lead.number}) no confirmó la llamada de ${lead.bookedWhen || 'hoy'}`).catch(() => {});
    }

    // Ausente: primero tu audio, después una línea para reprogramar.
    const noshowAudio = r.postCall ? await sendFixedAudio(lead.number, 'ausente') : false;
    const base = noshowAudio ? { ...lead, history: [...(lead.history || []), { role: 'assistant', content: audioNote('ausente'), ts: Date.now() }] } : lead;
    let result;
    try {
      result = await converse(base, { reminder: r, noshowAudio });
    } catch (e) {
      console.error('converse(reminder) error:', e?.message || e);
      updateLead(key, { remindersSent: sentIds, ...(noshowAudio ? { history: base.history } : {}) });
      return;
    }

    updateLead(key, {
      history: result.messages,
      lastBotAt: Date.now(),
      remindersSent: sentIds,
      ...((r.id === 'h3' || r.id === 'd1') ? { reminderAskedAt: Date.now() } : {}),
    });
    crmSync(key);
    await sendBubbles(lead.jid, result.text);
  });
}

// --- Opener con delay (lo dispara el scheduler cuando se cumple openerDueAt) -
export async function handleOpener(leadArg) {
  if (shuttingDown || ENV.BOT_PAUSED) return;
  const key = leadArg.key;
  await withLock(key, async () => {
    const lead = getLead(key);
    if (!lead || lead.status !== 'opening') return;
    if (!lead.openerDueAt || lead.openerDueAt > Date.now()) return;

    const openerText = lead.pendingOpener || OPENER_VARIANTS[0].globos.join('\n');
    console.log(`💬 Opener (${lead.openerVariant}${lead.openerAudio ? ' +audio' : ''}) -> ${lead.number}`);
    if (lead.lastMsgId) cloud.markRead(lead.lastMsgId); // recién acá marca leído el 1er msj
    const audioSent = lead.openerAudio ? await sendFixedAudio(lead.number, lead.openerAudio) : false;
    const extra = audioSent ? [{ role: 'assistant', content: audioNote(lead.openerAudio), ts: Date.now() }] : [];
    const patch = {
      status: 'opened',
      lastBotAt: Date.now(),
      pendingOpener: null,
      history: [...(lead.history || []), ...extra, { role: 'assistant', content: openerText, ts: Date.now() }],
    };
    patch.nextFollowupAt = nextFollowupAt({ ...lead, ...patch, followupCount: 0 });
    updateLead(key, patch);
    bandit.recordSent(lead.openerVariant);
    crmSync(key);
    await sendBubbles(lead.jid, openerText);
  });
}
