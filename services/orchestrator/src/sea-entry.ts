/**
 * Entry point for the packaged single-executable core (Node SEA).
 * Modules that cannot be bundled (playwright-core) are shipped as a folder
 * next to the executable and loaded through a filesystem require.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const base = path.join(path.dirname(process.execPath), 'core-modules', 'package.json');
(globalThis as { __JARVIS_REQUIRE__?: NodeRequire }).__JARVIS_REQUIRE__ = createRequire(base);
// node:sqlite prints an experimental warning; keep end-user logs clean.
process.removeAllListeners('warning');
void import('./main.js');
