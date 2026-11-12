/**
 * 内嵌网页用的本地反向代理。
 *
 * 职责：
 *  1. 把 https://leetcode.cn/* 映射到 http://127.0.0.1:PORT/*，并去掉禁止内嵌的响应头；
 *  2. 双向维护 Cookie（浏览器的登录态 → CookieJar → 扩展宿主可直接复用）；
 *  3. 往 HTML 里注入桥接脚本（src/bridge/bridge.ts 编译产物）。
 *
 * 注意：静态资源（static.leetcode.cn，带 CORS:*）由浏览器直连 CDN，不经过这里，
 * 因为站点前端的接口调用全部是相对路径（同源），代理只需覆盖文档与同源 API。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';
import type { SiteConfig } from '../core/site.js';
import type { CookieJar } from './cookies.js';
import {
  LC_BRIDGE_PATH,
  LC_CDN_PREFIX,
  LC_LOG_PATH,
  LC_PROBE_PATH,
  LC_STATUS_PATH,
  PROXIED_CDN_HOSTS,
  buildBrowserHeaders,
  buildUpstreamHeaders,
  challengePageHtml,
  injectIntoHtml,
  internalHomeHtml,
  isCloudflareChallenge,
  isHtmlResponse,
  rewriteTextUrls,
  shouldRewriteText,
} from './rewrite.js';

export interface ProxyOptions {
  site: SiteConfig;
  jar: CookieJar;
  /** 端口，0 = 自动分配 */
  port?: number;
  /** bridge.js 的绝对路径 */
  bridgeScriptPath: string;
  injectBridge: boolean;
  log: (line: string) => void;
  /** 桥接脚本上报的日志 */
  onBridgeLog?: (payload: unknown) => void;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

export class LeetCodeProxy {
  private server?: Server;
  private boundPort = 0;
  private bridgeSource = '';
  /** 待删除的浏览器 cookie（退出登录时用，一次生效） */
  private pendingCookieDeletions: string[] = [];
  private cdnCache = new Map<
    string,
    { status: number; headers: Record<string, string | string[]>; body: Buffer; ts: number }
  >();

  constructor(private opts: ProxyOptions) {}

  /** 让浏览器删除这些 cookie（下次响应时下发 Max-Age=0） */
  scheduleBrowserCookieClear(names: string[]): void {
    this.pendingCookieDeletions = [...new Set([...this.pendingCookieDeletions, ...names])];
  }

  get port(): number {
    return this.boundPort;
  }

