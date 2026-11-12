/**
 * AI 生成测试脚手架：把「题面 + metaData + 用例 + 用户代码」交给模型，
 * 换回一份可执行的脚手架计划（文件 + 命令），并做严格安全校验。
 *
 * 安全边界：
 *  - 生成物只允许落在 `<题目目录>/local/ai/` 下（相对路径、禁止绝对路径 / `..` / 隐藏文件）；
 *  - 扩展名必须与语言匹配（另允许 .json/.txt/.md 之类的惰性文件）；
 *  - 命令只允许白名单可执行文件或以 `./` 开头的生成物，且不得含 shell 元字符。
 *
 * 本文件**不 import vscode**，便于单测。
 */
import { getLang, normalizeLangSlug } from '../core/langs.js';
import type { LcMetaData, TestCase } from '../core/types.js';
import type { AssistantClient } from './provider.js';
import { buildHarnessPrompt } from './prompts.js';

/** 生成物目录名（相对题目的 `local/` 目录） */
export const AI_HARNESS_DIR = 'ai';

export interface AiHarnessSpec {
  langSlug: string;
  title: string;
  contentMd: string;
  meta: LcMetaData;
  cases: TestCase[];
  sourceCode: string;
  sourceFileName: string;
  sourceAbsPath: string;
}

export interface AiHarnessPlan {
  /** 相对 local/ai 目录 */
  files: Array<{ name: string; content: string }>;
  steps: Array<{ label: string; cmd: string; args: string[]; fatal?: boolean }>;
  note?: string;
}

const MAX_FILES = 16;
const MAX_FILE_CONTENT = 200_000;
const MAX_STEPS = 6;
const MAX_ARGS = 32;
const MAX_NAME_CHARS = 160;
const MAX_LABEL_CHARS = 60;
const MAX_NOTE_CHARS = 2000;

/** 语言 → 允许的生成物扩展名（不含点） */
const EXT_BY_LANG: Record<string, string[]> = {
  python3: ['py'],
  python: ['py'],
  javascript: ['js', 'mjs', 'cjs'],
  typescript: ['ts', 'js', 'mjs', 'cjs'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'h'],
  c: ['c', 'h'],
  java: ['java'],
  golang: ['go'],
  rust: ['rs'],
  ruby: ['rb'],
  php: ['php'],
  csharp: ['cs', 'csproj'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  dart: ['dart'],
  scala: ['scala'],
  elixir: ['ex', 'exs'],
  erlang: ['erl'],
  racket: ['rkt'],
  cangjie: ['cj'],
};

/** 与语言无关的惰性文件（用例 JSON / 说明） */
const COMMON_EXTS = ['json', 'txt', 'md'];

const ALL_LANG_EXTS = [...new Set(Object.values(EXT_BY_LANG).flat())];

/** 允许出现在 steps[].cmd 里的可执行命令（白名单，小写） */
const ALLOWED_COMMANDS = new Set([
  'python3',
  'python',
  'python2',
  'node',
  'nodejs',
  'deno',
  'bun',
  'tsx',
  'tsc',
  'g++',
  'clang++',
  'gcc',
  'clang',
  'cc',
  'javac',
  'java',
  'go',
  'rustc',
  'ruby',
  'php',
  'dotnet',
  'kotlinc',
  'swift',
  'swiftc',
  'dart',
  'scala',
  'elixir',
  'elixirc',
  'erlc',
  'racket',
]);

/** shell 元字符：命令与参数里一律不允许出现（我们用 spawn，不经 shell） */
const SHELL_META = /[;&|`$<>\n\r\0]/;

/** 允许的路径字符：字母数字、下划线、点、斜杠 */
const SAFE_PATH_CHARS = /^[A-Za-z0-9._/-]+$/;

function extsWithCommon(list: string[]): string[] {
  return [...new Set([...list, ...COMMON_EXTS])];
}

/** 某语言允许的扩展名（含点、小写）。未知语言给出宽泛的安全集合。 */
export function allowedExtensions(langSlug?: string): string[] {
  const slug = (langSlug ?? '').trim().toLowerCase();
  if (!slug) return extsWithCommon(ALL_LANG_EXTS).map((e) => `.${e}`);
  const normalized = normalizeLangSlug(slug);
  const list = EXT_BY_LANG[normalized];
  if (list) return extsWithCommon(list).map((e) => `.${e}`);
  const lang = getLang(normalized);
  if (lang?.ext) return extsWithCommon([lang.ext]).map((e) => `.${e}`);
  return extsWithCommon(ALL_LANG_EXTS).map((e) => `.${e}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string, opts: { allowEmpty?: boolean; max?: number } = {}): string {
  if (typeof value !== 'string') throw new Error(`${what} 必须是字符串`);
  if (!opts.allowEmpty && value.trim().length === 0) throw new Error(`${what} 不能为空`);
  if (opts.max && value.length > opts.max) throw new Error(`${what} 过长（>${opts.max} 字符）`);
  return opts.allowEmpty ? value : value.trim();
}

/** 相对路径安全检查：非绝对路径、无 `..`、无隐藏段、无空段、字符受限。 */
function assertSafeRelativePath(name: string, what: string): string {
  const path = name.trim();
  if (!path) throw new Error(`${what} 不能为空`);
  if (path.length > MAX_NAME_CHARS) throw new Error(`${what} 过长：${path.slice(0, 40)}…`);
  if (path.includes('..')) throw new Error(`${what} 不能包含 ".."：${path}`);
  if (path.includes('\\')) throw new Error(`${what} 不能包含反斜杠：${path}`);
  if (path.startsWith('/') || path.startsWith('~')) throw new Error(`${what} 不能是绝对路径：${path}`);
  if (/^[A-Za-z]:/.test(path)) throw new Error(`${what} 不能是绝对路径：${path}`);
  if (!SAFE_PATH_CHARS.test(path)) throw new Error(`${what} 只能包含字母、数字、下划线、点和斜杠：${path}`);
  const segments = path.split('/');
  if (segments.length > 4) throw new Error(`${what} 目录层级过深：${path}`);
  for (const seg of segments) {
    if (!seg) throw new Error(`${what} 含空路径段：${path}`);
    if (seg.startsWith('.')) throw new Error(`${what} 不能使用隐藏文件/目录：${path}`);
    if (/[\u0000-\u001f]/.test(seg)) throw new Error(`${what} 含控制字符：${path}`);
  }
  return path;
}

function assertAllowedExtension(path: string, exts: string[], what: string): void {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    throw new Error(`${what} 必须以合法扩展名结尾（允许：${exts.join(', ')}）：${path}`);
  }
  const ext = base.slice(dot).toLowerCase();
  if (!exts.includes(ext)) {
    throw new Error(`${what} 扩展名 ${ext} 不在允许列表（${exts.join(', ')}）内：${path}`);
  }
}

