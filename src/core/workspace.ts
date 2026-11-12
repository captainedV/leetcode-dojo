/**
 * 题目工作区：把每道题落到一个真实目录里，保证「本地 IDE 编辑 + 调试 + 测试」都可用。
 *
 * 目录结构：
 *   <base>/leetcode/<frontendId>.<slug>/
 *      problem.md            题面（Markdown，只读参考）
 *      meta.json             语言、题目元数据、模板快照
 *      solution.py           当前语言代码（真实文件，可断点调试）
 *      cases.json            测试用例（用户可手改）
 *      local/                自动生成的测试脚手架（不会被提交）
 *
 * <base> = 当前工作区第一个文件夹 | 扩展的 globalStorage 目录
 */
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LcQuestion, TestCase } from './types.js';
import { buildTestCases, htmlToMarkdown, parseMetaData } from './parse.js';
import { getLang } from './langs.js';
import { getSite } from './site.js';

export interface ProblemMeta {
  slug: string;
  questionId: string;
  frontendId: string;
  title: string;
  difficulty: string;
  langSlug: string;
  /** 各语言的官方模板快照，便于「重置模板」 */
  snippets: Record<string, string>;
  /** 生成脚手架的方式 */
  harnessSource?: 'builtin' | 'ai';
  createdAt: string;
  updatedAt: string;
}

export interface ProblemFiles {
  dir: vscode.Uri;
  slug: string;
  meta: vscode.Uri;
  readme: vscode.Uri;
  cases: vscode.Uri;
  localDir: vscode.Uri;
  source: vscode.Uri;
}

