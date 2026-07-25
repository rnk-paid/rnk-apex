#!/usr/bin/env node
/**
 * Build Foundry module.zip for GitHub Releases (module files only).
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'zips');
const staging = join(outDir, 'rnk-apex');
const mod = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8'));
const zipPath = join(outDir, 'module.zip');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const include = [
  'module.json',
  'README.md',
  'LICENSE.md',
  'CHANGELOG.md',
  'scripts',
  'templates',
  'styles',
  'lang'
];

for (const item of include) {
  execSync(`cp -a ${JSON.stringify(join(root, item))} ${JSON.stringify(staging)}/`, { shell: '/bin/bash' });
}

rmSync(zipPath, { force: true });
execSync(`cd ${JSON.stringify(outDir)} && zip -r module.zip rnk-apex`, { shell: '/bin/bash', stdio: 'inherit' });
console.log(`Packed ${mod.id}@${mod.version} → ${zipPath}`);
