module.exports = {
  apps: [
    {
      name: 'livetv-proxy',
      script: 'index.js',
      cwd: __dirname,
      env: {
        PORT: 8787,
      },
      instances: 1,
      autorestart: true,
      watch: false,
    },
  ],
};
