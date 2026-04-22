const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

const rootEnvPath = path.resolve(__dirname, '..', '..', '..', '.env');
dotenv.config({ path: rootEnvPath });

const prismaCli = require.resolve('prisma/build/index.js');
const args = process.argv.slice(2);

const child = spawn(process.execPath, [prismaCli, ...args], {
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

