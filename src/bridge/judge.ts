/**
 * 判题请求/响应的识别与改写（纯函数，可单测）。
 *
 * 依据 leetcode.cn 前端实际行为：
 *   POST /problems/{slug}/interpret_solution/   运行 → {interpret_id}
 *   POST /problems/{slug}/submit/               提交 → {submission_id}
 *   GET  /submissions/detail/{id}/check/        轮询结果
 *   GET  /submissions/detail/{id}/v2/check/     v2 结果
 * 请求体关键字段：`typed_code`、`lang`、`question_id`、`data_input`。
 */
import type { JudgeKind, NormalizedJudgeResult } from './protocol.js';

export interface JudgeRequestMatch {
  kind: JudgeKind;
  slug: string;
  url: string;
}

const RUN_RE = /\/problems\/([a-zA-Z0-9-]+)\/interpret_solution\/?(?:\?|$)/;
const SUBMIT_RE = /\/problems\/([a-zA-Z0-9-]+)\/submit\/?(?:\?|$)/;
export const CHECK_RE = /\/submissions\/detail\/(\d+)\/(?:v2\/)?check\/?(?:\?|$)/;

/** 判断一次请求是否是判题请求。 */
export function matchJudgeRequest(url: string, bodyText?: string): JudgeRequestMatch | null {
  const path = safePath(url);
  const run = RUN_RE.exec(path);
  if (run) return { kind: 'run', slug: run[1], url: path };
  const submit = SUBMIT_RE.exec(path);
  if (submit) return { kind: 'submit', slug: submit[1], url: path };
  // 兜底：某些版本把语言/代码放在 body 里、URL 可能是 GraphQL，此时靠 body 特征识别
  if (bodyText && /"typed_code"\s*:/.test(bodyText)) {
    const kind: JudgeKind = /"data_input"\s*:/.test(bodyText) ? 'run' : 'submit';
    if (path.includes('/graphql')) return { kind, slug: '', url: path };
  }
  return null;
}

