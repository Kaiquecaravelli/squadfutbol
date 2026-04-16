/**
 * ecosystem.config.cjs — Configuração PM2
 *
 * Gerencia o processo do scheduler com:
 *  - Reinício automático em caso de crash
 *  - Reinício após queda de energia (boot automático)
 *  - Logs rotativos por dia
 *  - Delay de 5s antes de reiniciar (evita loop de crash)
 *  - Memória máxima: reinicia se passar de 1.5GB (proteção contra memory leak)
 */

module.exports = {
  apps: [
    {
      // ── Scheduler Principal ───────────────────────────────────────────────���─
      name:             'squadfutbol',
      script:           'scripts/scheduler.js',
      interpreter:      'node',
      interpreter_args: '--require ./scripts/win-no-window.cjs',
      cwd:              __dirname,

      // Reinício automático
      autorestart:      true,
      restart_delay:    5000,       // 5s de espera antes de reiniciar
      max_restarts:     20,         // máximo de reinicializações antes de desistir
      min_uptime:       '10s',      // tempo mínimo para considerar "estável"

      // Proteção de memória (Playwright pode vazar memória em sessões longas)
      max_memory_restart: '1500M',

      // Variáveis de ambiente
      env: {
        NODE_ENV:    'production',
        TZ:          'America/Sao_Paulo',
      },

      // Logs
      log_date_format:  'YYYY-MM-DD HH:mm:ss',
      out_file:         'logs/pm2-out.log',
      error_file:       'logs/pm2-err.log',
      merge_logs:       true,
      log_type:         'json',

      // Comportamento no shutdown
      kill_timeout:     5000,       // 5s para o processo encerrar graciosamente
      wait_ready:       false,
      listen_timeout:   3000,

      // Monitoramento
      instance_var:     'INSTANCE_ID',
      watch:            false,       // não reinicia ao alterar arquivos (produção)
    },

    {
      // ── Watchdog de Saúde ───────────────────────────────────────────────────
      // Processo separado que monitora o scheduler e envia alerta ao Telegram
      // se o processo principal ficar offline por mais de 5 minutos
      name:          'squadfutbol-health',
      script:        'scripts/health-monitor.js',
      interpreter:   'node',
      interpreter_args: '--require ./scripts/win-no-window.cjs',
      cwd:           __dirname,
      autorestart:   true,
      restart_delay: 10000,
      max_restarts:  10,
      min_uptime:    '30s',
      env: {
        NODE_ENV: 'production',
        TZ:       'America/Sao_Paulo',
      },
      out_file:   'logs/health-out.log',
      error_file: 'logs/health-err.log',
      merge_logs: true,
      watch:      false,
    },

    {
      // ── Controlador de Economia de Energia ─────────────────────────────────
      // Detecta inatividade do usuário (15min sem mouse/teclado).
      // Quando inativo: para serviços Windows não essenciais + reduz CPU background.
      // Quando o usuário volta: restaura tudo automaticamente.
      // Os processos Node.js/PM2 NUNCA são afetados.
      name:          'squadfutbol-idle',
      script:        'scripts/idle-controller.js',
      interpreter:   'node',
      interpreter_args: '--require ./scripts/win-no-window.cjs',
      cwd:           __dirname,
      autorestart:   true,
      restart_delay: 15000,
      max_restarts:  5,
      min_uptime:    '60s',
      env: {
        NODE_ENV: 'production',
        TZ:       'America/Sao_Paulo',
      },
      out_file:   'logs/idle-out.log',
      error_file: 'logs/idle-err.log',
      merge_logs: true,
      watch:      false,
    },
    {
      // ── WatchdogAgent — Vigilância Sistêmica Permanente ───────────────────────
      // Monitora: sinal · precisão · dados · PIE · Kill Switches.
      // NÃO monitora: processo · internet · disco → health-monitor.js.
      // Envia alertas ao grupo quando necessário (máx. 3/dia).
      // Relatório semanal: todo domingo 08h.
      name:          'squadfutbol-watchdog',
      script:        'scripts/watchdog-agent.js',
      interpreter:   'node',
      interpreter_args: '--require ./scripts/win-no-window.cjs',
      cwd:           __dirname,
      autorestart:   true,
      restart_delay: 15_000,
      max_restarts:  10,
      min_uptime:    '30s',
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        TZ:       'America/Sao_Paulo',
      },
      out_file:   'logs/watchdog-out.log',
      error_file: 'logs/watchdog-err.log',
      merge_logs: true,
      watch:      false,
    },

    {
      // Treinador Noturno Autonomo
      name:          'squadfutbol-trainer',
      script:        'scripts/overnight-trainer.js',
      interpreter:   'node',
      interpreter_args: '--require ./scripts/win-no-window.cjs',
      cwd:           __dirname,
      autorestart:   true,
      restart_delay: 30000,
      max_restarts:  5,
      min_uptime:    '120s',
      env: { NODE_ENV: 'production', TZ: 'America/Sao_Paulo' },
      out_file:   'logs/trainer-out.log',
      error_file: 'logs/trainer-err.log',
      merge_logs: true,
      watch:      false,
    },
  ],
};