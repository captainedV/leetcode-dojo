/**
 * 「受限行内补全」的纯规则层（**不 import vscode**，可直接单测）。
 *
 * 为什么要有这层：`line` 级提示允许 AI 补「当前这一行」，但一行之差的补全
 * 也可能被模型扩成整段解法（多行、开块、写函数定义）。所以候选文本必须先过
 * 一组「硬规则」——这些规则不看模型、不看上下文语义，只看**文本形状**，
 * 过不了就直接丢弃，绝不放宽。
 */

export type HintLevel = 'off' | 'signature' | 'line';

export const HINT_LEVELS: readonly HintLevel[] = ['off', 'signature', 'line'];

export function isHintLevel(value: unknown): value is HintLevel {
  return typeof value === 'string' && (HINT_LEVELS as readonly string[]).includes(value);
}

/** 配置项 `lcLocal.hint.maxLineChars` 的默认值 */
export const DEFAULT_MAX_LINE_CHARS = 80;

export interface GatedLineFilterOptions {
  /** 单行补全的最大字符数 */
  maxChars: number;
  /** 光标所在行的已有内容（光标前） */
  anchorLine: string;
  /** 光标之后同一行已有内容（若光标本就在行尾则为空） */
  followingLine?: string;
  /** LeetCode langSlug，用于语言相关的语句分隔符/块判定 */
  langSlug: string;
}

export interface GatedLineVerdict {
  ok: boolean;
  /** ok 为 false 时的中文原因，便于日志与调试 */
  reason?: string;
}

const PYTHON_FAMILY = new Set(['python', 'python3', 'py']);
const RUBY_FAMILY = new Set(['ruby', 'rb']);
/** 用 `{ ... }` 分块、`;` 断句的语言 */
const BRACE_FAMILY = new Set([
  'javascript',
  'typescript',
  'ts',
  'js',
  'cpp',
  'cpp17',
  'cpp20',
  'c',
  'c++',
  'java',
  'csharp',
  'cs',
  'golang',
  'go',
  'rust',
  'rs',
  'kotlin',
  'kt',
  'swift',
  'php',
  'scala',
  'dart',
]);

/** 出现即视为「在写定义」的关键字（只允许补表达式/语句尾巴） */
const DEFINITION_KEYWORDS = /\b(class|def|function|public|private|protected|fn|struct|interface|impl)\s/;
/** 控制流关键字：出现 2 个及以上就认为在写逻辑块 */
const CONTROL_KEYWORDS = new Set(['for', 'while', 'if', 'else', 'switch', 'case', 'try', 'catch', 'elif']);
/** 内联条件表达式（Python 的 `a if c else b`）：不是控制流块 */
const INLINE_CONDITIONAL = /\bif\b[^;{}:]*?\belse\b/;
/** 以这些结尾表示「要开一个块」 */
const BLOCK_TAIL = /(\bdo|\bthen)$/;

const WORD_RUN = /\s+/g;

interface ScanResult {
  /** 是否有某个括号提前闭合（配平变负） */
  wentNegative: boolean;
  /** 结尾是否还有未闭合的括号（想开块） */
  unclosed: boolean;
  /** 括号深度全部为 0 时的 `;` 数量 */
  topLevelSemicolons: number;
}

/**
 * 扫一遍文本：括号配平 + 顶层分号计数。字符串字面量里的括号/分号不计入。
 * 只做文本级判断，不追求完整的词法分析（候选本身很短）。
 */
function scan(text: string): ScanResult {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let wentNegative = false;
  let topLevelSemicolons = 0;
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    switch (ch) {
      case '(':
        paren += 1;
        break;
      case ')':
        paren -= 1;
        if (paren < 0) wentNegative = true;
        break;
      case '{':
        brace += 1;
        break;
      case '}':
        brace -= 1;
        if (brace < 0) wentNegative = true;
        break;
      case '[':
        bracket += 1;
        break;
      case ']':
        bracket -= 1;
        if (bracket < 0) wentNegative = true;
        break;
      case ';':
        if (paren === 0 && brace === 0 && bracket === 0) topLevelSemicolons += 1;
        break;
      default:
        break;
    }
  }
  return {
    wentNegative,
    unclosed: paren > 0 || brace > 0 || bracket > 0,
    topLevelSemicolons,
  };
}

/** 去掉字符串字面量之外的注释尾巴（`//`、`#`），避免注释里的关键字被误判。 */
function stripTrailingComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '#' || (ch === '/' && text[i + 1] === '/')) return text.slice(0, i);
  }
  return text;
}

function isPythonish(langSlug: string): boolean {
  const slug = (langSlug || '').trim().toLowerCase();
  return PYTHON_FAMILY.has(slug) || RUBY_FAMILY.has(slug);
}

function isBraceLang(langSlug: string): boolean {
  return BRACE_FAMILY.has((langSlug || '').trim().toLowerCase());
}

/**
 * 统计候选文本里的「语句条数」。
 * - 括号深度为 0 的 `;` 视为语句分隔符（`for (a; b; c)` 里的分号不算）；
 * - 末尾没有 `;` 的那一段算最后一条语句（未闭合行）。
 * Python/Ruby 虽然用换行断句，但候选里禁止换行，所以同一套逻辑就够了。
 */
function countStatements(text: string): number {
  const body = stripTrailingComment(text).trimEnd();
  if (!body) return 0;
  const endsWithSemicolon = body.endsWith(';');
  const separators = scan(body).topLevelSemicolons;
  if (endsWithSemicolon) return Math.max(separators, 1);
  // Python/Ruby 用换行断句，但候选里禁止换行，所以这里同样是「一段算一条」；
  // 额外把 python 的行内 `a; b` 当作两条语句。
  return separators + 1;
}

