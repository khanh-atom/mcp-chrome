const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, 'dist', 'scripts', 'postinstall.js');
if (fs.existsSync(script)) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
