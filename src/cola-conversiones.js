import fs from 'node:fs';
import path from 'node:path';
import { ENV } from './config.js';

// ============================================================================
//  LA COLA DE CONVERSIONES. Un archivo JSON en el volumen, al lado de
//  leads.json, con una fila por evento que alguna vez existio.
//
//  POR QUE UNA COLA Y NO MANDAR DIRECTO. Porque Meta no deduplica los eventos
//  de mensajeria: lo dice la doc con todas las letras. Si el lote diario corre
//  dos veces, o si Railway reinicia el contenedor a mitad de corrida, sin cola
//  se manda la misma venta dos veces y la campana aprende de una compra que no
//  existio. La cola es la unica garantia de idempotencia que tenemos.
//
//  POR QUE ENTRAN TAMBIEN LOS QUE NO SE MANDAN. Porque el balde de "no
//  atribuible" es un numero del reporte, no un descarte (spec §6.8 punto 4). Si
//  crece, o se rompio la medicion o aparecio un canal nuevo. Un evento que se
//  tira no deja rastro; uno que queda en la cola con su motivo, si.
//
//  ESTADOS
//    pendiente       listo para mandar
//    enviado         Meta lo acepto. UNICO estado terminal: no se recalcula
//                    nunca mas, y es lo que hace idempotente al lote diario
//    no_atribuible   el lead no tiene ctwa_clid. No se manda y no va a poder
//    vencido         quedo fuera de la ventana de 7 dias (del clic o del
//                    event_time). No se manda y ya no se recupera
//    sin_valor       ganado pero sin monto declarado. Se recalcula: si manana
//                    el vendedor carga el monto, pasa solo a pendiente
//    sin_fecha       ganado sin fecha utilizable. Se recalcula igual
//    error           Meta lo rechazo o no contesto. Se reintenta en la
//                    proxima corrida
// ============================================================================

const ARCHIVO = path.join(ENV.DATA_DIR, 'conversiones.json');
const BITACORA = path.join(ENV.DATA_DIR, 'conversiones-log.jsonl');

// El unico estado del que no se vuelve. Todo lo demas se re-evalua en cada
// corrida, porque el registro de leads cambia: un lead sin monto hoy puede
// tener monto manana.
const TERMINAL = 'enviado';

let cache = null;

function cargar() {
  if (cache) return cache;
  cache = { version: 1, eventos: {} };
  try {
    if (fs.existsSync(ARCHIVO)) {
      const obj = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
      if (obj && typeof obj === 'object' && obj.eventos) cache = obj;
    }
  } catch (e) {
    // Si el archivo quedo ilegible NO arrancamos vacios en silencio: perder la
    // cola significa remandar todo, y eso es peor que fallar ruidosamente.
    throw new Error(`conversiones.json ilegible (${e.message}). Revisalo o movelo a mano antes de correr el lote.`);
  }
  return cache;
}

// Escritura atomica: primero el .tmp, despues el rename. Si el proceso se
// muere en el medio, el archivo viejo queda entero en vez de truncado.
export function guardar() {
  if (!cache) return;
  const dir = path.dirname(ARCHIVO) || '.';
  fs.mkdirSync(dir, { recursive: true });
  const tmp = ARCHIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, ARCHIVO);
}

export function rutaArchivo() {
  return ARCHIVO;
}

export function rutaBitacora() {
  return BITACORA;
}

// Solo para las pruebas: vuelve a leer del disco.
export function recargar() {
  cache = null;
  return cargar();
}

// ---------------------------------------------------------------------------

/**
 * Encola o actualiza un evento. ACA VIVE LA IDEMPOTENCIA.
 *
 * @param {object} reg  { eventId, eventName, telefono, ctwaClid, adId, valor,
 *                        moneda, eventTime, fechaEvento, primerContactoAt,
 *                        estado, motivo }
 * @returns {{ accion:'nuevo'|'actualizado'|'ya_enviado', registro:object }}
 */
