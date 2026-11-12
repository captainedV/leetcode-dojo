/**
 * 工具链探测：GUI 启动的 VS Code / Cursor 里 PATH 经常不完整（拿不到 Homebrew / nvm / pyenv），
 * 表现为「无法执行 node/python3」这类让人一头雾水的错误。
 * 这里按 4 个来源依次解析可执行文件：
 *   1) 当前进程的 PATH
 *   2) 登录 shell 的 PATH（`bash -lc 'command -v x'`，能拿到用户 .zprofile/.bash_profile 里的配置）
 *   3) 常见安装目录（Homebrew/arm64、Homebrew/intel、/usr/local/bin、~/.nvm、~/.pyenv、~/.cargo、~/.local/bin…）
 *   4) 已缓存的解析结果
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cache = new Map<string, string | null>();
let loginShellPath: string[] | null = null;

/** 常见安装目录（macOS / Linux） */
function commonDirs(): string[] {
  const home = homedir();
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, 'go', 'bin'),
    join(home, '.pyenv', 'shims'),
    join(home, '.asdf', 'shims'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    '/usr/local/go/bin',
    '/opt/local/bin',
    '/snap/bin',
  ];
  // nvm / fnm 的 node 目录
  for (const base of [join(home, '.nvm', 'versions', 'node'), join(home, '.fnm', 'node-versions')]) {
    try {
      // 延迟到运行时再判断，避免顶层抛错
      dirs.push(join(base, 'current', 'bin'));
    } catch {
      /* ignore */
    }
  }
  return dirs;
}

/** 读取登录 shell 的 PATH（只执行一次） */
export async function getLoginShellPath(force = false): Promise<string[]> {
  if (loginShellPath && !force) return loginShellPath;
  loginShellPath = [];
  const shell = process.env.SHELL || '/bin/bash';
  const out = await new Promise<string>((resolve) => {
    try {
      const child = spawn(shell, ['-lc', 'printf "%s" "$PATH"'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        env: { ...process.env, HOME: homedir() },
      });
      let buf = '';
      child.stdout.on('data', (d) => (buf += String(d)));
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(buf));
    } catch {
      resolve('');
    }
  });
  loginShellPath = out.split(':').map((s) => s.trim()).filter(Boolean);
  return loginShellPath;
}

/** 测试用：重置缓存 */
export function __resetToolchainCache(): void {
  cache.clear();
  loginShellPath = null;
}

