import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { ENV } from './config.js';

// Scope de calendario (lectura de disponibilidad + creación de eventos).
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export function loadCredentials() {
  if (ENV.GOOGLE_CREDENTIALS_B64) {
    const json = Buffer.from(ENV.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8');
    return JSON.parse(json);
  }
  if (ENV.GOOGLE_CREDENTIALS_JSON) return JSON.parse(ENV.GOOGLE_CREDENTIALS_JSON);
  const local = path.resolve('service-account.json');
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'));
  return null;
}

export function hasCredentials() {
  try {
    return !!loadCredentials();
  } catch {
    return false;
  }
}

let client = null;
async function getCalendar() {
  if (client) return client;
  const creds = loadCredentials();
  if (!creds) throw new Error('No hay credenciales de Google (GOOGLE_CREDENTIALS_B64 o service-account.json).');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
  client = google.calendar({ version: 'v3', auth: await auth.getClient() });
  return client;
}

// --- Helpers de zona horaria (sin librerías externas) -----------------------
// Offset (ms) que hay que SUMAR a UTC para obtener la hora local de `timeZone`
// en el instante `date`.
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m = {};
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUTC - date.getTime();
}

// Hora de pared (y,mo,d,h,mi en `timeZone`) -> instante Date en UTC.
export function wallToUtc(y, mo, d, h, mi, timeZone) {
  const base = Date.UTC(y, mo - 1, d, h, mi);
  let utc = base - tzOffsetMs(new Date(base), timeZone);
  const off2 = tzOffsetMs(new Date(utc), timeZone);
  utc = base - off2; // segunda pasada para bordes de DST
  return new Date(utc);
}

// Partes de fecha local (year/month/day/weekday) de un instante.
export function localParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const m = {};
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
  const y = +m.year, mo = +m.month, d = +m.day;
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return { y, mo, d, weekday };
}

// Etiqueta humana en español: "lunes 23/6 15:00" (separadores consistentes).
export function humanLabel(date, timeZone = ENV.TIMEZONE) {
  const f = new Intl.DateTimeFormat('es-AR', {
    timeZone, weekday: 'long', day: 'numeric', month: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const m = {};
  for (const p of f.formatToParts(date)) m[p.type] = p.value;
  return `${m.weekday} ${m.day}/${m.month} ${m.hour}:${m.minute}`;
}

const hm = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return { h: h || 0, m: m || 0 };
};

// --- Cálculo PURO de huecos (testeable sin Google) --------------------------
// Dada la lista de intervalos ocupados (ms epoch) y el "ahora", devuelve los
// huecos libres dentro del horario laboral en los próximos N días.
export function computeFreeSlots(settings, busy, now = new Date(), tz = ENV.TIMEZONE) {
  const horizon = settings.bookingHorizonDays;
  const timeMin = now.getTime() + (settings.minLeadMinutes || 0) * 60000;
  const timeMax = now.getTime() + horizon * 24 * 3600 * 1000;
  const durMs = settings.callDurationMin * 60000;
  const stepMin = settings.slotStepMin;
  // Franjas del día: `windows` ([['10:00','12:00'],['14:00','19:00']]) o, si no hay, start/end.
  const wins = (Array.isArray(settings.workingHours.windows) && settings.workingHours.windows.length
    ? settings.workingHours.windows
    : [[settings.workingHours.start, settings.workingHours.end]])
    .map(([a, b]) => { const s = hm(a); const e = hm(b); return [s.h * 60 + s.m, e.h * 60 + e.m]; });
  const days = new Set(settings.workingHours.days);
  const overlapsBusy = (sMs) => busy.some((b) => sMs < b.end && sMs + durMs > b.start);

  // Generamos huecos de TODOS los días del horizonte (cap alto), no solo los más próximos: así, cuando
  // el lead pide un día puntual (ej "el lunes"), el bot tiene esos huecos y no dice "no hay" de gusto.
  const slots = [];
  for (let dayOffset = 0; dayOffset <= horizon && slots.length < 300; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 24 * 3600 * 1000);
    const { y, mo, d, weekday } = localParts(probe, tz);
    if (!days.has(weekday)) continue;
    for (const [wStart, wEnd] of wins) {
      for (let mins = wStart; mins + settings.callDurationMin <= wEnd; mins += stepMin) {
        const slotStart = wallToUtc(y, mo, d, Math.floor(mins / 60), mins % 60, tz);
        const sMs = slotStart.getTime();
        if (sMs < timeMin || sMs > timeMax) continue;
        if (overlapsBusy(sMs)) continue;
        slots.push({ startIso: slotStart.toISOString(), label: humanLabel(slotStart, tz) });
        if (slots.length >= 300) break;
      }
    }
  }
  return slots;
}