export class ProblemStore {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void,
  ) {}

  /** 题目根目录 */
  baseDir(): vscode.Uri {
    const cfg = vscode.workspace.getConfiguration('lcLocal');
    const subdir = cfg.get<string>('workspace.subdir', 'leetcode');
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) return vscode.Uri.joinPath(folder.uri, subdir);
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'workspace', subdir);
  }

  problemDir(question: Pick<LcQuestion, 'questionFrontendId' | 'questionId' | 'titleSlug'>): vscode.Uri {
    const id = question.questionFrontendId ?? question.questionId ?? '0';
    const name = `${String(id).padStart(3, '0')}.${question.titleSlug}`;
    return vscode.Uri.joinPath(this.baseDir(), name);
  }

  async files(question: LcQuestion, langSlug: string): Promise<ProblemFiles> {
    const dir = this.problemDir(question);
    await vscode.workspace.fs.createDirectory(dir);
    const localDir = vscode.Uri.joinPath(dir, 'local');
    await vscode.workspace.fs.createDirectory(localDir);
    return {
      dir,
      slug: question.titleSlug,
      meta: vscode.Uri.joinPath(dir, 'meta.json'),
      readme: vscode.Uri.joinPath(dir, 'problem.md'),
      cases: vscode.Uri.joinPath(dir, 'cases.json'),
      localDir,
      source: vscode.Uri.joinPath(dir, this.sourceFileName(langSlug)),
    };
  }

  sourceFileName(langSlug: string): string {
    const info = getLang(langSlug);
    const ext = info?.ext ?? 'txt';
    // Java / C# / Kotlin 习惯用类名做大写文件名，其余用小写 solution
    if (langSlug === 'java') return 'Solution.java';
    if (langSlug === 'csharp') return 'Solution.cs';
    if (langSlug === 'kotlin') return 'Solution.kt';
    if (langSlug === 'scala') return 'Solution.scala';
    return `solution.${ext}`;
  }

  async ensureProblem(
    question: LcQuestion,
    langSlug: string,
  ): Promise<{ files: ProblemFiles; created: boolean; snippet: string }> {
    const files = await this.files(question, langSlug);
    const snippet = this.pickSnippet(question, langSlug);
    // 先写元数据、题面与用例，最后落盘源代码文件，保证外部一旦观察到源代码出现，题目目录即完整可用
    if (!existsSync(files.readme.fsPath)) {
      await this.writeFile(files.readme, renderProblemMarkdown(question));
    }
    const meta = await this.readMeta(files.meta);
    const now = new Date().toISOString();
    const snippets = { ...(meta?.snippets ?? {}) };
    for (const s of question.codeSnippets ?? []) snippets[s.langSlug] = s.code;
    const next: ProblemMeta = {
      slug: question.titleSlug,
      questionId: question.questionId,
      frontendId: question.questionFrontendId ?? question.questionId,
      title: question.title,
      difficulty: question.difficulty,
      langSlug,
      snippets,
      harnessSource: meta?.harnessSource,
      createdAt: meta?.createdAt ?? now,
      updatedAt: now,
    };
    await this.writeFile(files.meta, JSON.stringify(next, null, 2));
    if (!existsSync(files.cases.fsPath)) {
      const cases = buildTestCases(question);
      await this.writeFile(files.cases, JSON.stringify({ cases }, null, 2));
    }
    const existed = existsSync(files.source.fsPath);
    if (!existed) {
      await this.writeFile(files.source, snippet || `// ${question.title}（未找到 ${langSlug} 模板）\n`);
      this.log(`[workspace] 新建 ${files.source.fsPath}`);
    }
    return { files, created: !existed, snippet };
  }

  pickSnippet(question: LcQuestion, langSlug: string): string {
    const snippets = question.codeSnippets ?? [];
    const exact = snippets.find((s) => s.langSlug === langSlug);
    if (exact) return exact.code;
    // python3 ← python、golang ← go 之类的兼容
    const alias: Record<string, string[]> = {
      python3: ['python'],
      python: ['python3'],
      golang: ['go'],
      typescript: ['javascript'],
    };
    for (const alt of alias[langSlug] ?? []) {
      const s = snippets.find((x) => x.langSlug === alt);
      if (s) return s.code;
    }
    return '';
  }

  async readMeta(uri: vscode.Uri): Promise<ProblemMeta | undefined> {
    try {
      const raw = await readFile(uri.fsPath, 'utf8');
      return JSON.parse(raw) as ProblemMeta;
    } catch {
      return undefined;
    }
  }

  async updateMeta(uri: vscode.Uri, patch: Partial<ProblemMeta>): Promise<void> {
    const meta = await this.readMeta(uri);
    if (!meta) return;
    const next = { ...meta, ...patch, updatedAt: new Date().toISOString() };
    await this.writeFile(uri, JSON.stringify(next, null, 2));
  }

  /** 读取用户自定义用例；解析失败时回退到题面示例 */
  async readCases(files: ProblemFiles, question: LcQuestion): Promise<TestCase[]> {
    try {
      const raw = await readFile(files.cases.fsPath, 'utf8');
      const parsed = JSON.parse(raw) as { cases?: TestCase[] };
      const cases = (parsed.cases ?? []).filter((c) => Array.isArray(c.args));
      if (cases.length) return cases.map((c, i) => ({ ...c, index: i }));
    } catch {
      /* 忽略 */
    }
    return buildTestCases(question);
  }

  async writeCases(files: ProblemFiles, cases: TestCase[]): Promise<void> {
    await this.writeFile(files.cases, JSON.stringify({ cases }, null, 2));
  }

  /**
   * 按 slug 查找本地已存在的题目目录与代码文件（用于进入模式时秒开上次题目的右栏代码，无需等待网络）。
   */
  async findCachedProblemSource(slug: string): Promise<{ source: vscode.Uri; meta: ProblemMeta } | undefined> {
    if (!slug) return undefined;
    try {
      const root = this.baseDir().fsPath;
      if (!existsSync(root)) return undefined;
      const entries = await readdir(root);
      const hit = entries.find((name) => name.endsWith(`.${slug}`));
      if (!hit) return undefined;
      const dir = vscode.Uri.joinPath(this.baseDir(), hit);
      const meta = await this.readMeta(vscode.Uri.joinPath(dir, 'meta.json'));
      if (!meta) return undefined;
      const source = vscode.Uri.joinPath(dir, this.sourceFileName(meta.langSlug || 'python3'));
      if (!existsSync(source.fsPath)) return undefined;
      return { source, meta };
    } catch {
      return undefined;
    }
  }

  async readSource(files: ProblemFiles): Promise<string> {
    try {
      return await readFile(files.source.fsPath, 'utf8');
    } catch {
      return '';
    }
  }

  async writeFile(uri: vscode.Uri, content: string): Promise<void> {
    const dir = uri.fsPath.slice(0, uri.fsPath.lastIndexOf('/'));
    if (dir) await mkdir(dir, { recursive: true });
    await writeFile(uri.fsPath, content, 'utf8');
  }

  /** 在当前工作区写 .vscode/settings.json，限制 AI 补全（重活由 aiGuard 负责） */
  async ensureCursorIgnore(): Promise<void> {
    const base = this.baseDir();
    const ignore = vscode.Uri.joinPath(base, '.cursorignore');
    if (existsSync(ignore.fsPath)) return;
    await this.writeFile(
      ignore,
      [
        '# LeetCode Local IDE：练习模式',
        '# 让 Cursor 的 AI 索引/上下文忽略题目代码，避免整题被自动补全。',
        '# （Tab 补全无法按目录关闭，请在 Cursor 设置里为练习时段手动关闭或降低强度。）',
        '*',
        '',
      ].join('\n'),
    );
  }
}

export function renderProblemMarkdown(question: LcQuestion): string {
  const site = getSite(vscode.workspace.getConfiguration('lcLocal').get<string>('site', 'leetcode.cn'));
  const meta = parseMetaData(question.metaData);
  const lines: string[] = [];
  const id = question.questionFrontendId ?? question.questionId;
  lines.push(`# ${id}. ${question.title}${question.translatedTitle ? ` / ${question.translatedTitle}` : ''}`);
  lines.push('');
  lines.push(`- 难度：**${question.difficulty}**`);
  lines.push(`- 链接：${site.origin}/problems/${question.titleSlug}/`);
  if (meta) {
    const params = meta.params.map((p) => `${p.name}: ${p.type}`).join(', ');
    lines.push(`- 签名：\`${meta.classname ?? 'Solution'}.${meta.name}(${params}) -> ${meta.return.type}\``);
  }
  lines.push('');
  lines.push('> 本题面仅作参考，判题以 LeetCode 官方为准。');
  lines.push('');
  lines.push(htmlToMarkdown(question.content ?? ''));
  if (question.hints?.length) {
    lines.push('');
    lines.push('## 官方提示');
    for (const h of question.hints) lines.push(`- ${htmlToMarkdown(h)}`);
  }
  return lines.join('\n');
}
