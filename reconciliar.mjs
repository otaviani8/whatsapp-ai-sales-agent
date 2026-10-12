#!/usr/bin/env node
import { ENV } from './src/config.js';
import * as cola from './src/cola-conversiones.js';
import { leerRegistro, ganados } from './src/ventas.js';
import { allLeads } from './src/store.js';

// ============================================================================
//  LA RECONCILIACION SEMANAL. Pone al lado tres numeros que casi nunca dan
//  igual: lo que dice el registro de leads, lo que efectivamente le devolvimos
//  a Meta, y lo que Meta informa.
//
//  LA DIFERENCIA NO ES UN ERROR: ES INFORMACION. Si crece, o se rompio la
//  medicion o aparecio un canal nuevo (spec §6.8, punto 4: el balde no
//  atribuible se reporta como propio y no se reparte). Repartirlo
//  proporcionalmente es la practica estandar y lo unico que hace es inflar el
//  ROAS.
//
//  Y ES EL ARGUMENTO COMERCIAL. La objecion mas dificil de contestar que tiene
//  una agencia es "Meta me dice otra cosa". Esta tabla es la respuesta: dice
//  exactamente cuanto se devolvio, cuanto no, y por que no.
//
//  USO
//    node reconciliar.mjs               ultimos 7 dias
//    node reconciliar.mjs --dias 30
//    node reconciliar.mjs --json
// ============================================================================

const args = process.argv.slice(2);
const valorDe = (f, def) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const JSON_OUT = args.includes('--json');
const DIAS = Number(valorDe('--dias', '7')) || 7;

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const money = (n) => `${ENV.META_CURRENCY} ${Number(n || 0).toLocaleString('es-AR')}`;
const fecha = (ms) => new Date(ms).toISOString().slice(0, 10);
const suma = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);

// Trae lo que informa Meta. Es opcional a proposito: sin cuenta publicitaria
// la reconciliacion igual sirve, solo le falta la tercera columna.
//
// NO inventamos el action_type: Meta cambia esos nombres seguido y clavar uno
// es garantia de reportar cero cuando en realidad hay datos. Traemos la lista
// entera y mostramos todo lo que huela a compra o a mensajeria.
async function traerDeMeta(desdeIso, hastaIso) {
  if (!ENV.META_AD_ACCOUNT_ID || !ENV.META_ACCESS_TOKEN) return null;
  const act = ENV.META_AD_ACCOUNT_ID.startsWith('act_') ? ENV.META_AD_ACCOUNT_ID : `act_${ENV.META_AD_ACCOUNT_ID}`;
  const url = new URL(`https://graph.facebook.com/${ENV.META_GRAPH_VERSION}/${act}/insights`);
  url.searchParams.set('fields', 'spend,actions,action_values');
  url.searchParams.set('level', 'account');
  url.searchParams.set('time_range', JSON.stringify({ since: desdeIso, until: hastaIso }));
  url.searchParams.set('access_token', ENV.META_ACCESS_TOKEN);
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) return { error: json?.error?.message || `HTTP ${res.status}` };
    const fila = json?.data?.[0] || {};
    const interesa = (t) => /purchase|lead|messaging|conversation/i.test(String(t));
    return {
      spend: Number(fila.spend || 0),
      acciones: (fila.actions || []).filter((a) => interesa(a.action_type)),
      valores: (fila.action_values || []).filter((a) => interesa(a.action_type)),
    };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

