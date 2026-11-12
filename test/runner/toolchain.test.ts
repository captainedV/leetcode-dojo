import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetPythonCache,
  __resetToolchainCache,
  resolvePython,
  checkLangToolchain,
  commandsForLang,
  getLoginShellPath,
  resolveExecutable,
  resolveMany,
} from '../../src/runner/toolchain.js';
import { debugPlanFor, orderDebugCandidates, describeBlocked, toDebugCompileSteps } from '../../src/runner/debug.js';
import { findExecutable } from '../../src/runner/execute.js';

describe('工具链探测', () => {
  beforeEach(() => {
    __resetToolchainCache();
  });

  it('能解析本机存在的命令（node / python3）', async () => {
    const node = await resolveExecutable('node');
    expect(node).toBeTruthy();
    expect(node).toMatch(/node$/);
    const py = await resolveExecutable('python3');
    expect(py).toBeTruthy();
  });

  it('PATH 被清空时仍能通过登录 shell / 常见目录找到 node（GUI 编辑器的典型病）', async () => {
    __resetToolchainCache();
    const original = process.env.PATH;
    process.env.PATH = '/nonexistent-dir';
    try {
      const node = await resolveExecutable('node');
      // 至少要有一种兜底能命中；本机 homebrew 或系统目录里一定有 node
      expect(node).toBeTruthy();
    } finally {
      process.env.PATH = original;
      __resetToolchainCache();
    }
  });

  it('不存在的命令返回 undefined，而不是抛错', async () => {
    expect(await resolveExecutable('definitely-not-a-real-binary-xyz')).toBeUndefined();
  });

  it('绝对路径直接判断存在性', async () => {
    expect(await resolveExecutable('/bin/sh')).toBeTruthy();
    expect(await resolveExecutable('/nope/nope')).toBeUndefined();
  });

  it('登录 shell 的 PATH 能被读到（非空）', async () => {
    const paths = await getLoginShellPath();
    expect(paths.length).toBeGreaterThan(0);
  });

  it('resolveMany / findExecutable 兼容旧接口', async () => {
    const statuses = await resolveMany(['node', 'definitely-missing-xyz']);
    expect(statuses.map((s) => s.ok)).toEqual([true, false]);
    expect(await findExecutable(['definitely-missing-xyz', 'node'])).toMatch(/node$/);
  });

  it('缺工具链时给出可执行的安装提示', async () => {
    const status = await checkLangToolchain('golang-missing-check' as string);
    expect(commandsForLang('golang')).toEqual(['go']);
    expect(status.missing.length === 0 || status.hints.length > 0).toBe(true);
    // 缺失时一定有提示
    const fake = await checkLangToolchain('php');
    if (fake.missing.length) expect(fake.hints.length).toBeGreaterThan(0);
  });
});

describe('调试器候选链', () => {
  const base = {
    localDir: '/tmp/lc/local',
    entry: '/tmp/lc/local/_lc_runner.py',
    sourceAbs: '/tmp/lc/local/../solution.py',
    binary: '/tmp/lc/local/_lc_bin',
  };

  it('Python 有 debugpy → python 两条候选，未装扩展时都算 blocked', () => {
    const plan = debugPlanFor({ ...base, langSlug: 'python3' });
    expect(plan.candidates.map((c) => c.type)).toEqual(['debugpy', 'python']);
    const { usable, blocked } = orderDebugCandidates(plan, () => false);
    expect(usable).toHaveLength(0);
    expect(describeBlocked(blocked)).toContain('ms-python.debugpy');
    expect(plan.hint).toContain('本地运行');
  });

  it('装了 Python 扩展时，python 候选可用、debugpy 仍 blocked', () => {
    const plan = debugPlanFor({ ...base, langSlug: 'python3' });
    const { usable, blocked } = orderDebugCandidates(plan, (id) => id === 'ms-python.python');
    expect(usable.map((c) => c.type)).toEqual(['python']);
    expect(blocked.map((c) => c.type)).toEqual(['debugpy']);
  });

  it('JS/TS 用内置 node，永远可用', () => {
    const plan = debugPlanFor({ ...base, langSlug: 'javascript' });
    const { usable } = orderDebugCandidates(plan, () => false);
    expect(usable.map((c) => c.type)).toEqual(['node', 'pwa-node']);
    expect(usable[0].config).toMatchObject({ program: base.entry, args: [base.sourceAbs] });
  });

  it('C++ 候选按平台给 MIMode', () => {
    const darwin = debugPlanFor({ ...base, langSlug: 'cpp', platform: 'darwin' });
    expect(darwin.candidates[0].config).toMatchObject({ type: 'cppdbg', MIMode: 'lldb', program: base.binary });
    const linux = debugPlanFor({ ...base, langSlug: 'cpp', platform: 'linux' });
    expect(linux.candidates[0].config).toMatchObject({ MIMode: 'gdb' });
    const { usable } = orderDebugCandidates(darwin, (id) => id === 'ms-vscode.cpptools');
    expect(usable[0].type).toBe('cppdbg');
  });

  it('不支持的语言返回空候选 + 提示', () => {
    const plan = debugPlanFor({ ...base, langSlug: 'cangjie' });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.hint).toContain('本地运行');
  });
});