function safePath(url: string): string {
  try {
    const u = new URL(url, 'http://127.0.0.1');
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export interface RewriteInput {
  lang?: string;
  code?: string;
  /** 用本地用例替换网页的输入（可选） */
  dataInput?: string;
}

export interface RewriteResult {
  changed: boolean;
  body?: string;
  code?: string;
  lang?: string;
  useLocalInput: boolean;
  dataInput?: string;
}

/**
 * 把请求体里的 `typed_code` / `lang` 换成本地代码与当前语言。
 * 保持其它字段原样（question_id、study_plan_slug、solve_session_* 等）。
 */
export function rewriteJudgeBody(
  _match: JudgeRequestMatch,
  bodyText: string | undefined,
  input: RewriteInput,
): RewriteResult {
  const result: RewriteResult = { changed: false, useLocalInput: false };
  if (!bodyText) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object') return result;
  const payload = parsed as Record<string, unknown>;
  // 兼容 GraphQL：{"query":...,"variables":{...}}
  const targets: Array<Record<string, unknown>> = [payload];
  const vars = payload.variables;
  if (vars && typeof vars === 'object') targets.push(vars as Record<string, unknown>);

  let changed = false;
  for (const target of targets) {
    if (input.code !== undefined && typeof target.typed_code === 'string' && target.typed_code !== input.code) {
      target.typed_code = input.code;
      result.code = input.code;
      changed = true;
    }
    if (input.lang !== undefined && typeof target.lang === 'string' && target.lang !== input.lang) {
      target.lang = input.lang;
      result.lang = input.lang;
      changed = true;
    }
    if (input.dataInput !== undefined && typeof target.data_input === 'string') {
      target.data_input = input.dataInput;
      result.useLocalInput = true;
      changed = true;
    }
  }
  if (result.lang === undefined) result.lang = input.lang;
  if (result.code === undefined) result.code = input.code;
  if (!changed) return { ...result, changed: false, body: bodyText };
  result.changed = true;
  result.body = JSON.stringify(payload);
  return result;
}

/** 从判题响应里取出 submission_id / interpret_id */
export function detectSubmissionId(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const obj = json as Record<string, unknown>;
  const candidates = ['submission_id', 'interpret_id', 'task_id'];
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

const PENDING_STATES = new Set(['PENDING', 'STARTED', 'QUEUED', 'RUNNING']);

/**
 * 归一化判题结果；若仍在队列中（PENDING/STARTED）返回 undefined。
 */
export function detectJudgeResult(json: unknown): NormalizedJudgeResult | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const obj = json as Record<string, unknown>;
  const state = typeof obj.state === 'string' ? obj.state : undefined;
  const statusMsg = typeof obj.status_msg === 'string' ? obj.status_msg : undefined;
  // 只有既没有 state 也没有 status_msg 的响应不是判题结果
  if (!state && !statusMsg) return undefined;
  if (state && PENDING_STATES.has(state.toUpperCase())) return undefined;

  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : undefined;

  const normalized: NormalizedJudgeResult = {
    state,
    statusMsg,
    statusCode: typeof obj.status_code === 'number' ? obj.status_code : undefined,
    runSuccess: typeof obj.run_success === 'boolean' ? obj.run_success : undefined,
    totalCorrect: numberOr(obj.total_correct),
    totalTestcases: numberOr(obj.total_testcases),
    codeAnswer: strArray(obj.code_answer),
    expectedCodeAnswer: strArray(obj.expected_code_answer),
    stdOutput: strArray(obj.std_output),
    codeOutput: strArray(obj.code_output),
    compareResult: typeof obj.compare_result === 'string' ? obj.compare_result : undefined,
    runtimeError: nonEmptyString(obj.runtime_error),
    compileError: nonEmptyString(obj.compile_error),
    fullCompileError: nonEmptyString(obj.full_compile_error),
    fullRuntimeError: nonEmptyString(obj.full_runtime_error),
    lastTestcase: typeof obj.last_testcase === 'string' ? obj.last_testcase : undefined,
    runtimePercentile: numberOr(obj.runtime_percentile),
    memoryPercentile: numberOr(obj.memory_percentile),
    submissionId: detectSubmissionId(obj),
    elapsedTime: numberOr(obj.elapsed_time),
    raw: json,
  };
  return normalized;
}

function numberOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 把判题结果渲染成适合输出面板的文本行。 */
export function formatJudgeResult(kind: JudgeKind, r: NormalizedJudgeResult): string[] {
  const lines: string[] = [];
  const title = kind === 'run' ? '运行结果（LeetCode 官方判题）' : '提交结果（LeetCode 官方判题）';
  lines.push(title);
  if (r.statusMsg) lines.push(`  结论：${r.statusMsg}`);
  if (r.state && r.state !== 'SUCCESS') lines.push(`  状态：${r.state}`);
  if (typeof r.totalCorrect === 'number' && typeof r.totalTestcases === 'number') {
    lines.push(`  通过用例：${r.totalCorrect}/${r.totalTestcases}`);
  }
  if (r.compareResult) {
    const passed = (r.compareResult.match(/1/g) ?? []).length;
    const total = r.compareResult.length;
    lines.push(`  用例比对：${r.compareResult}（${passed}/${total}）`);
  }
  if (typeof r.runtimePercentile === 'number') lines.push(`  耗时击败：${r.runtimePercentile.toFixed(2)}%`);
  if (typeof r.memoryPercentile === 'number') lines.push(`  内存击败：${r.memoryPercentile.toFixed(2)}%`);
  if (r.compileError) lines.push(`  编译错误：${firstLines(r.compileError, 6)}`);
  if (r.fullCompileError) lines.push(`  编译详情：\n${firstLines(r.fullCompileError, 12)}`);
  if (r.runtimeError) lines.push(`  运行时错误：${firstLines(r.runtimeError, 6)}`);
  if (r.fullRuntimeError) lines.push(`  错误详情：\n${firstLines(r.fullRuntimeError, 12)}`);
  if (r.lastTestcase) lines.push(`  最后执行的用例：${firstLines(r.lastTestcase, 4)}`);
  if (r.codeAnswer?.length) lines.push(`  实际输出：${r.codeAnswer.join(' | ')}`);
  if (r.expectedCodeAnswer?.length) lines.push(`  期望输出：${r.expectedCodeAnswer.join(' | ')}`);
  if (r.stdOutput?.some((s) => s && s.length)) lines.push(`  标准输出：${r.stdOutput.filter(Boolean).join(' | ')}`);
  return lines;
}

function firstLines(s: string, n: number): string {
  const parts = s.split('\n');
  return parts.slice(0, n).join('\n').trim();
}

/**
 * 站点内部有时会用 `"https://" + location.host + path` 拼资源地址；
 * 内嵌到 http 代理源后这种地址会变成 `https://127.0.0.1:PORT/...` 从而 SSL 失败。
 * 这里把「指向我们自己但不是 http」的地址纠正回 http。
 */
export function fixSelfProtocol(url: string, selfHost: string, proxyOrigin: string): string {
  if (!url) return url;
  try {
    const u = new URL(url, proxyOrigin);
    if (u.host !== selfHost) return url;
    if (u.protocol !== 'https:') return url;
    return `${proxyOrigin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}


export type LinkRoute = { kind: 'self'; href: string } | { kind: 'external'; href: string } | { kind: 'ignore' };

/**
 * 决定一次链接点击/`window.open` 应该怎么处理。
 *
 * 背景：站点不少入口（学习计划里的题目行、题解按钮）用的是 `window.open(...)` 弹新窗口，
 * 而 VS Code / Cursor 的 webview iframe 里 popup 会被直接拦掉——表现就是「点了没反应」。
 * 同站（同一个本地代理源）的链接应该改成在当前面板内跳转；真正的外部链接交给系统浏览器。
 */
export function classifyLink(url: string | null | undefined, pageHref: string, mode: 'popup' | 'anchor' = 'popup'): LinkRoute {
  if (!url) return { kind: 'ignore' };
  let resolved: URL;
  let page: URL;
  try {
    page = new URL(pageHref);
    resolved = new URL(url, pageHref);
  } catch {
    return { kind: 'ignore' };
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    // javascript: / mailto: 之类一律不接管
    return { kind: 'ignore' };
  }
  if (resolved.host === page.host) {
    // 只接管「页面级」跳转；下载类链接保持原样
    if (/\.(zip|pdf|png|jpe?g|gif|svg|txt|json|md)$/i.test(resolved.pathname) && mode === 'anchor') {
      return { kind: 'ignore' };
    }
    return { kind: 'self', href: resolved.href };
  }
  return { kind: 'external', href: resolved.href };
}