export function encolar(reg) {
  const db = cargar();
  const previo = db.eventos[reg.eventId];

  if (previo && previo.estado === TERMINAL) {
    // Ya salio. No se toca ni se remanda, pase lo que pase con la fila del
    // registro. Si el vendedor corrigio el monto despues del envio lo dejamos
    // anotado para que aparezca en la reconciliacion, pero no mandamos una
    // segunda venta: la correccion se arregla mirando el numero, no inflando
    // la cuenta de Meta.
    const cambioValor = Number.isFinite(reg.valor) && Number(previo.valor) !== Number(reg.valor);
    if (cambioValor) {
      previo.correcciones = previo.correcciones || [];
      previo.correcciones.push({ at: Date.now(), valorAnterior: previo.valor, valorNuevo: reg.valor });
      guardar();
    }
    return { accion: 'ya_enviado', registro: previo };
  }

  if (!previo) {
    db.eventos[reg.eventId] = {
      ...reg,
      // vistoAt se congela en el primer encolado y no se vuelve a tocar: es lo
      // que permite fechar un evento cuando el vendedor no cargo la fecha, sin
      // que esa fecha cambie en cada corrida (que romperia la idempotencia).
      vistoAt: Date.now(),
      corridas: 0,
      enviadoAt: null,
      respuesta: null,
    };
    guardar();
    return { accion: 'nuevo', registro: db.eventos[reg.eventId] };
  }

  // Existe y no es terminal: se refresca con lo ultimo del registro de leads,
  // conservando la historia (vistoAt, corridas).
  db.eventos[reg.eventId] = {
    ...previo,
    ...reg,
    vistoAt: previo.vistoAt,
    corridas: previo.corridas || 0,
    enviadoAt: previo.enviadoAt || null,
  };
  guardar();
  return { accion: 'actualizado', registro: db.eventos[reg.eventId] };
}

export function todos() {
  return Object.values(cargar().eventos);
}

export function pendientes() {
  return todos().filter((e) => e.estado === 'pendiente' || e.estado === 'error');
}

export function porEstado() {
  const cuenta = {};
  for (const e of todos()) cuenta[e.estado] = (cuenta[e.estado] || 0) + 1;
  return cuenta;
}

export function obtener(eventId) {
  return cargar().eventos[eventId] || null;
}

// `res` es el resultado crudo de enviarPayload: { ok, status, respuesta,
// intentos }. Guardamos las dos cuentas por separado porque miden cosas
// distintas: `corridas` es cuantas veces el lote diario intento este evento, y
// `intentosHttp` cuantos POST hizo el ultimo intento antes de rendirse. Si un
// evento acumula corridas, el problema es el dato; si acumula intentosHttp, el
// problema es Meta.
export function marcarEnviado(eventId, res) {
  const db = cargar();
  const e = db.eventos[eventId];
  if (!e) return null;
  e.estado = TERMINAL;
  e.motivo = '';
  e.enviadoAt = Date.now();
  e.corridas = (e.corridas || 0) + 1;
  e.intentosHttp = res?.intentos ?? null;
  e.status = res?.status ?? null;
  e.respuesta = res?.respuesta ?? res ?? null;
  guardar();
  return e;
}

export function marcarError(eventId, res) {
  const db = cargar();
  const e = db.eventos[eventId];
  if (!e) return null;
  e.estado = 'error';
  e.motivo = `Meta contesto HTTP ${res?.status ?? '?'} despues de ${res?.intentos ?? '?'} intentos. Se reintenta en la proxima corrida`;
  e.corridas = (e.corridas || 0) + 1;
  e.intentosHttp = res?.intentos ?? null;
  e.status = res?.status ?? null;
  e.respuesta = res?.respuesta ?? res ?? null;
  guardar();
  return e;
}

// --- Bitacora ---------------------------------------------------------------

// Append-only, una linea JSON por intento de envio: que se mando, cuando y que
// contesto Meta. Es lo que se mira cuando el cliente pregunta por que un numero
// no coincide, y es append-only justamente para que nadie lo pueda "arreglar".
export function anotar(entrada) {
  const dir = path.dirname(BITACORA) || '.';
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(BITACORA, JSON.stringify({ at: new Date().toISOString(), ...entrada }) + '\n');
}

export function leerBitacora(desdeMs = 0) {
  try {
    if (!fs.existsSync(BITACORA)) return [];
    return fs.readFileSync(BITACORA, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && Date.parse(x.at) >= desdeMs);
  } catch {
    return [];
  }
}
