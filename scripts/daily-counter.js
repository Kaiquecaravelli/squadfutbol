/**
 * daily-counter.js — Contador diário de análises enviadas ao grupo
 *
 * Fonte de verdade: pending-analyses.json (campo sentAt + type)
 * Tipos que contam: 'prelive', 'live', 'superodds', 'educational'
 * Leitura em tempo real — sempre reflete o estado atual do arquivo.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PENDING   = join(__dirname, '../data/pending-analyses.json');
const EDU_FILE  = join(__dirname, '../data/educational-sent.json');

// Retorna a data de hoje no fuso de São Paulo no formato YYYY-MM-DD
function todayBR() {
  return new Date().toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  }).split('/').reverse().join('-'); // DD/MM/YYYY → YYYY-MM-DD
}

/**
 * Lê pending-analyses.json e conta análises enviadas hoje ao grupo.
 * @returns {number}
 */
export function getDailyCount() {
  const today = todayBR();
  try {
    if (!existsSync(PENDING)) return 0;
    const arr = JSON.parse(readFileSync(PENDING, 'utf-8'));
    if (!Array.isArray(arr)) return 0;

    return arr.filter((a) => {
      if (!a.sentAt) return false;
      const sentDate = new Date(a.sentAt)
        .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
        .split('/').reverse().join('-');
      return sentDate === today;
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Retorna o número de análises educacionais enviadas hoje.
 * Educacionais são armazenadas em educational-sent.json (não em pending-analyses).
 */
export function getEducationalCountToday() {
  const today = todayBR();
  try {
    if (!existsSync(EDU_FILE)) return 0;
    const arr = JSON.parse(readFileSync(EDU_FILE, 'utf-8'));
    if (!Array.isArray(arr)) return 0;
    return arr.filter((e) => e.date === today).length;
  } catch {
    return 0;
  }
}

/**
 * Registra envio de análise educacional para o rastreador.
 * @param {object} info - { type, topic }
 */
export function recordEducationalSent(info = {}) {
  const today = todayBR();
  let arr = [];
  try {
    if (existsSync(EDU_FILE)) {
      arr = JSON.parse(readFileSync(EDU_FILE, 'utf-8'));
      if (!Array.isArray(arr)) arr = [];
    }
  } catch { arr = []; }

  arr.push({ date: today, sentAt: new Date().toISOString(), ...info });

  // Mantém apenas os últimos 30 dias
  const cutoff = Date.now() - 30 * 24 * 3_600_000;
  arr = arr.filter((e) => new Date(e.sentAt).getTime() > cutoff);

  writeFileSync(EDU_FILE, JSON.stringify(arr, null, 2), 'utf-8');
}

/**
 * Retorna contagem completa do dia (análises reais + educacionais).
 * @returns {{ total: number, real: number, educational: number, target: number, status: string, byCampeonato: object }}
 */
export function getDailyStatus() {
  const real        = getDailyCount();
  const educational = getEducationalCountToday();
  const total       = real + educational;
  const byCampeonato = getTournamentBreakdown();

  let status;
  if      (total >= 8) status = 'EXCELÊNCIA';
  else if (total >= 5) status = 'PADRÃO';
  else if (total >= 3) status = 'MÍNIMO';
  else if (total >= 1) status = 'INCOMPLETO';
  else                 status = 'CRÍTICO';

  return { total, real, educational, target: 3, status, byCampeonato };
}

/**
 * Retorna breakdown de análises por campeonato hoje.
 * Regra: máx 2 análises do mesmo campeonato por dia.
 * @returns {{ [competition: string]: number }}
 */
export function getTournamentBreakdown() {
  const today = todayBR();
  const result = {};
  try {
    if (!existsSync(PENDING)) return result;
    const arr = JSON.parse(readFileSync(PENDING, 'utf-8'));
    if (!Array.isArray(arr)) return result;

    arr.forEach((a) => {
      if (!a.sentAt) return;
      const sentDate = new Date(a.sentAt)
        .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
        .split('/').reverse().join('-');
      if (sentDate !== today) return;
      const comp = a.competition || 'Desconhecida';
      result[comp] = (result[comp] || 0) + 1;
    });
  } catch { /* retorna vazio */ }
  return result;
}

/**
 * Verifica se um campeonato atingiu o limite diário de 2 análises.
 * @param {string} competition
 * @returns {boolean} true se pode enviar, false se limite atingido
 */
export function canSendForTournament(competition) {
  const breakdown = getTournamentBreakdown();
  const count = breakdown[competition] || 0;
  return count < 2; // máx 2 análises por campeonato por dia
}
