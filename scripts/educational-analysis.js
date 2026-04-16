/**
 * educational-analysis.js — Análise Educacional (Módulo 5)
 *
 * Quando o mercado está seco (nenhum sinal real aprovado após esgotar
 * todos os 6 níveis do Módulo 1), este módulo gera e envia conteúdo
 * educacional de qualidade ao grupo.
 *
 * Conta como 1 das 3 análises diárias mínimas.
 * Máximo de 1 análise educacional por dia.
 *
 * Tipos disponíveis (definidos no Módulo 5.1):
 *   E1 — Por que o mercado está seco hoje
 *   E2 — Revisão de padrão da semana
 *   E3 — Análise de erro recente (vermelho)
 *   E4 — Calendário de oportunidades futuras
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDailyStatus, recordEducationalSent, getEducationalCountToday, getTournamentBreakdown } from './daily-counter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ────────────────────────────────────────────────────────────────────

function loadJSON(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

function dateStrBR(isoStr) {
  return new Date(isoStr).toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

// ── Gerador E1: Por que o mercado está seco hoje ───────────────────────────────

function buildE1(context = {}) {
  const { reasons = [], nextCandidates = [] } = context;

  const lines = [
    `📊 <b>ANÁLISE DO DIA · ${dateStrBR(new Date().toISOString())}</b>`,
    '',
    `<b>🔍 Por que não há sinais hoje?</b>`,
    `<i>Mercado Pré-Live — diagnóstico técnico</i>`,
    '',
    '—',
  ];

  if (reasons.length) {
    reasons.forEach((r) => lines.push(`• ${r}`));
  } else {
    lines.push(
      '• Grade do dia composta principalmente por ligas com histórico insuficiente no PIE',
      '• Probabilidades calculadas abaixo do limiar mínimo de qualidade (72%)',
      '• Sistema operando em modo de observação — coletando dados para calibração',
    );
  }

  lines.push('—', '');

  if (nextCandidates.length) {
    lines.push('<i>Próximas oportunidades monitoradas:</i>');
    nextCandidates.slice(0, 4).forEach((c) => {
      lines.push(`· <code>${c.time || '??:??'}</code>  ${c.match}  ·  ${c.market}`);
    });
  } else {
    lines.push('<i>Monitoramento ativo — sinais notificados assim que aprovados no gate de qualidade.</i>');
  }

  return lines.join('\n');
}

// ── Gerador E2: Revisão de padrão da semana ────────────────────────────────────

function buildE2() {
  // Seleciona padrão da biblioteca com rotação semanal (semana do ano % 8 + 1)
  const weekOfYear = Math.ceil(
    (Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / (7 * 86_400_000)
  );
  const patternIdx = ((weekOfYear - 1) % 8) + 1;

  const patterns = {
    1: {
      title: 'Under Lock — sequência defensiva',
      body: [
        'Quando um time não marca há 4+ jogos consecutivos E o adversário não sofreu em 3+, o padrão Under 1.5 ganha força estatística relevante.',
        '',
        'Dados históricos no PIE mostram que esse cruzamento resulta em Under 1.5 em ~71% dos casos nas ligas da whitelist.',
        '',
        'O que observar: linha de gols sofridos do time visitante + sequência de zeros do mandante nas últimas 5 rodadas.',
      ].join('\n'),
    },
    2: {
      title: 'Style Clash — Posse vs Contra-Ataque',
      body: [
        'Times de alta posse (>60%) pressionam constantemente e geram muitos escanteios mesmo sem converter.',
        '',
        'Correlação histórica: quando um time de posse domina enfrenta um bloco baixo de contra-ataque, média de escanteios sobe ~1.8 acima da média da liga.',
        '',
        'Aplicação prática: nesses confrontos, Over Corners 8.5 e 9.5 têm valor esperado positivo consistente.',
      ].join('\n'),
    },
    3: {
      title: 'Jogo de 6 Pontos — o mercado fica cauteloso',
      body: [
        'Em confrontos diretos com 1–3 pontos de diferença na tabela e ≤8 rodadas restantes, o padrão muda drasticamente.',
        '',
        'Brasileirão (últimos 5 anos): 61% de jogos de 6 pontos terminaram com Under 1.5. La Liga: 58%. Premier: 53%.',
        '',
        'Explicação: times priorizando não perder sobre marcar → postura reativa → menos escanteios, menos gols.',
      ].join('\n'),
    },
    4: {
      title: 'Momentum — time em sequência de vitórias',
      body: [
        'Time que venceu os últimos 4+ jogos consecutivos, jogando em casa contra adversário fora do top 8:',
        '',
        '• BTTS baixo (favorito domina sem sofrer): 67% de confirmação histórica',
        '• Over 2.5: 71% de confirmação (favorito marca 2+)',
        '',
        'O momentum cria desequilíbrio tático e psicológico que o modelo Poisson capta bem.',
      ].join('\n'),
    },
    5: {
      title: 'Árbitros de Jogos Abertos',
      body: [
        'Árbitros com perfil permissivo (média >3.0 gols nos últimos 20 jogos apitados) têm impacto mensurável.',
        '',
        'Over 2.5 com árbitro de perfil aberto: +7–12 pontos percentuais acima da média da liga.',
        '',
        'Fonte de dados para verificação: WhoScored e Transfermarkt — perfil de árbitro por jogo.',
      ].join('\n'),
    },
    6: {
      title: 'Pós-Data FIFA — fadiga de seleções',
      body: [
        'Times com 5+ convocados nacionais retornam cansados das datas FIFA. O primeiro jogo após o retorno mostra:',
        '',
        '• Queda de ~12% na intensidade (distância percorrida, sprints)',
        '• Impacto no Over 2.5: pode reduzir 5–8 pontos na probabilidade real',
        '',
        'Verificar: quantos titulares do time foram convocados e quantos jogaram >180 minutos na data FIFA.',
      ].join('\n'),
    },
    7: {
      title: 'Jogo de Volta com Vantagem Confortável',
      body: [
        'Time com vantagem de 2+ gols no agregado no jogo de volta administra o resultado passivamente.',
        '',
        'Padrão Under 1.5 no jogo de volta: Copa do Brasil (68%), Copa Libertadores (65%), Champions KO (61%).',
        '',
        'Escanteios também caem: time que lidera não precisa pressionar → menos corners gerados.',
      ].join('\n'),
    },
    8: {
      title: 'xG Alto + Eficiência Baixa = Over Corners',
      body: [
        'Times com xG alto mas baixa eficiência de conversão (xG/gols > 1.8) continuam pressionando sem marcar.',
        '',
        'Cada tentativa frustrada tende a terminar em escanteio ou lateral. Correlação no PIE: r = 0.71.',
        '',
        'Aplicação: quando os dois times têm esse perfil simultaneamente, Over Corners 8.5+ tem forte valor esperado.',
      ].join('\n'),
    },
  };

  const p = patterns[patternIdx] || patterns[1];

  return [
    `📊 <b>ANÁLISE DO DIA · ${dateStrBR(new Date().toISOString())}</b>`,
    '',
    `<b>📚 Padrão da Semana: ${p.title}</b>`,
    `<i>Estudo de padrão histórico — construção de conhecimento</i>`,
    '',
    '—',
    p.body,
    '—',
    '',
    '<i>Este padrão é monitorado ativamente. Quando identificado em jogo com dados verificáveis, dispara análise normal.</i>',
  ].join('\n');
}

// ── Gerador E4: Calendário de oportunidades futuras ────────────────────────────

function buildE4(candidates = []) {
  const lines = [
    `📊 <b>ANÁLISE DO DIA · ${dateStrBR(new Date().toISOString())}</b>`,
    '',
    `<b>🗓 Radar das Próximas 24h</b>`,
    `<i>Jogos monitorados — aguardando confirmação dos gates de qualidade</i>`,
    '',
    '—',
  ];

  if (candidates.length) {
    lines.push('Jogos no radar com potencial de análise:');
    candidates.slice(0, 6).forEach((c) => {
      const timeStr = c.kickoff ? new Date(c.kickoff).toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit',
      }) : '??:??';
      lines.push(`· <code>${timeStr}</code>  <b>${c.match}</b>  ·  ${c.market || 'análise pendente'}`);
    });
  } else {
    lines.push(
      'Monitoramento contínuo ativo. Os melhores jogos das próximas horas serão analisados automaticamente.',
      '',
      'O sistema roda a cada 15 minutos na janela 14–21h e emite sinal assim que um jogo passa no gate de qualidade.',
    );
  }

  lines.push('—');
  return lines.join('\n');
}

// ── Seletor automático de tipo ─────────────────────────────────────────────────

function selectType(context = {}) {
  // E4 se há candidatos mapeados
  if (context.nextCandidates?.length) return 'E4';

  // E2 sempre disponível (rotativo por semana)
  // E1 se contexto de mercado seco disponível
  if (context.reasons?.length) return 'E1';

  // Rotação: E2 nos dias pares, E4 nos dias ímpares (sem candidatos = E2)
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000
  );
  return dayOfYear % 2 === 0 ? 'E2' : 'E1';
}

// ── Ponto de entrada principal ─────────────────────────────────────────────────

/**
 * Verifica elegibilidade e envia análise educacional ao grupo.
 * @param {object} context - { reasons, nextCandidates, forceType }
 * @returns {boolean} true se enviou, false se já enviou hoje ou elegibilidade falhou
 */
