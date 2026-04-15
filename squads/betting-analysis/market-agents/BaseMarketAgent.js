import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { getExpertiseContext } from '../../../src/pie/pie-trainer.js';
import { search as memSearch, kgQuery, diaryWrite, isAvailable as memAvailable } from '../../../src/utils/mempalace.js';
import { callGroqWithRotation } from '../../../src/utils/groq-key-manager.js';
import {
  cacheGet, cacheSet,
  shouldSkipGroq,
  trackCall, trackCacheHit, trackGateSkip,
} from '../../../src/utils/groq-token-economy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '../prompts/markets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 100) / 100;

// Cache de contexto MemPalace por partida — compartilhado entre todos os agentes do mesmo jogo
// Evita 7x buscas semânticas redundantes para a mesma partida (1 busca → 7 agentes reutilizam)
const _memContextCache = new Map(); // key: matchName → { ctx, ts }
const MEM_CTX_TTL = 10 * 60_000;   // 10 min — cobre ciclo completo de análise de um jogo

export class BaseMarketAgent {
  /**
   * @param {object} config
   * @param {string} config.name              - identificador do agente
   * @param {string} config.market            - mercado principal analisado
   * @param {string} config.promptFile        - nome do arquivo .txt em prompts/markets/
   * @param {string} [config.primaryDataSource] - 'academia' | 'sofascore'
   *   'academia'  → Academia das Apostas como fonte primária de probabilidade histórica
   *   'sofascore' → SofaScore como fonte primária de estatísticas técnicas
   */
  constructor({ name, market, promptFile, primaryDataSource = 'academia' }) {
    this.name              = name;
    this.market            = market;
    this.promptFile        = promptFile;
    this.primaryDataSource = primaryDataSource;
    this.provider          = 'groq';
    this.systemPrompt      = this._loadPrompt();
  }

  _loadPrompt() {
    const path = join(PROMPTS_DIR, this.promptFile);
    return readFileSync(path, 'utf-8').trim();
  }

  _buildMessage(matchData, memoryContext = '') {
    // Remove campos nulos/undefined para reduzir tokens enviados à API
    const compact = (obj) => Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
    );

    // Calcula forma recente apenas das últimas 5 partidas (mais relevante)
    const forma5 = (formStr) => (formStr || '').slice(-5) || undefined;

    // Extrai média de gols H2H para enriquecer análise sem aumentar tokens
    const h2hSlice = matchData.h2h?.slice(0, 2) || [];
    const h2hGoalsAvg = h2hSlice.length
      ? round((h2hSlice.reduce((s, m) => s + (m.home_goals || 0) + (m.away_goals || 0), 0)) / h2hSlice.length)
      : undefined;

    const h2hCompact = h2hSlice.map((m) => ({ hg: m.home_goals ?? 0, ag: m.away_goals ?? 0 }));

    const payload = {
      ...compact({
        partida:    matchData.match,
        competicao: matchData.competition,
        mandante:   compact({
          time:          matchData.home?.team,
          forma5:        forma5(matchData.home?.form),
          gols_marc:     matchData.home?.goals_scored_avg,
          gols_sofr:     matchData.home?.goals_conceded_avg,
          xg:            matchData.home?.xg_avg,
          btts_pct:      matchData.home?.btts_pct,
          over25_pct:    matchData.home?.over_25_pct,
          cs_pct:        matchData.home?.clean_sheet_pct,
          corners_avg:   matchData.home?.corners_avg,
          shots_avg:     matchData.home?.shots_avg,
          possession:    matchData.home?.possession_avg ?? matchData.home?.possession,
        }),
        visitante:  compact({
          time:          matchData.away?.team,
          forma5:        forma5(matchData.away?.form),
          gols_marc:     matchData.away?.goals_scored_avg,
          gols_sofr:     matchData.away?.goals_conceded_avg,
          xg:            matchData.away?.xg_avg,
          btts_pct:      matchData.away?.btts_pct,
          over25_pct:    matchData.away?.over_25_pct,
          cs_pct:        matchData.away?.clean_sheet_pct,
          corners_avg:   matchData.away?.corners_avg,
          shots_avg:     matchData.away?.shots_avg,
          possession:    matchData.away?.possession_avg ?? matchData.away?.possession,
        }),
        h2h_gols_media: h2hGoalsAvg,
        odds: matchData.odds || {},
      }),
      h2h: h2hCompact, // sempre presente — lista vazia sinaliza "sem histórico direto"
    };

    // Injetar contexto de expertise do PIE Trainer — comprimido ao máximo para economizar tokens
    const expertiseFull = getExpertiseContext(this.market, matchData.competition);
    const expertise = expertiseFull ? expertiseFull.slice(0, 500) : '';

    // Indicação de fonte primária de dados para orientar o raciocínio do modelo
    const sourceHint = this.primaryDataSource === 'sofascore'
      ? `FONTE PRIMÁRIA: SofaScore — priorize estatísticas técnicas ao vivo (corners_avg, xG, chutes, pressão).`
      : `FONTE PRIMÁRIA: Academia das Apostas — priorize probabilidade histórica de mercado (btts_pct, over25_pct, forma).`;

