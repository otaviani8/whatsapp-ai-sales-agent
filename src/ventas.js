import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { ENV } from './config.js';
import { loadCredentials } from './calendar.js';
import { normalize } from './util.js';
import { allLeads } from './store.js';
import { aE164, claveTelefono } from './conversiones.js';

// ============================================================================
//  EL REGISTRO DE LEADS, LADO "GRUPO B": lo que declara el vendedor del
//  cliente. Es su unica obligacion en todo el circuito (spec §6.4).
//
//  DE DONDE SALE CADA COSA, Y POR QUE ESTA PARTIDO EN DOS
//
//  · El ctwa_clid, el id del anuncio y la fecha del primer contacto salen de
//    leads.json, que lo escribe el bot. Son el Grupo A: se capturan solos y no
//    se le piden nunca al cliente.
//  · El estado comercial, el monto y la fecha de la venta salen de la planilla
//    (o de un archivo local, para poder probar sin credenciales). Son el Grupo
//    B: solo los puede saber el vendedor.
//
//  Las dos mitades se unen por el TELEFONO, normalizado a E.164. Es la unica
//  llave que comparten, porque el vendedor conoce a la persona por su numero y
//  no por un id interno (spec §6.7).
//
//  OJO CON LA PLANILLA. crm.js ya escribe una columna "Estado" con su propio
//  vocabulario (nuevo / conversando / AGENDADO / frio) y la pisa en cada
//  upsert. Por eso el Grupo B usa titulos PROPIOS que no chocan con los del
//  bot: crm.js solo toca las columnas cuyo encabezado conoce, asi que estas
//  quedan intactas. No renombrar "Estado comercial" a "Estado".
// ============================================================================

// Titulos que el vendedor tiene que tener en la planilla. El match es por
// encabezado normalizado, asi que los acentos y las mayusculas dan igual.
export const COLUMNAS_GRUPO_B = [
  { key: 'estadoComercial', titulo: 'Estado comercial', obligatoria: true },
  { key: 'fechaEstado', titulo: 'Fecha del estado', obligatoria: false },
  { key: 'motivoPerdida', titulo: 'Motivo de perdida', obligatoria: false },
  { key: 'monto', titulo: 'Monto de la venta', obligatoria: true },
  { key: 'fechaVenta', titulo: 'Fecha de la venta', obligatoria: true },
  { key: 'moneda', titulo: 'Moneda', obligatoria: false },
];

// Los siete estados de spec §6.4. No se agregan mas: una lista abierta hace que
// el reporte no se pueda sumar.
export const ESTADOS = ['nuevo', 'contactado', 'calificado', 'oportunidad', 'ganado', 'perdido', 'no corresponde'];

const hkey = (h) => normalize(h).replace(/[^a-z0-9]/g, '');

// --- Parseo tolerante -------------------------------------------------------

