import type { LangSlug } from './types.js';

export type RunnerKind =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'cpp'
  | 'c'
  | 'java'
  | 'go'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'csharp'
  | 'kotlin'
  | 'swift'
  | 'unsupported';

export interface LangInfo {
  slug: LangSlug;
  /** LeetCode 展示名 */
  label: string;
  /** 文件扩展名（不含点） */
  ext: string;
  /** 本地运行所需的 kind */
  runner: RunnerKind;
  /** 该语言是否内置了本地测试脚手架 */
  harness: boolean;
  /** 用于生成注释的符号 */
  lineComment: string;
  /** 本地运行命令的探测顺序（第一个可用的被采用） */
  executables: string[];
}

const table: LangInfo[] = [
  {
    slug: 'python3',
    label: 'Python3',
    ext: 'py',
    runner: 'python',
    harness: true,
    lineComment: '#',
    executables: ['python3', 'python'],
  },
  {
    slug: 'python',
    label: 'Python',
    ext: 'py',
    runner: 'python',
    harness: true,
    lineComment: '#',
    executables: ['python2', 'python'],
  },
  {
    slug: 'javascript',
    label: 'JavaScript',
    ext: 'js',
    runner: 'javascript',
    harness: true,
    lineComment: '//',
    executables: ['node'],
  },
  {
    slug: 'typescript',
    label: 'TypeScript',
    ext: 'ts',
    runner: 'typescript',
    harness: true,
    lineComment: '//',
    executables: ['node'],
  },
  {
    slug: 'cpp',
    label: 'C++',
    ext: 'cpp',
    runner: 'cpp',
    harness: true,
    lineComment: '//',
    executables: ['g++', 'clang++'],
  },
  {
    slug: 'c',
    label: 'C',
    ext: 'c',
    runner: 'c',
    harness: true,
    lineComment: '//',
    executables: ['gcc', 'clang'],
  },
  {
    slug: 'java',
    label: 'Java',
    ext: 'java',
    runner: 'java',
    harness: true,
    lineComment: '//',
    executables: ['java', 'javac'],
  },
  {
    slug: 'golang',
    label: 'Go',
    ext: 'go',
    runner: 'go',
    harness: true,
    lineComment: '//',
    executables: ['go'],
  },
  {
    slug: 'rust',
    label: 'Rust',
    ext: 'rs',
    runner: 'rust',
    harness: true,
    lineComment: '//',
    executables: ['rustc'],
  },
  {
    slug: 'ruby',
    label: 'Ruby',
    ext: 'rb',
    runner: 'ruby',
    harness: false,
    lineComment: '#',
    executables: ['ruby'],
  },
  {
    slug: 'php',
    label: 'PHP',
    ext: 'php',
    runner: 'php',
    harness: false,
    lineComment: '//',
    executables: ['php'],
  },
  {
    slug: 'csharp',
    label: 'C#',
    ext: 'cs',
    runner: 'csharp',
    harness: false,
    lineComment: '//',
    executables: ['dotnet'],
  },
  {
    slug: 'kotlin',
    label: 'Kotlin',
    ext: 'kt',
    runner: 'kotlin',
    harness: false,
    lineComment: '//',
    executables: ['kotlinc'],
  },
  {
    slug: 'swift',
    label: 'Swift',
    ext: 'swift',
    runner: 'swift',
    harness: false,
    lineComment: '//',
    executables: ['swift'],
  },
  {
    slug: 'dart',
    label: 'Dart',
    ext: 'dart',
    runner: 'unsupported',
    harness: false,
    lineComment: '//',
    executables: ['dart'],
  },
  {
    slug: 'scala',
    label: 'Scala',
    ext: 'scala',
    runner: 'unsupported',
    harness: false,
    lineComment: '//',
    executables: ['scala'],
  },
  {
    slug: 'elixir',
    label: 'Elixir',
    ext: 'ex',
    runner: 'unsupported',
    harness: false,
    lineComment: '#',
    executables: ['elixir'],
  },
  {
    slug: 'erlang',
    label: 'Erlang',
    ext: 'erl',
    runner: 'unsupported',
    harness: false,
    lineComment: '%',
    executables: ['erlc'],
  },
  {
    slug: 'racket',
    label: 'Racket',
    ext: 'rkt',
    runner: 'unsupported',
    harness: false,
    lineComment: ';',
    executables: ['racket'],
  },
  {
    slug: 'cangjie',
    label: 'Cangjie',
    ext: 'cj',
    runner: 'unsupported',
    harness: false,
    lineComment: '//',
    executables: [],
  },
];

const bySlug = new Map(table.map((l) => [l.slug, l]));

/** LeetCode 的部分别名 → 规范 slug */
const aliases: Record<string, string> = {
  py: 'python3',
  python3_: 'python3',
  js: 'javascript',
  ts: 'typescript',
  cpp17: 'cpp',
  cpp20: 'cpp',
  golang: 'golang',
  go: 'golang',
  csharp: 'csharp',
  cs: 'csharp',
  rs: 'rust',
  kt: 'kotlin',
};

export function normalizeLangSlug(slug: string): string {
  const s = (slug || '').trim().toLowerCase();
  return aliases[s] ?? s;
}

export function getLang(slug: string): LangInfo | undefined {
  return bySlug.get(normalizeLangSlug(slug));
}

export function allLangs(): LangInfo[] {
  return [...table];
}

export function runnerFor(slug: string): RunnerKind {
  return getLang(slug)?.runner ?? 'unsupported';
}

/** 按扩展名反查语言，用于把本地打开的文件关联回 LeetCode 语言。 */
export function langsByExt(ext: string): LangInfo[] {
  const e = ext.replace(/^\./, '').toLowerCase();
  return table.filter((l) => l.ext === e);
}