// --- Espaciado de opciones (cierre asumido) ---------------------------------
// De la lista de huecos consecutivos, elige hasta `n` BIEN repartidos (distintos
// días y franjas) para no ofrecer dos horarios pegados. Puro y testeable.
export function diversifySlots(slots, n = 6) {
  if (!Array.isArray(slots) || slots.length <= n) return slots || [];
  const byDay = new Map();
  for (const s of slots) {
    const day = s.startIso.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  const picked = [];
  // 1ª pasada: el primer hueco de cada día (mañana).
  for (const arr of byDay.values()) {
    if (picked.length >= n) break;
    picked.push(arr[0]);
  }
  // 2ª pasada: un hueco más tarde de cada día (tarde), si falta cubrir n.
  for (const arr of byDay.values()) {
    if (picked.length >= n) break;
    if (arr.length > 1) picked.push(arr[arr.length - 1]);
  }
  picked.sort((a, b) => a.startIso.localeCompare(b.startIso));
  return picked.slice(0, n);
}

// --- Disponibilidad (consulta el calendario y arma los huecos) --------------
export async function getAvailableSlots(settings) {
  const tz = ENV.TIMEZONE;
  const cal = await getCalendar();
  const now = new Date();
  const timeMax = new Date(now.getTime() + settings.bookingHorizonDays * 24 * 3600 * 1000);

  const fb = await cal.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: tz,
      items: [{ id: ENV.CALENDAR_ID }],
    },
  });
  const busy = (fb.data.calendars?.[ENV.CALENDAR_ID]?.busy || []).map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  return computeFreeSlots(settings, busy, now, tz);
}

// --- Reserva ----------------------------------------------------------------
// Crea el evento de la llamada. Devuelve { eventId, htmlLink, when, startIso }.
export async function bookCall(settings, { startIso, summary, description }) {
  const cal = await getCalendar();
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw new Error('startIso inválido: ' + startIso);

  // Chequeo anti doble-booking: re-verificamos que el hueco siga libre.
  const end = new Date(start.getTime() + settings.callDurationMin * 60000);
  const fb = await cal.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      timeZone: ENV.TIMEZONE,
      items: [{ id: ENV.CALENDAR_ID }],
    },
  });
  const conflicts = fb.data.calendars?.[ENV.CALENDAR_ID]?.busy || [];
  if (conflicts.length > 0) {
    return { conflict: true, when: humanLabel(start) };
  }

  // Link de videollamada: un Meet fijo (MEET_LINK) que Martín usa siempre.
  // Lo metemos en el evento (location + descripción) y lo devolvemos para que el
  // bot se lo pase al lead y lo repita en los recordatorios.
  const meetLink = ENV.MEET_LINK || '';
  const fullDesc = meetLink
    ? `${description || ''}\n\nLink de la videollamada (Google Meet): ${meetLink}`.trim()
    : (description || '');
  const res = await cal.events.insert({
    calendarId: ENV.CALENDAR_ID,
    requestBody: {
      summary: summary || 'Acme · Llamada',
      description: fullDesc,
      location: meetLink || undefined,
      start: { dateTime: start.toISOString(), timeZone: ENV.TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: ENV.TIMEZONE },
    },
  });
  return {
    eventId: res.data.id,
    htmlLink: res.data.htmlLink,
    meetLink,
    when: humanLabel(start),
    startIso: start.toISOString(),
  };
}
