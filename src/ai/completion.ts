/**
 * 受限补全：把「只提示 API 签名」和「只补一行」两种档位接到 VS Code 的补全 API 上。
 *
 * 三个要点：
 * 1. 只在「练习文件」里生效（题目目录下的源码文件），普通项目里完全不干扰；
 * 2. `signature` 档只补「名字 + 参数名」，永远不补算法主体；
 * 3. `line` 档即使走 AI，也必须先过 lineGate 的硬规则。
 *
 * 纯规则在 ./lineGate.ts（不 import vscode，可单测），这里只做 VS Code 适配。
 */
import * as vscode from 'vscode';
import { hintsForLine, insertTextFor, type ApiSignature } from './signatureDb.js';
import { checkLineCompletion } from './lineGate.js';
import type { GatedLineFilterOptions, GatedLineVerdict, HintLevel } from './lineGate.js';
import { langsByExt, normalizeLangSlug } from '../core/langs.js';

// 纯函数/类型原样透出，调用方与测试都从 completion.ts 拿也行
export { checkLineCompletion } from './lineGate.js';
export type { GatedLineFilterOptions, GatedLineVerdict, HintLevel } from './lineGate.js';

export interface CompletionProviderDeps {
  getLevel: () => HintLevel;
  getMaxChars: () => number;
  isPracticeFile: (doc: vscode.TextDocument) => boolean;
  /** 可选：AI 行补全（无则退化为纯本地签名提示）；返回 null 表示无建议 */
  requestLine?: (ctx: { langSlug: string; linePrefix: string; before: string; after: string }) => Promise<string | null>;
  log: (msg: string) => void;
}

/** 传给 AI 的上下文行数（前后各这么多行） */
const CONTEXT_LINES = 12;
/** 一次最多给几条签名提示 */
const MAX_SUGGESTIONS = 5;
const DETAIL_TEXT = 'API 提示（不会生成算法）';

/** VS Code languageId → LeetCode langSlug */
const LANGUAGE_ID_TO_SLUG: Record<string, string> = {
  python: 'python3',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  typescript: 'typescript',
  typescriptreact: 'typescript',
  cpp: 'cpp',
  c: 'c',
  java: 'java',
  go: 'golang',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
  csharp: 'csharp',
  kotlin: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  dart: 'dart',
};

/** 从文档推断 LeetCode langSlug（先看 languageId，再回退到扩展名）。 */
export function langSlugOf(doc: vscode.TextDocument): string {
  const byId = LANGUAGE_ID_TO_SLUG[doc.languageId];
  if (byId) return byId;
  const ext = doc.uri.path.includes('.') ? doc.uri.path.slice(doc.uri.path.lastIndexOf('.') + 1) : '';
  const byExt = ext ? langsByExt(ext)[0]?.slug : undefined;
  return normalizeLangSlug(byExt ?? doc.languageId ?? '');
}

interface LineContext {
  /** 整行文本 */
  lineText: string;
  /** 光标前的行内文本 */
  linePrefix: string;
  /** 光标后的行内文本 */
  lineSuffix: string;
  /** 光标前紧挨着的标识符（正在输入的那半个词） */
  wordPrefix: string;
  /** 光标后紧挨着的标识符（行内剩余的半个词） */
  wordSuffix: string;
}

function lineContext(doc: vscode.TextDocument, position: vscode.Position): LineContext {
  const lineText = doc.lineAt(position.line).text;
  const linePrefix = lineText.slice(0, position.character);
  const lineSuffix = lineText.slice(position.character);
  return {
    lineText,
    linePrefix,
    lineSuffix,
    wordPrefix: /[\w$]*$/.exec(linePrefix)?.[0] ?? '',
    wordSuffix: /^[\w$]*/.exec(lineSuffix)?.[0] ?? '',
  };
}

/** 光标前文本的括号净深度（只看 `()[]{}`） */
function bracketDepth(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
  }
  return depth;
}

/**
 * 光标是否在注释/字符串里：这里只做保守判断（未闭合引号、行内注释标记），
 * 判断不了的时候按「不在」处理，交给后续规则兜底。
 */
function looksLikeCommentOrString(prefix: string, langSlug: string): boolean {
  const slug = normalizeLangSlug(langSlug);
  const hashComment = ['python', 'python3', 'ruby'].includes(slug);
  let quote: string | null = null;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
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
    if (ch === '/' && prefix[i + 1] === '/') return true;
    if (hashComment && ch === '#') return true;
  }
  // 引号没闭合 → 光标在字符串里
  return quote !== null;
}

/**
 * 计算「替换哪个范围」：
 * - 正在输入的词（光标前后）一定替换掉；
 * - 光标后面只剩空白 → 扩展到行尾；
 * - 光标后面是编辑器自动补的右括号（且光标前确有未闭合的左括号）→ 一起替换掉；
 * - 其它情况返回 undefined（后面还有正经代码，不硬塞）。
 */
function replacementRange(
  doc: vscode.TextDocument,
  position: vscode.Position,
  ctx: LineContext,
): vscode.Range | undefined {
  const start = position.translate(0, -ctx.wordPrefix.length);
  const tail = ctx.lineSuffix.slice(ctx.wordSuffix.length);
  const tailTrimmed = tail.trim();
  let endCharacter = position.character + ctx.wordSuffix.length;
  if (tailTrimmed === '') {
    endCharacter = doc.lineAt(position.line).range.end.character;
  } else if (/^[)\]}]+[;\s]*$/.test(tailTrimmed) && bracketDepth(ctx.linePrefix) > 0) {
    const tailStart = position.character + ctx.wordSuffix.length;
    endCharacter = tailStart + tail.indexOf(tailTrimmed) + tailTrimmed.length;
  } else {
    return undefined;
  }
  return new vscode.Range(start, position.with(position.line, endCharacter));
}

