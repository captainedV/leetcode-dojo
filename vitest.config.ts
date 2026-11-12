import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * TS 源码里按 NodeNext 规范写 `.js` 后缀（打包后正确），测试时映射回 `.ts`。
 */
const tsFromJs = {
  name: 'ts-from-js',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const base = resolve(dirname(importer), source.slice(0, -3));
    if (existsSync(`${base}.ts`)) return `${base}.ts`;
    if (existsSync(`${base}/index.ts`)) return `${base}/index.ts`;
    return null;
  },
};

export default defineConfig({
  plugins: [tsFromJs],
  resolve: {
    alias: {
      // 集成测试里用替身顶替 vscode 宿主
      vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
    reporters: 'default',
  },
});
