// ============================================================================
//  probar-voz.mjs  |  Corre el prompt REAL contra la API y muestra qué dice el bot.
//
//  Sirve para ver la voz de verdad, no la que uno imagina leyendo el prompt.
//  Arma el system prompt igual que brain.js (SYSTEM_PROMPT + KNOWLEDGE + RUBRO_REF
//  + contexto en vivo) y stubea las herramientas de calendario.
//
//  Uso:
//    railway run --service setter node probar-voz.mjs           (todos los guiones)
//    railway run --service setter node probar-voz.mjs 3         (solo el guion 3)
// ============================================================================
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, KNOWLEDGE, RUBRO_REF, SETTINGS, SOCIAL_PROOF, OPENER_VARIANTS, AUDIOS } from './src/persona.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Espejo exacto de brain.js: mismo thinking, mismo effort, mismo techo de tokens.
const EFFORT = process.env.CLAUDE_EFFORT || 'low';
const SUPPORTS_REASONING = /(opus-4-[5-9]|sonnet-4-6|opus-5|sonnet-5|haiku-5|fable-5|mythos-5)/.test(MODEL);
const reasoning = () => (SUPPORTS_REASONING ? { thinking: { type: 'adaptive' }, output_config: { effort: EFFORT } } : {});

// Los dos huecos que devolvería el calendario. Fijos para que el guion sea reproducible.
// Se agenda en el día con 90 minutos de margen (SETTINGS.minLeadMinutes): son las 14:00, los huecos son de la tarde.
const SLOTS = ['hoy lunes 13 a las 16:00', 'hoy lunes 13 a las 16:30'];
const HAY_HORARIO = /16(:00|:30| ?hs|\b)|4 de la tarde|cuatro y media/i;

function buildSystem(lead) {
  const ctx = [
    'contexto en vivo (no lo menciones salvo que haga falta):',
    '- HOY es lunes 13 de octubre, son las 14:00 (zona America/Argentina/Buenos_Aires).',
    `- las llamadas duran ${SETTINGS.callDurationMin} minutos`,
    '- horario en que podés agendar: lunes, martes, miércoles, jueves, viernes de 10:00 a 12:00 y de 14:00 a 19:00',
    `- ofrecé como mucho ${SETTINGS.maxSlotsToOffer} horarios por mensaje`,
    '- botones de horario: no',
    `- el lead se llama ${lead.nombre}`,
    `- huecos libres reales del calendario: ${SLOTS.join(' / ')}. NO inventes otros.`,
    `- link de la videollamada: https://meet.google.com/rzk-dmds-jat`,
    SOCIAL_PROOF?.length
      ? `- pruebas sociales (usá SOLO si desconfía o duda de si funciona): ${SOCIAL_PROOF.map((s) => `"${s}"`).join('; ')}`
      : null,
  ].filter(Boolean).join('\n');

  let base = `${SYSTEM_PROMPT}\n\n--- conocimiento del negocio (usalo para responder dudas y objeciones con precisión; NO expliques de más, redirigí siempre a la llamada) ---\n${KNOWLEDGE.trim()}`;
  base += `\n\n--- referencia de rubros (hablá el idioma del rubro del lead; usá SOLO el bloque que corresponde, NO lo recites) ---\n${RUBRO_REF.trim()}`;
  return [
    { type: 'text', text: base, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: ctx },
  ];
}

