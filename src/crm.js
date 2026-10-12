import { google } from 'googleapis';
import { ENV } from './config.js';
import { loadCredentials } from './calendar.js';
import { humanLabel } from './calendar.js';
import { normalize } from './util.js';
import { normalizarTelefonoAR } from './telefono.js';

// ============================================================================
//  CRM en Google Sheets. El bot escribe UNA fila por lead y la mantiene al día
//  (estado, último mensaje, próximo follow-up, llamada agendada, etc.). Escribe
//  SOLO sus columnas (matchea por encabezado, ver `init()`), así podés agregar
//  columnas tuyas (notas, dueño, lo que quieras) a la derecha y el bot no las
//  pisa. Esto sigue siendo así después de R03: agregar entradas a COLUMNS no
//  cambia cómo se ubican en la planilla, el matcheo por título es el mismo, y
//  las columnas nuevas se agregan al final del header existente sin tocar
//  ninguna columna que no esté en este array. Es el diseño de spec §6.4: el
//  vendedor del cliente carga estado/monto/fecha de venta en esa misma fila.
//
//  Se activa solo si está seteado SHEET_ID. Si no, no hace nada.
// ============================================================================

// key interno -> título visible de la columna (en este orden)
const COLUMNS = [
  { key: 'telefono', title: 'Teléfono' },
  { key: 'nombre', title: 'Nombre' },
  { key: 'origen', title: 'Origen (anuncio)' },
  { key: 'estado', title: 'Estado' },
  { key: 'temperatura', title: 'Temperatura' },
  { key: 'objecion', title: 'Objeción' },
  { key: 'ultimo_lead', title: 'Último msg lead' },
  { key: 'ultimo_bot', title: 'Último msg bot' },
  { key: 'followups', title: 'Follow-ups' },
  { key: 'proximo_followup', title: 'Próximo follow-up' },
  { key: 'agendada', title: 'Llamada agendada' },
  { key: 'link', title: 'Link evento' },
  { key: 'primer_contacto', title: 'Primer contacto' },
  { key: 'ultima_actividad', title: 'Última actividad' },
  { key: 'mensajes', title: 'Mensajes' },
  // Agregadas en R03, al final para no correr de lugar las columnas de arriba
  // (algunas planillas ya tienen columnas del cliente pegadas a continuación).
  { key: 'ctwa_clid', title: 'ID del clic (ctwa)' },
  { key: 'ad_id', title: 'ID del anuncio' },
  { key: 'minutos_primera_respuesta', title: 'Minutos hasta 1ra respuesta' },
];

const ESTADO = { opening: 'nuevo', opened: 'nuevo', engaged: 'conversando', booked: 'AGENDADO', lost: 'frío' };

export function enabled() {
  return !!ENV.SHEET_ID;
}

// índice 0 -> 'A', 25 -> 'Z', 26 -> 'AA'
export function colLetter(idx) {
  let n = idx + 1, s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const hkey = (h) => normalize(h).replace(/[^a-z0-9]/g, '');
const snippet = (s, n = 140) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const ts = (ms) => (ms ? humanLabel(new Date(ms)) : '');

// Últimos textos reales (ignora notas internas y tool_results).
export function lastTexts(history = []) {
  let lead = '', bot = '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[nota interna')) {
      if (!lead) lead = m.content;
    } else if (m.role === 'assistant') {
      const c = m.content;
      const txt = Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : String(c || '');
      if (!bot && txt.trim()) bot = txt;
    }
    if (lead && bot) break;
  }
  return { lead, bot };
}

