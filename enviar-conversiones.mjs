#!/usr/bin/env node
import { ENV } from './src/config.js';
import * as cola from './src/cola-conversiones.js';
import { leerRegistro, ganados } from './src/ventas.js';
import {
  clasificar, construirPayload, credenciales, enviarEnTandas, eventIdDe,
  faltantes, idNoAtribuible, urlEventos, VENTANA_CLIC_DIAS, VENTANA_EVENT_TIME_DIAS,
} from './src/conversiones.js';

// ============================================================================
//  EL LOTE DIARIO. Toma las filas que el vendedor del cliente marco como
//  ganadas, las encola y le devuelve a Meta las que se pueden devolver.
//
//  POR QUE UNA VEZ POR DIA Y NO EN TIEMPO REAL. Porque con estos volumenes la
//  complejidad de un envio inmediato no se justifica, y porque el lote permite
//  revisar antes de mandar, que es justamente lo que hace el modo de prueba
//  (spec §6.6).
//
//  POR QUE EL MODO DE PRUEBA ES EL DEFAULT. Porque un evento mandado no se
//  puede desmandar. Hay que pedir el envio a proposito con --enviar.
//
//  USO
//    node enviar-conversiones.mjs              modo prueba: arma y muestra
//    node enviar-conversiones.mjs --enviar     manda de verdad
//    node enviar-conversiones.mjs --limit 5    corta la corrida en 5 eventos
//    node enviar-conversiones.mjs --json       salida para maquina
//    node enviar-conversiones.mjs --sin-planilla   solo el archivo local
//
//  El cron de produccion es la linea con --enviar, una vez al dia.
// ============================================================================

const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const valorDe = (f, def) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const ENVIAR = tiene('--enviar');
const JSON_OUT = tiene('--json');
const SIN_PLANILLA = tiene('--sin-planilla');
const LIMITE = Number(valorDe('--limit', '0')) || 0;

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const plata = (n, moneda) => (n == null ? '—' : `${moneda || ENV.META_CURRENCY} ${Number(n).toLocaleString('es-AR')}`);

// Nunca imprimimos el token, ni siquiera en el modo de prueba: estos logs
// terminan pegados en un chat mas seguido de lo que uno quisiera.
function urlSegura() {
  try {
    return urlEventos() + '?access_token=***';
  } catch {
    const v = ENV.META_GRAPH_VERSION;
    return `https://graph.facebook.com/${v}/{META_DATASET_ID}/events?access_token=***`;
  }
}

