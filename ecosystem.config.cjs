module.exports = {
  apps: [
    {
      name: 'pa-sap-api',
      cwd: __dirname,
      script: 'npm.cmd',
      args: 'run start:api',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'pa-sap-worker',
      cwd: __dirname,
      script: 'npm.cmd',
      args: 'run start:worker',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'pa-sap-web',
      cwd: __dirname,
      script: 'npm.cmd',
      args: 'run start:web',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