function countMessages(history = []) {
  let n = 0;
  for (const m of history) {
    if (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[nota interna')) n++;
    else if (m.role === 'assistant') {
      const c = m.content;
      const txt = Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('') : String(c || '');
      if (txt.trim()) n++;
    }
  }
  return n;
}

// Minutos entre el primer contacto y la primera respuesta real del bot (el
// opener cuenta como respuesta, aunque salga con el delay a propósito para
// parecer humano: es lo que el lead efectivamente esperó). Es el indicador de
// gestión que la oferta compromete, campo A11 de spec §6.4. Si el lead cortó
// antes de que el bot llegara a responder, no hay nada que calcular: vacío.
function minutosPrimeraRespuesta(lead) {
  const inicio = lead.openedAt || 0;
  if (!inicio) return '';
  const primerBot = (lead.history || []).find((m) => m.role === 'assistant' && m.ts);
  if (!primerBot || primerBot.ts < inicio) return '';
  return String(Math.round((primerBot.ts - inicio) / 60000));
}

// Convierte un lead en el mapa key->valor de las columnas del CRM.
export function leadToValues(lead) {
  const { lead: ml, bot: mb } = lastTexts(lead.history);
  return {
    // telefonoE164 es el campo A9 de spec §6.4, la llave con la que el vendedor
    // del cliente cruza la venta contra el lead (ver §6.7). Si por lo que sea
    // todavía no está calculado, caemos al número crudo de antes: la columna
    // llave de esta planilla nunca se escribe vacía (ver R03, `init()` abajo
    // indexa las dos formas para que esta transición no duplique filas).
    telefono: lead.telefonoE164 || ('+' + (lead.number || '')),
    nombre: lead.name || '',
    origen: lead.ad?.title || lead.ad?.body || (lead.ad ? 'anuncio' : 'directo'),
    estado: ESTADO[lead.status] || lead.status || '',
    temperatura: lead.profile?.temperature != null ? String(lead.profile.temperature) : '',
    objecion: lead.profile?.objection || '',
    ultimo_lead: snippet(ml),
    ultimo_bot: snippet(mb),
    followups: String(lead.followupCount ?? 0),
    proximo_followup: ts(lead.nextFollowupAt),
    agendada: lead.bookedWhen || '',
    link: lead.bookedLink || '',
    primer_contacto: ts(lead.openedAt),
    ultima_actividad: ts(Math.max(lead.lastInboundAt || 0, lead.lastBotAt || 0) || null),
    mensajes: String(countMessages(lead.history)),
    // ctwa_clid es el id del CLIC (no del anuncio): lo único que permite
    // devolverle la venta a Meta por la API de Conversiones. Los leads de
    // antes del 2026-08-25 no lo tienen y nunca lo van a tener, queda vacío
    // a propósito, no se inventa. Ver mapReferral() en whatsapp.js.
    ctwa_clid: lead.ad?.ctwaClid || '',
    // ad_id es el source_id de Meta: agrupa por anuncio de verdad. El título
    // (columna "Origen") es para leer con los ojos, este id es para pivotear.
    ad_id: lead.ad?.sourceId || '',
    minutos_primera_respuesta: minutosPrimeraRespuesta(lead),
  };
}

// Parsea el número de fila de un range tipo "CRM!A45:L45".
export function rowOfRange(updatedRange) {
  const m = String(updatedRange || '').match(/![A-Z]+(\d+):/);
  return m ? Number(m[1]) : null;
}

// --- Cliente de Sheets -----------------------------------------------------
let sheetsClient = null;
async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const creds = loadCredentials();
  if (!creds) throw new Error('No hay credenciales de Google para el CRM.');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return sheetsClient;
}

const tabRef = () => `'${(ENV.SHEET_TAB || 'CRM').replace(/'/g, "''")}'`;

// --- Estado en memoria (encabezados + fila por teléfono) -------------------
let ready = false;
let colIndex = {}; // key -> índice 0-based de columna
let rowByPhone = new Map(); // dígitos de teléfono (crudo O normalizado) -> nº de fila (1-based)

// Arma el índice fila<->teléfono a partir de las filas crudas de la planilla.
// LA TRAMPA de R03: antes de esta corrección, la columna Teléfono se escribía
// con el número crudo, así que las filas viejas están indexadas con esa forma
// (a veces sin el 9, a veces con el 15). Ahora escribimos telefonoE164, que
// para el mismo lead da una forma DISTINTA. Si solo indexáramos la forma que
// está guardada, la primera vez que ese lead vuelve a escribir el matcheo no
// lo encuentra, `upsertLead()` hace `append` en vez de `update`, y la fila
// vieja queda huérfana con una fila nueva duplicada al lado (mismo lead, dos
// filas, historial partido). Por eso cada fila entra al mapa bajo DOS claves,
// la cruda tal cual está escrita y la normalizada: así el lookup encuentra la
// fila sin importar con cuál de las dos formas se escribió originalmente. Es
// exactamente el mismo truco que ya usa `getLead`/`last10` para el JSON, pero
// acá con dos entradas de mapa en vez de una función de llave fija, porque acá
// la llave SÍ tiene que cambiar de forma (a diferencia de `last10`, que no se
// toca). Separada de `init()` para poder testear el matcheo sin pegarle a la
// API de Sheets, ver crm.test.js.
export function indexRowsByPhone(rows, phoneCol) {
  const idx = new Map();
  for (let r = 1; r < rows.length; r++) {
    const v = (rows[r] || [])[phoneCol];
    if (!v) continue;
    const crudo = String(v).replace(/\D/g, ''); // como quedó escrito (Sheets se come el +)
    if (crudo) idx.set(crudo, r + 1);
    const normalizado = normalizarTelefonoAR(v).replace(/\D/g, '');
    if (normalizado) idx.set(normalizado, r + 1);
  }
  return idx;
}

async function init() {
  if (ready) return;
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ENV.SHEET_ID,
    range: tabRef(),
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  let header = rows[0] || [];

  // Asegurar que existan nuestras columnas (sin pisar las del usuario).
  const hNorm = header.map(hkey);
  let changed = false;
  for (const col of COLUMNS) {
    let idx = hNorm.indexOf(hkey(col.title));
    if (idx < 0) {
      idx = header.length;
      header.push(col.title);
      hNorm.push(hkey(col.title));
      changed = true;
    }
    colIndex[col.key] = idx;
  }
  if (changed || rows.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: ENV.SHEET_ID,
      range: `${tabRef()}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    });
  }

  // Indexar filas existentes por teléfono (crudo Y normalizado, ver el porqué
  // en indexRowsByPhone).
  rowByPhone = indexRowsByPhone(rows, colIndex.telefono);
  ready = true;
}

// Serializa todas las escrituras al CRM (evita choques al crear filas).
let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(fn, fn).catch((e) => console.error('crm:', e?.message || e));
  return chain;
}

// Crea o actualiza la fila del lead. No bloquea el flujo de WhatsApp.
export function upsertLead(lead) {
  if (!enabled()) return Promise.resolve();
  return enqueue(async () => {
    await init();
    const sheets = await getSheets();
    const vals = leadToValues(lead);
    const phone = vals.telefono.replace(/\D/g, ''); // solo dígitos para matchear (el + se pierde en Sheets)
    const row = rowByPhone.get(phone);

    if (row) {
      const data = COLUMNS.map((c) => ({
        range: `${tabRef()}!${colLetter(colIndex[c.key])}${row}`,
        values: [[vals[c.key]]],
      }));
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: ENV.SHEET_ID,
        requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
    } else {
      const width = Math.max(...COLUMNS.map((c) => colIndex[c.key])) + 1;
      const arr = new Array(width).fill('');
      for (const c of COLUMNS) arr[colIndex[c.key]] = vals[c.key];
      const out = await sheets.spreadsheets.values.append({
        spreadsheetId: ENV.SHEET_ID,
        range: tabRef(),
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [arr] },
      });
      const newRow = rowOfRange(out.data.updates?.updatedRange);
      if (newRow) rowByPhone.set(phone, newRow);
    }
  });
}

// MIGRACIÓN de la planilla (R03): reescribe la columna Teléfono de las filas
// que ya existen a E.164. Se corre A MANO, una sola vez, con
// `node migrar-telefonos-crm.mjs` (necesita las mismas credenciales de Google
// que usa el bot en producción, así que corré esto donde/con el .env que las
// tiene). Segura si se corre dos veces: una fila cuyos dígitos ya coinciden
// con la forma normalizada no se vuelve a escribir, así que la segunda pasada
// no cambia nada. Si un valor no normaliza, se deja tal cual estaba, no se
// inventa nada, y se cuenta aparte para poder revisarlo a mano.
export async function migrarTelefonosAE164() {
  if (!enabled()) throw new Error('SHEET_ID no está seteado, no hay CRM que migrar.');
  await init();
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ENV.SHEET_ID,
    range: tabRef(),
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  const phoneCol = colIndex.telefono;
  const r = { totalConTelefono: 0, reescritas: 0, yaEstaban: 0, noPudoNormalizar: 0 };
  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const v = (rows[i] || [])[phoneCol];
    if (!v) continue;
    r.totalConTelefono++;
    const actual = String(v).replace(/\D/g, '');
    const e164 = normalizarTelefonoAR(v);
    const objetivo = e164.replace(/\D/g, '');
    if (!objetivo) { r.noPudoNormalizar++; continue; }
    if (actual === objetivo) { r.yaEstaban++; continue; }
    data.push({ range: `${tabRef()}!${colLetter(phoneCol)}${i + 1}`, values: [[e164]] });
    r.reescritas++;
  }
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ENV.SHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
  }
  // El índice en memoria ya tiene ambas formas cargadas desde el init() de
  // arriba (ver indexRowsByPhone), así que reescribir la celda no lo desactualiza.
  return r;
}

// --- Registro de agendadas (pestaña aparte, append-only) --------------------
//  Cada vez que el bot reserva una llamada, AGREGA una fila acá. Es el aviso de
//  agendados confiable: no depende de la ventana de 24h de WhatsApp.
const bookingsTabRef = () => `'${(ENV.BOOKINGS_TAB || 'AGENDADAS').replace(/'/g, "''")}'`;
const BOOKING_HEADER = ['Agendado el', 'Lead', 'Teléfono', 'Día/hora de la call', 'Link Meet', 'Link evento', 'Origen'];
let bookingsTabReady = false;

// Garantiza que exista la pestaña de agendadas con su encabezado.
async function ensureBookingsTab(sheets) {
  if (bookingsTabReady) return;
  const title = ENV.BOOKINGS_TAB || 'AGENDADAS';
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ENV.SHEET_ID });
  const exists = (meta.data.sheets || []).some((s) => s.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: ENV.SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: ENV.SHEET_ID, range: `${bookingsTabRef()}!A1:G1` });
  if (!(res.data.values?.[0] || []).length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: ENV.SHEET_ID,
      range: `${bookingsTabRef()}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [BOOKING_HEADER] },
    });
  }
  bookingsTabReady = true;
}

// Agrega UNA fila al registro de agendadas. No bloquea el flujo de WhatsApp.
export function appendBooking(lead = {}, booking = {}, origin = 'directo') {
  if (!enabled()) return Promise.resolve();
  return enqueue(async () => {
    const sheets = await getSheets();
    await ensureBookingsTab(sheets);
    const row = [
      humanLabel(new Date()),
      lead.name || '',
      '+' + (lead.number || ''),
      booking.when || lead.bookedWhen || '',
      booking.meetLink || lead.bookedMeetLink || '',
      booking.htmlLink || lead.bookedLink || '',
      origin,
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: ENV.SHEET_ID,
      range: bookingsTabRef(),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  });
}