  origin(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  url(pathname = '/'): string {
    return `${this.origin()}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;
    try {
      this.bridgeSource = await readFile(this.opts.bridgeScriptPath, 'utf8');
    } catch (err) {
      this.opts.log(`[proxy] 读取 bridge.js 失败：${(err as Error).message}（将不注入桥接脚本）`);
      this.bridgeSource = '';
    }
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket as Socket));
    const preferred = this.opts.port ?? 0;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(preferred, '127.0.0.1', () => resolve());
      });
    } catch (err) {
      if (!preferred) throw err;
      // 持久化的端口被占用：退回随机端口（会话仍可用，只是站点的 localStorage 会换源）
      this.opts.log(`[proxy] 端口 ${preferred} 不可用（${(err as Error).message}），改用随机端口`);
      server.removeAllListeners('error');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
    }
    const addr = server.address();
    this.boundPort = typeof addr === 'object' && addr ? addr.port : 0;
    this.server = server;
    this.opts.log(`[proxy] 已启动 ${this.origin()} → ${this.opts.site.origin}`);
    return this.boundPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.opts.log('[proxy] 已停止');
  }

  // ---------------------------------------------------------------- 请求处理

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(req.url ?? '/', this.origin());
    } catch {
      this.reply(res, 400, 'text/plain', 'bad request');
      return;
    }
    const pathname = url.pathname;

    if (pathname === LC_BRIDGE_PATH) {
      this.reply(res, 200, 'application/javascript; charset=utf-8', this.bridgeSource, { 'cache-control': 'no-store' });
      return;
    }
    if (pathname === LC_STATUS_PATH) {
      const body = JSON.stringify({
        ok: true,
        site: this.opts.site.id,
        origin: this.origin(),
        signedIn: this.opts.jar.isSignedIn(),
        cookies: this.opts.jar.summary(),
        injectBridge: this.opts.injectBridge && this.bridgeSource.length > 0,
      });
      this.reply(res, 200, 'application/json', body);
      return;
    }
    if (pathname === LC_PROBE_PATH) {
      this.reply(res, 200, 'application/json', JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    if (pathname === LC_LOG_PATH) {
      const body = await readBody(req);
      try {
        this.opts.onBridgeLog?.(JSON.parse(body.toString('utf8')));
      } catch {
        this.opts.onBridgeLog?.({ raw: body.toString('utf8').slice(0, 2000) });
      }
      this.reply(res, 200, 'text/plain', 'ok');
      return;
    }
    const cdn = /^\/__lc\/cdn\/([a-z0-9.-]+)(\/.*)?$/i.exec(pathname);
    if (cdn) {
      const host = cdn[1].toLowerCase();
      if (!PROXIED_CDN_HOSTS.has(host)) {
        this.reply(res, 404, 'text/plain', 'cdn host not proxied');
        return;
      }
      try {
        await this.forward(req, res, url, started, { host, path: cdn[2] || '/' });
      } catch (err) {
        this.opts.log(`[proxy] CDN ${host}${cdn[2]} 失败：${(err as Error).message}`);
        this.reply(res, 502, 'text/plain', 'cdn fetch failed');
      }
      return;
    }

    if (pathname.startsWith('/__lc/')) {
      this.reply(res, 404, 'text/plain', 'not found');
      return;
    }

    try {
      await this.forward(req, res, url, started);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.opts.log(`[proxy] ${req.method} ${url.pathname} 失败：${msg}`);
      const html = challengePageHtml(this.opts.site, `代理请求失败：${escapeHtml(msg)}`);
      this.reply(res, 502, 'text/html; charset=utf-8', html);
    }
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    started: number,
    target?: { host: string; path: string },
  ): Promise<void> {
    const site = this.opts.site;
    const method = (req.method ?? 'GET').toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const body = hasBody ? await readBody(req) : undefined;

    const headers = buildUpstreamHeaders(req.headers, {
      site,
      path: `${url.pathname}${url.search}`,
      cookieHeader: this.opts.jar.header(),
    });

    const targetPath = target ? `${target.path}${url.search}` : `${url.pathname}${url.search}`;
    const upstreamUrl = target ? `https://${target.host}${targetPath}` : `${site.origin}${targetPath}`;
    const isCdn = !!target;
    const cacheKey = isCdn ? upstreamUrl : '';
    if (isCdn) {
      const cached = this.cdnCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < 1000 * 60 * 30) {
        this.writeHead(res, cached.status, { ...cached.headers });
        res.end(cached.body);
        return;
      }
    }
    const init: RequestInit = {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    };
    if (body && body.length) init.body = new Uint8Array(body);

    const upstream = await fetch(upstreamUrl, init);
    const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
    if (setCookies.length) this.opts.jar.absorbSetCookie(setCookies);

    const contentType = upstream.headers.get('content-type');
    let raw = Buffer.from(await upstream.arrayBuffer());

    if (isCloudflareChallenge(upstream.status, upstream.headers, raw.subarray(0, 4096).toString('utf8'))) {
      const html = challengePageHtml(
        site,
        `${site.host} 返回了 Cloudflare 人机验证（HTTP ${upstream.status}），代理无法在 IDE 内绕过。`,
      );
      this.opts.log(`[proxy] ${method} ${url.pathname} → Cloudflare challenge (${upstream.status})`);
      this.reply(res, 200, 'text/html; charset=utf-8', html);
      return;
    }

    const wantInject = !isCdn && this.opts.injectBridge && this.bridgeSource.length > 0 && isHtmlResponse(contentType);
    let out = raw;
    if (wantInject) {
      out = Buffer.from(injectIntoHtml(raw.toString('utf8'), { bridgeSrc: LC_BRIDGE_PATH }), 'utf8');
    }
    // 文本资源统一改写绝对 URL（这是「页面不要跳出代理」的关键）
    if (shouldRewriteText(contentType) && raw.length < 12 * 1024 * 1024) {
      let text = out.toString('utf8');
      if (wantInject) text = rewriteTextUrls(text, { site, proxyOrigin: this.origin() });
      else if (isCdn || /json|javascript|css|svg/i.test(contentType ?? '')) {
        text = rewriteTextUrls(text, { site, proxyOrigin: this.origin() });
      }
      out = Buffer.from(text, 'utf8');
    }

    const browserHeaders: Record<string, string | string[]> = buildBrowserHeaders(upstream.headers, {
      site,
      html: wantInject,
    });
    const browserCookies = this.opts.jar.toBrowserSetCookie();
    if (this.pendingCookieDeletions.length) {
      for (const name of this.pendingCookieDeletions) {
        browserCookies.push(`${name}=; Path=/; Max-Age=0; SameSite=Lax`);
      }
      this.opts.log(`[proxy] 已通知浏览器删除 cookie：${this.pendingCookieDeletions.join(', ')}`);
      this.pendingCookieDeletions = [];
    }
    if (browserCookies.length) browserHeaders['set-cookie'] = browserCookies;
    if (isCdn && upstream.status === 200 && shouldRewriteText(contentType) && out.length < 4 * 1024 * 1024) {
      this.cacheCdn(cacheKey, upstream.status, browserHeaders, out);
    }
    this.writeHead(res, upstream.status, browserHeaders);
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(out);
    if (process.env.LC_LOCAL_DEBUG) {
      this.opts.log(
        `[proxy] ${method} ${url.pathname}${url.search} → ${upstream.status} ${out.length}B ${Date.now() - started}ms`,
      );
    }
  }

