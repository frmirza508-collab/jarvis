// Bundles the license API into dist/main.js and copies migrations next to it.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'dist'), { recursive: true });
for (const entry of ['main', 'cli']) {
  await build({
    entryPoints: [path.join(root, `src/${entry}.ts`)],
    outfile: path.join(root, `dist/${entry}.js`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    external: ['pg-native'],
    logLevel: 'warning',
  });
}
cpSync(path.resolve(root, '../../infra/database/migrations'), path.join(root, 'dist/migrations'), { recursive: true });
console.log('Built services/license-api/dist (main.js, cli.js, migrations/)');