function assertSafeToken(value: string, what: string): void {
  if (SHELL_META.test(value)) throw new Error(`${what} 含 shell 元字符，已拒绝：${value}`);
  if (/[\u0000-\u001f]/.test(value)) throw new Error(`${what} 含控制字符，已拒绝：${value}`);
}

function normalizeCommand(raw: unknown, what: string): string {
  const cmd = requireString(raw, what);
  if (/\s/.test(cmd) && !cmd.startsWith('./')) {
    throw new Error(`${what} 只能是单个命令名，参数请放进 args：${cmd}`);
  }
  assertSafeToken(cmd, what);
  if (cmd.startsWith('./')) {
    const rel = cmd.slice(2);
    if (!rel) throw new Error(`${what} 缺少可执行文件名：${cmd}`);
    assertSafeRelativePath(rel, what);
    return cmd;
  }
  if (cmd.includes('/') || cmd.includes('\\')) {
    throw new Error(`${what} 不允许使用路径形式的命令（除 ./ 开头的生成物外）：${cmd}`);
  }
  if (!ALLOWED_COMMANDS.has(cmd.toLowerCase())) {
    throw new Error(`${what} 不在白名单内：${cmd}`);
  }
  return cmd;
}

function normalizeArg(raw: unknown, what: string): string {
  if (typeof raw !== 'string') throw new Error(`${what} 必须是字符串`);
  assertSafeToken(raw, what);
  if (raw.length > 4000) throw new Error(`${what} 过长`);
  return raw;
}

/**
 * 校验 / 清洗模型输出的脚手架计划；任何不合规都抛错（调用方负责提示重试）。
 * 第二个参数 `langSlug` 用于按语言校验扩展名；省略时尝试读 `raw.langSlug`，
 * 再不行就用宽泛的安全扩展名集合。
 */
