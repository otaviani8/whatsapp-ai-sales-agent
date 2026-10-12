import crypto from 'node:crypto';
import { ENV } from './config.js';
import { sleep } from './util.js';

// ============================================================================
//  DEVOLUCION DE LA VENTA A META — API de Conversiones para mensajeria (CAPI
//  for Business Messaging).
//
//  POR QUE EXISTE. Meta ve que una conversacion de WhatsApp empezo, pero no ve
//  si termino en venta. Una plataforma no puede optimizar hacia algo que nunca
//  mide: por eso una campana de leads deriva sola hacia leads baratos, que es
//  lo unico que si puede contar. Devolverle el evento de venta con su valor es
//  el unico mecanismo real para que empiece a optimizar hacia compradores, y
//  de paso hace que el reporte propio y el de Meta reconcilien. spec §6.6.
//
//  ESTE MODULO NO DECIDE NADA DE NEGOCIO: arma el evento, lo clasifica contra
//  las ventanas de Meta y lo manda. Quien decide que se encola es ventas.js, y
//  quien garantiza que no se mande dos veces es cola-conversiones.js.
// ----------------------------------------------------------------------------
//  VERIFICADO CONTRA LA DOCUMENTACION DE META EL 2026-08-25. El que lea esto
//  dentro de seis meses necesita saber contra que se escribio, porque esta API
//  cambia seguido y la spec de medición §6.3 dejaba esto explicitamente como un hueco
//  a verificar el dia de la implementacion:
//
//  · Endpoint:  POST https://graph.facebook.com/{VERSION}/{DATASET_ID}/events
//               ?access_token={TOKEN}
//    Fuente: developers.facebook.com/docs/marketing-api/conversions-api/
//            business-messaging/ (la doc muestra el ejemplo con v16.0; la
//            version se pasa por entorno, no se clava en el codigo).
//  · Version de Graph vigente al 2026-08-25: v26.0 (salio el 2026-07-29). El
//    bot corre en v25.0, que sigue soportada. El default es la del bot.
//  · Campos del evento, verbatim de la doc:
//      event_name, event_time, action_source: "business_messaging",
//      messaging_channel: "whatsapp",
//      user_data.whatsapp_business_account_id, user_data.ctwa_clid,
//      custom_data.currency, custom_data.value, y partner_agent al nivel del
//      cuerpo (hermano de "data", no adentro del evento).
//    OJO: para WhatsApp el identificador de cuenta es el WABA, NO page_id.
//    page_id es para Messenger e Instagram.
//  · event_time: "can be up to 7 days before you send an event to Facebook. If
//    any event_time in data is greater than 7 days in the past, we return an
//    error for the entire request and process no events." Es literal, y es la
//    razon por la que filtramos ANTES de mandar: un solo evento viejo tira
//    abajo la tanda entera.
//    Fuente: developers.facebook.com/docs/marketing-api/conversions-api/
//            parameters/server-event/
//  · Deduplicacion: para mensajeria Meta dice explicitamente que NO deduplica
//    ("Meta does not assist with deduplicating events... we highly encourage
//    advertisers to perform deduplication before sending"). O sea: la
//    idempotencia es 100% nuestra. Mandamos event_id igual porque es un campo
//    estandar de evento de servidor y nos sirve de llave de auditoria, pero no
//    confiamos en el.
//  · Permisos del token: whatsapp_business_management y
//    whatsapp_business_manage_events. El dataset se crea una sola vez con
//    POST /{WABA_ID}/dataset.
//
//  [SIN CONFIRMAR EN DOC OFICIAL DE META] La ventana de atribucion del
//  ctwa_clid seria de 7 dias post-clic: un evento atado a un clic mas viejo
//  que eso se descarta. Lo dicen de forma coincidente varias fuentes de
//  terceros (customerlabs.com, aixel.io) y no lo encontre escrito en la pagina
//  oficial. Se toma como cierto porque es coherente con el limite oficial de 7
//  dias de event_time, pero HAY QUE RECONFIRMARLO cuando haya credenciales.
//
//  CONSECUENCIA GRANDE, Y CONTRADICE AL ANEXO: spec §6.8 declara una ventana de
//  venta de 180 dias y §6.9 usa como ejemplo una compra a los 20 dias del
//  clic. Esa venta NO se puede devolver a Meta: queda fuera de los 7 dias por
//  las dos puntas. La ventana de 180 dias sigue valiendo para el reporte
//  interno propio; para la devolucion a Meta el techo real es 7 dias. El
//  codigo no fuerza nada: marca esas filas como "vencido" y las deja visibles
//  en la reconciliacion, que es donde tienen que estar.
// ============================================================================