function norm(text: string): string {
  return text.trim().replace(WORD_RUN, ' ');
}

function isWordChar(ch: string): boolean {
  return /[\w$]/.test(ch);
}

/**
 * 找出「语句位置」上的控制流关键字。
 * 约定：`(`/`[` 内部的 for/if 不可能自己开一个语句块（推导式、生成器、内联表达式都是合法单行），
 * 因此只在圆括号/方括号深度为 0 处计数；大括号不豁免（`{ if ... }` 仍然是块）。
 */
function controlKeywordHits(text: string): string[] {
  const hits: string[] = [];
  let paren = 0;
  let bracket = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '(') {
      paren += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      paren -= 1;
      i += 1;
      continue;
    }
    if (ch === '[') {
      bracket += 1;
      i += 1;
      continue;
    }
    if (ch === ']') {
      bracket -= 1;
      i += 1;
      continue;
    }
    if (isWordChar(ch) && (i === 0 || !isWordChar(text[i - 1]))) {
      let j = i;
      while (j < text.length && isWordChar(text[j])) j += 1;
      const word = text.slice(i, j);
      if (paren === 0 && bracket === 0 && CONTROL_KEYWORDS.has(word)) hits.push(word);
      i = j;
      continue;
    }
    i += 1;
  }
  return hits;
}

/**
 * 判断一段「候选补全文本」是否允许插入当前行。
 *
 * 规则（全部为硬规则，任何一条不过就丢弃）：
 * 1. 空文本不允许；含换行不允许（多行 = 整段解法）；
 * 2. 长度超过 maxChars 不允许；
 * 3. 括号配平变负、或结尾仍有未闭合括号（想开块）不允许；
 * 4. 以 `:`、`{`、`do`、`then` 结尾不允许（块开头）；
 * 5. 控制流关键字出现 2 个及以上不允许（只数语句位置上的；`(`/`[` 里的推导式、
 *    Python 的 `a if c else b` 内联条件表达式不算开块）；
 * 6. 出现 `class `/`def `/`function `/`public `/`fn ` 等定义不允许；
 * 7. 与光标后已存在的内容重复不允许；
 * 8. 语句数 > 1 不允许（只补一条语句）。
 */
export function checkLineCompletion(text: string, opts: GatedLineFilterOptions): GatedLineVerdict {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();

  // 1. 空 / 多行
  if (!trimmed) return { ok: false, reason: '候选为空' };
  if (/[\r\n]/.test(raw)) return { ok: false, reason: '候选包含换行（可能是整段解法）' };

  // 2. 长度上限（按 trim 后的长度算，避免尾随空格误伤）
  const maxChars = Number.isFinite(opts.maxChars) ? Math.floor(opts.maxChars) : DEFAULT_MAX_LINE_CHARS;
  if (maxChars > 0 && trimmed.length > maxChars) {
    return { ok: false, reason: `候选长度 ${trimmed.length} 超过上限 ${maxChars}` };
  }

  const code = stripTrailingComment(trimmed).trimEnd();
  const codeNoTrailingPunct = code || trimmed;

  // 3. 括号配平
  const scanned = scan(trimmed);
  if (scanned.wentNegative) return { ok: false, reason: '括号配平为负（多了右括号）' };
  if (scanned.unclosed) return { ok: false, reason: '结尾还有未闭合的括号（想开一个块）' };

  // 4. 块开头
  if (/[:{]$/.test(codeNoTrailingPunct) || BLOCK_TAIL.test(codeNoTrailingPunct)) {
    return { ok: false, reason: '候选以块开头结尾（: / { / do / then）' };
  }

  // 5. 控制流关键字 >= 2（语句位置上的）
  const controlHits = controlKeywordHits(codeNoTrailingPunct);
  // 唯一的豁免：Python 的内联条件表达式 `a if c else b` 语义上是单个表达式，不会开块
  const inlineConditional =
    controlHits.length === 2 &&
    controlHits.includes('if') &&
    controlHits.includes('else') &&
    INLINE_CONDITIONAL.test(codeNoTrailingPunct);
  if (controlHits.length >= 2 && !inlineConditional) {
    return { ok: false, reason: `出现 ${controlHits.length} 个控制流关键字（${controlHits.join('/')}）` };
  }

  // 6. 定义关键字
  if (DEFINITION_KEYWORDS.test(codeNoTrailingPunct)) {
    return { ok: false, reason: '候选包含 class/def/function/public/fn 等定义语句' };
  }

  // 7. 与光标后已有内容重复
  const following = norm(opts.followingLine ?? '');
  const cand = norm(trimmed);
  if (following) {
    if (following === cand) return { ok: false, reason: '候选与光标后已有内容重复' };
    if (cand.length >= 3 && following.endsWith(cand)) {
      return { ok: false, reason: '候选已经存在于光标之后' };
    }
  }
  // 锚点行（光标前内容）已经把这段写完了，也不要重复
  const anchor = norm(opts.anchorLine ?? '');
  if (anchor && cand.length >= 3 && anchor.endsWith(cand)) {
    return { ok: false, reason: '候选与光标前已写内容重复' };
  }

  // 8. 只允许单语句
  const statements = countStatements(trimmed);
  if (statements > 1) {
    return { ok: false, reason: `候选包含 ${statements} 条语句（只允许补一条）` };
  }
  // 语言无关的兜底：`}` / `);` 之类收尾片段单独出现没有意义（大括号语言才看）
  if (!isPythonish(opts.langSlug) && !isBraceLang(opts.langSlug) && /[{}]/.test(codeNoTrailingPunct)) {
    return { ok: false, reason: '未知语言出现大括号，保守拒绝' };
  }

  return { ok: true };
}