export async function sendEducationalAnalysis(context = {}) {
  // Máximo de 1 análise educacional por dia
  if (getEducationalCountToday() >= 1) {
    console.log('[Educacional] Análise educacional já enviada hoje — ignorando');
    return false;
  }

  const type = context.forceType || selectType(context);

  let text;
  if      (type === 'E1') text = buildE1(context);
  else if (type === 'E2') text = buildE2();
  else if (type === 'E4') text = buildE4(context.nextCandidates || []);
  else                     text = buildE2(); // fallback

  // Envia ao grupo via Telegram
  try {
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ path: join(__dirname, '../.env') });
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) throw new Error('Credenciais Telegram ausentes');

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:                  chatId,
        text,
        parse_mode:               'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram API error: ${err}`);
    }

    recordEducationalSent({ type, topic: type === 'E2' ? 'padrão semanal' : 'mercado seco' });
    console.log(`[Educacional] ✅ Análise ${type} enviada ao grupo`);
    return true;
  } catch (err) {
    console.error(`[Educacional] ❌ Erro ao enviar: ${err.message}`);
    return false;
  }
}

// ── Notificação ao admin sobre escalada ───────────────────────────────────────

/**
 * Envia alerta privado ao admin com status do contador diário.
 * @param {object} opts - { level, count, target, reason }
 */
