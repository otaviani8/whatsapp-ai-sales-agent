import Anthropic from '@anthropic-ai/sdk';
import { ENV } from './config.js';
import {
  SETTINGS, SYSTEM_PROMPT, SOCIAL_PROOF, KNOWLEDGE, RUBRO_REF,
  FOLLOWUP_DIRECTIVE, BREAKUP_DIRECTIVE, REMINDER_DIRECTIVE, NOSHOW_DIRECTIVE, BOOKED_DIRECTIVE, OPENER_AD_DIRECTIVE,
} from './persona.js';
import { getAvailableSlots, bookCall, humanLabel, diversifySlots, localParts } from './calendar.js';
import { firstName } from './util.js';
import { resumenTexto } from './resumen.js';

function localHourOf(startIso, tz) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(startIso)));
}
function localDayKey(d, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// Arma la lista que el bot OFRECE: por día, el bloque temprano CONSECUTIVO (para llenar de las 10 hacia
// arriba, escalonado) + un muestreo de la tarde (para cubrir pedidos puntuales), todo en orden cronológico.
function buildOfferList(slots, tz, denseEarly = 5, sampleLater = 4) {
  const byDay = new Map();
  for (const s of slots) {
    const k = localDayKey(new Date(s.startIso), tz);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  const out = [];
  for (const arr of byDay.values()) {
    out.push(...arr.slice(0, denseEarly));
    const rest = arr.slice(denseEarly);
    if (rest.length <= sampleLater) out.push(...rest);
    else { const step = (rest.length - 1) / (sampleLater - 1); for (let i = 0; i < sampleLater; i++) out.push(rest[Math.round(i * step)]); }
  }
  out.sort((a, b) => a.startIso.localeCompare(b.startIso));
  return out;
}
// "hoy" / "mañana" / "pasado mañana" según la fecha local del hueco vs ahora (null si está más lejos).
function relDay(startIso, tz) {
  const a = localParts(new Date(), tz);
  const b = localParts(new Date(startIso), tz);
  const diff = Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86400000);
  return diff === 0 ? 'hoy' : diff === 1 ? 'mañana' : diff === 2 ? 'pasado mañana' : null;
}

let _client = null;
const client = () => (_client ??= new Anthropic({ apiKey: ENV.ANTHROPIC_API_KEY }));

// effort: appointment-setting es una tarea simple y sensible a la latencia (el
// lead está esperando), así que vamos con "low" por default. Configurable.
const EFFORT = process.env.CLAUDE_EFFORT || 'low';

// Haiku 4.5, Sonnet 4.5 y anteriores NO soportan adaptive
// thinking ni output_config.effort: mandárselos da error 400. Detectamos el
// modelo y solo agregamos esos campos donde el modelo los banca.
const SUPPORTS_REASONING = /(opus-4-[5-9]|sonnet-4-6|opus-5|sonnet-5|haiku-5|fable-5|mythos-5)/.test(ENV.CLAUDE_MODEL);
const reasoning = () =>
  SUPPORTS_REASONING ? { thinking: { type: 'adaptive' }, output_config: { effort: EFFORT } } : {};

const DAYNAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function workingHoursText() {
  const wh = SETTINGS.workingHours;
  const days = wh.days.map((d) => DAYNAMES[d]).join(', ');
  const franjas = Array.isArray(wh.windows) && wh.windows.length
    ? wh.windows.map(([a, b]) => `de ${a} a ${b}`).join(' y ')
    : `de ${wh.start} a ${wh.end}`;
  return `${days} ${franjas}`;
}

function adContextLine(ad) {
  if (!ad || (!ad.title && !ad.body)) return null;
  const parts = [];
  if (ad.title) parts.push(`titular "${String(ad.title).slice(0, 160)}"`);
  if (ad.body) parts.push(`texto "${String(ad.body).slice(0, 160)}"`);
  return `- este lead viene de un anuncio (${parts.join(', ')}). podés referenciar de qué se trata con naturalidad, sin leerlo palabra por palabra ni citarlo entre comillas`;
}

function buildSystem(lead) {
  const p = lead?.profile;
  const ctx = [
    `contexto en vivo (no lo menciones salvo que haga falta):`,
    `- HOY es ${humanLabel(new Date())} (zona ${ENV.TIMEZONE}). tené SIEMPRE presente qué día es hoy: al confirmar o recordar una videollamada referí el día y fecha concretos (ej "el jueves 25 a las 14"); NO uses "mañana/hoy" sin chequear contra la fecha de hoy, porque la charla sigue en días distintos y "mañana" de ayer puede ser "hoy". cada hueco que te da la herramienta ya viene marcado con (hoy)/(mañana) para que no te confundas`,
    `- las llamadas duran ${SETTINGS.callDurationMin} minutos`,
    `- horario en que podés agendar: ${workingHoursText()}`,
    `- ofrecé como mucho ${SETTINGS.maxSlotsToOffer} horarios por mensaje`,
    `- botones de horario: ${lead?.abBotones ? 'sí' : 'no'}`,
    lead?.name ? `- el lead se llama ${firstName(lead.name)}` : null,
    adContextLine(lead?.ad),
    p?.style ? `- estilo del lead (reflejalo): ${p.style}` : null,
    p?.objection && !/^ningun/i.test(p.objection) ? `- objeción a trabajar con tacto: ${p.objection}` : null,
    SOCIAL_PROOF?.length
      ? `- pruebas sociales (usá SOLO si desconfía o duda de si funciona, con naturalidad, sin inventar números ni nombres): ${SOCIAL_PROOF.map((s) => `"${s}"`).join('; ')}`
      : null,
  ].filter(Boolean).join('\n');

  // El conocimiento del negocio (estable) va en el bloque cacheado, junto al
  // system prompt, para que el bot responda dudas con datos reales sin explicar
  // de más (el detalle va en la llamada).
  let base = KNOWLEDGE && KNOWLEDGE.trim()
    ? `${SYSTEM_PROMPT}\n\n--- conocimiento del negocio (usalo para responder dudas y objeciones con precisión; NO expliques de más, redirigí siempre a la llamada) ---\n${KNOWLEDGE.trim()}`
    : SYSTEM_PROMPT;
  if (RUBRO_REF && RUBRO_REF.trim()) {
    base += `\n\n--- referencia de rubros (hablá el idioma del rubro del lead; usá SOLO el bloque que corresponde, NO lo recites) ---\n${RUBRO_REF.trim()}`;
  }

  return [
    { type: 'text', text: base, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: ctx },
  ];
}

const TOOLS = [
  {
    name: 'get_available_slots',
    description:
      'Devuelve los horarios LIBRES reales para agendar la llamada (lee el calendario y respeta el horario laboral). Usalo SIEMPRE antes de proponer horarios; nunca inventes uno.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'book_call',
    description:
      'Reserva la llamada en el calendario en el horario indicado. Usalo SOLO cuando el lead ya aceptó un horario concreto. El horario debe ser uno de los devueltos por get_available_slots.',
    input_schema: {
      type: 'object',
      properties: {
        datetime_iso: {
          type: 'string',
          description: 'Inicio de la llamada en ISO 8601 (el campo startIso del hueco elegido).',
        },
        notes: { type: 'string', description: 'Notas opcionales para el evento.' },
      },
      required: ['datetime_iso'],
    },
  },
  {
    name: 'cancel_booking',
    description:
      'Da de baja la videollamada YA agendada. Usalo APENAS el lead avise que NO va a poder ir, que la cancela, que no le interesa más, que la deja, o que no asistirá. Es CRÍTICO usarlo: si no, el bot le va a seguir mandando recordatorios de una llamada que el lead ya canceló (y eso lo hace bloquear). NO lo uses si solo quiere REPROGRAMAR a otro horario (para eso usá book_call con el nuevo horario).',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'motivo breve de la cancelación si el lead lo dijo (opcional).' },
      },
      required: [],
    },
  },
];

