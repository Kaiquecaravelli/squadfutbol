/**
 * LiveInPlayAgent — Agente especializado em análise de jogos ao vivo
 *
 * Diferenças do BaseMarketAgent:
 *  - Consome liveData (estado atual do jogo) em vez de dados pré-jogo
 *  - Retorna um array de mercados (múltiplas oportunidades por jogo)
 *  - Não usa PIE Trainer (sem histórico de previsões ao vivo ainda)
 *  - Prompt focado em xG live, chutes, posse, minuto e placar
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { callGeminiWithRotation } from '../../../src/utils/gemini-key-manager.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '../prompts/markets/live-inplay.txt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LiveInPlayAgent {
  constructor() {
    this.name         = 'LiveInPlay';
    this.provider     = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
    this.systemPrompt = readFileSync(PROMPT_PATH, 'utf-8').trim();
  }

  // ── Constrói o payload para o modelo ───────────────────────────────────────
  _buildMessage(liveData) {
    const ls  = liveData.live_stats || {};
    const compact = (obj) => Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
    );

    const payload = compact({
      partida:    liveData.match,
      competicao: liveData.competition,
      // Estado atual
      minuto:           liveData.minuto,
      minuto_display:   liveData.minuto_label,
      minutos_restantes: liveData.minutos_restantes,
      is_acrescimo:     liveData.is_acrescimo || false,
      acrescimo:        liveData.acrescimo || 0,
      periodo:          liveData.periodo,
      placar:           liveData.placar,
      gols_casa:        liveData.gols_casa,
      gols_fora:        liveData.gols_fora,
      projecao_gols_totais:       liveData.projecao_total_gols,
      gols_esperados_restantes:   liveData.gols_esperados_restantes,
      // xG ao vivo
      xg_casa:    liveData.xg_home,
      xg_fora:    liveData.xg_away,
      xg_total:   liveData.xg_total,
      // Estatísticas ao vivo
      estatisticas_live: ls.posse_casa != null ? compact({
        posse_casa:          ls.posse_casa,
        posse_fora:          ls.posse_fora,
        chutes_alvo_casa:    ls.chutes_alvo_casa,
        chutes_alvo_fora:    ls.chutes_alvo_fora,
        chutes_total_casa:   ls.chutes_total_casa,
        chutes_total_fora:   ls.chutes_total_fora,
        escanteios_casa:     ls.escanteios_casa,
        escanteios_fora:     ls.escanteios_fora,
        ataques_perig_casa:  ls.ataques_perig_casa,
        ataques_perig_fora:  ls.ataques_perig_fora,
        defesas_casa:        ls.defesas_casa,
        defesas_fora:        ls.defesas_fora,
        amarelos_casa:       ls.amarelos_casa,
        amarelos_fora:       ls.amarelos_fora,
      }) : null,
      // Contexto pré-jogo (peso menor)
      forma_casa:           (liveData.home?.form || '').slice(-5) || null,
      forma_fora:           (liveData.away?.form || '').slice(-5) || null,
      media_gols_casa:      liveData.home?.goals_scored_avg,
      media_gols_fora:      liveData.away?.goals_scored_avg,
      // H2H resumido
      h2h_ultimos:          liveData.h2h?.slice(0, 3).map((m) => m.score),
    });

    return [
      'INSTRUÇÃO CRÍTICA: Retorne APENAS o JSON array do schema. Sem texto antes ou depois.',
      'DADOS DO JOGO AO VIVO:',
      JSON.stringify(payload),
    ].join('\n');
  }

  // ── Parse da resposta (array de mercados) ──────────────────────────────────
  _parseResponse(text) {
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Tenta parse direto
    try {
      const parsed = JSON.parse(clean);
      // Normaliza: se retornou objeto wrapper {markets:[...]} ou {results:[...]}, extrai o array
      if (Array.isArray(parsed)) return parsed;
      const arr = parsed.markets ?? parsed.results ?? parsed.opportunities ?? parsed.mercados;
      if (Array.isArray(arr)) return arr;
      // Objeto único → envolve em array
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {}

    // Extrai primeiro array JSON
    const arrMatch = clean.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch {}
    }

    // Extrai objetos individuais e monta array
    const results = [];
    const objRegex = /\{[^{}]+\}/g;
    let m;
    while ((m = objRegex.exec(clean)) !== null) {
      try { results.push(JSON.parse(m[0])); } catch {}
    }
    if (results.length) return results;

    return [];
  }

  // ── Chamada Groq com rotação automática de chaves ─────────────────────────
  async _callGemini(message) {
    const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
    return callGeminiWithRotation(async (apiKey) => {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model,
          temperature:     0.15,
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
    }, 'LiveInPlay', 18);
  }

  // ── Método principal ───────────────────────────────────────────────────────
  async analyze(liveData) {
    const message  = this._buildMessage(liveData);
    const raw      = await this._callGemini(message);
    const results  = this._parseResponse(raw);

    // Gate duplo no agente: prob >= 80 E conf >= 80
    // Se Gemini omitir confianca, usa 0 → garante rejeição automática
    return results
      .filter((r) => {
        if (!r || typeof r.probabilidade !== 'number') return false;
        const prob = r.probabilidade;
        const conf = typeof r.confianca === 'number' ? r.confianca : 0;
        return prob >= 80 && conf >= 80;
      })
      .map((r) => ({
        agent:          this.name,
        mercado:        r.mercado || 'Desconhecido',
        recomendacao:   r.recomendacao || 'APOSTAR',
        probabilidade:  r.probabilidade,
        confianca:      r.confianca,
        odds_minima:    r.odds_minima_recomendada ?? null,
        justificativa:  r.justificativa || '',
      }));
  }
}
