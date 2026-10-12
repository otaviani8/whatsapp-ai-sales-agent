// Pruebas de la lógica nueva del 07/10/2026 (sin red ni IA).
//   DATA_DIR=./pruebas/tmp node pruebas/logica-2026-10-07.test.mjs
import assert from 'node:assert/strict';
import { computeFreeSlots, localParts } from '../src/calendar.js';
import { SETTINGS } from '../src/persona.js';
import { nextFollowupAt, windowOpen, META_RE } from '../src/whatsapp.js';

const tz = 'America/Argentina/Buenos_Aires';
let ok = 0;
const hhmm = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(/^0/, '');
const t = (name, fn) => { fn(); ok++; console.log('  ok  ' + name); };

// Lunes 13/10/2026 a las 08:00 de Buenos Aires (11:00 UTC).
const lunes8 = new Date('2026-10-13T11:00:00Z');

t('las franjas son 10-12 y 14-19, cada 30 min, llamadas de 20', () => {
  const slots = computeFreeSlots(SETTINGS, [], lunes8, tz);
  const hoy = slots.filter((s) => localParts(new Date(s.startIso), tz).d === 13);
  const horas = hoy.map((s) => hhmm(s.startIso));
  assert.deepEqual(horas, ['10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30']);
});

t('respeta la hora de margen y lo ocupado del calendario', () => {
  const now = new Date('2026-10-13T13:10:00Z'); // 10:10 local
  const busy = [{ start: Date.parse('2026-10-13T17:00:00Z'), end: Date.parse('2026-10-13T18:00:00Z') }]; // 14 a 15 local
  const slots = computeFreeSlots(SETTINGS, busy, now, tz).filter((s) => localParts(new Date(s.startIso), tz).d === 13);
  const horas = slots.map((s) => hhmm(s.startIso));
  assert.equal(horas[0], '11:30'); // 10:10 + 60 min de margen
  assert.ok(!horas.includes('14:00') && !horas.includes('14:30'));
});

t('ventana de 24 horas', () => {
  const now = Date.now();
  assert.equal(windowOpen({ lastInboundAt: now - 3 * 3600e3 }, now), true);
  assert.equal(windowOpen({ lastInboundAt: now - 24 * 3600e3 }, now), false);
});

t('seguimientos: primero texto dentro de las 24 h, después plantillas, después nada', () => {
  const now = Date.now();
  const base = { lastInboundAt: now - 3600e3, inboundHours: { 11: 1 } };
  const a = nextFollowupAt({ ...base, followupCount: 0 });
  assert.ok(a - base.lastInboundAt < 23.5 * 3600e3, 'el primer toque cae dentro de las 24 h');
  const tpl = nextFollowupAt({ ...base, followupCount: SETTINGS.followupCadenceHours.length, tplCount: 0 });
  assert.ok(tpl - base.lastInboundAt >= 23 * 3600e3, 'la primera plantilla sale pasado el día');
  const fin = nextFollowupAt({ ...base, followupCount: SETTINGS.followupCadenceHours.length, tplCount: SETTINGS.templateFollowups.length });
  assert.equal(fin, null);
});

t('el filtro de globos deja pasar los normales y frena el razonamiento', () => {
  for (const l of ['Quedó el lead en el piso de publicidad, así que toca coordinar.', 'Ofrecé horarios: hoy a las 16.', 'Son los huecos libres.']) assert.ok(META_RE.test(l), l);
  for (const l of ['Tengo hoy a las 16 o a las 16:30. Cuál te queda mejor ?', 'Segunda: hoy cómo te llegan los comercios nuevos ?', 'Listo, quedó el lunes 13 a las 16:30.']) assert.ok(!META_RE.test(l), l);
});

console.log(`\n${ok} pruebas ok`);
process.exit(0);