// Ventana oficial de Meta para event_time (dias). Verificada 2026-08-25.
export const VENTANA_EVENT_TIME_DIAS = 7;
// Ventana de atribucion del clic (dias). Ver el [SIN CONFIRMAR] de arriba.
export const VENTANA_CLIC_DIAS = 7;

const DIA_MS = 24 * 60 * 60 * 1000;

// Nombres de evento que acepta la API de mensajeria (doc del 2026-08-25). Se
// deja la lista entera para no tener que volver a buscarla, aunque hoy el
// circuito use uno solo.
export const EVENTOS_VALIDOS = [
  'Purchase', 'LeadSubmitted', 'InitiateCheckout', 'AddToCart', 'ViewContent',
  'OrderCreated', 'OrderShipped', 'OrderDelivered', 'OrderCanceled',
  'OrderReturned', 'CartAbandoned', 'QualifiedLead', 'RatingProvided',
  'ReviewProvided',
];

// --- Configuracion ---------------------------------------------------------

// Nunca hay secretos en el codigo: todo sale del entorno. Esto devuelve que
// falta, sin tirar, para que el modo de prueba pueda armar el payload igual.
export function faltantes() {
  const falta = [];
  if (!ENV.META_DATASET_ID) falta.push('META_DATASET_ID');
  if (!ENV.META_ACCESS_TOKEN) falta.push('META_ACCESS_TOKEN');
  if (!ENV.META_WABA_ID) falta.push('META_WABA_ID (o WABA_ID)');
  return falta;
}

// Igual que faltantes() pero tirando: la usa el envio real, que sin esto no va.
export function credenciales() {
  const falta = faltantes();
  if (falta.length) {
    throw new Error(
      `Faltan variables de entorno para mandarle eventos a Meta: ${falta.join(', ')}. ` +
      'Cargalas en .env (local) o en Railway. No hay valores por defecto a proposito.'
    );
  }
  return {
    datasetId: ENV.META_DATASET_ID,
    token: ENV.META_ACCESS_TOKEN,
    wabaId: ENV.META_WABA_ID,
    graphVersion: ENV.META_GRAPH_VERSION,
  };
}

export function urlEventos() {
  const { datasetId, graphVersion } = credenciales();
  // META_EVENTS_URL existe para dos cosas: poder ejercitar el circuito entero
  // (envio, reintentos, idempotencia) contra un servidor local antes de tener
  // credenciales de Meta, y por si algun dia hay que salir por un proxy. En
  // produccion va vacio y pega derecho contra Graph.
  if (ENV.META_EVENTS_URL) return ENV.META_EVENTS_URL;
  return `https://graph.facebook.com/${graphVersion}/${datasetId}/events`;
}

// --- Hasheo de datos personales --------------------------------------------

// SHA-256 en minuscula y sin espacios, como pide Meta para cualquier dato
// personal. Hoy el evento de mensajeria no necesita telefono (le alcanza con
// ctwa_clid + WABA), pero si alguna vez se manda, se manda hasheado o no se
// manda. Nunca en claro.
export function hashPII(valor) {
  const limpio = String(valor ?? '').trim().toLowerCase();
  if (!limpio) return '';
  return crypto.createHash('sha256').update(limpio, 'utf8').digest('hex');
}

