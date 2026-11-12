/**
 * LeetCode 客户端（走本地 CookieJar 的登录态，从扩展宿主直接调用站点接口）。
 *
 * 用途：
 *  - 拉题目数据（GraphQL）：题面、codeSnippets、metaData、exampleTestcases；
 *  - 「官方运行 / 提交」的**直连通道**：浏览器不参与也能判题（用于 leetcode.com 的 API 模式，
 *    以及内嵌页面桥接失效时的兜底）；
 *  - 轮询判题结果。
 *
 * 端点依据 leetcode.cn 前端产物核对（见 core/site.ts）。
 */
import type { CookieJar } from '../proxy/cookies.js';
import type { SiteConfig } from '../core/site.js';
import type { LcQuestion } from '../core/types.js';
import type { NormalizedJudgeResult } from '../bridge/protocol.js';
import { detectJudgeResult, detectSubmissionId } from '../bridge/judge.js';

export interface LcClientOptions {
  site: SiteConfig;
  jar: CookieJar;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

export interface ProblemsetItem {
  titleSlug: string;
  title: string;
  frontendId: string;
  difficulty: string;
  paidOnly?: boolean;
}

const QUESTION_QUERY = `query questionData($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionId
    questionFrontendId
    title
    titleSlug
    translatedTitle
    difficulty
    content
    exampleTestcases
    metaData
    sampleTestCase
    hints
    isPaidOnly
    codeSnippets { lang langSlug code }
  }
}`;

const PROBLEMSET_QUERY = `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList: questionList(
    categorySlug: $categorySlug
    limit: $limit
    skip: $skip
    filters: $filters
  ) {
    total: totalNum
    questions: data {
      frontendQuestionId: questionFrontendId
      title
      titleSlug
      paidOnly: isPaidOnly
      difficulty
    }
  }
}`;

export class LcClient {
  constructor(private opts: LcClientOptions) {}

  get site(): SiteConfig {
    return this.opts.site;
  }

  get jar(): CookieJar {
    return this.opts.jar;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const { site, jar } = this.opts;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      origin: site.origin,
      referer: `${site.origin}/problemset/`,
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    const csrf = jar.csrfToken();
    if (csrf) headers['x-csrftoken'] = csrf;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    return fetchImpl(`${site.origin}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
  }

  async graphql<T>(query: string, variables: Record<string, unknown>, operationName?: string): Promise<T> {
    const body = JSON.stringify({ query, variables, operationName });
    const res = await this.request(this.site.graphql, { method: 'POST', body });
    const text = await res.text();
    if (res.status === 403 && /Just a moment|challenge/i.test(text)) {
      throw new Error(`${this.site.host} 返回 Cloudflare 验证，无法从扩展宿主直连。请改用内嵌网页登录。`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`GraphQL 响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    const obj = json as { data?: T; errors?: Array<{ message?: string }> };
    if (obj.errors?.length) {
      throw new Error(`GraphQL 错误：${obj.errors.map((e) => e.message ?? '未知').join('; ')}`);
    }
    if (!obj.data) throw new Error(`GraphQL 无数据（HTTP ${res.status}）`);
    return obj.data;
  }

  async fetchQuestion(titleSlug: string): Promise<LcQuestion> {
    const data = await this.graphql<{ question: LcQuestion | null }>(QUESTION_QUERY, { titleSlug }, 'questionData');
    if (!data.question) throw new Error(`题目不存在：${titleSlug}`);
    return data.question;
  }

  async fetchProblemset(limit = 200, skip = 0): Promise<ProblemsetItem[]> {
    const data = await this.graphql<{
      problemsetQuestionList: { total: number; questions: Array<Record<string, unknown>> };
    }>(PROBLEMSET_QUERY, { categorySlug: '', skip, limit, filters: {} }, 'problemsetQuestionList');
    const list = data.problemsetQuestionList?.questions ?? [];
    return list.map((q) => ({
      titleSlug: String(q.titleSlug ?? ''),
      title: String(q.title ?? ''),
      frontendId: String(q.frontendQuestionId ?? ''),
      difficulty: String(q.difficulty ?? ''),
      paidOnly: Boolean(q.paidOnly),
    }));
  }

  /** LeetCode 官方「运行」：只跑示例用例。 */
  async run(
    titleSlug: string,
    questionId: string,
    lang: string,
    code: string,
    dataInput: string,
  ): Promise<{ submissionId: string }> {
    await this.ensureSignedIn('运行');
    const res = await this.request(this.site.endpoints.run(titleSlug), {
      method: 'POST',
      body: JSON.stringify({ lang, question_id: questionId, typed_code: code, data_input: dataInput }),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error('未登录或登录已失效，请在左侧网页里重新登录。');
    }
    if (res.status === 429) {
      throw new Error('触发 LeetCode 频率限制，请稍后再试。');
    }
    const json = safeJson(text);
    const id = detectSubmissionId(json);
    if (!id) throw new Error(`运行请求失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
    return { submissionId: id };
  }

  /** LeetCode 官方提交。 */
  async submit(titleSlug: string, questionId: string, lang: string, code: string): Promise<{ submissionId: string }> {
    await this.ensureSignedIn('提交');
    const res = await this.request(this.site.endpoints.submit(titleSlug), {
      method: 'POST',
      body: JSON.stringify({ lang, question_id: questionId, typed_code: code }),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error('未登录或登录已失效，请在左侧网页里重新登录。');
    }
    if (res.status === 429) {
      throw new Error('触发 LeetCode 频率限制，请稍后再试。');
    }
    const json = safeJson(text);
    const id = detectSubmissionId(json);
    if (!id) throw new Error(`提交请求失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
    return { submissionId: id };
  }

  /** 轮询判题结果 */
  async pollResult(
    submissionId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<NormalizedJudgeResult> {
    const timeoutMs = opts.timeoutMs ?? 60000;
    const intervalMs = opts.intervalMs ?? 900;
    const started = Date.now();
    let lastError: string | undefined;
    while (Date.now() - started < timeoutMs) {
      for (const path of [this.site.endpoints.check(submissionId), this.site.endpoints.checkV2(submissionId)]) {
        try {
          const res = await this.request(path, { method: 'GET' });
          if (!res.ok) continue;
          const json = safeJson(await res.text());
          const parsed = detectJudgeResult(json);
          if (parsed) return parsed;
        } catch (err) {
          lastError = (err as Error).message;
        }
      }
      await delay(intervalMs);
    }
    throw new Error(`判题结果超时（${timeoutMs}ms）${lastError ? `：${lastError}` : ''}`);
  }

  /** 检查是否已登录（尽量不额外发请求：只看 cookie；必要时查 /session/） */
  async ensureSignedIn(action: string): Promise<void> {
    if (this.jar.isSignedIn()) return;
    throw new Error(`当前未登录，无法${action}。请在左侧 LeetCode 页面登录后再试。`);
  }

  async refreshSession(): Promise<{ signedIn: boolean; username?: string }> {
    try {
      const res = await this.request(this.site.endpoints.session(), { method: 'GET' });
      if (!res.ok) return { signedIn: this.jar.isSignedIn() };
      const json = safeJson(await res.text()) as Record<string, unknown> | undefined;
      const user = json?.user as Record<string, unknown> | undefined;
      if (user?.isSignedIn) {
        const username = typeof user.username === 'string' ? user.username : undefined;
        return { signedIn: true, username };
      }
      return { signedIn: this.jar.isSignedIn() };
    } catch {
      return { signedIn: this.jar.isSignedIn() };
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
