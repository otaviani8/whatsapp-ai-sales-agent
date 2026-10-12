import { allLeads } from './store.js';
import { handleFollowup, handleReminder, handleOpener, handleScheduled, handleDueReply, dueReminder } from './whatsapp.js';
import { sleep } from './util.js';

// Cada cuánto revisa quién necesita un recordatorio / respuesta debounced (segundos).
// Bajo (20s) para que la respuesta agrupada salga pronto tras la ventana de ~40s.
const POLL_SEG = Number(process.env.FOLLOWUP_POLL_SEG) || 20;
// Espaciado entre follow-ups dentro de una misma pasada (anti-spam).
const GAP_SEG = Number(process.env.FOLLOWUP_GAP_SEG) || 20;

let running = false;

export function startFollowups() {
  if (process.env.BOT_PAUSED === '1') {
    console.log('⏸️  BOT_PAUSED: no arranco los follow-ups.');
    return;
  }
  console.log(`🔔 Follow-ups activados (revisa cada ${POLL_SEG}s).`);
  const tick = () => poll().catch((e) => console.error('follow-up poll error:', e?.message || e));
  setInterval(tick, POLL_SEG * 1000);
}

async function poll() {
  if (running) return; // no solapar pasadas
  running = true;
  try {
    const now = Date.now();
    const leads = allLeads();

    // Nadie que haya pedido opt-out (optOut) ni a quien el último envío le rebotó (lastSendFailed:
    // bloqueo o fuera de ventana de 24h) recibe mensajes iniciados por el bot. Corta el ban por reportes.
    const contactable = (l) => !l.optOut && (!l.lastSendFailed || l.lastSendFailed.win24); // fuera de 24 h igual salen plantillas

    // 0) Openers con delay cumplido (el PRIMER mensaje, que sale ~5 min después).
    const dueOpeners = leads.filter((l) => l.status === 'opening' && l.openerDueAt && l.openerDueAt <= now && contactable(l));
    for (const lead of dueOpeners) {
      await handleOpener(lead);
      await sleep(GAP_SEG * 1000);
    }

    // 0.5) Respuestas "debounced": el lead dejó de escribir (venció replyDueAt), respondemos a todo junto.
    const dueReplies = leads.filter((l) => l.replyDueAt && l.replyDueAt <= now && !l.optOut);
    for (const lead of dueReplies) {
      await handleDueReply(lead);
      await sleep(3000);
    }

    // 1) Follow-ups de leads que se quedaron callados.
    const due = leads.filter(
      (l) =>
        (l.status === 'opened' || l.status === 'engaged') &&
        l.nextFollowupAt &&
        l.nextFollowupAt <= now &&
        contactable(l)
    );
    for (const lead of due) {
      await handleFollowup(lead);
      await sleep(GAP_SEG * 1000); // espaciado natural entre recordatorios
    }

    // 2) Recordatorios anti no-show de llamadas ya agendadas.
    const remind = leads.filter((l) => dueReminder(l, now) && contactable(l));
    for (const lead of remind) {
      await handleReminder(lead);
      await sleep(GAP_SEG * 1000);
    }

    // 3) Mensajes programados one-off (reschedule, etc.) cuya hora ya llegó.
    const sched = leads.filter((l) => l.scheduledMsg && l.scheduledMsg.at && l.scheduledMsg.at <= now && contactable(l));
    for (const lead of sched) {
      await handleScheduled(lead);
      await sleep(GAP_SEG * 1000);
    }
  } finally {
    running = false;
  }
}
