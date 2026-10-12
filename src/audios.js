// ============================================================================
//  Audios fijos de Martín (apertura, confirmación, ausente).
//  Los archivos viven en audios/<id>.(ogg|opus|m4a|mp3|wav|webm) dentro del repo y
//  se deployan con el código. Se suben a Meta una vez y se reusa el media id: Meta
//  lo guarda 30 días, así que se vuelve a subir a los 20 o si cambió el archivo.
//  Si un archivo no está, hasAudio() da false y el bot sigue sin ese audio.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from './config.js';
import * as cloud from './cloud.js';
import { transcodeToOggOpus } from './audio.js';

const DIR = path.join(process.cwd(), 'audios');
const CACHE_FILE = path.join(ENV.DATA_DIR, 'audios-cache.json');
const EXTS = ['ogg', 'opus', 'm4a', 'mp3', 'wav', 'webm', 'mp4', 'aac'];
const MAX_AGE_MS = 20 * 24 * 3600 * 1000;

let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch { cache = {}; }
  return cache;
}
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    console.error('audios-cache.json no se pudo guardar:', e.message);
  }
}

function fileFor(id) {
  for (const ext of EXTS) {
    const p = path.join(DIR, `${id}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function hasAudio(id) {
  return !!(id && fileFor(id));
}

async function mediaIdFor(id) {
  const file = fileFor(id);
  if (!file) return null;
  const stat = fs.statSync(file);
  const c = loadCache();
  const hit = c[id];
  if (hit && hit.mtime === stat.mtimeMs && hit.file === path.basename(file) && Date.now() - hit.at < MAX_AGE_MS) {
    return hit.mediaId;
  }
  let buf = fs.readFileSync(file);
  if (!/\.(ogg|opus)$/i.test(file)) buf = await transcodeToOggOpus(buf);
  const mediaId = await cloud.uploadMedia(buf, 'audio/ogg', `${id}.ogg`);
  c[id] = { mediaId, at: Date.now(), mtime: stat.mtimeMs, file: path.basename(file) };
  saveCache();
  console.log(`🎙️  audio "${id}" subido a Meta (${mediaId})`);
  return mediaId;
}

// Manda el audio fijo `id` como nota de voz. Devuelve true si salió.
export async function sendFixedAudio(to, id) {
  if (!hasAudio(id)) return false;
  try {
    let mediaId = await mediaIdFor(id);
    try {
      await cloud.sendAudio(to, mediaId);
    } catch (e) {
      // El media id pudo vencer antes de tiempo: se sube de nuevo una vez.
      if (!/media|131053|100/i.test(String(e?.message || ''))) throw e;
      delete loadCache()[id];
      mediaId = await mediaIdFor(id);
      await cloud.sendAudio(to, mediaId);
    }
    console.log(`   🎙️  audio "${id}" -> ${to}`);
    return true;
  } catch (e) {
    console.error(`❌ audio "${id}" a ${to} falló:`, e?.message || e);
    return false;
  }
}