// Los montos los escribe una persona apurada en una planilla: pueden venir como
// "350.000", "$ 350.000,50", "350000.5" o como numero puro. Se parsea con
// criterio y despues se muestra el resultado en el modo de prueba, para que el
// que revisa vea que entendio el sistema antes de que salga a Meta.
export function parsearMonto(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, '').trim();
  if (!s) return null;
  const tienePunto = s.includes('.');
  const tieneComa = s.includes(',');
  if (tienePunto && tieneComa) {
    // Formato argentino: el punto separa miles y la coma decimales.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (tieneComa) {
    const dec = s.split(',').pop();
    s = dec.length <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (tienePunto) {
    // Un solo separador y es punto: si el ultimo grupo tiene 3 digitos y hay
    // mas de tres digitos en total, es separador de miles ("350.000"), no
    // decimal. Con dos digitos o menos es decimal ("350.5").
    const partes = s.split('.');
    const ultimo = partes[partes.length - 1];
    if (ultimo.length === 3 && s.replace(/\D/g, '').length > 3) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Argentina es UTC-3 fijo (no hay horario de verano desde 2009), asi que se
// puede clavar el offset sin traer una libreria de zonas horarias.
const OFFSET_AR = '-03:00';

// Devuelve { ms, iso } o null. Acepta el numero de serie de Google Sheets, el
// formato argentino DD/MM/AAAA y el ISO AAAA-MM-DD. La hora se fija al mediodia
// local: una venta no tiene hora declarada y el mediodia no se cae de dia por
// redondeo de zona horaria en ninguna de las dos puntas.
export function parsearFecha(v) {
  if (v == null || v === '') return null;

  // Numero de serie de Sheets: dias desde el 1899-12-30.
  if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 80000) {
    const base = Date.UTC(1899, 11, 30);
    const dia = Math.floor(v);
    const d = new Date(base + dia * 86400000);
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return { ms: Date.parse(`${iso}T12:00:00${OFFSET_AR}`), iso };
  }

  const s = String(v).trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const ms = Date.parse(`${iso}T12:00:00${OFFSET_AR}`);
    return Number.isFinite(ms) ? { ms, iso } : null;
  }

  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const dia = m[1].padStart(2, '0');
    const mes = m[2].padStart(2, '0');
    const anio = m[3].length === 2 ? '20' + m[3] : m[3];
    const iso = `${anio}-${mes}-${dia}`;
    const ms = Date.parse(`${iso}T12:00:00${OFFSET_AR}`);
    return Number.isFinite(ms) ? { ms, iso } : null;
  }

  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { ms, iso };
}

// --- Fuente 1: archivo local ------------------------------------------------

// Existe para dos cosas: poder probar el circuito entero sin credenciales de
// Google, y tener una salida de emergencia si el cliente manda las ventas por
// otro lado. Formato: un array de objetos con las mismas claves del Grupo B.
export function rutaArchivoVentas() {
  return ENV.VENTAS_FILE || path.join(ENV.DATA_DIR, 'ventas-declaradas.json');
}

export function leerArchivo() {
  const ruta = rutaArchivoVentas();
  if (!fs.existsSync(ruta)) return [];
  const crudo = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  const arr = Array.isArray(crudo) ? crudo : Array.isArray(crudo?.ventas) ? crudo.ventas : [];
  return arr.map((f) => ({
    telefonoCrudo: f.telefono ?? f.telefono_e164 ?? f.tel ?? '',
    estadoComercial: f.estado ?? f.estado_comercial ?? f.estadoComercial ?? '',
    fechaEstado: f.fecha_estado ?? f.fechaEstado ?? '',
    motivoPerdida: f.motivo_perdida ?? f.motivoPerdida ?? '',
    monto: f.monto ?? f.monto_de_la_venta ?? f.valor ?? '',
    fechaVenta: f.fecha_venta ?? f.fechaVenta ?? '',
    moneda: f.moneda ?? '',
    fuente: 'archivo',
    fila: null,
  }));
}

// --- Fuente 2: la planilla --------------------------------------------------

let sheetsClient = null;
async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const creds = loadCredentials();
  if (!creds) throw new Error('No hay credenciales de Google (GOOGLE_CREDENTIALS_B64 o _JSON) para leer la planilla.');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    // Solo lectura: este proceso NUNCA escribe en la planilla del cliente.
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return sheetsClient;
}

export function planillaDisponible() {
  return !!(ENV.SHEET_ID && (ENV.GOOGLE_CREDENTIALS_B64 || ENV.GOOGLE_CREDENTIALS_JSON));
}

