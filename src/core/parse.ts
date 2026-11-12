/**
 * 题面 / 元数据的解析逻辑。纯函数，可直接单测。
 *
 * 关键点：
 *  - `exampleTestcases` 是「按参数逐行」排列的，按 params.length 分组即可得到每个示例的输入；
 *  - 期望输出不在 `exampleTestcases` 里，需要从题面 HTML 的 `Output:` 块解析；
 *  - `metaData` 是 JSON 字符串。
 */
import type { ExampleBlock, LcMetaData, LcQuestion, TestCase } from './types.js';

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&minus;': '-',
  '&le;': '<=',
  '&ge;': '>=',
  '&ne;': '!=',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&(lt|gt|amp|quot|#39|apos|nbsp|minus|le|ge|ne);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/(pre|code|div|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/** 把题面 HTML 转成可读的 Markdown-ish 文本，用于在题目面板里展示。 */
export function htmlToMarkdown(html: string): string {
  let out = html;
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = stripTags(inner).replace(/^\n+|\n+$/g, '');
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
    const t = stripTags(inner).trim();
    return t ? '`' + t + '`' : '';
  });
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `**${stripTags(inner).trim()}**`);
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${stripTags(inner).trim()}*`);
  out = out.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, (_m, inner: string) => '^' + stripTags(inner).trim());
  out = out.replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, (_m, inner: string) => '_' + stripTags(inner).trim());
  out = out.replace(/<li[^>]*>/gi, '\n- ');
  out = out.replace(/<\/(ul|ol)>/gi, '\n');
  out = out.replace(/<hr\s*\/?>/gi, '\n---\n');
  out = stripTags(out);
  out = out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/** 解析 `metaData` 字段（容错：坏 JSON 返回 undefined）。 */
export function parseMetaData(raw: string | undefined | null): LcMetaData | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as LcMetaData;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.params)) return undefined;
    if (typeof parsed.return !== 'object' || parsed.return === null) {
      parsed.return = { type: 'void' };
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 按 `params.length` 把 `exampleTestcases` 逐行切分成示例。
 * 若行数不是 params 数的整数倍，按能整除的最大前缀处理，剩余行整体作为最后一个用例。
 */
export function splitExampleTestcases(exampleTestcases: string, paramCount: number): string[][] {
  const lines = (exampleTestcases ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd());
  // 去掉尾部空行
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return [];
  const n = Math.max(1, paramCount || 1);
  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i += n) {
    const g = lines.slice(i, i + n);
    if (g.length === n) groups.push(g);
    else if (groups.length === 0) groups.push(g); // 不整除时也保留，交给上层提示
    else groups[groups.length - 1].push(...g);
  }
  return groups;
}

const OUTPUT_LINE = /^\s*(?:输出|输出结果)\s*[:：]\s*([\s\S]*)$|^\s*Output\s*:\s*([\s\S]*)$/i;
const INPUT_LINE = /^\s*(?:输入|输入数据)\s*[:：]\s*([\s\S]*)$|^\s*Input\s*:\s*([\s\S]*)$/i;
const EXPLAIN_LINE = /^\s*(?:解释|说明|Explanation)\s*[:：]?\s*([\s\S]*)$/i;
const EXAMPLE_HEAD = /^\s*(?:Example|示例)\s*\d*\s*[:：]?\s*$/i;

/** HTML → 纯文本行（<p>/<div>/<br> 等都转成换行，便于按行扫描） */
export function htmlToLines(html: string): string[] {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/pre>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ');
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .filter((l) => l.length > 0);
}

/**
 * 从题面 HTML 解析示例。
 *
 * 站点有两种写法（都要支持）：
 *   A. `<pre><strong>Input:</strong> ...<strong>Output:</strong> ...</pre>`
 *   B. `<p><strong>Input:</strong> <code>nums = [...]</code></p><p><strong>Output:</strong> <code>[0,1]</code></p>`
 * 所以这里统一按「文本行」扫描，而不是只认 `<pre>`。
 */
export function parseExamples(contentHtml: string): ExampleBlock[] {
  if (!contentHtml) return [];
  const lines = htmlToLines(contentHtml);
  const blocks: ExampleBlock[] = [];
  let cur: { input: string[]; output: string[]; explanation: string[] } | null = null;

  const flush = (): void => {
    if (!cur) return;
    const input = cur.input.join('\n').trim();
    const output = cur.output.join('\n').trim();
    if (input || output) {
      blocks.push({
        index: blocks.length,
        input: input || null,
        output: output || null,
        explanation: cur.explanation.join(' ').trim() || null,
      });
    }
    cur = null;
  };

  for (const line of lines) {
    if (EXAMPLE_HEAD.test(line)) {
      flush();
      cur = { input: [], output: [], explanation: [] };
      continue;
    }
    const im = INPUT_LINE.exec(line);
    if (im) {
      const value = (im[1] ?? im[2] ?? '').trim();
      if (!cur) cur = { input: [], output: [], explanation: [] };
      else if (cur.output.length) {
        flush();
        cur = { input: [], output: [], explanation: [] };
      }
      if (value) cur.input.push(value);
      continue;
    }
    const om = OUTPUT_LINE.exec(line);
    if (om) {
      const value = (om[1] ?? om[2] ?? '').trim();
      if (!cur) cur = { input: [], output: [], explanation: [] };
      if (value) cur.output.push(value);
      continue;
    }
    const em = EXPLAIN_LINE.exec(line);
    if (em) {
      const value = (em[1] ?? '').trim();
      if (!cur) cur = { input: [], output: [], explanation: [] };
      if (value) cur.explanation.push(value);
      continue;
    }
    if (!cur) continue;
    // 续行：输出之后算解释，输入之后算输入的续行
    if (cur.output.length) cur.explanation.push(line);
    else if (cur.input.length) cur.input.push(line);
  }
  flush();
  return blocks;
}

/**
 * 从示例的 `Input:` 文本里拆出每个参数的值文本。
 * 同时支持 `nums = [1,2], target = 3` 与 `"[1,2]", "abc"` 两种写法。
 */
export function splitInputArgs(input: string | null, paramNames: string[]): string[] {
  if (!input) return [];
  const text = input.replace(/\r/g, '').trim();
  // 先尝试 "name = value" 形式
  const named = splitNamedArgs(text);
  if (named && paramNames.length > 0) {
    const ordered = paramNames.map((n) => named[n.trim().toLowerCase()]);
    if (ordered.every((v) => v !== undefined)) return ordered as string[];
  }
  // 再按顶层逗号拆分
  const parts = splitTopLevel(text, ',');
  if (parts.length === paramNames.length) return parts.map((p) => p.trim());
  return parts.map((p) => p.trim());
}

/** 解析 `a = 1, b = [2,3]` → { a: '1', b: '[2,3]' }（值内逗号/括号安全） */
export function splitNamedArgs(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const parts = splitTopLevel(text, ',');
  let found = false;
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    if (!/^[a-zA-Z_][\w]*$/.test(key)) continue;
    out[key] = p.slice(eq + 1).trim();
    found = true;
  }
  return found ? out : null;
}

/** 按顶层分隔符切分（忽略 [] {} () 与引号内部的逗号）。 */
export function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === '\\') {
        buf += text[++i] ?? '';
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    if (ch === ']' || ch === '}' || ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '') out.push(buf.trim());
  return out;
}

/**
 * 组装本地用例：优先使用 `exampleTestcases`（官方给判题机的输入），
 * 期望输出来自题面示例，并按「输入内容」配对（而不是只按顺序，避免题面笔误导致错位）。
 */
export function buildTestCases(question: Pick<LcQuestion, 'exampleTestcases' | 'content' | 'metaData'>): TestCase[] {
  const meta = parseMetaData(question.metaData);
  const paramCount = meta?.params.length ?? 1;
  const paramNames = meta?.params.map((p) => p.name) ?? [];
  const groups = splitExampleTestcases(question.exampleTestcases, paramCount);
  const examples = parseExamples(question.content);
  const pairs = examples.map((ex) => ({ args: splitInputArgs(ex.input, paramNames), out: ex.output }));

  const findExpected = (args: string[], position: number): string | null => {
    const byValue = pairs.find(
      (p) => p.args.length === args.length && p.args.every((v, i) => looseEqualArg(v, args[i])),
    );
    if (byValue?.out) return cleanExpected(byValue.out);
    if (pairs.length === groups.length && pairs[position]?.out) return cleanExpected(pairs[position].out);
    return null;
  };

  const cases: TestCase[] = [];
  const seen = new Set<string>();
  for (const args of groups) {
    const key = args.join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({ index: cases.length, args, expected: findExpected(args, cases.length), source: 'leet' });
  }

  // exampleTestcases 缺失时退化为题面示例
  if (cases.length === 0 && examples.length) {
    for (const ex of examples) {
      if (!ex.input) continue;
      const args = splitInputArgs(ex.input, paramNames);
      if (!args.length) continue;
      cases.push({
        index: cases.length,
        args,
        expected: ex.output ? cleanExpected(ex.output) : null,
        source: 'example',
      });
    }
  }
  return cases;
}

/** 比较两个参数原文是否等价（忽略空白、引号、大小写布尔） */
export function looseEqualArg(a: string, b: string): boolean {
  const norm = (s: string): string =>
    (s ?? '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/^["']|["']$/g, '')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null')
      .toLowerCase();
  return norm(a) === norm(b);
}

export interface CustomInputResult {
  args: string[];
  error?: string;
}

/**
 * 解析用户手写的调试输入。
 * 支持三种写法（按顺序尝试）：
 *   1. 具名：`l1 = [2,4,3], l2 = [5,6,4]`
 *   2. 分号/换行分隔，每个参数一行：`[2,4,3]\n[5,6,4]`
 *   3. 顶层逗号分隔：`[2,4,3], [5,6,4]`
 */
export function parseCustomInput(text: string, paramNames: string[]): CustomInputResult {
  const raw = (text ?? '').trim();
  if (!raw) return { args: [], error: '输入为空' };
  const expected = paramNames.length;

  // 1) 具名形式
  if (raw.includes('=')) {
    const named = splitNamedArgs(raw.replace(/[;\n]+/g, ','));
    if (named) {
      const ordered = paramNames.map((n) => named[n.trim().toLowerCase()] ?? named[n]);
      if (ordered.every((v) => v !== undefined)) return { args: ordered as string[] };
      const values = Object.values(named);
      if (values.length === expected) return { args: values };
    }
  }
  // 2) 分号/换行分隔
  const byLines = raw
    .split(/[;\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (byLines.length === expected) return { args: byLines };
  // 3) 顶层逗号分隔
  const byComma = splitTopLevel(raw, ',');
  if (byComma.length === expected) return { args: byComma.map((v) => v.trim()) };

  return {
    args: [],
    error: `参数个数不对：这道题需要 ${expected} 个参数（${paramNames.join(', ') || '见题面签名'}），你给了 ${
      byComma.length || byLines.length
    } 个`,
  };
}

/** 清理期望输出：去掉行内的解释性文字与多余空白。 */
export function cleanExpected(raw: string): string {
  let s = raw.replace(/\r/g, '').trim();
  // 只保留第一行（多行期望极少见，且通常第二行是解释）
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    // 形如 [[1,2],[3,4]] 跨行的情况：尝试拼回去
    const joined = lines.join('');
    if (balanced(joined) && /^[[{]/.test(joined)) return joined.replace(/\s+/g, ' ');
    s = lines[0];
  } else if (lines.length === 1) {
    s = lines[0];
  }
  return s
    .replace(/\s*[（(]行\s*1[)）].*$/i, '')
    .replace(/\s*(或|or)\s+.*$/i, '')
    .trim();
}

function balanced(s: string): boolean {
  let d = 0;
  for (const ch of s) {
    if (ch === '[' || ch === '{' || ch === '(') d++;
    else if (ch === ']' || ch === '}' || ch === ')') d--;
    if (d < 0) return false;
  }
  return d === 0;
}

/** 归一化输出文本，便于跨语言比较。 */
export function normalizeOutput(s: string): string {
  let t = (s ?? '').trim();
  if (t === '') return '';
  t = t.replace(/\r/g, '');
  // 去掉最外层包裹的引号（不同语言打印字符串的方式不同）
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  t = t
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/\bnull\b/g, 'null')
    .replace(/\bundefined\b/g, 'null');
  // 数字统一：1.0 → 1，-0 → 0
  t = t.replace(/(?<![\w.])-?(\d+)\.0+(?![\d])/g, (_m, d: string) => d);
  t = t.replace(/(?<![\w.])-0(?![\d.])/g, '0');
  // 去掉引号内的差异不处理；统一空白
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\s*([,[\]{}])\s*/g, '$1');
  t = t.replace(/,\s*\]/g, ']');
  return t.trim();
}

export interface CompareOutcome {
  /** true=完全一致；false=不一致；null=无法判定（没有期望输出） */
  ok: boolean | null;
  /** 附加说明，例如「顺序不同但内容一致」 */
  note?: string;
}

/**
 * 比较实际/期望输出，并对**多解题目**做宽松兜底。
 *
 * 为什么需要：LeetCode 上不少题目接受任意顺序（两数之和的下标、三数之和、全排列、
 * 字母异位词分组、克隆图…），官方判题机用 special checker。我们如果只做严格字符串比较，
 * 会出现「本地测试未通过但提交 Accepted」的假阴性。
 * 严格不等时用「多重集合等价」再比一次，命中就判过并标注「顺序不同」。
 */
export function compareOutputEx(actual: string, expected: string | null): CompareOutcome {
  const strict = compareOutput(actual, expected);
  if (strict !== false) return { ok: strict };
  if (expected && unorderedEquivalent(actual, expected)) {
    return { ok: true, note: '内容一致但顺序不同（本题接受任意答案顺序）' };
  }
  return { ok: false };
}

/** 判断两段输出是否「多重集合等价」（递归排序数组元素后比较） */
export function unorderedEquivalent(a: string, b: string): boolean {
  const pa = tryParseJson(a);
  const pb = tryParseJson(b);
  if (pa === undefined || pb === undefined) return false;
  if (!Array.isArray(pa) || !Array.isArray(pb)) return false;
  if (pa.length !== pb.length) return false;
  return canonicalMultiset(pa) === canonicalMultiset(pb);
}

function canonicalMultiset(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalMultiset).sort().join(',') + ']';
  }
  return JSON.stringify(value);
}

function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // 常见于 Python repr：True/False/None 或单引号
    const fixed = trimmed
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null')
      .replace(/'([^'\\]*)'/g, '"$1"');
    try {
      return JSON.parse(fixed);
    } catch {
      return undefined;
    }
  }
}

/** 比较实际输出与期望输出（返回 true/false/null=无法判定）。 */
export function compareOutput(actual: string, expected: string | null): boolean | null {
  if (expected === null || expected === '') return null;
  const a = normalizeOutput(actual);
  const e = normalizeOutput(expected);
  if (a === e) return true;
  // 浮点容差
  const fa = Number(a);
  const fe = Number(e);
  if (Number.isFinite(fa) && Number.isFinite(fe)) {
    return Math.abs(fa - fe) <= 1e-5 * Math.max(1, Math.abs(fe));
  }
  return false;
}