// Recorte defensivo del historial para no crecer infinito (corta en un turno
// "user" limpio para no romper pares tool_use/tool_result).
function trimHistory(messages, max = 60) {
  if (messages.length <= max) return messages;
  let cut = messages.length - max;
  while (cut < messages.length && !(messages[cut].role === 'user' && typeof messages[cut].content === 'string')) {
    cut++;
  }
  return cut < messages.length ? messages.slice(cut) : messages;
}

async function runTool(name, input, lead, state) {
  if (name === 'get_available_slots') {
    const all = await getAvailableSlots(SETTINGS);
    if (all.length === 0) return 'no hay horarios libres en la ventana configurada';
    const tz = ENV.TIMEZONE;
    // Sacamos HOY (la agenda ya está) + los días bloqueados (offerBlackoutDates), y separamos lo OFRECIBLE
    // (10-21, escalonado) de lo temprano (7/8/9, solo si el lead lo pide). Cada hueco lleva (mañana) etc.
    const blocked = new Set(SETTINGS.offerBlackoutDates || []);
    if (SETTINGS.offerSkipToday) blocked.add(localDayKey(new Date(), tz));
    const future = all.filter((s) => !blocked.has(localDayKey(new Date(s.startIso), tz)));
    let offerables = future.filter((s) => { const h = localHourOf(s.startIso, tz); return h >= SETTINGS.offerStartHour && h < SETTINGS.offerEndHour; });
    // Del primer día con lugar, la franja de 14 a 17 va primero (es la que más se presenta); el resto sigue en orden.
    if (offerables.length) {
      const dia = localDayKey(new Date(offerables[0].startIso), tz);
      const tarde = offerables.filter((s) => localDayKey(new Date(s.startIso), tz) === dia && (() => { const h = localHourOf(s.startIso, tz); return h >= 14 && h < 17; })());
      if (tarde.length >= 2) offerables = [...tarde, ...offerables.filter((s) => !tarde.includes(s))];
    }
    const earlies = future.filter((s) => localHourOf(s.startIso, tz) < SETTINGS.offerStartHour);
    const fmt = (arr) => arr.map((s) => { const rel = relDay(s.startIso, tz); return { startIso: s.startIso, cuando: rel ? `${s.label} (${rel})` : s.label }; });
    return JSON.stringify({
      hoy: humanLabel(new Date(), tz),
      instruccion: `ofrecé SOLO de "ofrecer", los dos más CERCANOS (los primeros de la lista). Botones solo si el contexto dice "botones de horario: sí". Si el LEAD pide un día u hora puntual, buscalo en "ofrecer".${SETTINGS.offerSkipToday ? ' NO agendes para hoy.' : ' Se puede agendar para hoy.'}`,
      ofrecer: fmt(buildOfferList(offerables, tz)),
      temprano_solo_si_lo_piden: fmt(earlies).slice(0, 20),
    });
  }
  if (name === 'book_call') {
    // No agendamos en días cubiertos (hoy + offerBlackoutDates): ofrecé otro día disponible.
    const tz = ENV.TIMEZONE;
    const dk = localDayKey(new Date(input.datetime_iso), tz);
    const blockedDays = new Set(SETTINGS.offerBlackoutDates || []);
    if (SETTINGS.offerSkipToday) blockedDays.add(localDayKey(new Date(), tz));
    if (blockedDays.has(dk)) {
      return 'ese día ya está completo, no agendes ahí: ofrecé otro día de los disponibles (más adelante)';
    }
    const r = await bookCall(SETTINGS, {
      startIso: input.datetime_iso,
      summary: `Acme · Llamada 1 (20 min) · ${lead?.name || lead?.number || 'lead'}`,
      description: [
        'Llamada 1 de 20 minutos, agendada por el bot de WhatsApp.',
        lead?.number ? `WhatsApp: +${lead.number}` : '',
        lead?.name ? `Nombre: ${lead.name}` : '',
        input.notes ? `Notas: ${input.notes}` : '',
        resumenTexto(lead),
        'Guion: el manual de ventas (privado), sección 4. Grabá y transcribí la llamada.',
      ].filter(Boolean).join('\n'),
    });
    if (r.conflict) return `ese horario (${r.when}) se ocupó recién, ofrecé otro de get_available_slots`;
    state.booking = r;
    const conAudio = !!state.hasConfirmAudio;
    return `reservado: ${r.when} (eventId ${r.eventId}). primer globo: confirmale que quedó el ${r.when}, que son ${SETTINGS.callDurationMin} minutos por Google Meet y que es con vos. ${conAudio ? 'después de ese globo sale SOLO tu audio de confirmación (dice que tenga a mano la lista de precios, que sume al socio y que el link sale un rato antes): no repitas nada de eso.' : 'agregá en ese globo que un rato antes le pasás el link por acá, y que si lo decide con un socio lo sume.'} segundo globo, solo si no lo sabés todavía: a qué zonas reparte y cuál es su pedido mínimo. NO pases ningún link ahora. no revendas.`;
  }
  if (name === 'cancel_booking') {
    if (lead?.status !== 'booked' && !lead?.bookedStartIso) return 'no hay ninguna videollamada agendada para cancelar';
    state.cancelled = true;
    return 'listo, di de baja la videollamada agendada y dejo de mandarle recordatorios. respondele corto y cordial, sin reofrecer ni insistir, y dejale la puerta abierta por si más adelante quiere retomar';
  }
  return 'herramienta desconocida';
}