export function normalizeAiHarnessPlan(raw: unknown, langSlug?: string): AiHarnessPlan {
  const obj = asRecord(raw, 'AI 脚手架输出');
  const inferred = langSlug ?? (typeof obj.langSlug === 'string' ? obj.langSlug : undefined);
  const exts = allowedExtensions(inferred);

  if (!Array.isArray(obj.files) || obj.files.length === 0) {
    throw new Error('AI 脚手架输出缺少 files（应为非空数组）');
  }
  if (obj.files.length > MAX_FILES) throw new Error(`files 数量过多（>${MAX_FILES}）`);

  const seen = new Set<string>();
  const files: AiHarnessPlan['files'] = [];
  for (let i = 0; i < obj.files.length; i += 1) {
    const item = asRecord((obj.files as unknown[])[i], `files[${i}]`);
    const name = assertSafeRelativePath(requireString(item.name, `files[${i}].name`), `files[${i}].name`);
    assertAllowedExtension(name, exts, `files[${i}].name`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`files 中出现重复文件：${name}`);
    seen.add(key);
    const content = requireString(item.content, `files[${i}].content`, { allowEmpty: true, max: MAX_FILE_CONTENT });
    files.push({ name, content });
  }

  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error('AI 脚手架输出缺少 steps（应为非空数组）');
  }
  if (obj.steps.length > MAX_STEPS) throw new Error(`steps 数量过多（>${MAX_STEPS}）`);

  const steps: AiHarnessPlan['steps'] = [];
  for (let i = 0; i < obj.steps.length; i += 1) {
    const item = asRecord((obj.steps as unknown[])[i], `steps[${i}]`);
    const rawLabel = requireString(item.label, `steps[${i}].label`);
    const label = rawLabel.length > MAX_LABEL_CHARS ? rawLabel.slice(0, MAX_LABEL_CHARS) : rawLabel;
    const cmd = normalizeCommand(item.cmd, `steps[${i}].cmd`);
    if (!Array.isArray(item.args)) throw new Error(`steps[${i}].args 必须是字符串数组`);
    if (item.args.length > MAX_ARGS) throw new Error(`steps[${i}].args 过多（>${MAX_ARGS}）`);
    const args = item.args.map((arg, j) => normalizeArg(arg, `steps[${i}].args[${j}]`));
    if (item.fatal !== undefined && typeof item.fatal !== 'boolean') {
      throw new Error(`steps[${i}].fatal 必须是布尔值`);
    }
    const step: AiHarnessPlan['steps'][number] = { label, cmd, args };
    if (typeof item.fatal === 'boolean') step.fatal = item.fatal;
    steps.push(step);
  }

  const plan: AiHarnessPlan = { files, steps };
  if (obj.note !== undefined && obj.note !== null && obj.note !== '') {
    const note = requireString(obj.note, 'note', { max: MAX_NOTE_CHARS });
    if (note) plan.note = note;
  }
  return plan;
}

/** 生成脚手架（失败重试 1 次，并带上「上次输出不合法」的原因）。 */
export async function generateHarnessWithAI(
  client: AssistantClient,
  spec: AiHarnessSpec,
): Promise<AiHarnessPlan> {
  if (!client.available) {
    throw new Error(
      'AI 未启用或缺少 API Key，无法生成 AI 脚手架：请打开 lcLocal.ai.enabled 并配置 lcLocal.ai.apiKey（或环境变量 LC_LOCAL_AI_KEY）。',
    );
  }
  const { system, user } = buildHarnessPrompt({
    langSlug: spec.langSlug,
    title: spec.title,
    contentMd: spec.contentMd,
    metaJson: JSON.stringify(spec.meta, null, 2),
    casesJson: JSON.stringify(
      spec.cases.map((c) => ({ i: c.index, args: c.args, expected: c.expected, source: c.source })),
      null,
      2,
    ),
    sourceCode: spec.sourceCode,
  });

  const exts = allowedExtensions(spec.langSlug);
  const sysContent = [
    system,
    '',
    `【本次任务的语言约束】langSlug=${spec.langSlug}；文件名扩展名只允许：${exts.join(', ')}。`,
    `生成物只会写入 <题目目录>/local/${AI_HARNESS_DIR}/，禁止生成与用户代码同名的文件（用户代码：${spec.sourceFileName}）。`,
  ].join('\n');

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: sysContent },
    { role: 'user', content: user },
  ];

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await client.chatJson<unknown>(messages, { maxTokens: 4000, temperature: 0.1 });
      return normalizeAiHarnessPlan(data, spec.langSlug);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      messages.push({
        role: 'user',
        content: [
          `上一次输出不可用：${lastError}`,
          '请重新输出严格 JSON（顶层只有 files / steps / note，不要 markdown 围栏）：',
          `- files[].name 必须是相对 local/${AI_HARNESS_DIR}/ 的路径，扩展名只允许 ${exts.join(', ')}，不得含 ".." 或绝对路径；`,
          '- steps[].cmd 只能来自白名单（python3 / node / g++ / javac / java / go / rustc 等）或以 ./ 开头的生成物，不得含 shell 元字符；',
          '- 运行步骤必须打印 __LC_RESULT__ / __LC_DONE__ 协议行。',
        ].join('\n'),
      });
    }
  }
  throw new Error(`AI 脚手架生成失败（已重试 1 次）：${lastError}`);
}
