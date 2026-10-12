import Anthropic from '@anthropic-ai/sdk';
import { ENV } from './config.js';

// ============================================================================
//  Análisis por lead (idea #1+2+3): después de cada turno saca el ESTILO del
//  lead, su OBJECIÓN principal y una TEMPERATURA (0-100). Eso personaliza los
//  mensajes, ajusta la cadencia de follow-up y llena el CRM. Usa structured
//  output para que la salida sea siempre un JSON válido.
// ============================================================================
let _client = null;
const client = () => (_client ??= new Anthropic({ apiKey: ENV.ANTHROPIC_API_KEY }));

const SCHEMA = {
  type: 'object',
  properties: {
    temperatura: { type: 'integer', description: '0-100: qué tan cerca está de agendar la llamada (0 = perdido, 100 = listo para agendar)' },
    objecion: { type: 'string', description: 'la traba principal del lead en pocas palabras (precio, tiempo, desconfianza, ya tiene a alguien, etc.) o "ninguna"' },
    estilo: { type: 'string', description: 'cómo escribe el lead en una frase: largo, formalidad, si usa emojis, si manda audios' },
    resumen: { type: 'string', description: 'estado de la charla en una frase corta' },
    vende: { type: 'string', description: 'qué vende el lead y a qué comercios, en pocas palabras, o "" si no lo dijo' },
    como_llegan: { type: 'string', description: 'cómo le llegan hoy los comercios nuevos, o "" si no lo dijo' },
    publicidad: { type: 'string', description: 'cuánto dijo que puede poner por mes en publicidad, tal cual, o "" si no lo dijo' },
    llega_al_piso: { type: 'string', enum: ['si', 'no', 'no_dijo'], description: 'si lo que dijo de publicidad llega a 500 mil pesos por mes (unos 300 dólares)' },
    motivo: { type: 'string', description: 'qué lo llevó a escribir, con sus palabras, o ""' },
    probo_antes: { type: 'string', description: 'qué probó antes para sumar comercios y cómo le fue, o ""' },
    comercios_cartera: { type: 'string', description: 'a cuántos comercios le vende hoy, tal cual lo dijo, o ""' },
    decisor: { type: 'string', description: 'si decide solo o con quién (socio, hermano), o ""' },
    zonas: { type: 'string', description: 'zonas donde reparte o quiere llegar, o ""' },
    pedido_minimo: { type: 'string', description: 'su pedido mínimo, o ""' },
  },
  required: ['temperatura', 'objecion', 'estilo', 'resumen', 'vende', 'como_llegan', 'publicidad', 'llega_al_piso', 'motivo', 'probo_antes', 'comercios_cartera', 'decisor', 'zonas', 'pedido_minimo'],
  additionalProperties: false,
};

function transcript(history = []) {
  return history
    .map((m) => {
      if (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[nota interna')) {
        return 'lead: ' + m.content;
      }
      if (m.role === 'assistant') {
        const c = m.content;
        const t = Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : String(c || '');
        return t.trim() ? 'bot: ' + t : null;
      }
      return null;
    })
    .filter(Boolean)
    .join('\n')
    .slice(-4000);
}

export async function analyze(lead) {
  const t = transcript(lead.history);
  if (!t) return null;
  try {
    const resp = await client().messages.create({
      model: ENV.CLAUDE_MODEL,
      max_tokens: 700,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      system:
        'analizás una charla de whatsapp entre un setter (bot) y un lead. devolvé el análisis pedido, objetivo y conciso, en español.',
      messages: [{ role: 'user', content: `charla:\n${t}` }],
    });
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const data = JSON.parse(text);
    let temp = Math.round(Number(data.temperatura));
    if (!Number.isFinite(temp)) temp = 50;
    temp = Math.max(0, Math.min(100, temp));
    return {
      temperature: temp,
      objection: String(data.objecion || '').slice(0, 120),
      style: String(data.estilo || '').slice(0, 200),
      summary: String(data.resumen || '').slice(0, 200),
      vende: String(data.vende || '').slice(0, 160),
      como_llegan: String(data.como_llegan || '').slice(0, 160),
      publicidad: String(data.publicidad || '').slice(0, 80),
      llega_al_piso: ['si', 'no'].includes(data.llega_al_piso) ? data.llega_al_piso : '',
      motivo: String(data.motivo || '').slice(0, 200),
      probo_antes: String(data.probo_antes || '').slice(0, 160),
      comercios_cartera: String(data.comercios_cartera || '').slice(0, 60),
      decisor: String(data.decisor || '').slice(0, 80),
      zonas: String(data.zonas || '').slice(0, 120),
      pedido_minimo: String(data.pedido_minimo || '').slice(0, 60),
      updatedAt: Date.now(),
    };
  } catch (e) {
    console.error('insights.analyze error:', e?.message || e);
    return null;
  }
}
