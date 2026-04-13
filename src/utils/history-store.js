/**
 * History Store — Persistência do analysisHistory em disco
 *
 * Problema resolvido: o analysisHistory era um Map em memória.
 * Ao reiniciar o bot, os sofascoreIds e kickoffTimes eram perdidos,
 * impedindo o result-fetcher de buscar resultados de jogos anteriores.
 *
 * Solução: serializar o Map em data/analysis-history.json a cada
 * inserção/atualização e recarregar na inicialização.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '../../data/analysis-history.json');

// Janela de retenção: mantém no disco apenas entradas das últimas 48h
const RETENTION_MS = 48 * 3_600_000;

// ── Carregar do disco e reconstituir Map ──────────────────────────────────────
export function loadAnalysisHistory() {
  if (!existsSync(FILE)) return new Map();

  try {
    const raw     = JSON.parse(readFileSync(FILE, 'utf-8'));
    const now     = Date.now();
    const cutoff  = now - RETENTION_MS;
    const entries = Object.entries(raw)
      .filter(([, v]) => {
        // Descarta entradas muito antigas (já não haverá resultado a coletar)
        const t = v.kickoffTime || v.savedAt || 0;
        return t >= cutoff;
      })
      .map(([k, v]) => [Number(k), v]);

    console.log(`[HistoryStore] 🔄 Recarregadas ${entries.length} entradas do disco`);
    return new Map(entries);
  } catch {
    console.warn('[HistoryStore] Falha ao carregar — iniciando vazio');
    return new Map();
  }
}

// ── Salvar Map em disco ───────────────────────────────────────────────────────
export function persistAnalysisHistory(map) {
  try {
    const obj = {};
    for (const [k, v] of map.entries()) {
      // Serializa apenas o essencial (evita salvar objetos muito grandes)
      obj[k] = {
        match:           v.matchData?.match || '',
        competition:     v.matchData?.competition || '',
        match_date:      v.matchData?.date || '',
        sofascoreId:     v.sofascoreId || v.matchData?.match_id || v.matchData?.sofascore_id || null,
        kickoffTime:     v.kickoffTime || null,
        predictionId:    v.predictionId || null,
        resultRegistered: v.resultRegistered || false,
        savedAt:         Date.now(),
        // Mantém approved markets para poder re-analisar sem o objeto completo
        approved: (v.approved || []).map((m) => ({
          market:         m.market,
          recommendation: m.recommendation,
          probabilidade:  m.probabilidade,
          confianca:      m.confianca || 0,
          odds_minima:    m.odds_minima || null,
        })),
        // Mantém matchData mínimo para o analyzeResult e notificações
        matchData: {
          match:       v.matchData?.match || '',
          competition: v.matchData?.competition || '',
          date:        v.matchData?.date || '',
          match_id:    v.matchData?.match_id || null,
          sofascore_id: v.matchData?.sofascore_id || null,
          home:        { team: v.matchData?.home?.team || '' },
          away:        { team: v.matchData?.away?.team || '' },
        },
        messageIds: v.messageIds || [],
      };
    }
    writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[HistoryStore] Falha ao salvar: ${err.message}`);
  }
}
