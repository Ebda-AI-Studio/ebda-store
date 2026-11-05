/**
 * PM2 Ecosystem Configuration
 * Production process management for Ebda
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 start ecosystem.config.js --env production
 *   pm2 reload ecosystem.config.js --env production
 */

module.exports = {
  apps: [
    {
      name: 'ebda-api',
      script: 'apps/api/dist/index.js',
      instances: 'max',
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      max_restarts: 10,
      env: {
        NODE_ENV: 'development',
        PORT: 4000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      error_file: 'logs/api-error.log',
      out_file: 'logs/api-out.log',
      log_file: 'logs/api-combined.log',
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_size: '50M',
      retain: 10,
    },
    {
      name: 'force-web',
      script: 'apps/web/.next/standalone/apps/web/server.js',
      instances: 2,
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      max_restarts: 10,
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: 'logs/web-error.log',
      out_file: 'logs/web-out.log',
      log_file: 'logs/web-combined.log',
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_size: '50M',
      retain: 10,
    },
    {
      name: 'force-admin',
      script: 'apps/admin/.next/standalone/apps/admin/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      max_restarts: 10,
      env: {
        NODE_ENV: 'development',
        PORT: 3001,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      error_file: 'logs/admin-error.log',
      out_file: 'logs/admin-out.log',
      log_file: 'logs/admin-combined.log',
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_size: '50M',
      retain: 10,
    },
  ],

  deploy: {
    production: {
      user: 'deploy',
      host: ['server1.example.com'],
      ref: 'origin/main',
      repo: 'git@github.com:Ebda-AI-Studio/ebda-store.git',
      path: '/var/www/ebda',
      'pre-deploy-local': '',
      'post-deploy':
        'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
      env: {
        NODE_ENV: 'production',
      },
    },
    staging: {
      user: 'deploy',
      host: ['staging.example.com'],
      ref: 'origin/develop',
      repo: 'git@github.com:Ebda-AI-Studio/ebda-store.git',
      path: '/var/www/ebda-staging',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env staging',
      env: {
        NODE_ENV: 'staging',
      },
    },
  },
};
