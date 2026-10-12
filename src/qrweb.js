import http from 'node:http';
import QRCode from 'qrcode';

// ============================================================================
//  Página web de vinculación: sirve un QR que se actualiza solo, para escanear
//  con WhatsApp del número nuevo. Pensada para correr en Railway (escucha en
//  $PORT y se expone con un dominio público). Se prende solo si QR_WEB=1.
//  Una vez vinculado, sacá QR_WEB y el dominio.
// ============================================================================

let currentQR = null;   // último QR emitido por Baileys (string)
let connected = false;  // ya vinculó
let server = null;

export function setQR(qr) {
  currentQR = qr;
  connected = false;
}

export function setConnected() {
  connected = true;
  currentQR = null;
}

function page() {
  if (connected) {
    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp vinculado</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:60px;background:#0b141a;color:#e9edef">
<h1>✅ WhatsApp vinculado</h1>
<p>Ya está conectado. Podés cerrar esta página.</p>
</body></html>`;
  }
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Vincular WhatsApp</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:32px;background:#0b141a;color:#e9edef">
<h2>Vincular el número nuevo</h2>
<p>En el teléfono: WhatsApp → Dispositivos vinculados → Vincular un dispositivo → escaneá:</p>
${currentQR
    ? `<img src="/qr.png?t=${Date.now()}" width="320" height="320" alt="QR" style="background:#fff;padding:14px;border-radius:10px">`
    : `<p>⏳ Generando el QR… (la página se refresca sola cada 5s)</p>`}
<p style="opacity:.6;margin-top:18px">se actualiza solo · si el QR caduca, esperá unos segundos</p>
</body></html>`;
}

export function startQrWeb() {
  if (server) return;
  // Por seguridad escucha SOLO en localhost (127.0.0.1): nadie de afuera lo ve.
  // La vinculación se hace local; la sesión después se migra a Railway por env.
  const host = process.env.QR_HOST || '127.0.0.1';
  const port = Number(process.env.QR_PORT || process.env.PORT) || 8080;
  server = http.createServer(async (req, res) => {
    try {
      if (req.url && req.url.startsWith('/qr.png')) {
        if (!currentQR) {
          res.writeHead(404).end();
          return;
        }
        const png = await QRCode.toBuffer(currentQR, { width: 320, margin: 2 });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(png);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page());
    } catch (e) {
      res.writeHead(500).end('error');
      console.error('qrweb error:', e?.message || e);
    }
  });
  server.listen(port, host, () => console.log(`🌐 Página de vinculación QR (privada) en http://${host}:${port}`));
}
