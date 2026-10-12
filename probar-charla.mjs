// ============================================================================
//  probar-charla.mjs  |  El bot charla con mayoristas simulados por otra IA.
//  Cada lead tiene su historia, su forma de escribir, su apuro y sus objeciones, y
//  contesta lo que el bot le pregunta (no un guion fijo). Mide el estilo y el hilo:
//  cuántos mensajes tarda en ofrecer horarios, si preguntó el motivo, los comercios,
//  quién decide, y si repitió preguntas.
//
//  Uso:  railway run --service setter node probar-charla.mjs        (todos)
//        railway run --service setter node probar-charla.mjs 3      (solo el 3)
// ============================================================================
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, KNOWLEDGE, RUBRO_REF, SETTINGS, SOCIAL_PROOF, OPENER_VARIANTS, AUDIOS } from './src/persona.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'medium';
const LEAD_MODEL = 'claude-haiku-5-5';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const reasoning = (e) => ({ thinking: { type: 'adaptive' }, output_config: { effort: e } });

const SLOTS = ['hoy lunes 13 a las 16:00', 'hoy lunes 13 a las 16:30', 'mañana martes 14 a las 14:00'];
function botSystem(nombre) {
  const ctx = [
    'contexto en vivo (no lo menciones salvo que haga falta):',
    '- HOY es lunes 13 de octubre, son las 14:00 (zona America/Argentina/Buenos_Aires).',
    `- las llamadas duran ${SETTINGS.callDurationMin} minutos`,
    '- horario en que podés agendar: lunes a viernes de 10:00 a 12:00 y de 14:00 a 19:00',
    '- ofrecé como mucho 2 horarios por mensaje',
    '- botones de horario: no',
    `- antes de tu primer mensaje ya le salió tu audio de apertura, que dice: "${AUDIOS.apertura}". No te presentes de nuevo.`,
    `- el lead se llama ${nombre}`,
    `- horarios libres reales del calendario (esto reemplaza a la herramienta get_available_slots en esta prueba): ${SLOTS.join(' / ')}. NO inventes otros.`,
    `- pruebas sociales (usá SOLO si desconfía o duda de si funciona): ${SOCIAL_PROOF.map((s) => `"${s}"`).join('; ')}`,
  ].join('\n');
  const base = `${SYSTEM_PROMPT}\n\n--- conocimiento del negocio ---\n${KNOWLEDGE.trim()}\n\n--- referencia de rubros ---\n${RUBRO_REF.trim()}`;
  return [{ type: 'text', text: base, cache_control: { type: 'ephemeral' } }, { type: 'text', text: ctx }];
}

