import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const required = [
  'server.js',
  'package.json',
  'public/index.html',
  'data/server-config.json',
  'data/legendary-claims.json',
  'data/players.json',
  'data/world.json'
];
for (const rel of required) {
  const p = path.join(here, rel);
  if (!fs.existsSync(p)) throw new Error(`Missing: ${rel}`);
}
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
if (pkg.type !== 'module') throw new Error('package.json must use ESM');
if (!pkg.dependencies?.ws) throw new Error('ws dependency missing');
JSON.parse(fs.readFileSync(path.join(here, 'data/server-config.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(here, 'data/legendary-claims.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(here, 'data/players.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(here, 'data/world.json'), 'utf8'));
const html = fs.readFileSync(path.join(here, 'public/index.html'), 'utf8');
for (const token of ["'/ws'", "t:'claimLegendary'", "t:'resetLegendaryClaims'", "t:'battleRequest'", "t:'battleAccept'", "t:'battleReject'", "t:'battlePeerReady'"]) {
  if (!html.includes(token)) throw new Error(`HTML protocol token missing: ${token}`);
}
console.log('Static server package validation: PASS');
console.log(`HTML size: ${html.length.toLocaleString()} chars`);
console.log(`Package: ${pkg.name}@${pkg.version}`);
