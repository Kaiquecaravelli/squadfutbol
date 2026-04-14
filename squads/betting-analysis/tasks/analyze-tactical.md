# Task: analyze-tactical
agent: tactician
elicit: false

## Inputs
- `match_data.json`

## Steps
1. Calcular score tático de home e away (0–100):
   - Forma recente: +8/W, +2/D, -6/L
   - Diferença de gols: ±8 por gol/jogo
   - xG médio: ±5 pts
   - Vantagem de casa: +8 pts (só home)
2. Analisar H2H: contar vitórias, empates, derrotas
3. Identificar key_factors (máx. 5 frases)
4. Detectar risk_flags (clima, sequência negativa, etc.)
5. Derivar tactical_edge: home | away | neutral (diferença > 10 pts)
6. Prever estilo de jogo (narrativa curta)

## Output
```json
{
  "tactical_edge", "home_score", "away_score",
  "h2h": { "home_wins", "draws", "away_wins", "total" },
  "key_factors": [],
  "risk_flags": [],
  "predicted_style": ""
}
```
