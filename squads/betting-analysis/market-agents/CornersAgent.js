import { BaseMarketAgent } from './BaseMarketAgent.js';

/**
 * CornersAgent — Over/Under Escanteios
 * Fonte primária: SofaScore (estatísticas técnicas ao vivo: corners_avg, chutes, pressão)
 * Validação: Academia das Apostas (tendência histórica de mercado)
 *
 * Módulo 4 (2026-04-16): injeta distribuição temporal de escanteios e pressure index.
 * Dados extraídos de getLiveStats() por período (1ST/2ND) do SofaScore.
 */
export class CornersAgent extends BaseMarketAgent {
  constructor() {
    super({
      name:              'Escanteios',
      market:            'Escanteios',
      promptFile:        'corners.txt',
      primaryDataSource: 'sofascore',
    });
  }

  /**
   * Injeta distribuição temporal de escanteios, pressure index e ritmo projetado.
   * Usado para cruzar λ_corners estimado com o ritmo real observado ao vivo.
   */
  _buildAgentExtras(matchData) {
    const ls = matchData.live_stats || {};
    const extras = {};

    // Distribuição temporal de escanteios (disponível em partidas ao vivo)
    if (ls.corners_1st_home != null || ls.corners_1st_away != null) {
      extras.escanteios_1t = {
        casa: ls.corners_1st_home ?? null,
        fora: ls.corners_1st_away ?? null,
      };
    }
    if (ls.corners_2nd_home != null || ls.corners_2nd_away != null) {
      extras.escanteios_2t = {
        casa: ls.corners_2nd_home ?? null,
        fora: ls.corners_2nd_away ?? null,
      };
    }

    // Pressure index — % de ataques perigosos do time em relação ao total
    // >= 60: time dominante → +1 escanteio esperado
    // <= 35: time passivo → -1 escanteio esperado
    if (ls.pressure_index_home != null) extras.pressure_index_casa = ls.pressure_index_home;
    if (ls.pressure_index_away != null) extras.pressure_index_fora = ls.pressure_index_away;

    // Ritmo de escanteios projetado para 90 min (validação λ_corners ao vivo)
    const minuto = matchData.minuto;
    if (minuto && ls.corners_home != null && ls.corners_away != null) {
      const total = ls.corners_home + ls.corners_away;
      const min90 = Math.max(minuto, 1);
      extras.ritmo_escanteios_p90 = Math.round(total / min90 * 90 * 10) / 10;
    }

    return Object.keys(extras).length ? extras : null;
  }
}
