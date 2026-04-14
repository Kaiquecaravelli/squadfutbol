/**
 * Live2TAgent — Agente especializado em análise de 2° Tempo (min 46+)
 *
 * Diferenças do LiveInPlayAgent:
 *  - Prompt focado exclusivamente em 2T (min 46-97)
 *  - Mercados: Resultado Final, Próximo Gol, Over/Under Restante, BTTS Final
 *  - Gate: prob >= 80 E conf >= 80 (ambos obrigatórios — sem padrão tolerante)
 *  - Contextualiza minuto dentro do 2T (não como minuto total do jogo)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { callGeminiWithRotation } from '../../../src/utils/gemini-key-manager.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '../prompts/markets/live-2t.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Live2TAgent {
  constructor() {
    this.name         = 'Live2T';
    this.provider     = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
    this.systemPrompt = readFileSync(PROMPT_PATH, 'utf-8').trim();
  }

  _buildMessage(liveData) {
    const ls = liveData.live_stats || {};
    const compact = (obj) => Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
    );

    // Calcula gols marcados no 2T (após min 45)
    const totalGols  = (liveData.gols_casa || 0) + (liveData.gols_fora || 0);
    const min        = typeof liveData.minuto === 'number' ? liveData.minuto : 60;
    const min2T      = Math.max(0, min - 45); // minutos decorridos no 2T
    const ritmo2T    = min2T > 0 ? totalGols / min2T : 0;
    const xgTotal    = (liveData.xg_home ?? 0) + (liveData.xg_away ?? 0);

    const payload = compact({
      partida:          liveData.match,
      competicao:       liveData.competition,
      // Contexto temporal do 2T
      minuto_display:   liveData.minuto_label || String(min),
      minuto_no_2t:     min2T,
      minutos_restantes: liveData.minutos_restantes,
      is_acrescimo:     liveData.is_acrescimo || false,
      // Placar
      placar:           liveData.placar,
      gols_casa:        liveData.gols_casa,
      gols_fora:        liveData.gols_fora,
      // xG e projeção
      xg_casa:          liveData.xg_home,
      xg_fora:          liveData.xg_away,
      xg_total:         xgTotal > 0 ? Math.round(xgTotal * 10) / 10 : null,
      xg_supera_gols:   xgTotal > totalGols ? Math.round((xgTotal - totalGols) * 10) / 10 : 0,
      gols_esperados_restantes: liveData.gols_esperados_restantes,
      ritmo_gols_2t:    Math.round(ritmo2T * 100) / 100,
      // Stats ao vivo (2T foco)
      stats_2t: ls.chutes_alvo_casa != null ? compact({
        chutes_alvo_casa:    ls.chutes_alvo_casa,
        chutes_alvo_fora:    ls.chutes_alvo_fora,
        posse_casa:          ls.posse_casa,
        posse_fora:          ls.posse_fora,
        ataques_perig_casa:  ls.ataques_perig_casa,
        ataques_perig_fora:  ls.ataques_perig_fora,
        escanteios_casa:     ls.escanteios_casa,
        escanteios_fora:     ls.escanteios_fora,
        defesas_casa:        ls.defesas_casa,
        defesas_fora:        ls.defesas_fora,
      }) : null,
      // Contexto pré-jogo mínimo
      forma_casa:  (liveData.home?.form || '').slice(-4) || null,
      forma_fora:  (liveData.away?.form || '').slice(-4) || null,
    });

    return [
      'INSTRUÇÃO: Retorne APENAS o JSON array. Sem texto antes ou depois.',
      'JOGO AO VIVO — SEGUNDO TEMPO:',
      JSON.stringify(payload),
    ].join('\n');
  }

  _parseResponse(text) {
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try {
      const parsed = JSON.parse(clean);
      if (Array.isArray(parsed)) return parsed;
      const arr = parsed.markets ?? parsed.results ?? parsed.opportunities ?? parsed.mercados;
      if (Array.isArray(arr)) return arr;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {}
    const arr = clean.match(/\[[\s\S]*\]/);
    if (arr) { try { return JSON.parse(arr[0]); } catch {} }
    const results = [];
    const objRegex = /\{[^{}]+\}/g;
    let m;
    while ((m = objRegex.exec(clean)) !== null) {
      try { results.push(JSON.parse(m[0])); } catch {}
    }
    return results;
  }

  // ── Chamada Groq com rotação automática de chaves ─────────────────────────
  async _callGemini(message) {
    const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
    return callGeminiWithRotation(async (apiKey) => {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model,
          temperature:     0.1,
          max_tokens:      500,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user',   content: message },
          ],
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 30_000,
        }
      );
      const text = res.data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Resposta vazia');
      return text;
    }, 'Live2T', 18);
  }

  async analyze(liveData) {
    const message = this._buildMessage(liveData);
    const raw     = await this._callGemini(message);
    const results = this._parseResponse(raw);
    return results
      // Gate duplo no agente: prob >= 80 E conf >= 80
      // Se Gemini omitir confianca, usa 0 → garante rejeição automática
      .filter((r) => {
        if (!r || typeof r.probabilidade !== 'number') return false;
        const prob = r.probabilidade;
        const conf = typeof r.confianca === 'number' ? r.confianca : 0;
        return prob >= 80 && conf >= 80;
      })
      .map((r) => ({
        agent:         this.name,
        mercado:       r.mercado || 'Desconhecido',
        recomendacao:  r.recomendacao || 'APOSTAR',
        probabilidade: r.probabilidade,
        confianca:     r.confianca,
        odds_minima:   r.odds_minima_recomendada ?? null,
        justificativa: r.contexto || '',
      }));
  }
}
