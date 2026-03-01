// pm2 ecosystem config for Feature Dashboard + Proxy
// Usage:
//   pm2 start ecosystem.config.cjs          # Start all
//   pm2 start ecosystem.config.cjs --only dashboard-backend
//   pm2 stop all
//   pm2 save                                # Persist across pm2 resurrect

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'proxy',
      script: path.join(__dirname, 'backend', 'proxy.cjs'),
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'dashboard-backend',
      script: 'backend/server.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 3000,
      env: {
        PROJECT_ROOT: path.resolve(__dirname, '..', '..', '..', '..'),
        PORT: '3001',
        PROXY_ENABLED: 'true',
        PROXY_HOST: '127.0.0.1',
        PROXY_PORT: '8888',
        DASHBOARD_DEBUG: '1',
        // CCS_PROFILE: Auto-detected from ~/.ccs/config.yaml (set manually to override)
      },
    },
    {
      name: 'dashboard-frontend',
      script: path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js'),
      args: '--host',
      cwd: path.join(__dirname, 'frontend'),
      watch: false,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 2000,
    },
  ],
};
