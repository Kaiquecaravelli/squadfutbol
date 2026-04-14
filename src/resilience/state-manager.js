/**
 * state-manager.js — Checkpoint de Estado do Pipeline
 *
 * Salva o estado do pipeline em disco a cada operação significativa.
 * Em caso de queda de energia ou crash, o pipeline retoma do último
 * checkpoint salvo, sem reprocessar o que já foi feito.
 *
 * Arquivo de estado: data/pipeline-state.json
 * Arquivo de backup: data/pipeline-state.bak.json (rotacionado a cada save)
 *
 * Formato do estado:
 * {
 *   version:      número da versão do schema
 *   savedAt:      ISO timestamp do último save
 *   runId:        UUID da execução atual
 *   interrupted:  true se a execução foi interrompida antes do fim
 *   stage:        etapa atual ('etapa1_coletar' … 'etapa7_resumo' | 'done')
 *   progress:     { current, total } dentro da etapa
 *   data: {
 *     dates:      datas que estão sendo processadas
 *     coletadas:  partidas já coletadas
 *     fechadas:   predições fechadas no backfill
 *     injetados:  partidas injetadas no PIE
 *     qualified:  oportunidades que passaram no gate (array)
 *     gatedByUrl: oportunidades com URL Superbet confirmada (array)
 *     enviadas:   IDs/chaves já enviadas ao Telegram
 *   }
 * }
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DATA_DIR     = join(__dirname, '../../data');
const STATE_PATH   = join(DATA_DIR, 'pipeline-state.json');
const BAK_PATH     = join(DATA_DIR, 'pipeline-state.bak.json');
const SCHEMA_VER   = 2;

// ── Utilitários ────────────────────────────────────────────────────────────────
function _ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function _now() {
  return new Date().toISOString();
}

// ── API Pública ────────────────────────────────────────────────────────────────

/**
 * Lê o estado salvo em disco.
 * Retorna null se não existir ou se estiver corrompido (tenta o backup).
 */
export function readState() {
  for (const path of [STATE_PATH, BAK_PATH]) {
    try {
      if (!existsSync(path)) continue;
      const raw   = readFileSync(path, 'utf8');
      const state = JSON.parse(raw);
      if (state.version === SCHEMA_VER) return state;
    } catch { /* arquivo corrompido — tenta o backup */ }
  }
  return null;
}

/**
 * Salva o estado atual em disco de forma atômica:
 *   1. Move o estado atual para .bak (backup)
 *   2. Escreve o novo estado principal
 * Garante que nunca fiquemos sem estado válido mesmo em queda no meio do write.
 *
 * @param {object} patch — campos a atualizar no estado
 */
export function saveState(patch) {
  _ensureDir();
  try {
    // Rotaciona: estado atual → backup
    if (existsSync(STATE_PATH)) {
      copyFileSync(STATE_PATH, BAK_PATH);
    }

    const existing = readState() || _emptyState();
    const updated  = {
      ...existing,
      ...patch,
      version: SCHEMA_VER,
      savedAt: _now(),
      data: {
        ...(existing.data || {}),
        ...(patch.data   || {}),
      },
    };

    writeFileSync(STATE_PATH, JSON.stringify(updated, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[StateManager] Falha ao salvar estado: ${err.message}`);
  }
}

/**
 * Inicia uma nova execução — marca como interrupted=true até ser concluída.
 * Se existir um estado anterior incompleto, sinaliza para retomada.
 * @param {string[]} dates  — datas sendo processadas
 * @returns {{ runId: string, resume: boolean, prevState: object|null }}
 */
export function startRun(dates) {
  const prev   = readState();
  const resume = !!(prev && prev.interrupted && prev.stage !== 'done');

  const runId  = randomUUID();
  saveState({
    runId,
    interrupted: true,
    stage:       'start',
    progress:    { current: 0, total: 7 },
    data: {
      dates,
      coletadas:  0,
      fechadas:   0,
      injetados:  0,
      qualified:  [],
      gatedByUrl: [],
      enviadas:   [],
    },
  });

  return { runId, resume, prevState: resume ? prev : null };
}

/**
 * Atualiza a etapa atual e dados do progresso.
 * Chamado no início de cada etapa e ao concluir cada item.
 *
 * @param {string}  stage    — nome da etapa (ex: 'etapa1_coletar')
 * @param {object}  [data]   — dados parciais a mesclar em state.data
 * @param {object}  [progress] — { current, total }
 */
export function checkpoint(stage, data = {}, progress = null) {
  const patch = { stage, data };
  if (progress) patch.progress = progress;
  saveState(patch);
}

/**
 * Marca a execução como concluída com sucesso.
 * Remove o flag interrupted.
 */
export function completeRun(summary = {}) {
  saveState({
    stage:       'done',
    interrupted: false,
    data:        summary,
  });
}

/**
 * Retorna true se existe um estado interrompido que pode ser retomado.
 */
export function hasInterruptedRun() {
  const s = readState();
  return !!(s && s.interrupted && s.stage !== 'done' && s.stage !== 'start');
}

/**
 * Limpa o estado (após conclusão bem-sucedida ou reset manual).
 */
export function clearState() {
  try { writeFileSync(STATE_PATH, JSON.stringify({ version: SCHEMA_VER, stage: 'done', interrupted: false, savedAt: _now() }, null, 2), 'utf8'); }
  catch {}
}

function _emptyState() {
  return {
    version:     SCHEMA_VER,
    runId:       null,
    interrupted: false,
    stage:       'start',
    progress:    { current: 0, total: 7 },
    savedAt:     _now(),
    data:        { dates: [], coletadas: 0, fechadas: 0, injetados: 0, qualified: [], gatedByUrl: [], enviadas: [] },
  };
}
