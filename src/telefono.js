// ============================================================================
//  Normalización de teléfonos argentinos a E.164. Sin dependencias.
//
//  POR QUÉ EXISTE ESTO. Todo el embudo se une por el número de teléfono: el
//  vendedor del cliente conoce a la persona por su número, no por un id interno
//  nuestro. Si el teléfono no normaliza, el lead que capturó el bot y la venta
//  que cargó el vendedor terminan siendo dos filas distintas, y el embudo se
//  corta justo entre la consulta y la venta, que es el único lugar donde no se
//  puede permitir que se corte. Ver la spec de medición §6.4 (campo A9) y §6.7.
//
//  EL 15 Y EL 9, que es lo que hace que acá esto falle más que en cualquier
//  otro país, y lo que el que lea esto en seis meses no se va a acordar:
//
//  - El "15" es herencia de cuando el celular se pagaba distinto que el fijo.
//    Se marca SOLO desde una línea local y va DESPUÉS del código de área:
//    011 15 5555-0123. En formato internacional no existe: hay que sacarlo.
//  - El "9" es al revés: es un dígito que Argentina exige DESPUÉS del 54 para
//    marcarle a un celular desde afuera, y que nadie escribe cuando anota un
//    número a mano. Falta más veces de las que sobra, y es el error más común.
//  - Los dos son excluyentes. El mismo aparato es 011 15 5555-0123 desde un
//    fijo porteño y +54 9 11 5555-0123 desde el exterior. Nunca los dos juntos.
//  - El "0" del principio es el prefijo de larga distancia nacional. Tampoco
//    viaja al formato internacional.
//
//  El resultado es siempre +549 + 10 dígitos (área + abonado): 13 dígitos, 14
//  caracteres contando el +. El código de área mide 2, 3 o 4 dígitos según la
//  localidad (11 en AMBA, 351 en Córdoba, 2954 en Santa Rosa), pero área más
//  abonado suman 10 SIEMPRE, y eso es lo que se valida al final.
//
//  LOS FIJOS. Un fijo de verdad es +54 + área + abonado, sin el 9. Nosotros le
//  ponemos el 9 igual, a propósito: con los dígitos pelados un fijo escrito sin
//  el 15 es indistinguible de un celular escrito sin el 15, y si la misma
//  persona saliera a veces como +54... y a veces como +549... el cruce contra la
//  fila que carga el vendedor se rompe, que es justo lo que esta función viene a
//  evitar. Sumado a que todo lo que entra por acá entró por WhatsApp, preferimos
//  una convención determinística antes que una adivinanza telefónicamente fina.
//
//  LO QUE NO HACE. No adivina. Si el número tiene menos de 10 dígitos, si viene
//  con código de otro país, o si no le cierra la forma, devuelve cadena vacía.
//  Un campo vacío se ve y se corrige; un número inventado contamina el registro
//  de leads en silencio y nadie se entera hasta el reporte.
// ============================================================================

// Códigos de área de 3 dígitos. Los que arrancan en 2 o en 3 y NO están acá son
// de 4 dígitos; el único de 2 dígitos es el 11 (AMBA). Esta tabla es lo único
// que permite saber dónde termina el área y, por lo tanto, dónde está el 15.
const AREA_3 = new Set([
  '220', '221', '223', '230', '236', '237', '249', '260', '261', '263', '264',
  '266', '280', '291', '297', '299', '336', '341', '342', '343', '345', '348',
  '351', '353', '358', '362', '364', '370', '376', '379', '380', '381', '383',
  '385', '387', '388',
]);

// Largo del código de área de un número nacional (con o sin el 15 pegado).
function largoArea(nsn) {
  if (nsn.startsWith('11')) return 2;
  if (AREA_3.has(nsn.slice(0, 3))) return 3;
  return 4;
}

// Recibe cualquier cosa (string, número, un JID de WhatsApp, basura) y devuelve
// el celular argentino en E.164 (+549XXXXXXXXXX) o cadena vacía si no se puede.
export function normalizarTelefonoAR(entrada) {
  // Los identificadores de WhatsApp vienen como 5491155550123@s.whatsapp.net y
  // a veces con sufijo de dispositivo (:12) antes del @. Cortamos ahí porque si
  // no, ese ":12" se cuela como dos dígitos más y arruina el número. Un @lid no
  // es un teléfono: queda un id largo que no cierra ninguna forma y termina
  // devolviendo vacío, que es exactamente lo que queremos que pase.
  const crudo = String(entrada ?? '').trim().split('@')[0].split(':')[0];

  let digitos = crudo.replace(/\D/g, '');
  if (!digitos) return '';

  // El + inicial (o el 00 de salida internacional) es una declaración: "esto ya
  // trae código de país". Si lo trae y no es 54, es de otro país y no lo tocamos.
  let internacional = crudo.startsWith('+');
  if (digitos.startsWith('00')) {
    digitos = digitos.slice(2);
    internacional = true;
  }

  // Sacamos el 54 solo si lo que queda alcanza para un número argentino. Ningún
  // código de área arranca en 5, así que un 54 adelante con 10 o más dígitos
  // atrás es país, no área.
  if (digitos.startsWith('54') && digitos.length - 2 >= 10) {
    digitos = digitos.slice(2);
  } else if (internacional) {
    return '';
  }

  // El 0 de larga distancia nacional.
  let nsn = digitos.replace(/^0+/, '');

  // El 9 de celular, si está. Solo con 11 dígitos o más: ningún área argentina
  // arranca en 9, así que acá no hay ambigüedad posible.
  if (nsn.length >= 11 && nsn.startsWith('9')) nsn = nsn.slice(1);

  // El 15, que vive entre el código de área y el abonado.
  if (nsn.length > 10) {
    const a = largoArea(nsn);
    if (nsn.slice(a, a + 2) === '15') nsn = nsn.slice(0, a) + nsn.slice(a + 2);
  }

  // Área más abonado son 10 dígitos y arrancan en 1, 2 o 3. Cualquier otra cosa
  // (le falta un dígito, le sobra, es de otro país, es un @lid) no se adivina.
  if (!/^[1-3]\d{9}$/.test(nsn)) return '';

  return '+549' + nsn;
}
