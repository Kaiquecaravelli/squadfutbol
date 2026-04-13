import { newsApi } from '../utils/api-client.js';

const IMPACT_RULES = [
  { keywords: ['lesiona', 'lesão', 'machuca', 'contund', 'injury', 'injured', 'out', 'desfalca'],  impact: -15, category: 'injury' },
  { keywords: ['suspens', 'cartão', 'expulso', 'suspended', 'banned'],                              impact: -10, category: 'suspension' },
  { keywords: ['crise', 'briga', 'confus', 'demit', 'crisis', 'sacked', 'fired'],                  impact: -10, category: 'crisis' },
  { keywords: ['interino', 'interim', 'caretaker'],                                                  impact: -8,  category: 'interim_coach' },
  { keywords: ['viagem', 'voo', 'travel', 'long trip', 'horas de voo'],                             impact: -5,  category: 'fatigue_travel' },
  { keywords: ['retorna', 'voltou', 'recuper', 'returns', 'back from injury'],                       impact: +10, category: 'return' },
  { keywords: ['final', 'decisivo', 'título', 'campeão', 'final match', 'must win'],                impact: +8,  category: 'motivation' },
  { keywords: ['invicto', 'sequência', 'unbeaten', 'winning streak'],                               impact: +6,  category: 'momentum' },
  { keywords: ['eliminado', 'rebaixado', 'eliminated', 'relegated', 'dead rubber'],                  impact: -12, category: 'low_motivation' },
];

export async function fetchNewsForMatch(matchData) {
  console.log(`📰 [News Analyst] Buscando notícias...`);

  const [homeAnalysis, awayAnalysis] = await Promise.all([
    fetchTeamNews(matchData.home.team),
    fetchTeamNews(matchData.away.team),
  ]);

  return { home: homeAnalysis, away: awayAnalysis };
}

export async function fetchTeamNews(teamName) {
  const lookback = parseInt(process.env.NEWS_LOOKBACK_HOURS || '72');
  const from = new Date(Date.now() - lookback * 3600000).toISOString().split('T')[0];
  const lang = process.env.NEWS_LANGUAGE || 'pt,en';

  let articles = [];

  try {
    const res = await newsApi.get('/everything', {
      params: {
        q: `"${teamName}" futebol OR football OR soccer`,
        language: lang.split(',')[0],
        from,
        sortBy: 'publishedAt',
        pageSize: 20,
        apiKey: process.env.NEWSAPI_KEY,
      },
    });
    articles = res?.articles || [];
  } catch {
    // fallback: inglês
    try {
      const res = await newsApi.get('/everything', {
        params: {
          q: `"${teamName}" football OR soccer`,
          language: 'en',
          from,
          sortBy: 'publishedAt',
          pageSize: 20,
          apiKey: process.env.NEWSAPI_KEY,
        },
      });
      articles = res?.articles || [];
    } catch {
      articles = [];
    }
  }

  return analyzeArticles(teamName, articles);
}

function analyzeArticles(teamName, articles) {
  let totalImpact = 0;
  const keyHeadlines = [];

  for (const article of articles) {
    const text = `${article.title} ${article.description || ''}`.toLowerCase();
    for (const rule of IMPACT_RULES) {
      if (rule.keywords.some((kw) => text.includes(kw))) {
        totalImpact += rule.impact;
        keyHeadlines.push({
          title: article.title,
          source: article.source?.name,
          url: article.url,
          published: article.publishedAt,
          impact: rule.impact,
          category: rule.category,
        });
        break; // uma regra por artigo
      }
    }
  }

  const sentiment = totalImpact > 5 ? 'positive' : totalImpact < -5 ? 'negative' : 'neutral';

  // dedup e top 5
  const unique = [...new Map(keyHeadlines.map((h) => [h.title, h])).values()].slice(0, 5);

  return {
    team: teamName,
    news_count: articles.length,
    impact_score: Math.max(-30, Math.min(30, totalImpact)),
    sentiment,
    key_headlines: unique,
    summary: buildSummary(teamName, unique, totalImpact),
  };
}

function buildSummary(team, headlines, impact) {
  if (!headlines.length) return `Sem notícias relevantes para ${team} nas últimas horas.`;

  const parts = headlines
    .slice(0, 3)
    .map((h) => `${h.impact > 0 ? '✅' : '⚠️'} ${h.title}`)
    .join(' | ');

  const label = impact > 5 ? 'positivo' : impact < -5 ? 'negativo' : 'neutro';
  return `${team}: impacto ${label} (${impact > 0 ? '+' : ''}${impact} pts). ${parts}`;
}
