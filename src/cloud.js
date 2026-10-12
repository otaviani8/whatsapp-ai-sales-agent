// ============================================================================
//  Cloud API de WhatsApp (Meta oficial). Reemplaza a Baileys: no hay socket ni
//  sesión vinculada — los mensajes ENTRAN por webhook y SALEN por HTTP a la
//  Graph API. Acá va solo el cliente HTTP de bajo nivel; la lógica del bot
//  (leads, follow-ups, etc.) sigue en whatsapp.js.
// ============================================================================
import https from 'node:https';
import crypto from 'node:crypto';
import { ENV } from './config.js';
import { markTokenOk, markTokenError } from './health.js';

const GRAPH = () => ENV.GRAPH_VERSION || 'v25.0';

// POST genérico a la Graph API. Resuelve con el JSON de respuesta.
function graphPost(pathPart, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/${GRAPH()}/${pathPart}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ENV.WA_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(chunks); } catch { /* respuesta no-JSON */ }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            markTokenOk(); // aviso de salud: la Graph API responde bien, el token vive
            resolve(json);
          } else {
            if (res.statusCode === 401 || res.statusCode === 403) {
              markTokenError(res.statusCode, json?.error?.message || chunks.slice(0, 200));
            }
            reject(new Error(`graph ${res.statusCode}: ${chunks.slice(0, 400)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// GET genérico a la Graph API (para resolver la URL de un media).
function graphGet(pathPart) {
  return new Promise((resolve, reject) => {
    https
      .request(
        {
          hostname: 'graph.facebook.com',
          path: `/${GRAPH()}/${pathPart}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${ENV.WA_TOKEN}` },
        },
        (res) => {
          let chunks = '';
          res.on('data', (c) => (chunks += c));
          res.on('end', () => {
            // graphGet nunca reject por status (los callers miran json?.url / json?.error), pero
            // igual anotamos el estado del token para el aviso de salud.
            if (res.statusCode === 401 || res.statusCode === 403) {
              let j = null;
              try { j = JSON.parse(chunks); } catch { /* no-json */ }
              markTokenError(res.statusCode, j?.error?.message || chunks.slice(0, 200));
            } else if (res.statusCode >= 200 && res.statusCode < 300) {
              markTokenOk();
            }
            try { resolve(JSON.parse(chunks)); } catch { resolve(null); }
          });
        }
      )
      .on('error', reject)
      .end();
  });
}

// El "9" de Argentina: Meta entrega el inbound CON el 9 (549 + área + nro) pero
// a veces guarda/espera el wa_id SIN el 9 (54 + área + nro). Probamos ambas formas.
function arVariants(digits) {
  const out = [digits];
  if (digits.startsWith('549')) out.push('54' + digits.slice(3)); // 549... -> 54...
  else if (digits.startsWith('54')) out.push('549' + digits.slice(2)); // 54... -> 549...
  return out;
}

// Manda un mensaje de texto a un número (wa_id). Si el destinatario "no está en la
// lista / es inválido" por el tema del 9 de Argentina, reintenta con la otra forma.
export async function sendText(to, text) {
  const digits = String(to).replace(/\D/g, '');
  const candidates = arVariants(digits);
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await graphPost(`${ENV.WA_PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: candidates[i],
        type: 'text',
        text: { preview_url: false, body: String(text).slice(0, 4096) },
      });
    } catch (e) {
      lastErr = e;
      const recoverable = /131030|131026|not in allowed list|invalid.*recipient|recipient.*invalid/i.test(e.message || '');
      if (!recoverable || i === candidates.length - 1) throw e;
      // si fue un error de destinatario, probamos la otra variante (toggle del 9)
    }
  }
  throw lastErr;
}

