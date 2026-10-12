import speech from '@google-cloud/speech';
import { loadCredentials } from './calendar.js';

// ============================================================================
//  Transcripción de audios de WhatsApp (Google Speech-to-Text).
//  Reusa la misma service account del calendario. Requiere:
//   - habilitar la "Cloud Speech-to-Text API" en el proyecto GCP
//   - billing habilitado en GCP (free tier 60 min/mes; después ~$0.024/min)
//  Se activa con STT=1. Si falla, el bot le pide el texto al lead (no crashea).
// ============================================================================

let _client = null;
function client() {
  if (_client) return _client;
  const creds = loadCredentials();
  if (!creds) throw new Error('sin credenciales de Google para STT');
  _client = new speech.SpeechClient({ credentials: creds, projectId: creds.project_id });
  return _client;
}

const textOf = (resp) => (resp?.results || []).map((r) => r.alternatives?.[0]?.transcript || '').join(' ').trim();

// buffer = audio OGG/Opus crudo de WhatsApp. Devuelve el texto (o '' si no entendió).
export async function transcribe(buffer) {
  if (!buffer || !buffer.length) { console.warn('🎙️ STT: buffer vacío (la descarga del audio falló)'); return ''; }
  const content = buffer.toString('base64');
  const magic = buffer.slice(0, 4).toString('latin1'); // "OggS" si es un OGG válido
  if (magic !== 'OggS') console.warn(`🎙️ STT: el audio NO es OGG (magic="${magic}", ${buffer.length}b) — la descarga puede haber traído basura`);
  // WhatsApp/Opus suele ser 48kHz; probamos también 16kHz por las dudas.
  for (const sampleRateHertz of [48000, 16000]) {
    const config = { encoding: 'OGG_OPUS', sampleRateHertz, languageCode: 'es-AR', enableAutomaticPunctuation: true, audioChannelCount: 1 };
    try {
      const [resp] = await client().recognize({ config, audio: { content } });
      const text = textOf(resp);
      console.log(`🎙️ STT sync @${sampleRateHertz}Hz: ${buffer.length}b magic="${magic}" -> "${text.slice(0, 60)}"`);
      if (text) return text;
    } catch (e) {
      const msg = e?.message || String(e);
      console.error(`stt sync @${sampleRateHertz}Hz:`, msg.slice(0, 180));
      // Audios de más de ~1 min: el recognize síncrono NO los banca. Probamos longRunningRecognize.
      if (/too long|longer than|exceed|60 sec|sync/i.test(msg)) {
        try {
          const [op] = await client().longRunningRecognize({ config, audio: { content } });
          const [resp] = await op.promise();
          const text = textOf(resp);
          console.log(`🎙️ STT long @${sampleRateHertz}Hz -> "${text.slice(0, 60)}"`);
          if (text) return text;
        } catch (e2) {
          console.error(`stt long @${sampleRateHertz}Hz:`, (e2?.message || String(e2)).slice(0, 180));
        }
      }
    }
  }
  return '';
}
