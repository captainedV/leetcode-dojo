/**
 * 站点适配：所有与 LeetCode 域名 / 端点相关的常量集中在这里。
 * 端点信息来自 leetcode.cn 前端产物（已核对）：
 *   POST /problems/{slug}/interpret_solution/ → {interpret_id}
 *   GET  /submissions/detail/{id}/check/       → 判题结果
 *   POST /problems/{slug}/submit/              → {submission_id}
 */
export type SiteId = 'leetcode.cn' | 'leetcode.com';

export interface SiteConfig {
  id: SiteId;
  host: string;
  origin: string;
  /** GraphQL 端点（相对） */
  graphql: string;
  /** 站点是否能被内嵌到 IDE 面板（.com 有 Cloudflare 挑战 + X-Frame-Options） */
  embeddable: boolean;
  /** 是否支持「内嵌网页里登录」 */
  webLogin: boolean;
  /** 附带说明 */
  note?: string;
  endpoints: {
    run: (titleSlug: string) => string;
    submit: (titleSlug: string) => string;
    check: (id: string) => string;
    checkV2: (id: string) => string;
    session: () => string;
  };
  /** 语言在 localStorage 里的键 */
  langStorageKeys: string[];
  /** 会话 cookie 名 */
  sessionCookie: string;
  csrfCookie: string;
}

export const SITES: Record<SiteId, SiteConfig> = {
  'leetcode.cn': {
    id: 'leetcode.cn',
    host: 'leetcode.cn',
    origin: 'https://leetcode.cn',
    graphql: '/graphql/',
    embeddable: true,
    webLogin: true,
    endpoints: {
      run: (slug) => `/problems/${slug}/interpret_solution/`,
      submit: (slug) => `/problems/${slug}/submit/`,
      check: (id) => `/submissions/detail/${id}/check/`,
      checkV2: (id) => `/submissions/detail/${id}/v2/check/`,
      session: () => '/session/',
    },
    langStorageKeys: ['global_lang', 'lang'],
    sessionCookie: 'LEETCODE_SESSION',
    csrfCookie: 'csrftoken',
  },
  'leetcode.com': {
    id: 'leetcode.com',
    host: 'leetcode.com',
    origin: 'https://leetcode.com',
    graphql: '/graphql/',
    embeddable: false,
    // Cloudflare 会对 Node 发出的文档请求返回 403 challenge，也无法绕过 X-Frame-Options
    webLogin: false,
    note: 'leetcode.com 由 Cloudflare 保护，本地代理拿不到文档且禁止内嵌；请改用 leetcode.cn，或粘贴已登录的 Cookie 走 API 模式。',
    endpoints: {
      run: (slug) => `/problems/${slug}/interpret_solution/`,
      submit: (slug) => `/problems/${slug}/submit/`,
      check: (id) => `/submissions/detail/${id}/check/`,
      checkV2: (id) => `/submissions/detail/${id}/v2/check/`,
      session: () => '/session/',
    },
    langStorageKeys: ['global_lang', 'lang'],
    sessionCookie: 'LEETCODE_SESSION',
    csrfCookie: 'csrftoken',
  },
};

export function getSite(id: string | undefined): SiteConfig {
  const key = (id ?? 'leetcode.cn') as SiteId;
  return SITES[key] ?? SITES['leetcode.cn'];
}

/** 从 URL 路径解析题目 slug：/problems/two-sum/ → two-sum */
export function slugFromPath(pathname: string): string | undefined {
  const m = /^\/problems\/([a-zA-Z0-9-]+)(?:\/|$)/.exec(pathname);
  return m ? m[1] : undefined;
}

/** 从 URL 路径解析提交/运行详情页 id */
export function submissionIdFromPath(pathname: string): string | undefined {
  const m = /^\/submissions\/detail\/(\d+)/.exec(pathname);
  return m ? m[1] : undefined;
}
