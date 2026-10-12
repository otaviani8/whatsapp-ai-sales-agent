// ============================================================================
//  Audio — transcodeo de notas de voz grabadas en el panel a OGG/Opus, que es
//  el único formato que la Cloud API de WhatsApp acepta como nota de voz.
//  El navegador graba en webm/opus (Chrome/Android) o mp4/aac (Safari/iOS);
//  ffmpeg-static (binario estático, no requiere instalar nada en Railway) lo
//  convierte a ogg/opus mono 48k. Si ffmpeg no estuviera, tira error claro.
// ============================================================================
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export function transcodeToOggOpus(input) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg no disponible (ffmpeg-static no resolvió un binario)'));
    if (!input || !input.length) return reject(new Error('audio vacío'));
    const ff = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ar', '48000',
      '-ac', '1',
      '-f', 'ogg',
      'pipe:1',
    ]);
    const out = [];
    const err = [];
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.on('data', (c) => err.push(c));
    ff.on('error', reject); // ej. ENOENT si el binario no es ejecutable
    ff.on('close', (code) => {
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg falló (code ${code}): ${Buffer.concat(err).toString().slice(0, 200)}`));
    });
    ff.stdin.on('error', () => {}); // tragar EPIPE si ffmpeg cierra antes
    ff.stdin.write(input);
    ff.stdin.end();
  });
}
