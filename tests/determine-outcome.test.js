/**
 * determine-outcome.test.js — Testes de integração para determineOutcome
 *
 * Execução: node --test tests/determine-outcome.test.js
 *
 * Cópia local da função para teste isolado (sem necessidade de exportar).
 * Mantém a lógica EXATA de scripts/result-checker.js — atualizar aqui se
 * a fonte mudar.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Cópia local da função para teste isolado ─────────────────────────────────
// Fonte: scripts/result-checker.js — função determineOutcome (não exportada)
// entry é opcional — usado para "Resultado Final {time}" que precisa saber qual time
function determineOutcome(market, prediction, score, entry = {}) {
  if (score.home == null || score.away == null) return null;

  // Usa placar do tempo normal (90min) — ignora prorrogação/pênaltis
  const homeGoals = score.normaltime_home ?? score.home;
  const awayGoals = score.normaltime_away ?? score.away;
  const total = homeGoals + awayGoals;
  const rec   = String(prediction || '').toUpperCase().trim();
  const mkt   = (market || '').toUpperCase();

  // ── Gols Over/Under ──────────────────────────────────────────────────────────
  if (market.includes('Over 0.5'))  return total > 0;
  if (market.includes('Over 1.5'))  return total > 1;
  if (market.includes('Over 2.5'))  return total > 2;
  if (market.includes('Over 3.5'))  return total > 3;
  if (market.includes('Over 4.5'))  return total > 4;
  if (market.includes('Over 5.5'))  return total > 5;
  if (market.includes('Under 0.5')) return total < 1;
  if (market.includes('Under 1.5')) return total < 2;
  if (market.includes('Under 2.5')) return total < 3;
  if (market.includes('Under 3.5')) return total < 4;
  if (market.includes('Under 4.5')) return total < 5;

  // ── BTTS / Ambas Marcam ──────────────────────────────────────────────────────
  if (mkt.includes('BTTS') || mkt.includes('AMBAS')) {
    const bttsOk = homeGoals > 0 && awayGoals > 0;
    if (rec === 'NÃO' || rec === 'NAO' || rec === 'NO' || rec === 'NÃO MARCAM') return !bttsOk;
    return bttsOk;
  }

  // ── Resultado — genéricos home/away verificados ANTES de "Resultado Final {time}" ──
  if (mkt.includes('RESULTADO FINAL CASA') || mkt.includes('HOME WIN') || market === '1')
    return homeGoals > awayGoals;
  if (mkt.includes('RESULTADO FINAL FORA') || mkt.includes('AWAY WIN') || market === '2')
    return awayGoals > homeGoals;
  if (mkt.includes('DRAW') || mkt.includes('EMPATE') || market === 'X')
    return homeGoals === awayGoals;

  // ── "Resultado Final {time}" — identifica time pelo nome ────────────────────
  if (mkt.includes('RESULTADO FINAL')) {
    const [homeTeam, awayTeam] = (entry.match || '').split(/\s+vs\s+/i);
    const teamInMarket = market.replace(/resultado final/i, '').trim().toLowerCase();
    if (teamInMarket.length >= 3) {
      const isHomeTeam = homeTeam && homeTeam.toLowerCase().includes(teamInMarket.slice(0, 6));
      const isAwayTeam = awayTeam && awayTeam.toLowerCase().includes(teamInMarket.slice(0, 6));
      if (isHomeTeam) return homeGoals > awayGoals;
      if (isAwayTeam) return awayGoals > homeGoals;
    }
    // Time não identificado no mercado — não verificável
    return null;
  }

  // ── Dupla Chance ─────────────────────────────────────────────────────────────
  if (market === '1X' || mkt.includes('DUPLA CHANCE 1X')) return homeGoals >= awayGoals;
  if (market === 'X2' || mkt.includes('DUPLA CHANCE X2')) return awayGoals >= homeGoals;
  if (market === '12' || mkt.includes('DUPLA CHANCE 12')) return homeGoals !== awayGoals;

  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const score = (home, away, opts = {}) => ({ home, away, ...opts });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Over / Under Gols
// ─────────────────────────────────────────────────────────────────────────────
describe('Over/Under Gols', () => {
  describe('Over 1.5', () => {
    test('2-0 → true  (total=2 > 1)', () => {
      assert.equal(determineOutcome('Over 1.5', 'SIM', score(2, 0)), true);
    });
    test('1-0 → false (total=1 não > 1)', () => {
      assert.equal(determineOutcome('Over 1.5', 'SIM', score(1, 0)), false);
    });
    test('1-1 → true  (total=2 > 1)', () => {
      assert.equal(determineOutcome('Over 1.5', 'SIM', score(1, 1)), true);
    });
  });

  describe('Over 2.5', () => {
    test('2-1 → true  (total=3 > 2)', () => {
      assert.equal(determineOutcome('Over 2.5', 'SIM', score(2, 1)), true);
    });
    test('1-1 → false (total=2 não > 2)', () => {
      assert.equal(determineOutcome('Over 2.5', 'SIM', score(1, 1)), false);
    });
  });

  describe('Over 3.5', () => {
    test('4-0 → true  (total=4 > 3)', () => {
      assert.equal(determineOutcome('Over 3.5', 'SIM', score(4, 0)), true);
    });
    test('2-1 → false (total=3 não > 3)', () => {
      assert.equal(determineOutcome('Over 3.5', 'SIM', score(2, 1)), false);
    });
  });

  describe('Over 5.5', () => {
    test('3-3 → true  (total=6 > 5)', () => {
      assert.equal(determineOutcome('Over 5.5', 'SIM', score(3, 3)), true);
    });
    test('3-2 → false (total=5 não > 5)', () => {
      assert.equal(determineOutcome('Over 5.5', 'SIM', score(3, 2)), false);
    });
  });

  describe('Under 2.5', () => {
    test('1-0 → true  (total=1 < 3)', () => {
      assert.equal(determineOutcome('Under 2.5', 'SIM', score(1, 0)), true);
    });
    test('2-1 → false (total=3 não < 3)', () => {
      assert.equal(determineOutcome('Under 2.5', 'SIM', score(2, 1)), false);
    });
  });

  describe('Under 3.5', () => {
    test('2-0 → true  (total=2 < 4)', () => {
      assert.equal(determineOutcome('Under 3.5', 'SIM', score(2, 0)), true);
    });
    test('3-1 → false (total=4 não < 4)', () => {
      assert.equal(determineOutcome('Under 3.5', 'SIM', score(3, 1)), false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. BTTS / Ambas Marcam
// ─────────────────────────────────────────────────────────────────────────────
describe('BTTS / Ambas Marcam', () => {
  test('BTTS + 1-1 → true  (ambos marcaram)', () => {
    assert.equal(determineOutcome('BTTS', 'SIM', score(1, 1)), true);
  });
  test('BTTS + 2-0 → false (away não marcou)', () => {
    assert.equal(determineOutcome('BTTS', 'SIM', score(2, 0)), false);
  });
  test('BTTS + prediction NÃO + 1-0 → true  (apostou que não marcaria — acertou)', () => {
    assert.equal(determineOutcome('BTTS', 'NÃO', score(1, 0)), true);
  });
  test('BTTS + prediction NÃO + 1-1 → false (apostou que não marcaria — errou)', () => {
    assert.equal(determineOutcome('BTTS', 'NÃO', score(1, 1)), false);
  });
  test('Ambas Marcam + 1-1 → true', () => {
    assert.equal(determineOutcome('Ambas Marcam', 'SIM', score(1, 1)), true);
  });
  test('Ambas Marcam + prediction NAO + 1-0 → true', () => {
    assert.equal(determineOutcome('Ambas Marcam', 'NAO', score(1, 0)), true);
  });
  test('Ambas Marcam + prediction NO + 0-0 → true  (nenhum marcou → não ocorreu BTTS)', () => {
    assert.equal(determineOutcome('Ambas Marcam', 'NO', score(0, 0)), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Resultado Final — genérico (Home Win / Away Win / Draw / 1 / 2 / X)
// ─────────────────────────────────────────────────────────────────────────────
describe('Resultado Final genérico', () => {
  describe('Home Win', () => {
    test('Home Win + 2-1 → true', () => {
      assert.equal(determineOutcome('Home Win', 'SIM', score(2, 1)), true);
    });
    test('Home Win + 0-1 → false', () => {
      assert.equal(determineOutcome('Home Win', 'SIM', score(0, 1)), false);
    });
    test('Home Win + 0-0 → false (empate)', () => {
      assert.equal(determineOutcome('Home Win', 'SIM', score(0, 0)), false);
    });
  });

  describe('Away Win', () => {
    test('Away Win + 0-2 → true', () => {
      assert.equal(determineOutcome('Away Win', 'SIM', score(0, 2)), true);
    });
    test('Away Win + 1-0 → false', () => {
      assert.equal(determineOutcome('Away Win', 'SIM', score(1, 0)), false);
    });
  });

  describe('Draw / Empate', () => {
    test('Draw + 1-1 → true', () => {
      assert.equal(determineOutcome('Draw', 'SIM', score(1, 1)), true);
    });
    test('Draw + 2-1 → false', () => {
      assert.equal(determineOutcome('Draw', 'SIM', score(2, 1)), false);
    });
    test('EMPATE + 0-0 → true', () => {
      assert.equal(determineOutcome('EMPATE', 'SIM', score(0, 0)), true);
    });
  });

  describe('Mercados 1 / 2 / X', () => {
    test('market "1" + 2-0 → true  (home win)', () => {
      assert.equal(determineOutcome('1', 'SIM', score(2, 0)), true);
    });
    test('market "2" + 0-2 → true  (away win)', () => {
      assert.equal(determineOutcome('2', 'SIM', score(0, 2)), true);
    });
    test('market "X" + 0-0 → true  (empate)', () => {
      assert.equal(determineOutcome('X', 'SIM', score(0, 0)), true);
    });
    test('market "1" + 0-1 → false', () => {
      assert.equal(determineOutcome('1', 'SIM', score(0, 1)), false);
    });
    test('market "X" + 2-1 → false', () => {
      assert.equal(determineOutcome('X', 'SIM', score(2, 1)), false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Resultado Final com time identificado pelo nome
// ─────────────────────────────────────────────────────────────────────────────
describe('Resultado Final com time identificado', () => {
  const bocaVsRiver = { match: 'Boca Juniors vs River Plate' };

  test('Resultado Final Boca Juniors + 2-1 → true  (Boca é mandante, ganhou)', () => {
    assert.equal(
      determineOutcome('Resultado Final Boca Juniors', 'SIM', score(2, 1), bocaVsRiver),
      true,
    );
  });

  test('Resultado Final River Plate + 2-1 → false (River é visitante, perdeu)', () => {
    assert.equal(
      determineOutcome('Resultado Final River Plate', 'SIM', score(2, 1), bocaVsRiver),
      false,
    );
  });

  test('Resultado Final River Plate + 0-2 → true  (River é visitante, ganhou)', () => {
    assert.equal(
      determineOutcome('Resultado Final River Plate', 'SIM', score(0, 2), bocaVsRiver),
      true,
    );
  });

  test('Resultado Final Boca Juniors + 1-1 → false (empate não é vitória do Boca)', () => {
    assert.equal(
      determineOutcome('Resultado Final Boca Juniors', 'SIM', score(1, 1), bocaVsRiver),
      false,
    );
  });

  test('Resultado Final (sem time identificável) + 2-1 → null', () => {
    // teamInMarket.length < 3 → não identificável → retorna null
    assert.equal(
      determineOutcome('Resultado Final', 'SIM', score(2, 1), {}),
      null,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Dupla Chance
// ─────────────────────────────────────────────────────────────────────────────
describe('Dupla Chance', () => {
  describe('1X (home win ou empate)', () => {
    test('1X + 2-1 → true  (home win)', () => {
      assert.equal(determineOutcome('1X', 'SIM', score(2, 1)), true);
    });
    test('1X + 0-0 → true  (empate)', () => {
      assert.equal(determineOutcome('1X', 'SIM', score(0, 0)), true);
    });
    test('1X + 0-1 → false (away win)', () => {
      assert.equal(determineOutcome('1X', 'SIM', score(0, 1)), false);
    });
    test('Dupla Chance 1X + 2-0 → true', () => {
      assert.equal(determineOutcome('Dupla Chance 1X', 'SIM', score(2, 0)), true);
    });
  });

  describe('X2 (empate ou away win)', () => {
    test('X2 + 0-1 → true  (away win)', () => {
      assert.equal(determineOutcome('X2', 'SIM', score(0, 1)), true);
    });
    test('X2 + 1-1 → true  (empate)', () => {
      assert.equal(determineOutcome('X2', 'SIM', score(1, 1)), true);
    });
    test('X2 + 2-0 → false (home win)', () => {
      assert.equal(determineOutcome('X2', 'SIM', score(2, 0)), false);
    });
    test('Dupla Chance X2 + 0-2 → true', () => {
      assert.equal(determineOutcome('Dupla Chance X2', 'SIM', score(0, 2)), true);
    });
  });

  describe('12 / Dupla Chance 12 (qualquer vencedor — sem empate)', () => {
    test('Dupla Chance 12 + 2-1 → true  (home win)', () => {
      assert.equal(determineOutcome('Dupla Chance 12', 'SIM', score(2, 1)), true);
    });
    test('Dupla Chance 12 + 0-0 → false (empate não conta)', () => {
      assert.equal(determineOutcome('Dupla Chance 12', 'SIM', score(0, 0)), false);
    });
    test('Dupla Chance 12 + 0-3 → true  (away win)', () => {
      assert.equal(determineOutcome('Dupla Chance 12', 'SIM', score(0, 3)), true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Edge Cases
// ─────────────────────────────────────────────────────────────────────────────
describe('Edge Cases', () => {
  test('score.home = null → null', () => {
    assert.equal(determineOutcome('Over 1.5', 'SIM', { home: null, away: 1 }), null);
  });

  test('score.away = undefined → null', () => {
    assert.equal(determineOutcome('Over 1.5', 'SIM', { home: 1, away: undefined }), null);
  });

  test('mercado desconhecido "Placar Exato 2-1" → null', () => {
    assert.equal(determineOutcome('Placar Exato 2-1', 'SIM', score(2, 1)), null);
  });

  test('Over 5.5 + 3-3 → true  (total=6 > 5)', () => {
    assert.equal(determineOutcome('Over 5.5', 'SIM', score(3, 3)), true);
  });

  test('Over 5.5 + 3-2 → false (total=5 não > 5)', () => {
    assert.equal(determineOutcome('Over 5.5', 'SIM', score(3, 2)), false);
  });

  test('mercado vazio "" → null', () => {
    assert.equal(determineOutcome('', 'SIM', score(2, 1)), null);
  });

  test('prediction vazia ainda avalia BTTS corretamente', () => {
    // rec = '' — não bate em NÃO/NAO/NO → retorna bttsOk normalmente
    assert.equal(determineOutcome('BTTS', '', score(1, 1)), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Placar com normaltime (ignora prorrogação / pênaltis)
// ─────────────────────────────────────────────────────────────────────────────
describe('Placar com normaltime (90min)', () => {
  test('normaltime 1-1, placar final 2-2: Over 2.5 → false (usa normaltime: total=2)', () => {
    // normaltime_home=1, normaltime_away=1 → total=2 → NÃO é Over 2.5
    assert.equal(
      determineOutcome('Over 2.5', 'SIM', score(2, 2, { normaltime_home: 1, normaltime_away: 1 })),
      false,
    );
  });

  test('normaltime 3-2: Over 2.5 → true (total=5 > 2)', () => {
    assert.equal(
      determineOutcome('Over 2.5', 'SIM', score(3, 2, { normaltime_home: 3, normaltime_away: 2 })),
      true,
    );
  });

  test('normaltime 1-0, placar final 1-1 (pênaltis): home win (1X) → true via normaltime', () => {
    // normaltime: 1-0 → home ganhou nos 90min → 1X = true
    assert.equal(
      determineOutcome('1X', 'SIM', score(1, 1, { normaltime_home: 1, normaltime_away: 0 })),
      true,
    );
  });

  test('normaltime 0-0: BTTS → false (nenhum marcou em 90min)', () => {
    assert.equal(
      determineOutcome('BTTS', 'SIM', score(1, 1, { normaltime_home: 0, normaltime_away: 0 })),
      false,
    );
  });

  test('normaltime 2-1: Draw → false (resultado em 90min é 2-1, não empate)', () => {
    assert.equal(
      determineOutcome('Draw', 'SIM', score(2, 2, { normaltime_home: 2, normaltime_away: 1 })),
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
process.on('exit', () => console.log('\n✅ Testes de determineOutcome concluídos'));