const note = (txt) => ({ role: 'user', content: `[nota interna del sistema, no es un mensaje del lead] ${txt}`, ts: Date.now() });

// Corre un turno de conversación. Devuelve { text, messages, booking }.
//  - userText: el mensaje del lead (o null si es un follow-up).
//  - follow: true para generar un recordatorio cuando el lead se quedó callado.
//  - breakup: true para el último mensaje de la secuencia (cierre con la puerta abierta).
//  - reminder: objeto del recordatorio anti no-show ({ id, beforeMin }); no usa tools.
export async function converse(lead, { userText = null, follow = false, angle = null, breakup = false, reminder = null, booked = false, hasConfirmAudio = false, noshowAudio = false } = {}) {
  const messages = trimHistory([...(lead.history || [])]);
  if (userText != null) messages.push({ role: 'user', content: userText, ts: Date.now() });
  if (reminder) {
    if (reminder.postCall) {
      // la call ya pasó y no apareció: recuperar ausente (ÚNICO lugar donde se ofrece reprogramar)
      messages.push(note(NOSHOW_DIRECTIVE
        .replace('{cuando}', lead.bookedWhen || 'la llamada')
        .replace('{audio}', noshowAudio ? 'Recién le mandaste tu audio de ausente ("te estuve esperando, se te habrá complicado, decime qué horario te queda bien").' : '')));
    } else {
      // El link SOLO va en el recordatorio de 30 min antes ('m30'). Ni en la confirmación ni en el de
      // 3h se manda link (decisión de producto: que le llegue una sola vez, cerca de la hora).
      const sendLink = reminder.id === 'm30' || reminder.beforeMin <= 30;
      const link = sendLink && lead.bookedMeetLink
        ? ` recordale también el link de la videollamada: ${lead.bookedMeetLink}`
        : ' NO pongas ningún link en este mensaje, es solo el recordatorio del horario.';
      // Le pasamos los MINUTOS EXACTOS que faltan: si no, el bot inventa "en 15 minutos" aunque falten horas.
      const startMs = lead.bookedStartIso ? Date.parse(lead.bookedStartIso) : NaN;
      const mins = Number.isFinite(startMs) ? Math.max(0, Math.round((startMs - Date.now()) / 60000)) : null;
      const gap = mins == null ? '' :
        ` [dato exacto, NO inventes otra cosa: en este momento faltan ~${mins} minutos para la videollamada. si son más de 30, decí el horario concreto ("${lead.bookedWhen || 'la hora agendada'}") y NUNCA "en un rato" ni "en X minutos"].`;
      messages.push(note(REMINDER_DIRECTIVE.replace('{cuando}', lead.bookedWhen || 'la llamada') + gap + link));
    }
  } else if (follow && breakup) {
    messages.push(note(BREAKUP_DIRECTIVE));
  } else if (follow) {
    const angleLine = angle?.instruction ? `\nángulo de este recordatorio: ${angle.instruction}` : '';
    messages.push(note(`${FOLLOWUP_DIRECTIVE}${angleLine}`));
  } else if (booked) {
    // El lead ya agendó y volvió a escribir: NO vender ni re-ofrecer, solo responder corto.
    messages.push(note(BOOKED_DIRECTIVE.replace('{cuando}', lead.bookedWhen || 'la llamada')));
  }

  // Un recordatorio es un aviso de una sola vía: NO debe agendar ni mover nada.
  const tools = reminder ? [] : TOOLS;

  const state = { booking: null, hasConfirmAudio };
  let turns = 0;
  while (turns++ < ENV.MAX_TOOL_TURNS) {
    const resp = await client().messages.create({
      model: ENV.CLAUDE_MODEL,
      max_tokens: 2500, // techo, no objetivo: la brevedad la impone el prompt. Con razonamiento "medio" 700 dejaba respuestas vacías.
      // Con thinking adaptativo los tokens de razonamiento cuentan acá: 400 dejaba
      // respuestas vacias en los turnos largos y el lead recibia el texto de fallback.
      ...reasoning(),
      system: buildSystem(lead),
      ...(tools.length ? { tools } : {}),
      // La API SOLO acepta { role, content } por mensaje: sacamos campos nuestros (ts, via) que
      // guardamos en el historial para el panel pero que no van a Anthropic.
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    messages.push({ role: 'assistant', content: resp.content, ts: Date.now() });

    if (resp.stop_reason !== 'tool_use') break;

    const results = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      let out;
      try {
        out = await runTool(block.name, block.input || {}, lead, state);
      } catch (e) {
        out = `error ejecutando ${block.name}: ${e.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: String(out) });
    }
    messages.push({ role: 'user', content: results, ts: Date.now() });
  }

  // Texto de la última respuesta del asistente
  let text = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue;
    const c = messages[i].content;
    if (Array.isArray(c)) text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    else if (typeof c === 'string') text = c.trim();
    break;
  }
  if (!text) text = 'Perdón, se me cortó. Lo retomamos en un minuto.';

  return { text, messages, booking: state.booking, cancelled: !!state.cancelled };
}

// Genera el PRIMER mensaje (opener) referenciando el anuncio del que vino el
// lead. `variant` es la variante del bandit: la usamos como guía de estructura
// para no romper el A/B. Devuelve el texto (globos separados por '\n').
export async function generateOpener(lead, variant, { primero = '', conAudio = false } = {}) {
  const ref = (variant?.globos || []).join(' / ');
  const audioLine = conAudio
    ? 'Antes de este mensaje ya le salió tu audio de apertura, que dice: "Soy Martín Acosta. Vi que me escribiste por el anuncio. Contame un poco de tu negocio por acá y coordinamos una llamada de 20 minutos." NO te presentes de nuevo ni repitas eso: andá directo.'
    : 'No hubo audio: saludá y presentate en una línea como Martín Acosta, casual.';
  const resp = await client().messages.create({
    model: ENV.CLAUDE_MODEL,
    max_tokens: 300,
    ...reasoning(),
    system: buildSystem(lead),
    messages: [{ role: 'user', content: `[nota interna del sistema, no es un mensaje del lead] ${OPENER_AD_DIRECTIVE
      .replace('{ref}', ref)
      .replace('{audio}', audioLine)
      .replace('{primero}', String(primero || '(sin texto)').slice(0, 300))}` }],
  });
  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
