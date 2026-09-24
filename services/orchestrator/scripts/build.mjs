// Bundles the JARVIS core into one CommonJS file for Node SEA packaging.
// Usage: node scripts/build.mjs [--release]
// Release builds REQUIRE: JARVIS_LICENSE_PUBLIC_KEY (PEM, \n-escaped ok) and JARVIS_LICENSE_API_URL.
import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const release = process.argv.includes('--release');
const version = JSON.parse(readFileSync(path.resolve(root, '../../package.json'), 'utf8')).version;

const publicKey = process.env.JARVIS_LICENSE_PUBLIC_KEY?.replace(/\\n/g, '\n');
const apiUrl = process.env.JARVIS_LICENSE_API_URL;
if (release && (!publicKey || !apiUrl)) {
  console.error('Release build requires JARVIS_LICENSE_PUBLIC_KEY and JARVIS_LICENSE_API_URL');
  process.exit(1);
}
if (publicKey && /PRIVATE KEY/.test(publicKey)) {
  console.error('Refusing to embed a PRIVATE key in the desktop build');
  process.exit(1);
}

mkdirSync(path.join(root, 'dist'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/sea-entry.ts')],
  outfile: path.join(root, 'dist/jarvis-core.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: release,
  sourcemap: false,
  legalComments: 'eof',
  external: ['playwright-core', 'bufferutil', 'utf-8-validate'],
  define: {
    __JARVIS_RELEASE__: JSON.stringify(release),
    __JARVIS_VERSION__: JSON.stringify(version),
    ...(publicKey ? { __LICENSE_PUBLIC_KEY__: JSON.stringify(publicKey) } : {}),
    ...(apiUrl ? { __LICENSE_API_URL__: JSON.stringify(apiUrl) } : {}),
  },
  logLevel: 'warning',
});
console.log(`Built dist/jarvis-core.cjs (${release ? 'release' : 'development'}, v${version})`);