function renderDocumentation(entry: ApiSignature): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(entry.signature, '');
  md.appendMarkdown(`\n${entry.doc}\n`);
  if (entry.returns) md.appendMarkdown(`\n- 返回：\`${entry.returns}\``);
  if (entry.example) md.appendMarkdown(`\n- 示例：\`${entry.example}\``);
  md.appendMarkdown('\n\n_只提示 API 用法，不生成算法逻辑。_');
  return md;
}

/** `signature` 档：只给「名字 + 参数名」，只给一个 item。 */
function signatureSuggestion(
  deps: CompletionProviderDeps,
  doc: vscode.TextDocument,
  position: vscode.Position,
  langSlug: string,
  ctx: LineContext,
): vscode.InlineCompletionItem | undefined {
  const hints = hintsForLine(langSlug, ctx.linePrefix, ctx.wordPrefix);
  const entry = hints[0];
  if (!entry) return undefined;
  const range = replacementRange(doc, position, ctx);
  if (!range) {
    deps.log(`[hint] 光标后还有代码，跳过签名补全（${entry.name}）`);
    return undefined;
  }
  const insertText = insertTextFor(entry);
  deps.log(`[hint] 签名提示：${insertText}`);
  return new vscode.InlineCompletionItem(insertText, range);
}

/** 取 AI 行补全候选，并跑一遍硬规则。 */
async function aiLineSuggestion(
  deps: CompletionProviderDeps,
  doc: vscode.TextDocument,
  position: vscode.Position,
  langSlug: string,
  ctx: LineContext,
  token: vscode.CancellationToken,
): Promise<vscode.InlineCompletionItem | undefined> {
  const requestLine = deps.requestLine;
  if (!requestLine) return undefined;

  const firstLine = Math.max(0, position.line - CONTEXT_LINES);
  const lastLine = Math.min(doc.lineCount - 1, position.line + CONTEXT_LINES);
  const before = doc.getText(
    new vscode.Range(firstLine, 0, position.line, position.character),
  );
  const after = doc.getText(
    new vscode.Range(position.line, position.character, lastLine, doc.lineAt(lastLine).range.end.character),
  );

  let candidate: string | null = null;
  try {
    candidate = await requestLine({ langSlug, linePrefix: ctx.linePrefix, before, after });
  } catch (err) {
    deps.log(`[hint] AI 行补全请求失败：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (token.isCancellationRequested || !candidate) return undefined;

  const opts: GatedLineFilterOptions = {
    maxChars: deps.getMaxChars(),
    anchorLine: ctx.linePrefix.trim(),
    followingLine: ctx.lineSuffix.trim() ? ctx.lineSuffix : undefined,
    langSlug,
  };
  const verdict: GatedLineVerdict = checkLineCompletion(candidate, opts);
  if (!verdict.ok) {
    deps.log(`[hint] AI 候选被规则拦下：${verdict.reason ?? '未知原因'}`);
    return undefined;
  }
  deps.log(`[hint] AI 行补全通过：${candidate.trim()}`);
  // 纯插入（不替换已输入内容），与「续写这一行」的语义一致
  return new vscode.InlineCompletionItem(candidate.trim(), new vscode.Range(position, position));
}

/**
 * 行内补全 provider（ghost text）。
 * - `off`：不返回任何东西；
 * - 非练习文件：不返回任何东西；
 * - `signature`：只给当前所用 API 的签名片段；
 * - `line`：优先用 AI 候选（过硬规则），没有 requestLine 时退化为签名档。
 */
export function createPracticeCompletionProvider(deps: CompletionProviderDeps): vscode.InlineCompletionItemProvider {
  return {
    async provideInlineCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
      _context: vscode.InlineCompletionContext,
      token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionItem[]> {
      const level = deps.getLevel();
      if (level === 'off') return [];
      if (!deps.isPracticeFile(document)) return [];
      try {
        const langSlug = langSlugOf(document);
        const ctx = lineContext(document, position);
        if (looksLikeCommentOrString(ctx.linePrefix, langSlug)) return [];

        if (level === 'line' && deps.requestLine) {
          const item = await aiLineSuggestion(deps, document, position, langSlug, ctx, token);
          return item ? [item] : [];
        }
        const item = signatureSuggestion(deps, document, position, langSlug, ctx);
        return item ? [item] : [];
      } catch (err) {
        deps.log(`[hint] 行内补全异常：${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    },
  };
}

/**
 * 签名提示 provider（智能感知列表，最多 5 条，kind = Function）。
 * 注意：触发字符需要在 package.json 的 `contributes.languages`/`menus` 里声明，
 * 这里不额外注册命令，只负责给出候选项。
 */
export function createSignatureCompletionProvider(deps: CompletionProviderDeps): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): vscode.CompletionItem[] {
      if (deps.getLevel() === 'off') return [];
      if (!deps.isPracticeFile(document)) return [];
      try {
        const langSlug = langSlugOf(document);
        const ctx = lineContext(document, position);
        if (looksLikeCommentOrString(ctx.linePrefix, langSlug)) return [];
        const hints = hintsForLine(langSlug, ctx.linePrefix, ctx.wordPrefix);
        return hints.slice(0, MAX_SUGGESTIONS).map((entry, index) => {
          const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Function);
          item.detail = DETAIL_TEXT;
          item.documentation = renderDocumentation(entry);
          item.insertText = insertTextFor(entry);
          item.filterText = entry.name;
          item.sortText = String(index).padStart(2, '0');
          return item;
        });
      } catch (err) {
        deps.log(`[hint] 签名提示异常：${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    },
  };
}