// Guiones del proceso de venta del 07/10/2026 (sin garantía, el dueño en primera persona, tres
// preguntas con botones, piso de 400 mil pesos). `espera`: lo que el bot tiene que decir (true) o no
// puede decir (false) en toda la charla.
const NO_HONORARIO = [/500 d[oó]lares|honorario (es )?de \d/i, false, 'no dice el honorario sin que insista'];
const NO_PROMESA = [/te garantizo|garantizamos|te aseguro que (vas a|van a)|300 consultas|vas a vender/i, false, 'no promete resultados'];
// 07/10 noche: sin botones (el A/B de botones en horarios queda en "no" para estas pruebas) y sin numerar preguntas.
const NO_BOTONES = [/\[\[/, false, 'sin botones'];
const NO_NUMERA = [/\b(primera|segunda|última|ultima)\s*:/i, false, 'no numera las preguntas'];
const NO_NICOLAS = [/Nicol[aá]s/, false, 'no aparece Nicolás'];
const GUIONES = [
  { nombre: 'Martín', titulo: 'Distribuidora de limpieza, camino directo',
    lead: ['distribuidora de articulos de limpieza, le vendemos a almacenes y autoservicios de zona sur', 'por los preventistas y algun conocido que nos recomienda', '$500 mil a $1 M', 'Lun 13 · 16:30'],
    espera: [NO_BOTONES, NO_NUMERA, [HAY_HORARIO, true, 'ofrece horario'], NO_HONORARIO, NO_PROMESA, NO_NICOLAS] },
  { nombre: 'Rubén', titulo: 'Pregunta el precio dos veces',
    lead: ['hola, cuanto sale?', 'pero decime un numero aproximado', 'mayorista de ferreteria, le vendemos a ferreterias de provincia', 'el viajante y nada mas', 'Más de $1 millón', 'Lun 13 · 16:00'],
    espera: [[/500 d[oó]lares/, true, 'dice el honorario cuando insiste'], [/400 mil/, true, 'dice el piso de la publicidad'], [HAY_HORARIO, true, 'ofrece horario'], NO_PROMESA] },
  { nombre: 'Laura', titulo: 'La publicidad le trajo curiosos',
    lead: ['importamos bazar y regaleria, le vendemos a comercios', 'probe anuncios el año pasado y me llenaron el whatsapp de gente que queria comprar una taza', '$500 mil a $1 M', 'hoy 16 me sirve'],
    espera: [[/preguntas|qu[eé] negocio|zona|m[ií]nimo/i, true, 'explica el filtro de preguntas'], [HAY_HORARIO, true, 'ofrece horario'], NO_PROMESA] },
  { nombre: 'Diego', titulo: 'Pide casos antes de contar nada',
    lead: ['distribuidora de alimentos, 26 empleados. antes de contarte nada quiero saber si tienen algun cliente como yo', 'le vendemos a almacenes y autoservicios del conurbano', 'por recomendacion', 'Más de $1 millón', 'hoy 16:30'],
    espera: [[/materiales el[eé]ctricos/, true, 'usa el caso de las pruebas sociales'], [/vendi[óo]|factur/i, false, 'no inventa ventas del caso'], [HAY_HORARIO, true, 'ofrece horario']] },
  { nombre: 'Gustavo', titulo: 'Pide garantía',
    lead: ['distribuidora de electricidad, le vendemos a casas de electricidad del interior', 'me garantizan que vendo? cuantos clientes me traen?', 'por los viajantes', '$500 mil a $1 M', 'hoy 16'],
    espera: [[/ventas no|no te puedo garantizar|no puedo garantizar/i, true, 'aclara que no garantiza ventas'], NO_PROMESA, [HAY_HORARIO, true, 'ofrece horario']] },
  { nombre: 'Carla', titulo: 'Publicidad por debajo del piso',
    lead: ['distribuidora de golosinas, le vendemos a kioscos', 'yo misma salgo a visitar', 'Menos de $400 mil', 'y si llego a 600 mil?', 'hoy 16:30'],
    espera: [[/400 mil pesos/, true, 'dice el piso de 400 mil'], [HAY_HORARIO, true, 'ofrece horario cuando sube']] },
  { nombre: 'Sofía', titulo: 'Fuera del rubro: vende al público',
    lead: ['tengo una tienda de ropa, vendo por instagram al publico', 'no, solo al publico'],
    espera: [[HAY_HORARIO, false, 'no ofrece horario'], [/comercios/i, true, 'explica con quién trabaja']] },
  { nombre: 'Hernán', titulo: 'Pregunta si es un bot y suma al socio',
    lead: ['sos un bot?', 'somos fabrica de pastas secas, le vendemos directo a almacenes y a distribuidores', 'boca en boca', 'Más de $1 millón', 'lo tengo que ver con mi socio', 'hoy 16:30 con mi socio'],
    espera: [[/asistente/i, true, 'admite el asistente'], [/socio|sumalo|los dos/i, true, 'invita al socio'], [HAY_HORARIO, true, 'ofrece horario'], NO_NICOLAS] },
  { nombre: 'Gabriela', titulo: 'Pide hablar con un cliente antes de agendar',
    lead: ['importadora de bazar, le vendemos a bazares y regalerías de todo el país', 'quienes son ustedes? que experiencia tienen?', 'puedo hablar con algun cliente tuyo antes?', 'por ferias', 'Más de $1 millón', 'hoy 16'],
    espera: [[/en la llamada te paso el contacto|te paso el contacto/i, true, 'el contacto va en la llamada'], [/\d{4}[\s-]?\d{4}/, false, 'no da teléfonos de clientes por chat'], [HAY_HORARIO, true, 'ofrece horario']] },
];

// Espejo de normalizarSignos() en whatsapp.js: esto es lo que el lead recibe
// de verdad, no lo que devuelve el modelo. Sin esto el harness marca fallos de
// puntuación que la capa de envío ya corrige.
function normalizarSignos(s) {
  let t = String(s).replace(/[¿¡]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
  if (!t) return t;
  t = t.replace(/\s*([?!])/g, '$1');
  if (/[^.]\.$/.test(t)) t = t.slice(0, -1);
  if (!/^(Mart[ií]n|Acosta|Acme|Meta|Google)\b/.test(t) && !/^[A-ZÁÉÍÓÚÑ]{2,}\b/.test(t)) t = t.charAt(0).toLowerCase() + t.slice(1);
  return t;
}
// Espejo del filtro META_RE de whatsapp.js: esas líneas no le llegan al lead, pero se anotan.
const META_RE = /\brespuesta:|sin emojis|^nota:|\bel lead\b|\bhuecos?\b|^ofrec[ée][ \s:,]|^ofrezco\b|\btoca (coordinar|ofrecer)\b|nota interna|get_available_slots|book_call|cancel_booking/i;
const filtradas = [];
const COMENTA_PAUTA_RE = /[^.?!]*\b(algo serio|con (ese|eso|este|un) (rango|presupuesto|monto|n[uú]mero|mill[oó]n)|ya ten[eé]s margen)[^.?!]*[.?!]?\s*/gi;
function limpiarGlobo(line) {
  return String(line)
    .replace(/^(entendido|ok)\s*,?\s*(no\b[^:]{0,40}:|no,?\s*(perd[oó]n|nada de eso)[^:]{0,30}:?)\s*/i, '')
    .replace(/^[^:]{0,40}\bquise decir:\s*/i, '')
    .replace(COMENTA_PAUTA_RE, '')
    .replace(/^(entendido|perfecto)[,.]\s*/i, '')
    .trim();
}
function globos(txt) {
  return txt.split('\n').map((l) => normalizarSignos(limpiarGlobo(l))).filter(Boolean).filter((l) => {
    if (META_RE.test(l)) { filtradas.push(l); return false; }
    return true;
  });
}

// --- Auditoría automática de lo que el bot realmente dijo -------------------
const REGLAS = [
  [/¿|¡/, 'signo de apertura'],
  [/\b(primera|segunda|última)\s*:/i, 'numera las preguntas'],
  [/\b(entendido|excelente|le comento|quedo atento|a la brevedad)\b/i, 'frase de empresa, muy formal'],
  [/—/, 'em dash'],
  [/\bguita\b|\bjaja\b|\bsisi\b|\bxq\b|\btmb\b/i, 'registro demasiado informal'],
  [/queda (bastante )?corto|queda (bastante )?(por )?debajo|queda lejos|es poco|no alcanza|es bajo|otra escala|esa escala|cuando crezcas/i, 'evalúa el tamaño del lead'],
  [/no (somos|es) una agencia|a diferencia de otros|no como los que/i, 'se compara contra la categoría'],
  [/costo por consulta|un solo n[uú]mero|contra un solo|dos n[uú]meros, no uno/i, 'recita el indicador como discurso'],
  [/\bya es (una|un) \w+/i, 'plantilla "ya es una ___"'],
  [/\banos\b/, 'perdio la enie: escribio anos'],
  [/\b(once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veinti\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento)\b(?!\s+(minutos|dolares))/i, 'numero en letras en vez de cifras'],
  [/estás en el rango|calificás|cumplís con el mínimo|sos el perfil/i, 'le avisa que lo filtra'],
  [/invitaci[óo]n al mail|te llega la invitaci[óo]n|revisá tu casilla/i, 'invitación por mail'],
  [/buena pregunta|muy buena pregunta|me alegra que preguntes/i, 'califica la pregunta del lead'],
  [/ya es una operaci[óo]n con volumen|algo serio|algo interesante|buen rubro|buena base|buen presupuesto|ya tenés margen|se puede trabajar bien|qué bueno|excelente|qué interesante/i, 'muletilla de relleno'],
  [/trata direct[oa] con Mart[ií]n/i, 'dice que trata directo con Martín'],
  [/\bagencia\b/i, 'usa "agencia" para nosotros'],
  [/embudo|funnel|ROAS|\bCTR\b|\bCPC\b|\b(el|de|por|en) alcance\b|impresiones/i, 'palabra del oficio'],
  [/quedo a disposici[óo]n|sin compromiso|última oportunidad/i, 'fórmula de vendedor'],
  [/no voy a preguntarte|no te voy a preguntar/i, 'anuncia lo que no va a hacer'],
  // Restos de la oferta vieja
  [/\bniveles?\b|plan (b[aá]sico|premium|pro)\b|tres planes/i, 'habla de niveles (oferta vieja)'],
  [/\bleads?\b|\bB2B\b/i, 'jerga en inglés'],
];

const fallos = [];
function auditar(guion, texto) {
  for (const linea of globos(texto)) {
    for (const [re, regla] of REGLAS) {
      if (re.test(linea)) fallos.push({ guion, regla, linea });
    }
    // Pregunta sin cerrar: el interrogativo abre la oración pero no hay "?".
    for (const f of linea.split(/(?<=[.?!])\s+/)) {
      const s = f.trim();
      if (/^(Y |Pero |Entonces |Ahora |Contame,? |Decime,? )?(Qué|Cuánto|Cuántos|Cuánta|Cuántas|Cuál|Cómo|Dónde|Quién|Por qué)\b/i.test(s) && !/\?$/.test(s)) {
        fallos.push({ guion, regla: 'pregunta sin cerrar con "?"', linea: s });
      }
    }
  }
}

async function correr(g, idx) {
  console.log('\n' + '='.repeat(74));
  console.log(`GUION ${idx + 1}  |  ${g.titulo}`);
  console.log('='.repeat(74));

  const sys = buildSystem({ nombre: g.nombre });
  const messages = [];

  // Opener: el bot arranca. Se usa la variante A tal cual la manda whatsapp.js.
  // Opener: variante "audio" tal cual la manda whatsapp.js (el audio entra al historial como nota).
  const opener = OPENER_VARIANTS[0].globos.map((s) => s.replace('{nombre}', g.nombre));
  console.log('   BOT   (audio) ' + AUDIOS.apertura);
  opener.forEach((s) => console.log('   BOT   ' + s));
  messages.push({ role: 'assistant', content: `[audio enviado: "${AUDIOS.apertura}"]` });
  messages.push({ role: 'assistant', content: opener.join('\n') });

  for (const msg of g.lead) {
    console.log('  LEAD   ' + msg);
    messages.push({ role: 'user', content: msg });
    let txt = '';
    try {
      const r = await client.messages.create({
        model: MODEL, max_tokens: 700, ...reasoning(), system: sys, messages,
      });
      txt = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!txt) console.log('   ***   respuesta vacia (stop_reason: ' + r.stop_reason + ')');
    } catch (e) {
      console.log('   ***   ERROR de API: ' + e.message);
      continue;
    }
    globos(txt).forEach((s) => console.log('   BOT   ' + s));
    auditar(idx + 1, txt);
    messages.push({ role: 'assistant', content: txt });
  }

  // Lo que el guion espera que el bot diga (o no diga) en toda la charla.
  const dicho = messages.slice(2).filter((m) => m.role === 'assistant').map((m) => normalizarSignos(m.content)).join('\n');
  for (const [re, debe, desc] of g.espera || []) {
    if (re.test(dicho) !== debe) fallos.push({ guion: idx + 1, regla: 'esperado: ' + desc, linea: '(toda la charla)' });
  }
}

const solo = process.argv[2] ? Number(process.argv[2]) : null;
const lista = solo ? [GUIONES[solo - 1]] : GUIONES;
console.log(`modelo: ${MODEL}   |   guiones: ${lista.length}`);
for (let i = 0; i < lista.length; i++) await correr(lista[i], solo ? solo - 1 : i);

console.log('\n' + '='.repeat(74));
console.log('AUDITORIA DE LO QUE EL BOT DIJO DE VERDAD');
console.log('='.repeat(74));
if (filtradas.length) console.log(`(${filtradas.length} globos filtrados por META_RE, no llegan al lead: ${filtradas.map((l) => '"' + l.slice(0, 60) + '"').join(' · ')})\n`);
if (!fallos.length) {
  console.log('Sin fallos. Se cumplieron todas las reglas de voz.');
} else {
  console.log(`${fallos.length} fallos:\n`);
  for (const f of fallos) console.log(`  guion ${f.guion}  |  ${f.regla}\n      "${f.linea.slice(0, 100)}"`);
}
process.exit(fallos.length ? 1 : 0);
