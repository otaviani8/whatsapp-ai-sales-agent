import fs from 'node:fs';
import path from 'node:path';
import { ENV } from './config.js';
import { normalizarTelefonoAR } from './telefono.js';

// ============================================================================
//  Estado PERSISTENTE por lead. Un archivo JSON en el volumen (DATA_DIR).
//  Cada lead: historial de la charla + en qué paso está + si ya agendó.
//
//  lead = {
//    key, jid, number, name,
//        // key = últimos 10 dígitos del número (util.js/last10). ES LA LLAVE del
//        // archivo y NO se toca nunca: si cambia la forma de calcularla, todos
//        // los leads guardados quedan huérfanos y una charla en curso arranca
//        // de cero como si fuera un lead nuevo.
//    telefonoE164,
//        // DERIVADO de number/jid al crear el lead. Es el campo A9 del registro
//        // único de leads (la spec de medición §6.4): la llave con la que el vendedor del
//        // cliente cruza la venta contra el lead. NO reemplaza a key/number/jid,
//        // convive con ellos. Se calcula al ESCRIBIR, nunca al leer (§6.7).
//    ad: { title, body, sourceId, sourceUrl, sourceType, ctwaClid } | null,
//        // de que anuncio vino. ctwaClid = id del CLIC, para devolver la venta a Meta
//    status: 'opened' | 'engaged' | 'booked' | 'lost',
//    history: [ ...mensajes formato Anthropic... ],
//    openedAt, lastInboundAt, lastBotAt,
//    followupCount, nextFollowupAt,
//    bookedAt, eventId, bookedWhen, bookedStartIso, bookedLink,
//    remindersSent: [ 'h24', 'h1' ]   // recordatorios anti no-show ya enviados
//  }
// ============================================================================
const FILE = path.join(ENV.DATA_DIR, 'leads.json');

let leads = null;

function load() {
  if (leads) return leads;
  leads = {};
  try {
    if (fs.existsSync(FILE)) {
      const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) leads = obj;
    }
  } catch (e) {
    console.error('leads.json ilegible, arranco vacío:', e.message);
  }
  return leads;
}

// Resultado del último guardado real a disco. Lo consulta src/health.js para
// el aviso "error al escribir leads" y para el endpoint /salud — sin acoplar
// este archivo a nada de alertas (store.js no importa health.js ni alerts.js).
let saveStatus = { ok: true, error: null, at: Date.now() };
export function getSaveStatus() {
  return { ...saveStatus };
}

let saveTimer = null;
function save() {
  // Debounce: agrupa escrituras cercanas para no pegarle al disco en cada token.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE) || '.', { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(leads));
      saveStatus = { ok: true, error: null, at: Date.now() };
    } catch (e) {
      console.error('No pude guardar leads.json:', e.message);
      saveStatus = { ok: false, error: e.message, at: Date.now() };
    }
  }, 400);
}

// Escritura inmediata (para apagados prolijos).
export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.mkdirSync(path.dirname(FILE) || '.', { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(leads || {}));
    saveStatus = { ok: true, error: null, at: Date.now() };
  } catch (e) {
    console.error('No pude guardar leads.json:', e.message);
    saveStatus = { ok: false, error: e.message, at: Date.now() };
  }
}

// Prueba de escritura activa (para /salud): NO depende de que haya habido un
// guardado real de leads recientemente. Escribe un archivo chiquito de sonda.
export function checkWritable() {
  try {
    const dir = path.dirname(FILE) || '.';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.health-write-check'), String(Date.now()));
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function getLead(key) {
  return load()[key] || null;
}

export function createLead(key, fields) {
  load();
  const lead = {
    key,
    status: 'opened',
    history: [],
    followupCount: 0,
    nextFollowupAt: null,
    ...fields,
  };
  // Campo derivado, se calcula una sola vez y acá. Preferimos `number` (el wa_id
  // completo, con código de país) sobre `jid`, y recién al final caemos en `key`,
  // que son los 10 dígitos nacionales y para un argentino alcanza. Si no se puede
  // normalizar queda vacío a propósito: un vacío se ve, un número inventado no.
  if (!lead.telefonoE164) {
    lead.telefonoE164 = normalizarTelefonoAR(lead.number || lead.jid || key);
  }
  leads[key] = lead;
  save();
  return leads[key];
}

export function updateLead(key, patch) {
  load();
  if (!leads[key]) return null;
  leads[key] = { ...leads[key], ...patch };
  save();
  return leads[key];
}

// Borra un lead (para pruebas: /admin/reset). Devuelve true si existía.
export function deleteLead(key) {
  load();
  if (!leads[key]) return false;
  delete leads[key];
  save();
  return true;
}

export function allLeads() {
  return Object.values(load());
}

// Rellena `telefonoE164` en los leads que se crearon antes de que este campo
// existiera. Se corre a mano una sola vez (node backfill-telefono.mjs), pero es
// segura si se corre dos veces: solo escribe donde el campo falta, no pisa lo que
// ya está y no toca ningún otro campo, empezando por key/number/jid.
export function backfillTelefonoE164() {
  load();
  const r = { total: 0, completados: 0, yaEstaban: 0, sinDato: 0 };
  for (const [k, lead] of Object.entries(leads)) {
    if (!lead || typeof lead !== 'object') continue;
    r.total++;
    if (lead.telefonoE164) { r.yaEstaban++; continue; }
    const e164 = normalizarTelefonoAR(lead.number || lead.jid || k);
    if (!e164) { r.sinDato++; continue; }
    lead.telefonoE164 = e164;
    r.completados++;
  }
  if (r.completados) flush();
  return r;
}