  /** 原始 TCP 隧道：用于站点可能用到的 WebSocket（例如远程 LSP）。 */
  private handleUpgrade(req: IncomingMessage, socket: Socket): void {
    const site = this.opts.site;
    const url = req.url ?? '/';
    const upstream = tlsConnect({ host: site.host, servername: site.host, port: 443 }, () => {
      const lines = [`GET ${url} HTTP/1.1`, `Host: ${site.host}`];
      const cookie = this.opts.jar.header();
      for (const [k, v] of Object.entries(req.headers)) {
        if (!v || HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'host') continue;
        if (k.toLowerCase() === 'cookie') continue;
        lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      if (cookie) lines.push(`Cookie: ${cookie}`);
      lines.push('', '');
      upstream.write(lines.join('\r\n'));
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }

  private cacheCdn(
    key: string,
    status: number,
    headers: Record<string, string | string[]>,
    body: Buffer,
  ): void {
    if (this.cdnCache.size > 200) {
      const oldest = [...this.cdnCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 50);
      for (const [k] of oldest) this.cdnCache.delete(k);
    }
    this.cdnCache.set(key, { status, headers, body, ts: Date.now() });
  }

  // ---------------------------------------------------------------- 工具

  private writeHead(res: ServerResponse, status: number, headers: Record<string, string | string[]>): void {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      try {
        res.setHeader(k, v);
      } catch {
        /* 忽略非法头 */
      }
    }
    res.statusCode = status;
  }

  private reply(
    res: ServerResponse,
    status: number,
    contentType: string,
    body: string,
    extra: Record<string, string> = {},
  ): void {
    res.statusCode = status;
    res.setHeader('content-type', contentType);
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    if (status === 204) {
      res.end();
      return;
    }
    res.end(body);
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export { internalHomeHtml };
