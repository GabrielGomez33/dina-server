// ecosystem.config.js - PM2 Process Manager Configuration
// ============================================================================
// DINA Server - Enterprise Process Management
// ============================================================================
//
// Usage:
//   npm run build                  # Compile TypeScript to dist/
//   sudo pm2 start ecosystem.config.js  # Start DINA server
//   sudo pm2 reload ecosystem.config.js # Zero-downtime restart
//   sudo pm2 stop ecosystem.config.js   # Stop DINA server
//   sudo pm2 delete ecosystem.config.js # Remove from PM2
//   sudo pm2 logs dina-server           # View logs
//   sudo pm2 monit                      # Real-time monitoring
//
// Deploy shortcut:
//   npm run deploy                 # Rebuild + zero-downtime reload
//
// ============================================================================

const path = require('path');

const CWD = __dirname;
const DIST = path.join(CWD, 'dist');
const LOGS = '/root/.pm2/logs';

module.exports = {
  apps: [
    {
      name: 'dina-server',
      script: path.join(DIST, 'index.js'),
      cwd: CWD,

      // Restart policy
      autorestart: true,
      max_restarts: 15,
      min_uptime: '10s',
      restart_delay: 3000,

      // Resource limits
      max_memory_restart: '2048M',

      // Logging
      out_file: path.join(LOGS, 'dina-server-out.log'),
      error_file: path.join(LOGS, 'dina-server-error.log'),
      log_file: path.join(LOGS, 'dina-server-combined.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // Environment
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--enable-source-maps',
        CUDA_VISIBLE_DEVICES: '0',
      },

      // Graceful shutdown
      kill_timeout: 15000,
      listen_timeout: 15000,
      shutdown_with_message: true,

      // Process metadata
      instance_var: 'INSTANCE_ID',
    },
  ],
};