function isExecutable(p: string): boolean {
  try {
    // 目录里存在同名文件即认为可尝试（Windows 无 X_OK 概念）
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 解析一个命令名字到可执行文件绝对路径。
 * 找不到返回 undefined（调用方据此给出安装提示）。
 */
export async function resolveExecutable(name: string): Promise<string | undefined> {
  if (!name) return undefined;
  if (name.includes('/')) return isExecutable(name) ? name : undefined;
  const key = name;
  if (cache.has(key)) return cache.get(key) ?? undefined;

  const candidates: string[] = [];
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const probe = (dir: string) => {
    for (const ext of exts) candidates.push(join(dir, name + ext));
  };

  for (const dir of (process.env.PATH ?? '').split(pathSep).filter(Boolean)) probe(dir);
  for (const dir of await getLoginShellPath()) probe(dir);
  for (const dir of commonDirs()) probe(dir);

  const found = candidates.find((p) => isExecutable(p));
  cache.set(key, found ?? null);
  return found;
}

export interface ToolchainStatus {
  name: string;
  path?: string;
  ok: boolean;
}

/** 一次性解析一组命令，用于诊断信息 */
export async function resolveMany(names: string[]): Promise<ToolchainStatus[]> {
  const out: ToolchainStatus[] = [];
  for (const name of names) {
    const path = await resolveExecutable(name);
    out.push({ name, path, ok: !!path });
  }
  return out;
}

/** 某个语言要跑本地测试需要哪些命令 */
const LANG_COMMANDS: Record<string, string[]> = {
  python3: ['python3'],
  python: ['python2', 'python'],
  javascript: ['node'],
  typescript: ['node'],
  cpp: ['g++'],
  c: ['gcc'],
  java: ['javac', 'java'],
  golang: ['go'],
  rust: ['rustc'],
  ruby: ['ruby'],
  php: ['php'],
  csharp: ['dotnet'],
  kotlin: ['kotlinc'],
  swift: ['swift'],
};

export function commandsForLang(langSlug: string): string[] {
  return LANG_COMMANDS[langSlug] ?? [];
}

export interface MissingToolchain {
  missing: string[];
  hints: string[];
}

/** 检查某语言的工具链是否齐全，并给出可执行的安装提示 */
export async function checkLangToolchain(langSlug: string): Promise<MissingToolchain> {
  const names = commandsForLang(langSlug);
  const missing: string[] = [];
  for (const name of names) {
    const resolved = await resolveExecutable(name);
    if (!resolved) missing.push(name);
  }
  const hints: string[] = [];
  for (const name of missing) {
    switch (name) {
      case 'node':
        hints.push('未找到 node。macOS 可 `brew install node`，或确认 nvm 已加载（GUI 里可用 login shell 的 PATH 重启 IDE）。');
        break;
      case 'python3':
      case 'python2':
        hints.push('未找到 python3。macOS 可 `brew install python` 或安装 Xcode 命令行工具（`xcode-select --install`）。');
        break;
      case 'g++':
      case 'gcc':
        hints.push('未找到 C/C++ 编译器。macOS 执行 `xcode-select --install`；Linux 安装 build-essential。');
        break;
      case 'javac':
      case 'java':
        hints.push('未找到 JDK。安装 Temurin/OpenJDK 后把 `JAVA_HOME` 加入环境。');
        break;
      case 'go':
        hints.push('未找到 Go。macOS 可 `brew install go`。');
        break;
      case 'rustc':
        hints.push('未找到 Rust。可用 rustup 安装（`curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh`）。');
        break;
      case 'ruby':
        hints.push('未找到 ruby。macOS 自带 Ruby 可能在 /usr/bin/ruby。');
        break;
      default:
        hints.push(`未找到 ${name}，请安装后重启 IDE。`);
        break;
    }
  }
  return { missing, hints };
}


// ---------------------------------------------------------------- Python 选择

export interface PythonResolution {
  path: string;
  /** [major, minor] */
  version: [number, number];
  /** 是否满足 LeetCode 题面常用的 3.10+ 语法（X | None） */
  hasPep604: boolean;
  raw: string;
}

const PY_CANDIDATES = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
const PY2_CANDIDATES = ['python2', 'python'];
let pythonCache: PythonResolution | null | undefined;
let python2Cache: PythonResolution | null | undefined;

async function probePythonVersion(path: string): Promise<{ version: [number, number]; raw: string } | undefined> {
  return new Promise((resolve) => {
    try {
      const child = spawn(path, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      child.on('error', () => resolve(undefined));
      child.on('close', () => {
        const m = /Python\s+(\d+)\.(\d+)/i.exec(out);
        if (!m) return resolve(undefined);
        resolve({ version: [Number(m[1]), Number(m[2])], raw: out.trim().split('\n')[0] });
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * 选一个 Python 解释器：优先 3.10+（LeetCode 的 Python3 模板会用 `ListNode | None` 这种语法，
 * 3.9 会直接 TypeError），同版本里取最高。
 *
 * @param preferred 用户在设置里显式指定的路径（lcLocal.python.path），优先使用
 */
export async function resolvePython(preferred?: string): Promise<PythonResolution | undefined> {
  if (preferred) {
    const probed = await probePythonVersion(preferred);
    if (probed) return { path: preferred, version: probed.version, hasPep604: probed.version >= [3, 10] ? true : false, raw: probed.raw };
  }
  if (pythonCache !== undefined) return pythonCache ?? undefined;
  const found: PythonResolution[] = [];
  for (const name of PY_CANDIDATES) {
    const path = await resolveExecutable(name);
    if (!path) continue;
    if (found.some((f) => f.path === path)) continue;
    const probed = await probePythonVersion(path);
    if (!probed) continue;
    found.push({
      path,
      version: probed.version,
      hasPep604: probed.version[0] > 3 || (probed.version[0] === 3 && probed.version[1] >= 10),
      raw: probed.raw,
    });
  }
  if (!found.length) {
    pythonCache = null;
    return undefined;
  }
  // 先按“是否支持 PEP 604”排序，再按版本号从高到低
  found.sort((a, b) => {
    if (a.hasPep604 !== b.hasPep604) return a.hasPep604 ? -1 : 1;
    if (a.version[0] !== b.version[0]) return b.version[0] - a.version[0];
    return b.version[1] - a.version[1];
  });
  pythonCache = found[0];
  return pythonCache;
}

/** Python2（如果用户真的选了 python 语言） */
export async function resolvePython2(): Promise<PythonResolution | undefined> {
  if (python2Cache !== undefined) return python2Cache ?? undefined;
  for (const name of PY2_CANDIDATES) {
    const path = await resolveExecutable(name);
    if (!path) continue;
    const probed = await probePythonVersion(path);
    if (!probed) continue;
    if (probed.version[0] === 2) {
      python2Cache = { path, version: probed.version, hasPep604: false, raw: probed.raw };
      return python2Cache;
    }
  }
  python2Cache = null;
  return undefined;
}

/** 测试用：清掉 python 解析缓存 */
export function __resetPythonCache(): void {
  pythonCache = undefined;
  python2Cache = undefined;
}