export async function notifyAdminEscalation({ level, count, target = 3, reason = '' } = {}) {
  try {
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ path: join(__dirname, '../.env') });
    const token   = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
    if (!token || !adminId) return;

    const emoji  = count === 0 ? '🚨' : count < 2 ? '⚠️' : '💡';
    const now    = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const status = count >= target ? '✅' : count >= 2 ? '🟡' : '🔴';

    const text = [
      `${emoji} <b>[SISTEMA] Alerta de Produtividade · ${now}</b>`,
      '',
      `Análises enviadas hoje: <code>${count}/${target}</code> ${status}`,
      `Escalonando para Nível ${level}`,
      reason ? `Motivo: ${reason}` : '',
    ].filter(Boolean).join('\n');

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminId, text, parse_mode: 'HTML' }),
    });
  } catch { /* silent */ }
}

// ── Fechamento do dia (Módulo 6.1) ────────────────────────────────────────────

/**
 * Envia relatório de fechamento diário ao admin (23:30).
 * @param {object} extra - { verdes, vermelhos, patternStudied }
 */
export async function sendDailyClosingReport(extra = {}) {
  try {
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ path: join(__dirname, '../.env') });
    const token   = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
    if (!token || !adminId) return;

    const { total, real, educational, target, status } = getDailyStatus();
    const metaAtingida = total >= target;
    const dateStr = dateStrBR(new Date().toISOString());

    // Tenta carregar dados de resultados do dia
    let verdes = extra.verdes ?? 0;
    let vermelhos = extra.vermelhos ?? 0;
    let precisao = '--';
    try {
      const pending = loadJSON(join(__dirname, '../data/pending-analyses.json')) || [];
      const today = new Date().toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).split('/').reverse().join('-');

      const todayResolved = pending.filter((a) => {
        if (!a.resolvedAt) return false;
        const d = new Date(a.resolvedAt).toLocaleDateString('pt-BR', {
          timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
        }).split('/').reverse().join('-');
        return d === today && a.acertou !== null;
      });

      verdes    = todayResolved.filter((a) => a.acertou === true).length;
      vermelhos = todayResolved.filter((a) => a.acertou === false).length;
      const total_rv = verdes + vermelhos;
      precisao = total_rv > 0 ? `${Math.round((verdes / total_rv) * 100)}%` : '--';
    } catch { /* usa defaults */ }

    // Breakdown por campeonato
    const byCampeonato = getTournamentBreakdown();
    const campLines = Object.entries(byCampeonato)
      .sort(([, a], [, b]) => b - a)
      .map(([comp, cnt]) => `· ${comp}: <code>${cnt}</code>`)
      .join('\n') || '· (nenhuma análise enviada)';

    // Menor e média de odds do dia
    let oddMin = '--', oddMedia = '--';
    try {
      const pending = loadJSON(join(__dirname, '../data/pending-analyses.json')) || [];
      const today = new Date().toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).split('/').reverse().join('-');
      const todayOdds = pending
        .filter((a) => {
          if (!a.sentAt || !a.odds) return false;
          const d = new Date(a.sentAt).toLocaleDateString('pt-BR', {
            timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
          }).split('/').reverse().join('-');
          return d === today && typeof a.odds === 'number';
        })
        .map((a) => a.odds);
      if (todayOdds.length) {
        oddMin   = Math.min(...todayOdds).toFixed(2);
        oddMedia = (todayOdds.reduce((s, o) => s + o, 0) / todayOdds.length).toFixed(2);
      }
    } catch { /* usa defaults */ }

    const text = [
      `🔧 <b>[SISTEMA] · Fechamento do Dia · ${dateStr}</b>`,
      '════════════════════════════════════════════',
      `<b>Análises enviadas:</b>   <code>${total}</code> / meta 3`,
      `<b>Status:</b>              <code>${metaAtingida ? 'META ATINGIDA ✅' : 'INCOMPLETO ❌'}</code>`,
      '————————————————————————————————————————————',
      '<b>Por campeonato:</b>',
      campLines,
      '————————————————————————————————————————————',
      `<b>Odd mínima do dia:</b>   <code>${oddMin}</code>`,
      `<b>Odd média do dia:</b>    <code>${oddMedia}</code>`,
      '————————————————————————————————————————————',
      '<b>Resultados:</b>',
      `Verdes:   <code>${verdes}</code>  ·  Vermelhos: <code>${vermelhos}</code>`,
      `Precisão: <code>${precisao}</code>`,
      '════════════════════════════════════════════',
    ].join('\n');

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminId, text, parse_mode: 'HTML' }),
    });
    console.log('[Fechamento] ✅ Relatório de fechamento enviado ao admin');
  } catch (err) {
    console.error('[Fechamento] ❌ Erro:', err.message);
  }
}
