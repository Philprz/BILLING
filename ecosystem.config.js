module.exports = {
  apps: [
    {
      name: 'billing-api',
      script: 'apps/api/dist/index.js',
      cwd: 'C:\\Users\\PPZ\\BILLING',
      env_file: 'C:\\Users\\PPZ\\BILLING\\.env',
      watch: false,
      restart_delay: 3000,
      max_restarts: 10,
    },
    {
      name: 'billing-worker',
      script: 'apps/worker/dist/index.js',
      cwd: 'C:\\Users\\PPZ\\BILLING',
      env_file: 'C:\\Users\\PPZ\\BILLING\\.env',
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
    },
    {
      name: 'billing-web',
      script: 'C:\\Users\\PPZ\\BILLING\\node_modules\\vite\\bin\\vite.js',
      args: 'preview --port 4173 --host',
      cwd: 'C:\\Users\\PPZ\\BILLING\\apps\\web',
      watch: false,
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