// El telefono se normaliza distinto: Meta pide solo digitos con codigo de pais,
// sin el "+" y sin ceros de arranque, y recien despues el SHA-256.
export function hashTelefono(e164) {
  const digitos = String(e164 ?? '').replace(/\D/g, '');
  if (!digitos) return '';
  return crypto.createHash('sha256').update(digitos, 'utf8').digest('hex');
}

// --- Normalizacion del telefono a E.164 ------------------------------------

// El telefono es la llave que une el lead que capturo el bot con la venta que
// cargo el vendedor del cliente (spec §6.7). Si no normaliza, son dos filas
// distintas y el embudo se corta justo donde importa. En Argentina esto falla
// mas que en ningun lado por el "15" y por el "9", asi que se normaliza al
// ESCRIBIR, nunca al leer.
export function aE164Ar(crudo) {
  let d = String(crudo ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('54')) d = d.slice(2);
  while (d.startsWith('0')) d = d.slice(1);
  // El "9" es el marcador de movil que usan Meta y WhatsApp; lo sacamos aca y
  // lo volvemos a poner al final, asi el resto del algoritmo trabaja siempre
  // sobre los 10 digitos de area + numero.
  if (d.startsWith('9') && d.length >= 11) d = d.slice(1);
  // El "15" viejo va PEGADO al codigo de area, que puede tener 2, 3 o 4
  // digitos. Solo lo sacamos si al sacarlo quedan exactamente los 10 digitos
  // de un movil argentino: si no da, preferimos no adivinar.
  if (d.length > 10) {
    for (const largoArea of [2, 3, 4]) {
      if (d.slice(largoArea, largoArea + 2) === '15' && d.length - 2 === 10) {
        d = d.slice(0, largoArea) + d.slice(largoArea + 2);
        break;
      }
    }
  }
  if (d.length !== 10) return '';
  return '+549' + d;
}

