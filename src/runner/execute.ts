/**
 * 本地执行器：写脚手架 → 跑编译/运行步骤 → 解析协议行 → 与期望输出比较。
 * 不依赖 vscode，方便单测与在 CI 中验证。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { CaseResult, RunResult, TestCase } from '../core/types.js';
import { HARNESS_DONE_PREFIX, HARNESS_ERROR_PREFIX, HARNESS_RESULT_PREFIX } from '../core/types.js';
import { compareOutputEx } from '../core/parse.js';
import type { CmdStep, HarnessArtifact, HarnessInput, LanguageHarness } from './harness/types.js';
import { CASES_FILE } from './harness/types.js';
import { getHarness } from './harness/index.js';
import { checkLangToolchain, resolveExecutable, resolvePython, resolvePython2 } from './toolchain.js';

export interface ExecOptions {
  timeoutMs?: number;
  /** 每步命令的环境变量 */
  env?: Record<string, string>;
  /** 运行目录 */
  cwd?: string;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
  /** 用户显式指定的 python 路径（lcLocal.python.path） */
  pythonPath?: string;
}

export interface StepOutput {
  step: CmdStep;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandAvailability {
  found: boolean;
  path?: string;
}

/**
 * 解析可执行文件。GUI 启动的编辑器 PATH 常常不全，
 * 因此走 toolchain.ts 的多来源探测（进程 PATH → 登录 shell → 常见安装目录）。
 */
export async function findExecutable(names: string[]): Promise<string | undefined> {
  for (const name of names) {
    const resolved = await resolveExecutable(name);
    if (resolved) return resolved;
  }
  return undefined;
}

const MAX_STEP_OUTPUT_BYTES = 4 * 1024 * 1024;
const compileDigestCache = new Map<string, string>();

/** 清空指定目录（或全部）的增量编译缓存（例如调试编译改写二进制后） */
export function invalidateCompileCache(cwd?: string): void {
  if (!cwd) {
    compileDigestCache.clear();
    return;
  }
  for (const key of compileDigestCache.keys()) {
    if (key.startsWith(`${cwd}::`)) compileDigestCache.delete(key);
  }
}

/** 测试辅助：重置增量编译缓存 */
export function __resetCompileCache(): void {
  compileDigestCache.clear();
}

export function runStep(step: CmdStep, cwd: string, opts: ExecOptions = {}): Promise<StepOutput> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  return new Promise((resolve) => {
    const started = Date.now();
    if (opts.signal?.aborted) {
      resolve({ step, code: -1, stdout: '', stderr: '[aborted]', timedOut: true, durationMs: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputOverflow = false;
    const child = spawn(step.cmd, step.args, {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const abortHandler = () => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', abortHandler);
    child.stdout.on('data', (d) => {
      if (outputOverflow) return;
      const s = String(d);
      if (stdout.length + s.length > MAX_STEP_OUTPUT_BYTES) {
        outputOverflow = true;
        stdout += s.slice(0, Math.max(0, MAX_STEP_OUTPUT_BYTES - stdout.length));
        stderr += '\n[output limit] 标准输出超过 4MB 上限（疑似死循环打印），已自动终止子进程。';
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        return;
      }
      stdout += s;
      opts.onLog?.(s);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length > MAX_STEP_OUTPUT_BYTES) return;
      const s = String(d);
      stderr += s.slice(0, Math.max(0, MAX_STEP_OUTPUT_BYTES - stderr.length));
      opts.onLog?.(s);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortHandler);
      resolve({
        step,
        code: -1,
        stdout,
        stderr: stderr + `\n[exec error] ${err.message}`,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortHandler);
      resolve({ step, code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

export interface ParsedProtocol {
  results: Array<{ i: number; actual: string; error?: string | null; logs?: string; durationMs?: number }>;
  fatal?: string;
  done?: Record<string, unknown>;
  /** 非协议行（用户 print / 编译器输出） */
  noise: string;
}

export function parseProtocol(stdout: string): ParsedProtocol {
  const results: ParsedProtocol['results'] = [];
  let fatal: string | undefined;
  let done: Record<string, unknown> | undefined;
  const noise: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith(HARNESS_RESULT_PREFIX)) {
      try {
        const obj = JSON.parse(line.slice(HARNESS_RESULT_PREFIX.length));
        results.push({
          i: Number(obj.i ?? results.length),
          actual: typeof obj.actual === 'string' ? obj.actual : JSON.stringify(obj.actual ?? null),
          error: obj.error ?? null,
          logs: obj.logs,
          durationMs: obj.durationMs,
        });
      } catch {
        noise.push(line);
      }
    } else if (line.startsWith(HARNESS_ERROR_PREFIX)) {
      try {
        const obj = JSON.parse(line.slice(HARNESS_ERROR_PREFIX.length));
        fatal = String(obj.fatal ?? 'error');
      } catch {
        fatal = line.slice(HARNESS_ERROR_PREFIX.length);
      }
    } else if (line.startsWith(HARNESS_DONE_PREFIX)) {
      try {
        done = JSON.parse(line.slice(HARNESS_DONE_PREFIX.length));
      } catch {
        done = {};
      }
    } else {
      noise.push(line);
    }
  }
  return { results, fatal, done, noise: noise.join('\n').trim() };
}

/** 把脚手架写到磁盘 */
export async function materialize(artifact: HarnessArtifact, genDir: string): Promise<void> {
  await mkdir(genDir, { recursive: true });
  for (const f of artifact.files) {
    const target = join(genDir, f.name);
    const dir = target.slice(0, target.lastIndexOf('/'));
    if (dir && dir !== genDir) await mkdir(dir, { recursive: true });
    await writeFile(target, f.content, 'utf8');
  }
}

export function casesToResults(
  parsed: ParsedProtocol,
  cases: TestCase[],
): CaseResult[] {
  const byIndex = new Map(parsed.results.map((r) => [r.i, r]));
  return cases.map((c) => {
    const r = byIndex.get(c.index);
    if (!r) {
      return {
        index: c.index,
        ok: false,
        actual: '',
        expected: c.expected,
        error: parsed.fatal ? `脚手架启动失败：${parsed.fatal}` : '该用例没有产生结果（可能超时或提前退出）',
      };
    }
    if (r.error) {
      return { index: c.index, ok: false, actual: '', expected: c.expected, error: r.error, meta: { logs: r.logs } };
    }
    const outcome = compareOutputEx(r.actual, c.expected);
    return {
      index: c.index,
      ok: outcome.ok,
      actual: r.actual,
      expected: c.expected,
      durationMs: r.durationMs,
      meta: { ...(r.logs ? { logs: r.logs } : {}), ...(outcome.note ? { note: outcome.note } : {}) },
    };
  });
}

/** 完整跑一遍本地测试。 */
export async function runLocalTests(
  input: Omit<HarnessInput, 'debug'>,
  opts: ExecOptions = {},
): Promise<RunResult> {
  return runLocalTestsWith(getHarness(input.langSlug), input, opts);
}

/** 用指定脚手架实现跑一遍本地测试（便于对单个语言直接测试）。 */
export async function runLocalTestsWith(
  harness: LanguageHarness | undefined,
  input: Omit<HarnessInput, 'debug'>,
  opts: ExecOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  if (!harness) {
    return {
      ok: false,
      cases: [],
      durationMs: 0,
      langSlug: input.langSlug,
      harnessSource: 'builtin',
      unsupportedReason: `语言 ${input.langSlug} 暂无内置本地测试脚手架，可使用「在 LeetCode 上运行」或 AI 脚手架。`,
    };
  }
  const support = harness.supports(input.meta);
  if (!support.ok) {
    return {
      ok: false,
      cases: [],
      durationMs: 0,
      langSlug: input.langSlug,
      harnessSource: 'builtin',
      unsupportedReason: support.reason,
    };
  }
  let artifact: HarnessArtifact;
  try {
    artifact = harness.generate(input);
  } catch (err) {
    return {
      ok: false,
      cases: [],
      durationMs: Date.now() - started,
      langSlug: input.langSlug,
      harnessSource: 'builtin',
      unsupportedReason: `脚手架生成失败：${(err as Error).message}`,
    };
  }
  await materialize(artifact, input.genDir);
  const cwd = opts.cwd ?? input.genDir;
  const env = { ...(artifact.env ?? {}), ...(opts.env ?? {}) };

  // 先确认工具链在不在（GUI 编辑器 PATH 不全时会找不到命令）
  const toolchain = await checkLangToolchain(input.langSlug);
  const resolvedSteps: CmdStep[] = [];
  // python 要挑高版本解释器：LeetCode 的 Python3 模板会用到 3.10+ 的 `X | None` 语法
  let pythonOverride: string | undefined;
  if (/^python/.test(input.langSlug) || artifact.steps.some((s) => /^python[23]?(\.\d+)?$/.test(s.cmd))) {
    const py = input.langSlug === 'python' ? await resolvePython2() : await resolvePython(opts.pythonPath);
    pythonOverride = py?.path;
  }
  for (const step of artifact.steps) {
    const isPathLike = step.cmd.startsWith('./') || step.cmd.startsWith('/');
    let resolved = isPathLike ? step.cmd : await resolveExecutable(step.cmd);
    if (pythonOverride && /^python[23]?(\.\d+)?$/.test(step.cmd)) resolved = pythonOverride;
    if (!resolved && !isPathLike) {
      return {
        ok: false,
        cases: [],
        durationMs: Date.now() - started,
        langSlug: input.langSlug,
        harnessSource: 'builtin',
        unsupportedReason: `找不到命令 \`${step.cmd}\`。${toolchain.hints.join(' ')}`.trim(),
        stderr: toolchain.hints.join('\n'),
      };
    }
    resolvedSteps.push({ ...step, cmd: resolved ?? step.cmd });
  }

  let stdoutAll = '';
  let stderrAll = '';
  for (const step of resolvedSteps) {
    const isCompile = step.label === 'compile' || step.label === 'build';
    const cacheSlot = `${cwd}::${step.label}`;
    let compileDigest: string | undefined;

    if (isCompile) {
      compileDigest = computeCompileDigest(input, artifact, step);
      if (
        compileDigestCache.get(cacheSlot) === compileDigest &&
        hasExpectedCompileArtifact(step, cwd)
      ) {
        opts.onLog?.(`[compile-cache] 代码未变更，跳过重复编译（${input.langSlug}）\n`);
        continue;
      }
    }

    const out = await runStep(step, cwd, { ...opts, env: { ...env, ...(opts.env ?? {}) } });
    stdoutAll += out.stdout;
    stderrAll += out.stderr;
    if (out.timedOut) {
      const cancelled = Boolean(opts.signal?.aborted);
      return {
        ok: false,
        cases: input.testCases.map((c) => ({
          index: c.index,
          ok: false,
          actual: '',
          expected: c.expected,
          error: cancelled ? '已取消运行' : `超时（>${opts.timeoutMs ?? 20000}ms）`,
        })),
        stdout: stdoutAll,
        stderr: stderrAll,
        durationMs: Date.now() - started,
        langSlug: input.langSlug,
        harnessSource: 'builtin',
        unsupportedReason: cancelled
          ? '本地运行已取消。'
          : '执行超时：请检查是否有死循环，或调大 lcLocal.run.timeoutMs。',
      };
    }
    if (isCompile && out.code !== 0) {
      compileDigestCache.delete(cacheSlot);
      return {
        ok: false,
        cases: [],
        stdout: stdoutAll,
        stderr: stderrAll,
        durationMs: Date.now() - started,
        langSlug: input.langSlug,
        harnessSource: 'builtin',
        unsupportedReason: '编译失败，见输出面板。',
      };
    }
    if (out.code === null || out.code === -1) {
      if (isCompile) compileDigestCache.delete(cacheSlot);
      return {
        ok: false,
        cases: [],
        stdout: stdoutAll,
        stderr: stderrAll,
        durationMs: Date.now() - started,
        langSlug: input.langSlug,
        harnessSource: 'builtin',
        unsupportedReason: `无法执行 \`${step.cmd}\`：${out.stderr.trim().split('\n').slice(-1)[0] ?? '未知错误'}。${harness.installHint}`,
      };
    }
    if (isCompile && compileDigest) {
      compileDigestCache.set(cacheSlot, compileDigest);
    }
  }

  const parsed = parseProtocol(stdoutAll);
  const cases = casesToResults(parsed, input.testCases);
  const ok = cases.length > 0 && cases.every((c) => c.ok !== false);
  return {
    ok,
    cases,
    stdout: stdoutAll,
    stderr: stderrAll,
    durationMs: Date.now() - started,
    langSlug: input.langSlug,
    harnessSource: 'builtin',
  };
}

/** 判断题目是否已经生成了脚手架（调试命令复用）。 */
export function harnessExists(genDir: string, entry: string): boolean {
  return existsSync(join(genDir, entry));
}

function computeCompileDigest(
  input: Omit<HarnessInput, 'debug'>,
  artifact: HarnessArtifact,
  step: CmdStep,
): string {
  const hash = createHash('sha256');
  hash.update(`${input.langSlug}\0${step.cmd}\0${step.args.join('\0')}\0`);
  hash.update(input.sourceCode ?? '');
  hash.update('\0');
  try {
    if (input.sourceAbsPath && existsSync(input.sourceAbsPath)) {
      hash.update(readFileSync(input.sourceAbsPath));
      hash.update('\0');
    }
  } catch {
    /* ignore */
  }
  for (const f of artifact.files) {
    if (f.name === CASES_FILE) continue;
    hash.update(`${f.name}\0${f.content}\0`);
  }
  return hash.digest('hex');
}

function hasExpectedCompileArtifact(step: CmdStep, cwd: string): boolean {
  const outIdx = step.args.indexOf('-o');
  if (outIdx >= 0 && outIdx + 1 < step.args.length) {
    return existsSync(resolvePath(cwd, step.args[outIdx + 1]));
  }
  if (/(^|[\\/])javac(\.exe)?$/i.test(step.cmd)) {
    return existsSync(join(cwd, 'Main.class'));
  }
  return false;
}
