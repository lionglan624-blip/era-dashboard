#!/usr/bin/env node
/**
 * Patch pm2 ForkMode.js to fix console flash on Windows 11 KB5077181+
 *
 * Root cause: KB5077181 changed CREATE_NEW_PROCESS_GROUP behavior.
 * pm2's detached:true child spawns now flash a console window.
 * Fix: Set detached:false in ForkMode.js.
 *
 * Usage: node patch-pm2.js
 * Re-run after: npm update -g pm2
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Find global pm2 installation via npm root
const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
const forkModePath = path.join(globalRoot, 'pm2', 'lib', 'God', 'ForkMode.js');

if (!fs.existsSync(forkModePath)) {
  console.error('ERROR: ForkMode.js not found at', forkModePath);
  process.exit(1);
}

const content = fs.readFileSync(forkModePath, 'utf8');

if (content.includes('detached : false')) {
  console.log('Already patched.');
  process.exit(0);
}

if (!content.includes('detached : true')) {
  console.error('ERROR: Expected "detached : true" not found in ForkMode.js');
  console.error('pm2 version may have changed the code structure.');
  process.exit(1);
}

const patched = content.replace(
  /detached\s*:\s*true/,
  'detached : false'
);

fs.writeFileSync(forkModePath, patched, 'utf8');
console.log('Patched:', forkModePath);
console.log('Run "pm2 kill && pm2 start ecosystem.config.cjs" to apply.');
