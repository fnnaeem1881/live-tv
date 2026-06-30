module.exports = {
  apps: [
    {
      name: 'livetv-frontend',
      script: 'node_modules/vite/bin/vite.js',
      args: 'preview --host 0.0.0.0 --port 4173',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'livetv-proxy',
      script: 'index.js',
      cwd: __dirname + '/server',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        PORT: 8787,
      },
    },
  ],
};