// Marca un mensaje entrante como leído (tildes azules). Best-effort.
export async function markRead(messageId) {
  if (!messageId) return;
  return graphPost(`${ENV.WA_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  }).catch(() => {});
}

// Resuelve la URL de descarga de un media por su id (para STT de audios). Si Meta no devuelve url,
// tiramos error con el cuerpo (así se loguea en vez de fallar en silencio).
export async function getMediaUrl(mediaId) {
  const j = await graphGet(`${mediaId}`);
  if (!j?.url) throw new Error(`getMediaUrl sin url para ${mediaId}: ${JSON.stringify(j || {}).slice(0, 200)}`);
  return j.url;
}

// Como getMediaUrl pero devuelve también el mime y el tamaño (para servir la media en el panel con
// el Content-Type correcto: imágenes, audios, documentos del lead).
export async function getMedia(mediaId) {
  const j = await graphGet(`${mediaId}`);
  if (!j?.url) throw new Error(`getMedia sin url para ${mediaId}: ${JSON.stringify(j || {}).slice(0, 200)}`);
  return { url: j.url, mime: j.mime_type || 'application/octet-stream', size: Number(j.file_size) || 0 };
}

// Descarga el binario de un media. La URL de Meta requiere el token (solo en hosts de Meta) y a veces
// REDIRIGE al CDN: hay que seguir el redirect. Chequeamos el status para no devolver basura en silencio.
export function downloadMedia(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const metaHost = /(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com|whatsapp\.net)$/i.test(u.hostname);
    const headers = metaHost ? { Authorization: `Bearer ${ENV.WA_TOKEN}` } : {};
    https
      .get({ hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          return resolve(downloadMedia(new URL(res.headers.location, u).toString(), redirectsLeft - 1));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => reject(new Error(`downloadMedia ${res.statusCode}: ${body.slice(0, 200)}`)));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

// Sube un archivo a Meta (multipart) y devuelve el media id (para mandarlo después como documento).
export function uploadMedia(buffer, mimeType, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----otv' + crypto.randomBytes(12).toString('hex');
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mimeType}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${String(filename).replace(/"/g, '')}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const body = Buffer.concat([pre, buffer, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/${GRAPH()}/${ENV.WA_PHONE_NUMBER_ID}/media`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ENV.WA_TOKEN}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(chunks); } catch { /* no-json */ }
          if (res.statusCode >= 200 && res.statusCode < 300 && json?.id) resolve(json.id);
          else reject(new Error(`uploadMedia ${res.statusCode}: ${chunks.slice(0, 300)}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Manda un documento (PDF) ya subido (por media id) a un número. Reintenta con la otra forma del 9.
export async function sendDocument(to, mediaId, filename, caption) {
  const digits = String(to).replace(/\D/g, '');
  const candidates = arVariants(digits);
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await graphPost(`${ENV.WA_PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: candidates[i],
        type: 'document',
        document: {
          id: mediaId,
          filename: filename || 'documento.pdf',
          ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
        },
      });
    } catch (e) {
      lastErr = e;
      const recoverable = /131030|131026|not in allowed list|invalid.*recipient|recipient.*invalid/i.test(e.message || '');
      if (!recoverable || i === candidates.length - 1) throw e;
    }
  }
  throw lastErr;
}

// Manda una nota de voz (audio ya subido por media id). El binario debe ser ogg/opus (lo transcodea
// src/audio.js antes de subirlo). Reintenta con la otra forma del 9 de Argentina.
export async function sendAudio(to, mediaId) {
  const digits = String(to).replace(/\D/g, '');
  const candidates = arVariants(digits);
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await graphPost(`${ENV.WA_PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: candidates[i],
        type: 'audio',
        audio: { id: mediaId },
      });
    } catch (e) {
      lastErr = e;
      const recoverable = /131030|131026|not in allowed list|invalid.*recipient|recipient.*invalid/i.test(e.message || '');
      if (!recoverable || i === candidates.length - 1) throw e;
    }
  }
  throw lastErr;
}

// Manda un mensaje con hasta 3 botones de respuesta rápida. Cuando el lead toca uno, llega como
// mensaje 'interactive' y whatsapp.js lo lee como texto (el título del botón).
export async function sendButtons(to, body, titles) {
  const digits = String(to).replace(/\D/g, '');
  const candidates = arVariants(digits);
  const seen = new Set();
  const buttons = (titles || [])
    .map((t) => String(t).trim().slice(0, 20))
    .filter((t) => t && !seen.has(t) && seen.add(t))
    .slice(0, 3)
    .map((t, i) => ({ type: 'reply', reply: { id: `b${i + 1}`, title: t } }));
  if (!buttons.length) return sendText(to, body);
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await graphPost(`${ENV.WA_PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: candidates[i],
        type: 'interactive',
        interactive: { type: 'button', body: { text: String(body).slice(0, 1024) }, action: { buttons } },
      });
    } catch (e) {
      lastErr = e;
      const recoverable = /131030|131026|not in allowed list|invalid.*recipient|recipient.*invalid/i.test(e.message || '');
      if (!recoverable || i === candidates.length - 1) throw e;
    }
  }
  throw lastErr;
}