async function main() {
  const ahora = Date.now();
  log('');
  log('════════════════════════════════════════════════════════════════════');
  log(`  DEVOLUCION DE VENTAS A META  ·  ${ENVIAR ? 'ENVIO REAL' : 'MODO DE PRUEBA (no manda nada)'}`);
  log(`  ${new Date(ahora).toISOString()}`);
  log('════════════════════════════════════════════════════════════════════');

  const falta = faltantes();
  if (falta.length) {
    log('');
    log(`  ⚠  Faltan credenciales: ${falta.join(', ')}`);
    log('     Se puede armar el payload igual, pero no mandarlo.');
    if (ENVIAR) {
      console.error('\n  ✖ --enviar sin credenciales. Cargalas y volve a correr.\n');
      process.exitCode = 1;
      return;
    }
  }
  if (ENV.META_TEST_EVENT_CODE) log(`\n  ℹ  META_TEST_EVENT_CODE cargado: los eventos van al tablero de prueba.`);

  // --- 1. Leer el registro -------------------------------------------------
  const { registro, avisos, tab, leadsLeidos } = await leerRegistro({ conPlanilla: !SIN_PLANILLA });
  log('');
  log('─ Registro de leads ────────────────────────────────────────────────');
  log(`  Leads que capturo el bot (leads.json): ${leadsLeidos}`);
  log(`  Filas con estado declarado por el vendedor: ${registro.length}${tab ? ` (pestana "${tab}")` : ''}`);
  for (const a of avisos) log(`  ⚠  ${a}`);

  const filasGanadas = ganados(registro);
  log(`  Filas en "ganado": ${filasGanadas.length}`);

  // --- 2. Encolar ----------------------------------------------------------
  const eventName = ENV.META_EVENT_NAME;
  const resumenEncolado = { nuevo: 0, actualizado: 0, ya_enviado: 0, sin_telefono: 0 };
  const detalle = [];

  for (const fila of filasGanadas) {
    // Sin telefono normalizable no hay llave: ni para cruzar con el bot ni para
    // identificar la fila. Se cuenta aparte para que se vea en el reporte.
    if (!fila.telefono) {
      resumenEncolado.sin_telefono++;
      log(`  ⚠  Telefono no normalizable, fila salteada: "${fila.telefonoCrudo}"${fila.fila ? ` (fila ${fila.fila})` : ''}`);
      continue;
    }

    const eventTime = fila.fechaVentaMs
      ? Math.floor(fila.fechaVentaMs / 1000)
      : fila.fechaEstadoMs
        ? Math.floor(fila.fechaEstadoMs / 1000)
        : null;

    const reg = {
      eventId: fila.ctwaClid ? eventIdDe(fila.ctwaClid, eventName) : idNoAtribuible(fila.telefono, eventName),
      eventName,
      telefono: fila.telefono,
      nombre: fila.nombre,
      ctwaClid: fila.ctwaClid,
      adId: fila.adId,
      valor: fila.monto,
      moneda: (fila.moneda || ENV.META_CURRENCY).toUpperCase(),
      eventTime,
      fechaEvento: fila.fechaVentaIso || '',
      primerContactoAt: fila.primerContactoAt,
      filaPlanilla: fila.fila || null,
    };

    const { estado, motivo } = clasificar(reg, ahora);
    reg.estado = estado;
    reg.motivo = motivo;

    // Un no_atribuible tiene dos causas bien distintas y conviene distinguirlas:
    // el lead nunca entro por el bot, o entro pero de un anuncio anterior al
    // arreglo de mapReferral (2026-08-25), que descartaba el ctwa_clid.
    if (estado === 'no_atribuible') {
      reg.motivo = !fila.enLeadsJson
        ? 'el telefono no figura en leads.json: el lead no entro por el bot (entrada directa o carga manual)'
        : 'el lead entro por el bot pero sin ctwa_clid: vino de antes del arreglo de mapReferral o no fue un Click-to-WhatsApp';
    }

    const { accion, registro: guardado } = cola.encolar(reg);
    resumenEncolado[accion] = (resumenEncolado[accion] || 0) + 1;
    detalle.push({ accion, reg: guardado });
  }

  log('');
  log('─ Cola ─────────────────────────────────────────────────────────────');
  log(`  Archivo: ${cola.rutaArchivo()}`);
  log(`  Nuevos: ${resumenEncolado.nuevo}   ·   Actualizados: ${resumenEncolado.actualizado}   ·   Ya enviados antes: ${resumenEncolado.ya_enviado}`);
  if (resumenEncolado.sin_telefono) log(`  Salteados por telefono ilegible: ${resumenEncolado.sin_telefono}`);
  const cuenta = cola.porEstado();
  log(`  Estado de la cola completa: ${Object.entries(cuenta).map(([k, v]) => `${k}=${v}`).join('  ') || 'vacia'}`);

  // --- 3. Lo que NO se manda, y por que ------------------------------------
  const noSeMandan = cola.todos().filter((e) => ['no_atribuible', 'vencido', 'sin_valor', 'sin_fecha'].includes(e.estado));
  if (noSeMandan.length) {
    log('');
    log('─ No se devuelven a Meta ───────────────────────────────────────────');
    log(`  Esto no es un error: es el balde honesto. Si crece, o se rompio la`);
    log(`  medicion o aparecio un canal nuevo (spec §6.8).`);
    for (const e of noSeMandan.slice(0, 30)) {
      log(`  · ${e.telefono}  ${plata(e.valor, e.moneda)}  [${e.estado}] ${e.motivo}`);
    }
    if (noSeMandan.length > 30) log(`  … y ${noSeMandan.length - 30} mas.`);
  }

  // --- 4. Los que si ------------------------------------------------------
  let aMandar = cola.pendientes();
  if (LIMITE > 0 && aMandar.length > LIMITE) {
    log(`\n  ℹ  --limit ${LIMITE}: se recortan ${aMandar.length - LIMITE} eventos que quedan para la proxima corrida.`);
    aMandar = aMandar.slice(0, LIMITE);
  }

  log('');
  log('─ A devolver ───────────────────────────────────────────────────────');
  log(`  Eventos listos: ${aMandar.length}`);
  log(`  Ventanas verificadas 2026-08-25: clic ${VENTANA_CLIC_DIAS} dias · event_time ${VENTANA_EVENT_TIME_DIAS} dias`);
  log(`  Destino: ${urlSegura()}`);

  if (!aMandar.length) {
    log('\n  Nada para mandar. Fin.\n');
    if (JSON_OUT) console.log(JSON.stringify({ modo: ENVIAR ? 'envio' : 'prueba', encolado: resumenEncolado, cola: cuenta, aMandar: 0 }, null, 2));
    return;
  }

  // El payload EXACTO que saldria. En modo de prueba esto es todo el
  // entregable: se lee, se aprueba, y recien despues se corre con --enviar.
  const wabaId = ENV.META_WABA_ID || '{META_WABA_ID}';
  const payload = construirPayload(aMandar, wabaId);

  if (!ENVIAR) {
    log('');
    log('─ Payload que se mandaria (no se mando) ────────────────────────────');
    log(JSON.stringify(payload, null, 2));
    log('');
    log('  Para mandarlo de verdad: node enviar-conversiones.mjs --enviar');
    log('');
    if (JSON_OUT) console.log(JSON.stringify({ modo: 'prueba', encolado: resumenEncolado, cola: cuenta, payload }, null, 2));
    return;
  }

  // --- 5. Envio real -------------------------------------------------------
  credenciales(); // tira con mensaje claro si falta algo
  const resultados = await enviarEnTandas(aMandar, {
    tam: 20,
    onEnvio: async ({ regs, cuerpo, res }) => {
      // Bitacora primero: si el proceso se muere despues del POST, tiene que
      // quedar constancia de que el POST salio.
      cola.anotar({
        modo: 'envio',
        dataset: ENV.META_DATASET_ID,
        eventIds: regs.map((r) => r.eventId),
        eventos: cuerpo.data.length,
        status: res.status,
        ok: res.ok,
        intentos: res.intentos,
        respuesta: res.respuesta,
      });
      for (const r of regs) {
        if (res.ok) cola.marcarEnviado(r.eventId, res);
        else cola.marcarError(r.eventId, res);
      }
    },
  });

  const okEventos = resultados.filter((r) => r.res.ok).reduce((n, r) => n + r.regs.length, 0);
  const malEventos = resultados.filter((r) => !r.res.ok).reduce((n, r) => n + r.regs.length, 0);
  const valorEnviado = resultados.filter((r) => r.res.ok).reduce((s, r) => s + r.regs.reduce((a, x) => a + (Number(x.valor) || 0), 0), 0);

  log('');
  log('─ Resultado ────────────────────────────────────────────────────────');
  log(`  Aceptados por Meta: ${okEventos}   ·   Rechazados: ${malEventos}`);
  log(`  Valor devuelto: ${plata(valorEnviado, ENV.META_CURRENCY)}`);
  log(`  Bitacora: ${cola.rutaBitacora()}`);
  for (const r of resultados.filter((x) => !x.res.ok)) {
    log(`  ✖ ${r.regs.map((x) => x.telefono).join(', ')} → HTTP ${r.res.status}: ${JSON.stringify(r.res.respuesta).slice(0, 300)}`);
  }
  log('');

  if (JSON_OUT) {
    console.log(JSON.stringify({
      modo: 'envio', encolado: resumenEncolado, cola: cola.porEstado(),
      aceptados: okEventos, rechazados: malEventos, valorEnviado,
    }, null, 2));
  }
  if (malEventos) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\n✖ El lote fallo:', e?.message || e, '\n');
  process.exitCode = 1;
});
