// Tests del matcheo de filas del CRM. Corren con: node --test src/crm.test.js
//
// No pegan contra la API de Sheets (no hay credenciales acá): prueban
// indexRowsByPhone() directo, que es la pieza que resuelve la trampa de R03
// sin tocar init()/upsertLead() reales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexRowsByPhone, leadToValues } from './crm.js';

test('una fila vieja en formato crudo se sigue encontrando cuando el lead ahora normaliza distinto', () => {
  // Fila 2 de una planilla real: se escribió ANTES de R03, con el número
  // crudo tal como llegaba de WhatsApp (acá, sin el 9 — el bug que R03 corrige).
  const rows = [
    ['Teléfono', 'Nombre'],
    ['541155550123', 'Lead viejo'],
  ];
  const phoneCol = 0;
  const idx = indexRowsByPhone(rows, phoneCol);

  // El mismo lead, hoy: ya tiene telefonoE164 calculado (con el 9).
  const lead = { number: '541155550123', telefonoE164: '+5491155550123', name: 'Lead viejo', history: [] };
  const vals = leadToValues(lead);
  const phone = vals.telefono.replace(/\D/g, ''); // así es como upsertLead() arma la clave de búsqueda

  assert.equal(vals.telefono, '+5491155550123', 'leadToValues tiene que escribir el E.164, no el crudo');
  assert.equal(idx.get(phone), 2, 'el lookup con el teléfono normalizado tiene que encontrar la fila vieja, no perderla');
});

test('un lead sin telefonoE164 todavía (backfill no corrido, o no normaliza) no rompe el matcheo previo', () => {
  const rows = [['Teléfono'], ['1155550123']];
  const idx = indexRowsByPhone(rows, 0);
  const lead = { number: '1155550123', history: [] }; // sin telefonoE164
  const vals = leadToValues(lead);
  assert.equal(vals.telefono, '+1155550123', 'cae al crudo de antes, nunca escribe la celda llave vacía');
  const phone = vals.telefono.replace(/\D/g, '');
  assert.equal(idx.get(phone), 2);
});

test('correr la migración/el índice de nuevo sobre una fila ya migrada no genera una fila fantasma', () => {
  // Simula el estado DESPUÉS de correr migrar-telefonos-crm.mjs una vez.
  const rows = [['Teléfono'], ['+5491155550123']];
  const idx = indexRowsByPhone(rows, 0);
  const lead = { telefonoE164: '+5491155550123', history: [] };
  const vals = leadToValues(lead);
  const phone = vals.telefono.replace(/\D/g, '');
  assert.equal(idx.get(phone), 2, 'sigue matcheando la misma fila 2, no una fila nueva');
});

test('dos leads distintos (interior, área de 3) no colisionan en el índice', () => {
  const rows = [
    ['Teléfono'],
    ['5493514211234'], // Córdoba, ya en E.164 sin el +
    ['0341 15 456-7890'], // Rosario, crudo
  ];
  const idx = indexRowsByPhone(rows, 0);
  const leadCordoba = leadToValues({ telefonoE164: '+5493514211234', history: [] });
  const leadRosario = leadToValues({ telefonoE164: '+5493414567890', history: [] });
  assert.equal(idx.get(leadCordoba.telefono.replace(/\D/g, '')), 2);
  assert.equal(idx.get(leadRosario.telefono.replace(/\D/g, '')), 3);
});

test('leadToValues agrega las tres columnas nuevas de R03', () => {
  const lead = {
    telefonoE164: '+5491155550123',
    ad: { ctwaClid: 'clic-abc123', sourceId: 'ad-999' },
    openedAt: 1000,
    history: [{ role: 'assistant', content: 'hola', ts: 1000 + 5 * 60000 }],
  };
  const vals = leadToValues(lead);
  assert.equal(vals.ctwa_clid, 'clic-abc123');
  assert.equal(vals.ad_id, 'ad-999');
  assert.equal(vals.minutos_primera_respuesta, '5');
});

test('leads viejos sin ctwaClid: la columna queda vacía, no se inventa nada', () => {
  const lead = { telefonoE164: '+5491155550123', ad: { sourceId: 'ad-1' }, history: [] };
  const vals = leadToValues(lead);
  assert.equal(vals.ctwa_clid, '');
});

test('minutos_primera_respuesta vacío si el lead no tiene primer contacto o el bot nunca respondió', () => {
  assert.equal(leadToValues({ history: [] }).minutos_primera_respuesta, '');
  assert.equal(leadToValues({ openedAt: 1000, history: [] }).minutos_primera_respuesta, '');
});
