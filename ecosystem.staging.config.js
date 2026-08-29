// ecosystem.staging.config.js — PM2 config for the STAGING dina-server.
// ============================================================================
// Runs BESIDE production dina-server on the same host + same GPU, fully isolated
// at the app/DB/storage/port level. See docs/STAGING.md.
//
// Expectations:
//   * Lives in a SEPARATE staging checkout (e.g. /var/www/staging/dina-server)
//     that tracks `develop` and has its OWN `.env` with the staging values:
//     DINA_PORT=9445, DB_NAME=dina_staging, a distinct REDIS_DB, staging storage
//     roots (DINA_STORAGE_ROOT / SAGA_ROOT), a DISTINCT JWT_SECRET, and
//     MIRROR_SERVER_URL pointing at mirror-STAGING (https://127.0.0.1:9444).
//   * The app reads all of that from `.env` via dotenv — this file only sets the
//     PM2 process identity (staging-suffixed name + own log files) so staging and
//     prod never collide in `pm2 list` or the log directory.
//   * GPU: staging shares prod's single GPU (CUDA device 0) and prod's Ollama.
//     Ollama serialises requests per model, so a low-volume staging shares safely;
//     the GPU arbiter (DINA_GPU_ARBITER in .env) governs VRAM if enforcing.
//
// Start:  pm2 start ecosystem.staging.config.js && pm2 save
// ============================================================================

const path = require('path');

const CWD = __dirname;
const DIST = path.join(CWD, 'dist');
const LOGS = '/root/.pm2/logs';

module.exports = {
  apps: [
    {
      name: 'dina-server-staging',
      script: path.join(DIST, 'index.js'),
      cwd: CWD,

      autorestart: true,
      max_restarts: 15,
      min_uptime: '10s',
      restart_delay: 3000,

      max_memory_restart: '2048M',

      out_file: path.join(LOGS, 'dina-server-staging-out.log'),
      error_file: path.join(LOGS, 'dina-server-staging-error.log'),
      log_file: path.join(LOGS, 'dina-server-staging-combined.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // Staging keeps NODE_ENV=production (the app keys real behavior off it);
      // APP_ENV marks it as staging for logs/telemetry. Same GPU device as prod.
      env: {
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        NODE_OPTIONS: '--enable-source-maps',
        CUDA_VISIBLE_DEVICES: '0',
      },

      kill_timeout: 15000,
      listen_timeout: 15000,
      shutdown_with_message: true,

      instance_var: 'INSTANCE_ID',
    },
  ],
};
