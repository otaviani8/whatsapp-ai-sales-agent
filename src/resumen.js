// ============================================================================
//  Resumen del lead y tablero del embudo (07/10/2026).
//  - respuestasDelLead: las tres respuestas (qué vende, cómo le llegan los comercios,
//    publicidad) para el aviso al operadortián y el evento del calendario.
//  - embudo: las tasas de cada etapa que maneja el bot, para el control de los lunes
//    (el manual de ventas (privado), sección 10).
// ============================================================================

function texto(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
}
const esDelLead = (m) => m?.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[nota interna');

export function respuestasDelLead(history = []) {
  const out = { vende: '', como_llegan: '', publicidad: '' };
  const marcas = [['Primera:', 'vende'], ['Segunda:', 'como_llegan'], ['Última:', 'publicidad']];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    const t = texto(m);
    for (const [marca, campo] of marcas) {
      if (!t.includes(marca) || out[campo]) continue;
      const resp = history.slice(i + 1).find(esDelLead);
      if (resp) out[campo] = String(resp.content).replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  }
  return out;
}

// Los tres datos: primero del análisis de la IA (insights), y si no hay, de las marcas viejas.
export function datosDelLead(lead) {
  const p = lead?.profile || {};
  const viejo = respuestasDelLead(lead?.history || []);
  return {
    vende: p.vende || viejo.vende,
    como_llegan: p.como_llegan || viejo.como_llegan,
    publicidad: p.publicidad || viejo.publicidad,
    piso: p.llega_al_piso || (viejo.publicidad ? (/menos de/i.test(viejo.publicidad) ? 'no' : 'si') : ''),
  };
}

export function resumenTexto(lead) {
  const r = datosDelLead(lead);
  const p = lead?.profile || {};
  return [
    r.vende ? `Vende: ${r.vende}` : '',
    p.motivo ? `Por qué escribió: ${p.motivo}` : '',
    r.como_llegan ? `Cómo le llegan los comercios: ${r.como_llegan}` : '',
    p.probo_antes ? `Qué probó: ${p.probo_antes}` : '',
    p.comercios_cartera ? `Comercios hoy: ${p.comercios_cartera}` : '',
    r.publicidad ? `Publicidad: ${r.publicidad}` : '',
    p.decisor ? `Quién decide: ${p.decisor}` : '',
    p.zonas ? `Zonas: ${p.zonas}` : '',
    p.pedido_minimo ? `Pedido mínimo: ${p.pedido_minimo}` : '',
  ].filter(Boolean).join('\n');
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');

export function embudo(leads, dias, now = Date.now()) {
  const desde = now - dias * 24 * 3600 * 1000;
  const L = leads.filter((l) => (l.openedAt || 0) >= desde);
  const contestaron = L.filter((l) => {
    const h = l.history || [];
    const iBot = h.findIndex((m) => m.role === 'assistant');
    return iBot >= 0 && h.slice(iBot + 1).some(esDelLead);
  });
  const tres = L.filter((l) => datosDelLead(l).publicidad);
  const piso = L.filter((l) => datosDelLead(l).piso === 'si');
  const agendaron = L.filter((l) => l.bookedAt || l.status === 'booked');
  const cancelaron = agendaron.filter((l) => l.cancelled);
  const ausentes = agendaron.filter((l) => (l.remindersSent || []).includes('noshow'));
  const variantes = {};
  for (const l of L) {
    const v = `${l.openerVariant || '?'} · botones ${l.abBotones ? 'sí' : 'no'}`;
    variantes[v] = variantes[v] || { conversaciones: 0, agendaron: 0 };
    variantes[v].conversaciones++;
    if (l.bookedAt || l.status === 'booked') variantes[v].agendaron++;
  }
  return {
    dias,
    filas: [
      ['Conversaciones', L.length, ''],
      ['Contestaron la primera pregunta', contestaron.length, pct(contestaron.length, L.length)],
      ['Dijeron cuánto ponen en publicidad', tres.length, pct(tres.length, contestaron.length)],
      ['Llegan al piso de publicidad', piso.length, pct(piso.length, tres.length)],
      ['Agendaron', agendaron.length, pct(agendaron.length, piso.length)],
      ['Cancelaron', cancelaron.length, pct(cancelaron.length, agendaron.length)],
      ['Ausentes (salió el rescate)', ausentes.length, pct(ausentes.length, agendaron.length)],
    ],
    variantes: Object.entries(variantes).map(([v, x]) => [v, x.conversaciones, x.agendaron, pct(x.agendaron, x.conversaciones)]),
  };
}

export function embudoHTML(leads, now = Date.now()) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const tabla = (e) => `<h2>Últimos ${e.dias} días</h2><table><tr><th>Etapa</th><th>Cantidad</th><th>Tasa</th></tr>${
    e.filas.map((f) => `<tr><td>${esc(f[0])}</td><td>${f[1]}</td><td>${f[2]}</td></tr>`).join('')}</table>
    <h3>Pruebas A/B (apertura con o sin audio · botones en los horarios)</h3><table><tr><th>Variante</th><th>Conversaciones</th><th>Agendaron</th><th>Tasa</th></tr>${
    e.variantes.map((v) => `<tr><td>${esc(v[0])}</td><td>${v[1]}</td><td>${v[2]}</td><td>${v[3]}</td></tr>`).join('') || '<tr><td colspan="4">Sin datos</td></tr>'}</table>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embudo del bot</title>
<style>body{font-family:system-ui,sans-serif;background:#F7F5F0;color:#0E2A5C;margin:0;padding:20px 16px;max-width:720px}
h1{font-size:22px;margin:0 0 4px}p{color:#4B5872;margin:0 0 16px;font-size:14px}h2{font-size:17px;margin:22px 0 8px}h3{font-size:14px;margin:14px 0 6px;color:#4B5872}
table{border-collapse:collapse;width:100%;font-size:14px;background:#fff}td,th{border-bottom:1px solid #D9D3C7;padding:8px 10px;text-align:left}th{font-size:12px;color:#4B5872}
td:nth-child(n+2),th:nth-child(n+2){text-align:right}</style></head><body>
<h1>Embudo del bot</h1><p>Lo que pasa entre el primer mensaje y la llamada agendada. Las tasas son sobre la etapa anterior. La asistencia y el cierre se anotan en el Pipeline.</p>
${tabla(embudo(leads, 7, now))}${tabla(embudo(leads, 30, now))}</body></html>`;
}