async function main() {
  const ahora = Date.now();
  const desde = ahora - DIAS * 24 * 60 * 60 * 1000;

  log('');
  log('════════════════════════════════════════════════════════════════════');
  log(`  RECONCILIACION  ·  ultimos ${DIAS} dias  ·  ${fecha(desde)} → ${fecha(ahora)}`);
  log('════════════════════════════════════════════════════════════════════');

  // --- 1. El registro ------------------------------------------------------
  const leads = allLeads();
  const leadsPeriodo = leads.filter((l) => (l.openedAt || 0) >= desde);
  const conClid = leadsPeriodo.filter((l) => l.ad?.ctwaClid);
  const deAnuncio = leadsPeriodo.filter((l) => l.ad?.sourceId);

  const { registro, avisos } = await leerRegistro();
  const filasGanadas = ganados(registro).filter((f) => (f.fechaVentaMs || f.fechaEstadoMs || 0) >= desde);
  const montoDeclarado = suma(filasGanadas, (f) => f.monto);

  log('');
  log('─ 1. Lo que dice el registro ───────────────────────────────────────');
  log(`  Leads capturados por el bot          ${leadsPeriodo.length}`);
  log(`  … que vinieron de un anuncio         ${deAnuncio.length}`);
  log(`  … con ctwa_clid (devolvibles)        ${conClid.length}`);
  log(`  Ventas declaradas por el vendedor    ${filasGanadas.length}`);
  log(`  Monto declarado                      ${money(montoDeclarado)}`);
  log(`  (los montos los declara el cliente: Acme no los verifica)`);
  for (const a of avisos) log(`  ⚠  ${a}`);

  // --- 2. Lo que le devolvimos a Meta --------------------------------------
  const eventos = cola.todos();
  const enPeriodo = eventos.filter((e) => (e.eventTime ? e.eventTime * 1000 : e.vistoAt || 0) >= desde);
  const enviados = enPeriodo.filter((e) => e.estado === 'enviado');
  const valorEnviado = suma(enviados, (e) => e.valor);

  // events_received es lo que Meta CONFIRMO haber recibido, y no siempre coincide
  // con lo que creemos haber mandado. Sale de la bitacora, no de nuestra cuenta.
  const bitacora = cola.leerBitacora(desde);
  const recibidosPorMeta = suma(bitacora.filter((b) => b.ok), (b) => b?.respuesta?.events_received ?? 0);

  log('');
  log('─ 2. Lo que le devolvimos a Meta ───────────────────────────────────');
  log(`  Eventos enviados y aceptados         ${enviados.length}`);
  log(`  Valor devuelto                       ${money(valorEnviado)}`);
  log(`  events_received que confirmo Meta    ${recibidosPorMeta}`);
  log(`  Envios registrados en la bitacora    ${bitacora.length}`);

  // --- 3. El balde -------------------------------------------------------
  const baldes = {};
  for (const e of enPeriodo) {
    if (e.estado === 'enviado') continue;
    baldes[e.estado] = baldes[e.estado] || { n: 0, valor: 0, motivos: new Set() };
    baldes[e.estado].n++;
    baldes[e.estado].valor += Number(e.valor) || 0;
    if (e.motivo) baldes[e.estado].motivos.add(e.motivo);
  }

  log('');
  log('─ 3. Lo que NO se devolvio, y por que ──────────────────────────────');
  if (!Object.keys(baldes).length) {
    log('  Nada. Todo lo ganado en el periodo se devolvio.');
  } else {
    for (const [estado, d] of Object.entries(baldes)) {
      log(`  ${estado.padEnd(15)} ${String(d.n).padStart(4)} eventos   ${money(d.valor)}`);
      for (const m of [...d.motivos].slice(0, 3)) log(`      · ${m}`);
    }
  }

  // --- 4. Lo que informa Meta ---------------------------------------------
  const deMeta = await traerDeMeta(fecha(desde), fecha(ahora));
  log('');
  log('─ 4. Lo que informa Meta ───────────────────────────────────────────');
  if (!deMeta) {
    log('  Sin META_AD_ACCOUNT_ID: esta columna queda vacia. No es un error,');
    log('  es que no se pidio el acceso a la cuenta publicitaria.');
  } else if (deMeta.error) {
    log(`  ⚠  No pude consultarlo: ${deMeta.error}`);
  } else {
    log(`  Inversion                            ${money(deMeta.spend)}`);
    if (!deMeta.acciones.length) log('  Meta no informa acciones de compra ni de mensajeria en el periodo.');
    for (const a of deMeta.acciones) {
      const v = deMeta.valores.find((x) => x.action_type === a.action_type);
      log(`  ${String(a.action_type).padEnd(42)} ${String(a.value).padStart(6)}${v ? `   ${money(v.value)}` : ''}`);
    }
  }

  // --- 5. La diferencia ----------------------------------------------------
  const brechaEventos = filasGanadas.length - enviados.length;
  const brechaValor = montoDeclarado - valorEnviado;

  log('');
  log('─ 5. La diferencia ─────────────────────────────────────────────────');
  log(`  Ventas en el registro que Meta no vio   ${brechaEventos}`);
  log(`  Valor que Meta no vio                   ${money(brechaValor)}`);
  log('');
  if (brechaEventos > 0) {
    const pct = filasGanadas.length ? Math.round((brechaEventos / filasGanadas.length) * 100) : 0;
    log(`  El ${pct}% de las ventas declaradas no llego a Meta. El desglose del`);
    log('  punto 3 dice exactamente por que. Lo que hay que mirar es si ese');
    log('  porcentaje SUBE mes a mes: si sube, se rompio algo. Si se mantiene,');
    log('  es el costo estructural de medir con honestidad.');
  } else {
    log('  Todo lo declarado se devolvio. La diferencia contra el numero que');
    log('  muestra Meta, si la hay, es de su modelo de atribucion, no nuestra.');
  }
  log('');

  if (JSON_OUT) {
    console.log(JSON.stringify({
      periodo: { desde: fecha(desde), hasta: fecha(ahora), dias: DIAS },
      registro: {
        leads: leadsPeriodo.length, deAnuncio: deAnuncio.length, conCtwaClid: conClid.length,
        ventas: filasGanadas.length, montoDeclarado,
      },
      devuelto: { eventos: enviados.length, valor: valorEnviado, eventsReceived: recibidosPorMeta },
      baldes: Object.fromEntries(Object.entries(baldes).map(([k, v]) => [k, { n: v.n, valor: v.valor, motivos: [...v.motivos] }])),
      meta: deMeta,
      diferencia: { eventos: brechaEventos, valor: brechaValor },
    }, null, 2));
  }
}

main().catch((e) => {
  console.error('\n✖ La reconciliacion fallo:', e?.message || e, '\n');
  process.exitCode = 1;
});
