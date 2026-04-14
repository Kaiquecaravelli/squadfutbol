# Task: fetch-news
agent: news-analyst
elicit: false

## Inputs
- `match_data.json` (home.team + away.team)

## Steps
1. Para cada time (home + away) em paralelo:
   a. Chamar NewsAPI `/everything?q="{team}" futebol OR football`
   b. Lookback: últimas 72h (configurável via NEWS_LOOKBACK_HOURS)
   c. Idioma: pt, en (configurável via NEWS_LANGUAGE)
2. Para cada artigo, classificar impacto via regras de palavras-chave:
   - lesão/injury → -15 pts
   - suspensão → -10 pts
   - crise/sacked → -10 pts
   - retorno/return → +10 pts
   - motivação extra → +8 pts
3. Calcular impact_score total (clampado em [-30, +30])
4. Derivar sentiment: positive | negative | neutral
5. Retornar top 5 headlines mais relevantes

## Output
```json
{
  "home": { "team", "news_count", "impact_score", "sentiment", "key_headlines", "summary" },
  "away": { "team", "news_count", "impact_score", "sentiment", "key_headlines", "summary" }
}
```

## Error Handling
- Se NEWSAPI_KEY ausente: retornar impact_score=0, sentiment=neutral (não bloqueante)
- Se API retornar 429 (rate limit): aguardar 5s e tentar 1x em inglês como fallback