// Manda una imagen ya subida (por media id), con epígrafe opcional. Reintenta con la otra forma del 9.
export async function sendImage(to, mediaId, caption) {
  const digits = String(to).replace(/\D/g, '');
  const candidates = arVariants(digits);
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await graphPost(`${ENV.WA_PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: candidates[i],
        type: 'image',
        image: { id: mediaId, ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) },
      });
    } catch (e) {
      lastErr = e;
      const recoverable = /131030|131026|not in allowed list|invalid.*recipient|recipient.*invalid/i.test(e.message || '');
      if (!recoverable || i === candidates.length - 1) throw e;
    }
  }
  throw lastErr;
}

// Manda una PLANTILLA pre-aprobada por Meta (único modo de escribirle a un lead FUERA de la ventana
// de 24h). `bodyParams` son los valores de las variables {{1}},{{2}}... del cuerpo (ej. [nombre]).
// Reintenta con la otra forma del 9 de Argentina.
export async function sendTemplate(to, name, lang, bodyParams) {
  const digits = String(to).replace(/\D/g, '');
  const candidates = arVariants(digits);
  const components = (bodyParams && bodyParams.length)
    ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }]
    : [];
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await graphPost(`${ENV.WA_PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: candidates[i],
        type: 'template',
        template: { name, language: { code: lang || 'es_AR' }, ...(components.length ? { components } : {}) },
      });
    } catch (e) {
      lastErr = e;
      const recoverable = /131030|131026|not in allowed list|invalid.*recipient|recipient.*invalid/i.test(e.message || '');
      if (!recoverable || i === candidates.length - 1) throw e;
    }
  }
  throw lastErr;
}

// Chequeo EN VIVO del token, para cuando hace rato no se manda nada real (así
// el aviso "token vencido" y el endpoint /salud no dependen de que llegue un
// mensaje para enterarse). Devuelve ok:true/false SOLO ante un rechazo de auth
// confirmado (401/403); ante cualquier otro problema (sin red, etc.) devuelve
// ok:null — "no se pudo verificar", no "está roto" — para no disparar un
// falso positivo por un problema de red pasajero.
export async function checkTokenLive() {
  if (!ENV.WA_TOKEN || !ENV.WA_PHONE_NUMBER_ID) {
    return { ok: false, status: 401, detail: 'faltan WA_TOKEN / WA_PHONE_NUMBER_ID en las variables de entorno' };
  }
  try {
    const j = await graphGet(`${ENV.WA_PHONE_NUMBER_ID}?fields=id`);
    if (j && j.id) return { ok: true };
    const err = j?.error;
    if (err) {
      const tokenExpirado = err.code === 190 || [458, 459, 460, 463, 467].includes(err.error_subcode);
      return { ok: false, status: tokenExpirado ? 401 : 403, detail: err.message || 'la Graph API rechazó el pedido' };
    }
    return { ok: null, detail: 'respuesta inesperada de la Graph API' };
  } catch (e) {
    return { ok: null, detail: e?.message || String(e) };
  }
}

// Verifica la firma del webhook (X-Hub-Signature-256) con el app secret. Si no
// hay app secret configurado, no verifica (devuelve true) para no bloquear el setup.
export function verifySignature(rawBody, signatureHeader) {
  if (!ENV.WA_APP_SECRET) return true;
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', ENV.WA_APP_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}
