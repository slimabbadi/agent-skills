// Loads sharp from, in order: $SHARP_PATH, this skill's own node_modules (one-time
// `npm install` in scripts/), or the project the agent runs in. Fails with the install
// command instead of a bare MODULE_NOT_FOUND.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function load() {
  const tries = [
    process.env.SHARP_PATH && (() => createRequire(import.meta.url)(process.env.SHARP_PATH)),
    () => createRequire(path.join(scriptsDir, 'package.json'))('sharp'),
    () => createRequire(path.join(process.cwd(), 'package.json'))('sharp'),
  ].filter(Boolean);
  for (const t of tries) {
    try { return t(); } catch { /* next */ }
  }
  throw new Error(`ui-diff: sharp not found. Install it once with:\n  cd "${scriptsDir}" && npm install`);
}

export default load();
