/**
 * 响应/请求改写规则（纯函数，可单测）。
 *
 * 目标：把 https://leetcode.cn 的文档“搬”到 http://127.0.0.1:PORT 上，同时
 *  - 去掉 X-Frame-Options / CSP（否则无法内嵌、也无法注入脚本）
 *  - 把 Set-Cookie 交给 CookieJar 统一处理（顺便让扩展宿主复用登录态）
 *  - 把重定向改写成本地相对路径（否则 iframe 会跳回真实站点）
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { SiteConfig } from '../core/site.js';

export const LC_INTERNAL_PREFIX = '/__lc/';
export const LC_BRIDGE_PATH = '/__lc/bridge.js';
export const LC_STATUS_PATH = '/__lc/status';
export const LC_LOG_PATH = '/__lc/log';
export const LC_PROBE_PATH = '/__lc/probe';

/** 不应该转发给上游的请求头 */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'accept-encoding',
  'content-length',
  'origin',
  'referer',
  'te',
  'trailer',
]);

/** 不应该回给浏览器的响应头 */
const DROP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'strict-transport-security',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'set-cookie',
  'alt-svc',
]);

export interface RequestHeaderOptions {
  site: SiteConfig;
  /** 当前请求路径（用于构造 referer） */
  path: string;
  cookieHeader?: string;
}

export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  opts: RequestHeaderOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!value) continue;
    const k = key.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(k)) continue;
    if (k === 'cookie') continue; // 统一由 CookieJar 提供
    if (k === 'accept-encoding') continue;
    out[k] = Array.isArray(value) ? value.join(', ') : value;
  }
  out['accept-encoding'] = 'identity';
  out['origin'] = opts.site.origin;
  out['referer'] = opts.site.origin + opts.path;
  const cookie = opts.cookieHeader ?? '';
  if (cookie) out['cookie'] = cookie;
  return out;
}

export interface ResponseHeaderOptions {
  site: SiteConfig;
  /** 是否是有我们自己注入的 HTML（需要 no-store） */
  html?: boolean;
}

/** 处理上游响应头：删掉会破坏内嵌/注入的头，并改写 Location。 */
export function buildBrowserHeaders(
  upstream: Headers,
  opts: ResponseHeaderOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.forEach((value, key) => {
    const k = key.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(k)) return;
    if (k === 'location') {
      out['location'] = rewriteLocation(value, opts.site);
      return;
    }
    out[k] = value;
  });
  if (opts.html) {
    out['cache-control'] = 'no-store, must-revalidate';
    out['content-type'] = out['content-type'] ?? 'text/html; charset=utf-8';
  }
  if (!out['cache-control']) out['cache-control'] = 'no-cache';
  return out;
}

/** 把指向真实站点的绝对 Location 改写为相对路径 */
export function rewriteLocation(location: string, site: SiteConfig): string {
  if (!location) return location;
  try {
    const url = new URL(location, site.origin);
    if (url.host === site.host) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return location;
  } catch {
    return location;
  }
}

export const LC_CDN_PREFIX = '/__lc/cdn/';

/** 需要经代理转发并改写的 CDN 主机（脚本/样式/字体里含绝对 URL，必须改写） */
export const PROXIED_CDN_HOSTS = new Set(['static.leetcode.cn', 'static.leetcode.com']);

export interface UrlRewriteOptions {
  site: SiteConfig;
  proxyOrigin: string;
}

/**
 * 把文本里的「本站绝对 URL」改写成代理地址。
 *
 * 为什么必须做：站点前端会把路由跳转/接口地址写成 `https://leetcode.cn/...` 绝对地址，
 * 内嵌到代理源后会跳出代理（iframe 直接被换页），桥接随之失效。
 * 覆盖三种写法：`https://host`、`https:\/\/host`（JSON in JS）、`//host`（协议相对）。
 */