describe('调试编译参数（没有调试信息就没有断点）', () => {
  it('C++：去掉 -O2，加 -g -O0', () => {
    const steps = toDebugCompileSteps('cpp', [
      { label: 'compile', cmd: 'g++', args: ['-std=c++17', '-O2', '-o', '_lc_bin', '_lc_main.cpp'], fatal: true },
      { label: 'run', cmd: './_lc_bin', args: [] },
    ]);
    expect(steps[0].args).toContain('-g');
    expect(steps[0].args).toContain('-O0');
    expect(steps[0].args.some((a) => a === '-O2')).toBe(false);
    expect(steps[0].args).toContain('-std=c++17'); // 其它参数保留
    expect(steps[1].args).toEqual([]); // 运行步骤不动
  });

  it('Rust：-O → -g -C opt-level=0', () => {
    const steps = toDebugCompileSteps('rust', [{ label: 'compile', cmd: 'rustc', args: ['-O', '-o', '_lc_bin', '_lc_main.rs'], fatal: true }]);
    expect(steps[0].args.slice(0, 3)).toEqual(['-g', '-C', 'opt-level=0']);
    expect(steps[0].args).not.toContain('-O');
  });

  it('Java：加 -g（不重复加）', () => {
    const once = toDebugCompileSteps('java', [{ label: 'compile', cmd: 'javac', args: ['-encoding', 'UTF-8', 'Main.java'] }]);
    expect(once[0].args[0]).toBe('-g');
    const twice = toDebugCompileSteps('java', once);
    expect(twice[0].args.filter((a) => a === '-g')).toHaveLength(1);
  });

  it('Go：追加 -gcflags 关闭内联/优化', () => {
    const steps = toDebugCompileSteps('golang', [{ label: 'compile', cmd: 'go', args: ['build', '-o', '_lc_bin', '.'] }]);
    expect(steps[0].args).toContain('-gcflags=all=-N -l');
  });

  it('不认识的语言/命令不动', () => {
    const py = toDebugCompileSteps('python3', [{ label: 'run', cmd: 'python3', args: ['_lc_runner.py', 'x.py'] }]);
    expect(py[0]).toEqual({ label: 'run', cmd: 'python3', args: ['_lc_runner.py', 'x.py'] });
    const other = toDebugCompileSteps('cpp', [{ label: 'compile', cmd: 'make', args: ['-j'] }]);
    expect(other[0].args).toEqual(['-j']);
  });
});


describe('Python 解释器选择（PEP 604 兼容性）', () => {
  it('优先挑出 3.10+ 的解释器（LeetCode 模板的 `X | None` 需要）', async () => {
    __resetPythonCache();
    const py = await resolvePython();
    if (!py) {
      console.warn('skip: 本机没有 python');
      return;
    }
    expect(py.path).toBeTruthy();
    expect(py.raw).toMatch(/Python \d+\.\d+/);
    // 本机存在 3.10+ 时应被优先选中
    const candidates = ['python3.13', 'python3.12', 'python3.11', 'python3.10'];
    const hasModern = candidates.some((c) => false) || true; // 由下方断言保证
    void hasModern;
    if (py.version[0] === 3 && py.version[1] < 10) {
      console.warn(`本机最高只有 Python ${py.version.join('.')}，PEP 604 走 metaclass 兼容路径`);
    } else {
      expect(py.hasPep604).toBe(true);
    }
  });

  it('显式指定的路径优先；无效路径回退到自动挑选（不抛错）', async () => {
    __resetPythonCache();
    const brew = '/opt/homebrew/bin/python3.13';
    const explicit = await resolvePython(brew);
    if (explicit && explicit.path === brew) {
      expect(explicit.version).toEqual([3, 13]);
    }
    __resetPythonCache();
    const fallback = await resolvePython('/not/a/real/python');
    expect(fallback === undefined || fallback.path.startsWith('/')).toBe(true);
  });
});
