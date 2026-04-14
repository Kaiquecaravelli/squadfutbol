# Task: collect-data
agent: scout
elicit: false

## Inputs
- `match_id` — ID da partida (API-Football) ou match_id demo

## Steps
1. Buscar fixture na API-Football (`/fixtures?id={match_id}`)
2. Coletar stats de temporada de home e away em paralelo
3. Buscar histórico H2H (últimos 10 confrontos)
4. Buscar odds atuais na Superbet (superbet.bet.br — via scraper)
5. Buscar clima na cidade do estádio (OpenWeatherMap)
6. Normalizar e retornar `match_data.json`

## Output
```json
{
  "match_id", "match", "date", "competition", "venue",
  "home": { "team", "form", "goals_scored_avg", "goals_conceded_avg", "xg_avg" },
  "away": { "team", "form", "goals_scored_avg", "goals_conceded_avg", "xg_avg" },
  "h2h": [],
  "odds": { "home_win": null, "draw": null, "away_win": null, "over_25": null, "btts_yes": null },
  "weather": {}
}
```

## Error Handling
- Se API-Football falhar: lançar erro (blocking — sem dados, sem análise)
- Se odds/weather falharem: retornar null nesses campos (não bloqueante)