    return [
      `INSTRUÇÃO CRÍTICA: Retorne APENAS o JSON do schema. Sem texto antes ou depois.`,
      sourceHint,
      expertise,
      memoryContext, // contexto semântico do MemPalace (padrões e fatos históricos)
      `DADOS:`,
      JSON.stringify(payload), // sem indentação — economiza ~25% de tokens
    ].filter(Boolean).join('\n');
  }

  _parseResponse(text) {
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { return JSON.parse(clean); } catch {}
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
      let depth = 0, start = -1, end = -1;
      for (let i = 0; i < clean.length; i++) {
        if (clean[i] === '{') { if (!depth) start = i; depth++; }
        else if (clean[i] === '}') { depth--; if (!depth) { end = i; break; } }
      }
      if (start !== -1 && end !== -1) {
        try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
      }
    }
    throw new Error(`[${this.name}] JSON inválido na resposta`);
  }

  async _callGroq(message, matchName = '') {
    // 1. Cache — mesmo agente + mesma partida + mesmo mercado na sessão = reusa
    const cached = cacheGet(this.name, matchName, this.market);
    if (cached) {
      trackCacheHit();
      return cached;
    }

    // 2. Chamada Groq com rotação de chaves
    trackCall();
    const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

    const text = await callGroqWithRotation(async (apiKey) => {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model,
          temperature:     0.1,
          max_tokens:      400,
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
      const t = res.data?.choices?.[0]?.message?.content;
      if (!t) throw new Error('Resposta vazia');
      return t;
    }, this.name);

    // 3. Armazena no cache
    cacheSet(this.name, matchName, this.market, text);
    return text;
  }

  /**
   * Busca memórias semânticas relevantes no MemPalace para enriquecer o contexto.
   * Retorna string compacta (~300 tokens) com padrões e lições anteriores.
   */
  async _fetchMemoryContext(matchData) {
    try {
      const query = [
        this.market,
        matchData.competition || '',
        matchData.home?.team  || '',
        matchData.away?.team  || '',
      ].filter(Boolean).join(' ');

      // Busca semântica no palace — limitado a 2 resultados para economizar tokens
      const memories = await memSearch(query, { nResults: 2 });

      // Consulta knowledge graph para os times envolvidos
      const homeKg = matchData.home?.team
        ? await kgQuery(matchData.home.team)
        : [];
      const awayKg = matchData.away?.team
        ? await kgQuery(matchData.away.team)
        : [];

      const parts = [];

      if (memories.length) {
        const excerpts = memories
          .map((m) => m.text?.slice(0, 120)) // reduzido de 200 → 120 chars
          .filter(Boolean)
          .join(' | ');
        parts.push(`[MEM]: ${excerpts}`);
      }

      const kgFacts = [...homeKg, ...awayKg]
        .map((t) => `${t.subject} ${t.predicate} ${t.object}`)
        .slice(0, 4) // reduzido de 5 → 4 fatos
        .join(', ');
      if (kgFacts) parts.push(`[CONHECIMENTO DOS TIMES]: ${kgFacts}`);

      return parts.join('\n');
    } catch {
      return ''; // graceful fallback
    }
  }

  async analyze(matchData) {
    const matchName = matchData.match || matchData.match_name || '';

    // Gate de confiança — se Quant já está muito seguro, pula Gemini e economiza tokens
    const quantConf  = matchData._quantConfidence;
    const quantProb  = matchData._quantProbability;
    if (shouldSkipGroq(this.market, quantConf, quantProb)) {
      trackGateSkip();
      // Retorna resultado baseado só no Quant (sem chamar Gemini)
      return {
        agent:         this.name,
        market:        this.market,
        recomendacao:  matchData._quantRecommendation || 'APOSTAR',
        probabilidade: quantProb,
        confianca:     quantConf,
        ev:            matchData._quantEV,
        justificativa: `[Quant direto — confiança ${quantConf}% ≥ threshold]`,
        _skippedGemini: true,
      };
    }

    // Enriquecer contexto com memórias semânticas do MemPalace (compartilhado entre agentes do mesmo jogo)
    let memoryContext = '';
    const cached = _memContextCache.get(matchName);
    if (cached && Date.now() - cached.ts < MEM_CTX_TTL) {
      memoryContext = cached.ctx;
    } else {
      memoryContext = await this._fetchMemoryContext(matchData).catch(() => '');
      _memContextCache.set(matchName, { ctx: memoryContext, ts: Date.now() });
    }

    const message = this._buildMessage(matchData, memoryContext);
    const raw     = await this._callGroq(message, matchName);
    const result  = this._parseResponse(raw);

    // Registrar decisão no diário do agente para aprendizado futuro
    if (result?.recomendacao && result.recomendacao !== 'INCERTO') {
      const entry = `${matchName} [${matchData.competition || ''}]: ${this.market} → ${result.recomendacao} (${result.probabilidade}% / conf ${result.confianca}%)`;
      diaryWrite(this.name, entry).catch(() => {});
    }

    // IMPORTANTE: market: this.market deve vir APÓS o spread para garantir que o LLM
    // não possa sobrescrever o campo autoritativo do agente (ex: CornersAgent → "Escanteios").
    return { agent: this.name, ...result, market: this.market };
  }
}
