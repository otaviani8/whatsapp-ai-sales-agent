import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ENV } from './config.js';

// Prepara la carpeta de sesión (auth) ANTES de arrancar el socket:
//  - RESET_STATE=1   -> borra el estado de los leads (conversaciones/agendas).
//  - WIPE_AUTH=1     -> borra la sesión anterior (para re-vincular limpio).
//  - AUTH_SEED_B64   -> si no hay sesión, restaura una sembrada desde afuera.
export function prepareAuthDir() {
  const authDir = path.join(ENV.DATA_DIR, 'auth');
  const credsPath = path.join(authDir, 'creds.json');

  if (process.env.RESET_STATE === '1') {
    try {
      fs.rmSync(path.join(ENV.DATA_DIR, 'leads.json'), { force: true });
      console.log('🧹 RESET_STATE: borré el estado de los leads.');
    } catch (e) {
      console.error('RESET_STATE error:', e.message);
    }
  }

  if (process.env.WIPE_AUTH === '1') {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log('🧹 WIPE_AUTH: borré la sesión anterior.');
    } catch (e) {
      console.error('WIPE_AUTH error:', e.message);
    }
  }

  if (!fs.existsSync(credsPath) && ENV.AUTH_SEED_B64) {
    try {
      const raw = Buffer.from(ENV.AUTH_SEED_B64, 'base64');
      const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
      const files = JSON.parse(buf.toString('utf8'));
      fs.mkdirSync(authDir, { recursive: true });
      let n = 0;
      for (const [name, content] of Object.entries(files)) {
        if (name.includes('/') || name.includes('\\') || name.includes('..')) continue;
        fs.writeFileSync(path.join(authDir, name), content);
        n++;
      }
      console.log(`🌱 AUTH_SEED: restauré la sesión de WhatsApp (${n} archivos).`);
    } catch (e) {
      console.error('AUTH_SEED error (sigo sin sembrar):', e.message);
    }
  }
}