// Espejo de limpiarGlobo + normalizarSignos de whatsapp.js (sin el azar del "?").
const COMENTA_PAUTA_RE = /[^.?!]*\b(algo serio|con (ese|eso|este|un) (rango|presupuesto|monto|n[uú]mero|mill[oó]n)|ya ten[eé]s margen|(entra|est[aá]s|est[aá]) en el rango|as[ií] que seguimos)[^.?!]*[.?!]?\s*/gi;
const META_RE = /\brespuesta:|sin emojis|^nota:|\bel lead\b|\bhuecos?\b|^ofrec[ée][ \s:,]|^ofrezco\b|\btoca (coordinar|ofrecer)\b|nota interna|get_available_slots|book_call|cancel_booking|<invoke|<\/?parameter/i;
function globos(txt) {
  return String(txt).split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^(entendido|ok)\s*,?\s*(no\b[^:]{0,40}:|no,?\s*(perd[oó]n|nada de eso)[^:]{0,30}:?)\s*/i, '').replace(COMENTA_PAUTA_RE, '').trim())
    .filter((l) => l && !META_RE.test(l) && !/^\[\[/.test(l) && !/^\[fin\]$/i.test(l))
    .map((l) => { let t = l.replace(/[¿¡]/g, '').replace(/\s*([?!])/g, '$1'); if (/[^.]\.$/.test(t)) t = t.slice(0, -1); return t; });
}

const LEADS = [
  { nombre: 'Martín', titulo: 'Fábrica de calzado que vende a distribuidores, contesta corto',
    persona: 'Tenés una fábrica de calzado en San Martín (GBA) con 18 empleados. Le vendés a distribuidores que a su vez le venden a zapaterías del interior. Los clientes nuevos te llegan por conocidos y no lo medís. Escribiste porque querés dejar de depender de los conocidos y llegar directo a zapaterías del interior. Nunca hiciste publicidad. Le vendés a unas 60 zapaterías a través de los distribuidores y a 8 distribuidores. Podés poner unos 600 mil por mes en publicidad. Lo decidís con tu hermano. Contestás muy corto, informal, con alguna abreviatura (q, mas q nada).',
    primero: 'Hola' },
  { nombre: 'Gustavo', titulo: 'Eléctricos, desconfiado: probó Instagram y le llegaron curiosos',
    persona: 'Tenés una distribuidora de materiales eléctricos en Rosario, 22 empleados, le vendés a casas de electricidad e instaladores. El año pasado pagaste a un chico para hacer anuncios en Instagram y te escribían particulares pidiendo un cable. Desconfiás de las agencias. Preguntás en algún momento si esto funciona para tu rubro. Le vendés a unos 180 comercios. Podés poner 1 millón por mes. Decidís vos solo. Escribís normal, sin vueltas.',
    primero: 'buenas, vi el anuncio' },
  { nombre: 'Carla', titulo: 'Golosinas, apurada: quiere horarios ya',
    persona: 'Tenés una distribuidora de golosinas en Lanús que le vende a kioscos. Estás apurada: en tu segundo o tercer mensaje pedís "pasame horarios". Si te preguntan publicidad, decís 500 mil. Decidís vos. Contestás muy corto.',
    primero: 'hola quiero la llamada' },
  { nombre: 'Diego', titulo: 'Importador de bazar charlatán: cuenta todo de entrada',
    persona: 'Sos importador de bazar y regalería, vendés a bazares de todo el país, 15 empleados. Te gusta hablar. En tu primer mensaje contás qué vendés, a quién y que este año importaste el doble y tenés stock parado en el depósito, por eso querés sumar comercios. Te llegan comercios por ferias (la de Tecnópolis y la de Buenos Aires Market). Le vendés a unos 120 bazares. Podés poner 800 mil por mes. Lo decidís con tu socio. Escribís largo, con detalles.',
    primero: 'hola sebastian como va? te cuento, somos importadores de bazar y regaleria, le vendemos a bazares de todo el pais. este año traje el doble de mercaderia y tengo stock parado en el deposito, necesito sumar comercios si o si' },
  { nombre: 'Rubén', titulo: 'Ferretería mayorista, pregunta el precio dos veces',
    persona: 'Tenés un mayorista de ferretería en Córdoba que le vende a ferreterías de la provincia. Antes de contar nada preguntás cuánto sale, y si no te dan un número, insistís una vez más. Después contestás normal: te llegan clientes por un viajante, querés llegar a otras provincias, le vendés a 90 ferreterías, podés poner 700 mil, decidís vos.',
    primero: 'hola cuanto sale?' },
  { nombre: 'Lucía', titulo: 'Fuera del rubro: revendedora por catálogo',
    persona: 'Vendés cosmética por catálogo a clientas finales y armás revendedoras. Querés más revendedoras. Contestás corto.',
    primero: 'hola info' },
  { nombre: 'Marcelo', titulo: 'Alimentos, publicidad por debajo del piso',
    persona: 'Tenés una distribuidora chica de alimentos secos en Mar del Plata que le vende a almacenes. Te llegan por recomendación. Querés crecer porque perdiste dos clientes grandes. Le vendés a 40 almacenes. De publicidad podés poner 250 mil por mes, no más. Decidís vos. Escribís normal.',
    primero: 'hola' },
];

async function leadResponde(L, historial) {
  const conv = historial.map((m) => `${m.role === 'bot' ? 'Martín (el de la agencia)' : 'vos'}: ${m.text}`).join('\n');
  const r = await client.messages.create({
    model: LEAD_MODEL, max_tokens: 1200, ...reasoning('low'),
    system: `Sos un dueño de PyME argentino que le escribió por WhatsApp a Martín Acosta desde un anuncio. ${L.persona}
Respondé SOLO tu próximo mensaje de WhatsApp, como lo escribirías vos: castellano de Argentina, informal, sin signos de apertura. Contestá lo que te preguntan, sin dar información que no te pidieron (salvo que tu personaje sea charlatán). Si te ofrecen horarios y te parece bien, elegí uno escribiendo la hora. Si te confirman la llamada, contestá algo corto como "dale gracias". Nada de comillas ni de explicar lo que hacés.`,
    messages: [{ role: 'user', content: `La charla hasta ahora:\n${conv}\n\nTu próximo mensaje:` }],
  });
  let t = r.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim().replace(/^"|"$/g, '');
  if (!t) {
    const r2 = await client.messages.create({ model: LEAD_MODEL, max_tokens: 300, system: 'Sos un dueño de PyME argentino charlando por WhatsApp. ' + L.persona + ' Respondé solo tu próximo mensaje, corto.', messages: [{ role: 'user', content: `La charla:
${conv}

Tu próximo mensaje:` }] });
    t = r2.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim() || 'dale';
  }
  return t;
}

const REGLAS = [
  [/—/, 'raya'], [/\bjaja\b|\bxq\b|\btmb\b/i, 'muy informal'], [/\bagencia\b/i, 'dice agencia'],
  [/\b(primera|segunda|última)\s*:/i, 'numera preguntas'], [/\b(entendido|excelente|le comento|quedo atento)\b/i, 'frase de empresa'],
  [/te garantizo|garantizamos|vas a vender|300 consultas/i, 'promete resultados'], [/\bleads?\b|\bB2B\b|funnel|embudo/i, 'jerga'],
  [/si no lo med[ií]s|el problema (es|tuyo)|te est[aá]s perdiendo/i, 'marca una falla suya'],
  [/sebasti[aá]n otaviani/, 'nombre propio en minúscula'],
];

const resultados = [];
const USO = {};
async function correr(L, idx) {
  console.log('\n' + '='.repeat(74) + `\nLEAD ${idx + 1}  |  ${L.titulo}\n` + '='.repeat(74));
  const sys = botSystem(L.nombre);
  const api = [{ role: 'user', content: L.primero }];
  const hist = [{ role: 'lead', text: L.primero }];
  console.log('  LEAD   ' + L.primero);
  console.log('   BOT   (audio) ' + AUDIOS.apertura);
  let turnosBot = 0, ofrecioEn = null, agendo = false, fallos = [];
  const preguntas = [];
  for (let vuelta = 0; vuelta < 14; vuelta++) {
    const r = await client.messages.create({ model: MODEL, max_tokens: 2500, ...reasoning(EFFORT), system: sys, messages: api });
    for (const k of ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens']) USO[k] = (USO[k] || 0) + (r.usage?.[k] || 0);
    const txt = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const gs = globos(txt);
    turnosBot++;
    gs.forEach((g) => console.log('   BOT   ' + g));
    for (const g of gs) {
      for (const [re, regla] of REGLAS) if (re.test(g)) fallos.push(`${regla}: "${g.slice(0, 90)}"`);
      for (const q of g.split(/(?<=\?)/).map((x) => x.trim()).filter((x) => x.endsWith('?'))) {
        const n = q.toLowerCase().replace(/[^a-záéíóúñ ]/g, '');
        if (preguntas.includes(n)) fallos.push(`repite la pregunta: "${q.slice(0, 80)}"`);
        preguntas.push(n);
      }
    }
    const dicho = gs.join(' ');
    api.push({ role: 'assistant', content: txt || '...' });
    hist.push({ role: 'bot', text: dicho });
    if (ofrecioEn == null && /\b(16|16:30|14)(:00|:30)?\b.*(te sirve|te queda|cu[aá]l)/i.test(dicho)) ofrecioEn = turnosBot;
    if (/te agend[eé]|qued[oó] (agendad|el |para)/i.test(dicho)) { agendo = true; break; }
    if (!gs.length) break; // [fin]: el bot dio la charla por terminada
    if (/no te puedo ofrecer|hoy trabajamos desde/i.test(dicho) && !/ahí sí/i.test(dicho)) {
      const sig = await leadResponde(L, hist); console.log('  LEAD   ' + sig);
      if (!/(puedo|llego|subo|pongo).*(500|más)/i.test(sig)) break;
      api.push({ role: 'user', content: sig }); hist.push({ role: 'lead', text: sig }); continue;
    }
    const sig = await leadResponde(L, hist);
    console.log('  LEAD   ' + sig);
    api.push({ role: 'user', content: sig });
    hist.push({ role: 'lead', text: sig });
  }
  const todo = hist.filter((m) => m.role === 'bot').map((m) => m.text).join(' ');
  const res = {
    lead: idx + 1, titulo: L.titulo, turnosBot, ofrecioEn, agendo,
    motivo: /qu[eé] te llev[oó]|qu[eé] te hizo|por qu[eé] ahora|qu[eé] te mov|qu[eé] te motiv|qu[eé] te trajo|por qu[eé] te interes|qu[eé] buscás|cómo surgió|que te llevo/i.test(todo),
    comercios: /a cu[aá]ntos (comercios|kioscos|bazares|ferreter|almacenes|zapater|clientes)|cu[aá]ntos (comercios|clientes) (ten[eé]s|te compran)/i.test(todo),
    publicidad: /cu[aá]nto (pensabas|podr[ií]as|pod[eé]s|ten[eé]s pensado) (poner|invertir)|de publicidad/i.test(todo),
    decisor: /lo (ves|decid[ií]s) (vos )?solo|con alguien m[aá]s|tu socio|sumalo/i.test(todo),
    fallos,
  };
  resultados.push(res);
}

const solo = process.argv[2] ? Number(process.argv[2]) : null;
const lista = solo ? [LEADS[solo - 1]] : LEADS;
console.log(`bot: ${MODEL} (${EFFORT})  |  leads simulados: ${LEAD_MODEL}  |  charlas: ${lista.length}`);
for (let i = 0; i < lista.length; i++) await correr(lista[i], solo ? solo - 1 : i);

console.log('\n' + '='.repeat(74) + '\nRESUMEN\n' + '='.repeat(74));
for (const r of resultados) {
  console.log(`lead ${r.lead} | ${r.titulo}`);
  console.log(`   mensajes del bot: ${r.turnosBot} | ofreció horarios en el mensaje: ${r.ofrecioEn ?? '-'} | agendó: ${r.agendo ? 'sí' : 'no'} | motivo: ${r.motivo ? 'sí' : 'no'} | comercios: ${r.comercios ? 'sí' : 'no'} | quién decide: ${r.decisor ? 'sí' : 'no'} | publicidad: ${r.publicidad ? 'sí' : 'no'}`);
  for (const f of r.fallos) console.log('   FALLO  ' + f);
}
console.log('USO DE TOKENS DEL BOT:', JSON.stringify(USO));