// Lee la pestana del CRM y devuelve { filas, faltanColumnas }.
export async function leerPlanilla() {
  const tab = ENV.VENTAS_SHEET_TAB || ENV.SHEET_TAB || 'CRM';
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ENV.SHEET_ID,
    range: `'${tab.replace(/'/g, "''")}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  const header = (rows[0] || []).map(hkey);

  const idx = {};
  const faltanColumnas = [];
  for (const col of COLUMNAS_GRUPO_B) {
    const i = header.indexOf(hkey(col.titulo));
    if (i < 0) {
      if (col.obligatoria) faltanColumnas.push(col.titulo);
      continue;
    }
    idx[col.key] = i;
  }
  const iTel = header.indexOf(hkey('Telefono'));
  if (iTel < 0) faltanColumnas.push('Teléfono');
  if (faltanColumnas.length) return { filas: [], faltanColumnas, tab };

  const filas = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const tel = row[iTel];
    if (!tel) continue;
    filas.push({
      telefonoCrudo: tel,
      estadoComercial: idx.estadoComercial != null ? row[idx.estadoComercial] : '',
      fechaEstado: idx.fechaEstado != null ? row[idx.fechaEstado] : '',
      motivoPerdida: idx.motivoPerdida != null ? row[idx.motivoPerdida] : '',
      monto: idx.monto != null ? row[idx.monto] : '',
      fechaVenta: idx.fechaVenta != null ? row[idx.fechaVenta] : '',
      moneda: idx.moneda != null ? row[idx.moneda] : '',
      fuente: 'planilla',
      fila: r + 1,
    });
  }
  return { filas, faltanColumnas: [], tab };
}

// --- Union de las dos mitades -----------------------------------------------

/**
 * Lee todo el registro y lo cruza con leads.json.
 * La planilla gana sobre el archivo local cuando el mismo telefono esta en las
 * dos: la planilla es donde trabaja el vendedor de verdad.
 */
export async function leerRegistro({ conPlanilla = true } = {}) {
  const avisos = [];
  let filas = [];

  try {
    const delArchivo = leerArchivo();
    if (delArchivo.length) filas = filas.concat(delArchivo);
  } catch (e) {
    avisos.push(`No pude leer ${rutaArchivoVentas()}: ${e.message}`);
  }

  let tabUsada = null;
  if (conPlanilla && planillaDisponible()) {
    try {
      const { filas: dePlanilla, faltanColumnas, tab } = await leerPlanilla();
      tabUsada = tab;
      if (faltanColumnas.length) {
        avisos.push(
          `A la pestana "${tab}" le faltan columnas del Grupo B: ${faltanColumnas.join(', ')}. ` +
          `Agregalas a la derecha con esos titulos exactos. El bot no las pisa: crm.js solo toca las suyas.`
        );
      } else {
        // La planilla pisa al archivo local para el mismo telefono.
        const porTel = new Map(filas.map((f) => [claveTelefono(f.telefonoCrudo), f]));
        for (const f of dePlanilla) porTel.set(claveTelefono(f.telefonoCrudo), f);
        filas = [...porTel.values()];
      }
    } catch (e) {
      avisos.push(`No pude leer la planilla: ${e.message}`);
    }
  } else if (conPlanilla && ENV.SHEET_ID) {
    avisos.push('Hay SHEET_ID pero no hay credenciales de Google: se lee solo el archivo local.');
  }

  // Cruce con lo que capturo el bot.
  const leads = allLeads();
  const porClave = new Map();
  for (const l of leads) {
    const clave = claveTelefono(l.number || l.key || '');
    if (clave) porClave.set(clave, l);
  }

  const registro = filas.map((f) => {
    const clave = claveTelefono(f.telefonoCrudo);
    const lead = porClave.get(clave) || null;
    const monto = parsearMonto(f.monto);
    const fVenta = parsearFecha(f.fechaVenta);
    const fEstado = parsearFecha(f.fechaEstado);
    return {
      ...f,
      clave,
      telefono: aE164(f.telefonoCrudo),
      estadoNormalizado: normalize(f.estadoComercial),
      monto,
      fechaVentaMs: fVenta ? fVenta.ms : null,
      fechaVentaIso: fVenta ? fVenta.iso : '',
      fechaEstadoMs: fEstado ? fEstado.ms : null,
      // Grupo A, del bot:
      nombre: lead?.name || '',
      ctwaClid: lead?.ad?.ctwaClid || '',
      adId: lead?.ad?.sourceId || '',
      primerContactoAt: lead?.openedAt || null,
      enLeadsJson: !!lead,
    };
  });

  return { registro, avisos, tab: tabUsada, leadsLeidos: leads.length };
}

// Las filas que disparan la devolucion a Meta: ganadas. Nada mas.
export function ganados(registro) {
  return registro.filter((f) => f.estadoNormalizado === 'ganado');
}
