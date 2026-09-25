// Bundles the server (and the shared simulation it imports from ../src/shared) into dist/index.js.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // native / CJS dependencies stay in node_modules
  external: ['ws', 'better-sqlite3'],
  // `require` for any CJS that slips into the bundle
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
