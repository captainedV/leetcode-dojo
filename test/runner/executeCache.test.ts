import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMetaData } from '../../src/core/parse.js';
import {
  __resetCompileCache,
  findExecutable,
  invalidateCompileCache,
  runLocalTestsWith,
  runStep,
} from '../../src/runner/execute.js';
import { CppHarness } from '../../src/runner/harness/cpp.js';

const META = parseMetaData(
  JSON.stringify({
    name: 'add',
    params: [
      { name: 'a', type: 'integer' },
      { name: 'b', type: 'integer' },
    ],
    return: { type: 'integer' },
  }),
)!;

describe('执行器稳定性与编译增量缓存', () => {
  beforeEach(() => {
    __resetCompileCache();
  });

  it('C++ 代码未改只改测试用例时命中编译缓存，跳过重复编译；代码改动或主动失效后重新编译', async () => {
    if (!(await findExecutable(['g++', 'clang++']))) return;

    const dir = await mkdtemp(join(tmpdir(), 'lc-cache-'));
    const genDir = join(dir, 'local');
    const sourcePath = join(dir, 'solution.cpp');
    await mkdir(genDir, { recursive: true });

    const codeV1 = `class Solution { public: int add(int a, int b) { return a + b; } };\n`;
    await writeFile(sourcePath, codeV1, 'utf8');

    const logs1: string[] = [];
    const r1 = await runLocalTestsWith(
      CppHarness,
      {
        langSlug: 'cpp',
        meta: META,
        testCases: [{ index: 0, args: ['1', '2'], expected: '3', source: 'custom' }],
        sourceFile: 'solution.cpp',
        sourceAbsPath: sourcePath,
        sourceCode: codeV1,
        genDir,
        titleSlug: 'add',
      },
      { onLog: (l) => logs1.push(l) },
    );
    expect(r1.ok).toBe(true);
    expect(logs1.join('')).not.toContain('[compile-cache]');

    // 第二次：只新增/修改测试用例，代码未改 → 命中缓存，毫秒级跑完
    const logs2: string[] = [];
    const r2 = await runLocalTestsWith(
      CppHarness,
      {
        langSlug: 'cpp',
        meta: META,
        testCases: [
          { index: 0, args: ['10', '20'], expected: '30', source: 'custom' },
          { index: 1, args: ['-5', '8'], expected: '3', source: 'custom' },
        ],
        sourceFile: 'solution.cpp',
        sourceAbsPath: sourcePath,
        sourceCode: codeV1,
        genDir,
        titleSlug: 'add',
      },
      { onLog: (l) => logs2.push(l) },
    );
    expect(r2.ok).toBe(true);
    expect(r2.cases).toHaveLength(2);
    expect(logs2.join('')).toContain('[compile-cache]');

    // 第三次：代码发生变更 → 自动触发重新编译并反映新行为
    const codeV2 = `class Solution { public: int add(int a, int b) { return a + b + 100; } };\n`;
    await writeFile(sourcePath, codeV2, 'utf8');
    const logs3: string[] = [];
    const r3 = await runLocalTestsWith(
      CppHarness,
      {
        langSlug: 'cpp',
        meta: META,
        testCases: [{ index: 0, args: ['1', '2'], expected: '103', source: 'custom' }],
        sourceFile: 'solution.cpp',
        sourceAbsPath: sourcePath,
        sourceCode: codeV2,
        genDir,
        titleSlug: 'add',
      },
      { onLog: (l) => logs3.push(l) },
    );
    expect(r3.ok).toBe(true);
    expect(logs3.join('')).not.toContain('[compile-cache]');

    // 手动失效缓存后也会重编
    invalidateCompileCache(genDir);
    const logs4: string[] = [];
    await runLocalTestsWith(
      CppHarness,
      {
        langSlug: 'cpp',
        meta: META,
        testCases: [{ index: 0, args: ['1', '2'], expected: '103', source: 'custom' }],
        sourceFile: 'solution.cpp',
        sourceAbsPath: sourcePath,
        sourceCode: codeV2,
        genDir,
        titleSlug: 'add',
      },
      { onLog: (l) => logs4.push(l) },
    );
    expect(logs4.join('')).not.toContain('[compile-cache]');
  });

  it('支持通过 AbortSignal 立即取消正在运行的子进程', async () => {
    const nodeBin = await findExecutable(['node']);
    if (!nodeBin) return;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const out = await runStep(
      { label: 'run', cmd: nodeBin, args: ['-e', 'setTimeout(() => {}, 10000)'] },
      tmpdir(),
      { timeoutMs: 10000, signal: controller.signal },
    );
    expect(out.timedOut).toBe(true);
    expect(out.durationMs).toBeLessThan(2500);
  });

  it('死循环疯狂打印超过 4MB 时自动截断并杀掉子进程防 OOM', async () => {
    const nodeBin = await findExecutable(['node']);
    if (!nodeBin) return;
    const out = await runStep(
      {
        label: 'run',
        cmd: nodeBin,
        args: ['-e', 'const fs=require("fs"),b=Buffer.alloc(65536,120);while(true){try{fs.writeSync(1,b);}catch{break;}}'],
      },
      tmpdir(),
      { timeoutMs: 10000 },
    );
    expect(out.stderr).toContain('[output limit]');
    expect(out.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024 + 1024);
    expect(out.durationMs).toBeLessThan(3000);
  });
});
