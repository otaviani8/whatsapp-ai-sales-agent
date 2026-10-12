// Tests de la normalización a E.164. Corren con: node --test src/telefono.test.js
//
// La regla la spec de medición §6.7 es "se prueba con un caso de cada formato de la
// tabla". Acá hay bastante más que eso, porque el interior rompe la suposición
// de que el código de área mide dos dígitos, y porque lo que devuelve vacío
// importa tanto como lo que devuelve un número.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarTelefonoAR } from './telefono.js';

const CASOS = [
  // --- Los seis de la tabla la spec de medición §6.7 -----------------------------
  ['11 5555-0123', '+5491155550123', 'tal cual lo escribe la gente en AMBA'],
  ['011 15 5555 0123', '+5491155550123', 'con el 0 y con el 15'],
  ['+54 11 5555 0123', '+5491155550123', 'internacional pero sin el 9'],
  ['1155550123', '+5491155550123', 'pelado, sin nada'],
  ['+54 9 11 5555-0123', '+5491155550123', 'ya está bien, no hay que romperlo'],
  ['54 9 11 5555 0123', '+5491155550123', 'bien pero sin el +'],

  // --- Idempotencia: lo que ya salió de acá tiene que volver igual ---------
  ['+5491155550123', '+5491155550123', 'la salida de esta misma función'],
  ['5491155550123', '+5491155550123', 'la misma sin el +'],

  // --- Identificadores de WhatsApp ----------------------------------------
  ['5491155550123@s.whatsapp.net', '+5491155550123', 'JID clásico'],
  ['5491155550123:12@s.whatsapp.net', '+5491155550123', 'JID con sufijo de dispositivo'],
  ['541155550123@s.whatsapp.net', '+5491155550123', 'JID argentino que llegó sin el 9'],
  ['254346543211234@lid', '', 'un @lid no es un teléfono y no se adivina'],

  // --- Interior, área de 3 dígitos ----------------------------------------
  ['0351 15 123-4567', '+5493511234567', 'Córdoba con 0 y con 15'],
  ['351 15 123 4567', '+5493511234567', 'Córdoba sin el 0'],
  ['+54 341 456-7890', '+5493414567890', 'Rosario internacional sin el 9'],
  ['0261 15 4123456', '+5492614123456', 'Mendoza con 0 y con 15'],
  ['+54 9 261 412-3456', '+5492614123456', 'Mendoza ya normalizada'],

  // --- Interior, área de 4 dígitos ----------------------------------------
  ['02954 15 44-5566', '+5492954445566', 'Santa Rosa, área de 4'],
  ['+54 9 3541 44-5566', '+5493541445566', 'Villa Carlos Paz, área de 4'],
  ['02966 15 42-1234', '+5492966421234', 'Río Gallegos, área de 4'],

  // --- AMBA, más formas de escribirlo -------------------------------------
  ['(011) 15-5555-0123', '+5491155550123', 'con paréntesis y guiones'],
  ['11-5555-0123', '+5491155550123', 'con guiones y sin nada más'],
  ['  +54 9 11 5555 0123  ', '+5491155550123', 'con espacios de sobra a los costados'],

  // --- Fijos: les ponemos el 9 igual, a propósito (ver el encabezado) ------
  ['011 4123-4567', '+5491141234567', 'fijo de CABA'],
  ['0351 421-1234', '+5493514211234', 'fijo de Córdoba'],
  ['+54 11 4123 4567', '+5491141234567', 'fijo de CABA en internacional'],

  // --- Prefijo de salida internacional 00 ---------------------------------
  ['0054 9 11 5555 0123', '+5491155550123', '00 + 54 es argentino'],
  ['001 415 555 2671', '', '00 + 1 es de Estados Unidos'],

  // --- De otro país: vacío, nunca una adivinanza --------------------------
  ['+1 415 555 2671', '', 'Estados Unidos'],
  ['+34 600 123 456', '', 'España'],
  ['+56 9 1234 5678', '', 'Chile, que además tiene un 9 como el nuestro'],

  // --- Basura y números que no cierran ------------------------------------
  ['', '', 'cadena vacía'],
  [null, '', 'null'],
  [undefined, '', 'undefined'],
  ['hola, quiero info', '', 'texto sin un solo dígito'],
  ['ventas@example.com', '', 'un mail, no un teléfono'],
  ['5555-0123', '', 'sin código de área: 8 dígitos no alcanzan'],
  ['12345', '', 'cinco dígitos sueltos'],
  ['0', '', 'un cero solo'],
  [{}, '', 'un objeto'],
  ['+549115555288', '', 'le falta un dígito'],
  ['54911555501231', '', 'le sobra un dígito'],

  // --- No siempre llega como string ---------------------------------------
  [1155550123, '+5491155550123', 'un Number, no un string'],
];

for (const [entrada, esperado, porQue] of CASOS) {
  test(`${JSON.stringify(entrada)} -> ${esperado || '(vacío)'} · ${porQue}`, () => {
    assert.equal(normalizarTelefonoAR(entrada), esperado);
  });
}

test('normalizar dos veces da lo mismo que normalizar una', () => {
  for (const [entrada] of CASOS) {
    const una = normalizarTelefonoAR(entrada);
    assert.equal(normalizarTelefonoAR(una), una, `rompió con ${JSON.stringify(entrada)}`);
  }
});

test('todo lo que devuelve tiene la forma E.164 argentina de celular', () => {
  for (const [entrada] of CASOS) {
    const r = normalizarTelefonoAR(entrada);
    if (r) assert.match(r, /^\+549[1-3]\d{9}$/, `forma rara con ${JSON.stringify(entrada)}`);
  }
});
