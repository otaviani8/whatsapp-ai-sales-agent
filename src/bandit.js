import fs from 'node:fs';
import path from 'node:path';
import { ENV } from './config.js';
import { OPENER_VARIANTS } from './persona.js';

// ============================================================================
//  A/B automático del opener (idea #8). Un multi-armed bandit epsilon-greedy:
//  prueba las variantes de opener y, con el tiempo, usa más la que MÁS agenda.
//  Stats por variante { sent, booked } persistidas en bandit.json.
// ============================================================================
const FILE = path.join(ENV.DATA_DIR, 'bandit.json');
const EPSILON = Number(process.env.BANDIT_EPSILON) || 0.2; // 20% exploración

let stats = null;

function load() {
  if (stats) return stats;
  stats = {};
  try {
    if (fs.existsSync(FILE)) {
      const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (obj && typeof obj === 'object') stats = obj;
    }
  } catch (e) {
    console.error('bandit.json ilegible, arranco vacío:', e.message);
  }
  return stats;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE) || '.', { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(stats));
  } catch (e) {
    console.error('No pude guardar bandit.json:', e.message);
  }
}

// Elige una variante de opener. Devuelve { id, globos }.
export function pickOpenerVariant(rnd = Math.random) {
  const variants = OPENER_VARIANTS;
  if (!variants || variants.length === 0) return null;
  if (variants.length === 1) return variants[0];
  load();
  // Exploración
  if (rnd() < EPSILON) return variants[Math.floor(rnd() * variants.length)];
  // Explotación: mejor tasa de agendado (suavizado de Laplace)
  let best = variants[0], bestRate = -1;
  for (const v of variants) {
    const s = stats[v.id] || { sent: 0, booked: 0 };
    const rate = (s.booked + 1) / (s.sent + 2);
    if (rate > bestRate) {
      bestRate = rate;
      best = v;
    }
  }
  return best;
}

export function recordSent(id) {
  if (!id) return;
  load();
  stats[id] = stats[id] || { sent: 0, booked: 0 };
  stats[id].sent++;
  save();
}

export function recordBooked(id) {
  if (!id) return;
  load();
  stats[id] = stats[id] || { sent: 0, booked: 0 };
  stats[id].booked++;
  save();
}

export function getStats() {
  return { ...load() };
}

// ============================================================================
//  A/B del HORARIO de los follow-ups que caen de madrugada: aprende a qué hora
//  (9-13) responde MÁS la gente y empuja los follow-ups nocturnos a esa hora.
//  Stats por hora { sent, resp } en followup-hours.json.
// ============================================================================
const FU_FILE = path.join(ENV.DATA_DIR, 'followup-hours.json');
export const FOLLOWUP_AB_HOURS = (process.env.FOLLOWUP_AB_HOURS || '9,10,11,12,13').split(',').map(Number);
let fuStats = null;
function fuLoad() {
  if (fuStats) return fuStats;
  fuStats = {};
  try {
    if (fs.existsSync(FU_FILE)) {
      const o = JSON.parse(fs.readFileSync(FU_FILE, 'utf8'));
      if (o && typeof o === 'object') fuStats = o;
    }
  } catch (e) {
    console.error('followup-hours.json ilegible, arranco vacío:', e.message);
  }
  return fuStats;
}
function fuSave() {
  try {
    fs.mkdirSync(path.dirname(FU_FILE) || '.', { recursive: true });
    fs.writeFileSync(FU_FILE, JSON.stringify(fuStats));
  } catch (e) {
    console.error('No pude guardar followup-hours.json:', e.message);
  }
}
// Elige a qué hora (de FOLLOWUP_AB_HOURS) mandar un follow-up que caería de madrugada.
export function pickFollowupHour(rnd = Math.random) {
  fuLoad();
  if (rnd() < EPSILON) return FOLLOWUP_AB_HOURS[Math.floor(rnd() * FOLLOWUP_AB_HOURS.length)];
  let best = FOLLOWUP_AB_HOURS[0], bestRate = -1;
  for (const h of FOLLOWUP_AB_HOURS) {
    const s = fuStats[h] || { sent: 0, resp: 0 };
    const rate = (s.resp + 1) / (s.sent + 2); // Laplace
    if (rate > bestRate) { bestRate = rate; best = h; }
  }
  return best;
}
export function recordFollowupSent(hour) {
  if (hour == null || !FOLLOWUP_AB_HOURS.includes(hour)) return;
  fuLoad(); fuStats[hour] = fuStats[hour] || { sent: 0, resp: 0 }; fuStats[hour].sent++; fuSave();
}
export function recordFollowupResponse(hour) {
  if (hour == null || !FOLLOWUP_AB_HOURS.includes(hour)) return;
  fuLoad(); fuStats[hour] = fuStats[hour] || { sent: 0, resp: 0 }; fuStats[hour].resp++; fuSave();
}
export function getFollowupHourStats() { return { ...fuLoad() }; }