// Envoltorio para cuando el numero no es un movil argentino. No inventa nada:
// si no se puede normalizar como AR, devuelve los digitos con "+" adelante,
// que es lo unico honesto que se puede hacer con un numero de afuera.
export function aE164(crudo) {
  const ar = aE164Ar(crudo);
  if (ar) return ar;
  const d = String(crudo ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return d.length >= 8 ? '+' + d : '';
}

// LA LLAVE DE CRUCE entre el lead que capturo el bot y la venta que cargo el
// vendedor. Tiene que salir del telefono YA NORMALIZADO, nunca de los digitos
// crudos: "011 15 5555 0123" y "5491155550123" son la misma persona, pero sus
// ultimos diez digitos no coinciden ("1555550123" contra "1155550123"). Cruzar
// por los digitos crudos parece que funciona hasta que un vendedor escribe el
// 15, y ahi el embudo se corta justo donde importa (spec §6.7).
export function claveTelefono(crudo) {
  const e164 = aE164(crudo);
  return e164 || String(crudo ?? '').replace(/\D/g, '').slice(-10);
}

// --- Identidad del evento ---------------------------------------------------

// event_id DETERMINISTICO, y esta es la pieza que hace idempotente todo lo
// demas. Se calcula sobre el clic y el tipo de evento, y NO sobre el monto ni
// la fecha: si el vendedor corrige el monto tres dias despues, el event_id
// sigue siendo el mismo y la cola sabe que ese evento ya salio, en vez de
// mandar una segunda venta que no existio. Una venta por clic.
export function eventIdDe(ctwaClid, eventName) {
  const semilla = `${String(ctwaClid || '')}|${String(eventName || '')}`;
  return 'otv_' + crypto.createHash('sha256').update(semilla, 'utf8').digest('hex').slice(0, 40);
}

// Llave para las filas que NO son atribuibles. Van igual a la cola, con estado
// propio, porque el tamano de ese balde es informacion (spec §6.8 punto 4) y
// porque asi no se reprocesan en cada corrida.
export function idNoAtribuible(telefonoE164, eventName) {
  const semilla = `${String(telefonoE164 || '')}|${String(eventName || '')}`;
  return 'noatr_' + crypto.createHash('sha256').update(semilla, 'utf8').digest('hex').slice(0, 40);
}

// --- Clasificacion contra las ventanas --------------------------------------

// Decide si una fila se manda o no, y por que. Devolver el motivo importa
// tanto como la decision: es lo que despues se lee en la reconciliacion.
export function clasificar(reg, ahoraMs = Date.now()) {
  // Sin identificador de clic no hay nada que mandar. Nunca se inventa uno ni
  // se manda el evento sin el: es la tentacion obvia para "mejorar la
  // cobertura" y es exactamente lo que arruina la calidad del dato.
  if (!reg.ctwaClid) {
    return {
      estado: 'no_atribuible',
      motivo: 'el lead no trae ctwa_clid (entrada directa, lead viejo, o el bot todavia no lo guardaba)',
    };
  }

  if (!reg.eventTime) {
    return { estado: 'sin_fecha', motivo: 'no hay fecha del evento y no se inventa una' };
  }

  const eventoMs = reg.eventTime * 1000;
  const edadEvento = (ahoraMs - eventoMs) / DIA_MS;
  if (edadEvento > VENTANA_EVENT_TIME_DIAS) {
    return {
      estado: 'vencido',
      motivo: `el event_time tiene ${edadEvento.toFixed(1)} dias y Meta rechaza la tanda entera arriba de ${VENTANA_EVENT_TIME_DIAS}`,
    };
  }

  if (reg.primerContactoAt) {
    const edadClic = (eventoMs - reg.primerContactoAt) / DIA_MS;
    if (edadClic > VENTANA_CLIC_DIAS) {
      return {
        estado: 'vencido',
        motivo: `la venta cerro ${edadClic.toFixed(1)} dias despues del clic y la ventana de atribucion del ctwa_clid es de ${VENTANA_CLIC_DIAS}`,
      };
    }
  }

  // No se inventan montos: los declara el cliente y Acme no los verifica
  // (spec §6.10). Sin monto declarado el evento no sale, salvo que se prenda a
  // mano META_ENVIAR_SIN_VALOR, porque la doc pide value + currency para
  // Purchase y un valor fabricado es peor que no mandar nada.
  const tieneValor = Number.isFinite(reg.valor) && reg.valor > 0;
  if (!tieneValor && !ENV.META_ENVIAR_SIN_VALOR) {
    return { estado: 'sin_valor', motivo: 'no hay monto declarado por el vendedor y no se inventa uno' };
  }

  return { estado: 'pendiente', motivo: '' };
}

// --- Armado del payload -----------------------------------------------------

// Un evento, con la forma exacta que pide la doc de mensajeria.
export function construirEvento(reg, wabaId) {
  const evento = {
    event_name: reg.eventName,
    event_time: reg.eventTime,
    event_id: reg.eventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: {
      whatsapp_business_account_id: String(wabaId),
      ctwa_clid: reg.ctwaClid,
    },
  };

  // El telefono NO hace falta para atribuir (el ctwa_clid ya es
  // deterministico) y mandar datos personales que no suman es regalar
  // superficie. Queda detras de un interruptor, y si se prende va hasheado.
  if (ENV.META_ENVIAR_TELEFONO && reg.telefono) {
    const ph = hashTelefono(reg.telefono);
    if (ph) evento.user_data.ph = ph;
  }

  const tieneValor = Number.isFinite(reg.valor) && reg.valor > 0;
  if (tieneValor) {
    evento.custom_data = {
      currency: String(reg.moneda || ENV.META_CURRENCY).toUpperCase(),
      value: Number(reg.valor),
    };
  }

  return evento;
}

// El cuerpo completo del POST. partner_agent va al nivel del cuerpo, no adentro
// del evento: es lo que Meta usa para saber que integracion mando esto.
export function construirPayload(regs, wabaId) {
  const cuerpo = {
    data: regs.map((r) => construirEvento(r, wabaId)),
    partner_agent: ENV.META_PARTNER_AGENT,
  };
  // test_event_code manda el evento a la pestana "Eventos de prueba" del
  // Administrador de eventos en vez de a los datos reales. Sirve para la
  // primera prueba con credenciales de verdad sin ensuciar la cuenta.
  if (ENV.META_TEST_EVENT_CODE) cuerpo.test_event_code = ENV.META_TEST_EVENT_CODE;
  return cuerpo;
}

// --- Envio con reintentos ---------------------------------------------------

// Reintentamos solo lo que tiene sentido reintentar. Un 400 por payload mal
// armado no mejora esperando: solo un 429, un 5xx o un problema de red.
function esReintentable(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// Espera creciente 1s / 4s / 16s, con un poco de ruido para no sincronizar
// reintentos si alguna vez esto corre en paralelo para varios clientes.
const espera = (intento) => Math.round(1000 * Math.pow(4, intento) * (0.85 + Math.random() * 0.3));

// Manda UN cuerpo ya armado. Devuelve { ok, status, respuesta, intentos }.
// No tira nunca: los errores viajan en el resultado para que queden en la
// bitacora en vez de cortar la corrida.
export async function enviarPayload(cuerpo, { maxIntentos = 3, url = null, token = null } = {}) {
  const destino = url || urlEventos();
  const bearer = token || credenciales().token;
  let ultimo = null;

  for (let intento = 0; intento < maxIntentos; intento++) {
    if (intento > 0) await sleep(espera(intento - 1));
    try {
      const res = await fetch(`${destino}?access_token=${encodeURIComponent(bearer)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const texto = await res.text();
      let json = null;
      try { json = JSON.parse(texto); } catch { /* Meta a veces contesta HTML en los 5xx */ }
      ultimo = { ok: res.ok, status: res.status, respuesta: json || texto.slice(0, 500), intentos: intento + 1 };
      if (res.ok) return ultimo;
      if (!esReintentable(res.status)) return ultimo;
    } catch (e) {
      ultimo = { ok: false, status: 0, respuesta: { error: String(e?.message || e) }, intentos: intento + 1 };
    }
  }
  return ultimo;
}

// Manda una lista de registros en tandas. Si una tanda falla con un error que
// no se reintenta, la partimos y mandamos de a uno: la doc avisa que un solo
// evento invalido hace que Meta descarte la request COMPLETA, y no queremos
// que una fila rota se lleve puestas a las otras diecinueve.
export async function enviarEnTandas(regs, { tam = 20, onEnvio = null } = {}) {
  const { wabaId } = credenciales();
  const resultados = [];

  for (let i = 0; i < regs.length; i += tam) {
    const tanda = regs.slice(i, i + tam);
    const cuerpo = construirPayload(tanda, wabaId);
    const res = await enviarPayload(cuerpo);
    if (onEnvio) await onEnvio({ regs: tanda, cuerpo, res });

    if (res.ok || tanda.length === 1) {
      resultados.push({ regs: tanda, cuerpo, res });
      continue;
    }

    // Fallo y hay mas de uno: reintentamos individualmente para aislar al malo.
    for (const reg of tanda) {
      const cuerpoUno = construirPayload([reg], wabaId);
      const resUno = await enviarPayload(cuerpoUno);
      if (onEnvio) await onEnvio({ regs: [reg], cuerpo: cuerpoUno, res: resUno });
      resultados.push({ regs: [reg], cuerpo: cuerpoUno, res: resUno });
    }
  }

  return resultados;
}