export function rewriteTextUrls(text: string, opts: UrlRewriteOptions): string {
  if (!text) return text;
  const { site, proxyOrigin } = opts;
  let out = text;

  const replaceHost = (host: string, replacement: string, includeProtocolRelative: boolean): void => {
    const esc = escapeRegExp(host);
    // https://host
    out = out.replace(new RegExp('https://' + esc, 'g'), replacement);
    // https:\/\/host  （JS 字符串/JSON 里的转义写法）
    out = out.replace(new RegExp('https:\\\\/\\\\/' + esc, 'g'), replacement.replace(/\//g, '\\/'));
    if (includeProtocolRelative) {
      // 协议相对 //host（用 lookbehind 避免误伤已经改写过的 http://…）
      // 注意：CDN 主机不做这条改写——站点会用 `"https:" + "//static…"` 拼串，
      // 改写后会拼出 https://127.0.0.1 触发 SSL 错误；CDN 直连本身没问题（CORS *）。
      out = out.replace(new RegExp('(?<![:/\\w])//' + esc, 'g'), replacement);
    }
  };

  replaceHost(site.host, proxyOrigin, true);
  for (const cdnHost of PROXIED_CDN_HOSTS) {
    replaceHost(cdnHost, `${proxyOrigin}${LC_CDN_PREFIX}${cdnHost}`, false);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 哪些响应需要做文本改写 */
export function shouldRewriteText(contentType: string | null): boolean {
  if (!contentType) return false;
  return /text\/(html|css|plain|javascript)|application\/(javascript|json|x-javascript|xml)|image\/svg\+xml/i.test(contentType);
}

export function isHtmlResponse(contentType: string | null): boolean {
  if (!contentType) return false;
  return /text\/html/i.test(contentType);
}

export interface InjectionOptions {
  /** 注入脚本的地址（同源） */
  bridgeSrc?: string;
  /** 额外内联脚本（极少用） */
  inline?: string;
}

/**
 * 向 HTML 注入桥接脚本。放在 <head> 之后、尽量靠前，保证早于站点自身脚本执行
 * （需要抢在站点注册 fetch 之前打补丁）。
 */
export function injectIntoHtml(html: string, opts: InjectionOptions = {}): string {
  const bridgeSrc = opts.bridgeSrc ?? LC_BRIDGE_PATH;
  const tags = [`<script src="${bridgeSrc}" data-lc-local="1"></script>`];
  if (opts.inline) tags.push(`<script data-lc-local="inline">${opts.inline}</script>`);
  const payload = tags.join('');
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${payload}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${payload}</head>`);
  }
  return payload + html;
}

/** 判断上游是不是给我们返回了 Cloudflare 挑战页 */
export function isCloudflareChallenge(status: number, headers: Headers, bodySample: string): boolean {
  if (headers.get('cf-mitigated') === 'challenge') return true;
  if (status === 403 || status === 503) {
    return /Just a moment|cf-mitigated|challenge-platform/i.test(bodySample);
  }
  return false;
}

/** 生成一条给用户看的友好错误页 */
export function challengePageHtml(site: SiteConfig, detail: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>无法在 IDE 内打开 ${site.host}</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:32px;max-width:720px;margin:0 auto;line-height:1.7}
  h1{font-size:20px;margin:0 0 12px}
  code{background:rgba(127,127,127,.18);padding:2px 6px;border-radius:4px}
  ul{padding-left:20px}
  .hint{opacity:.75;font-size:13px;margin-top:24px;border-top:1px solid rgba(127,127,127,.3);padding-top:12px}
</style></head><body>
<h1>无法在 IDE 面板内加载 ${site.host}</h1>
<p>${detail}</p>
<ul>
  <li><b>改用 leetcode.cn</b>：<code>lcLocal.site</code> 设为 <code>leetcode.cn</code>，可在 IDE 内完整登录并刷题。</li>
  <li><b>粘贴 Cookie</b>：在浏览器登录后，把 <code>LEETCODE_SESSION</code> 与 <code>csrftoken</code> 粘到
      「LeetCode: 设置登录 Cookie」命令里，即可用本地 IDE + 官方判题（API 模式）。</li>
</ul>
<div class="hint">诊断：${detail}</div>
</body></html>`;
}

/** 生成 ICP/隐私无侵入的内部首页（当用户直接访问代理根路径时） */
export function internalHomeHtml(port: number, site: SiteConfig): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LeetCode Dojo 代理</title>
<style>body{font-family:-apple-system,sans-serif;padding:24px;line-height:1.6}</style></head><body>
<h1>LeetCode Dojo 本地代理</h1>
<p>代理目标：<code>${site.origin}</code>，监听端口 <code>${port}</code>。</p>
<p>请从 VS Code / Cursor 的「进入 LeetCode 模式」按钮使用，不要直接访问此页面。</p>
</body></html>`;
}
