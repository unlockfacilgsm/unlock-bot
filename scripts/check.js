'use strict';
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const directories = ['.', 'src', 'scripts', 'test'];
let failed = false;
for (const directory of directories) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', join(directory, entry.name)], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
