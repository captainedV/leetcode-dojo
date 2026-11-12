#!/usr/bin/env node
// Build script: bundles the extension host code and the two webview/bridge scripts.
import { build, context } from 'esbuild';
import { mkdirSync, cpSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

mkdirSync(resolve(root, 'dist/media'), { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  target: ['node20'],
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
};

const targets = [
  {
    ...common,
    entryPoints: [resolve(root, 'src/extension.ts')],
    outfile: resolve(root, 'dist/extension.js'),
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    // Injected into the proxied LeetCode page (runs in the page origin).
    ...common,
    entryPoints: [resolve(root, 'src/bridge/bridge.ts')],
    outfile: resolve(root, 'dist/media/bridge.js'),
    platform: 'browser',
    format: 'iife',
    target: ['chrome110'],
  },
  {
    // Webview shell that hosts the iframe + native toolbar.
    ...common,
    entryPoints: [resolve(root, 'src/webview/shell.ts')],
    outfile: resolve(root, 'dist/media/shell.js'),
    platform: 'browser',
    format: 'iife',
    target: ['chrome110'],
  },
];

function copyStatic() {
  const mediaSrc = resolve(root, 'media');
  if (existsSync(mediaSrc)) {
    cpSync(mediaSrc, resolve(root, 'dist/media'), { recursive: true });
  }
}

if (watch) {
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
  copyStatic();
  console.log('[build] watching…');
} else {
  await Promise.all(targets.map((t) => build(t)));
  copyStatic();
  console.log('[build] done');
}
