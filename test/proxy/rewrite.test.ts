import { describe, expect, it } from 'vitest';
import { CookieJar, parseSetCookie } from '../../src/proxy/cookies.js';
import { getSite } from '../../src/core/site.js';
import {
  buildBrowserHeaders,
  buildUpstreamHeaders,
  challengePageHtml,
  injectIntoHtml,
  isCloudflareChallenge,
  isHtmlResponse,
  rewriteLocation,
} from '../../src/proxy/rewrite.js';

const cn = getSite('leetcode.cn');
const com = getSite('leetcode.com');

describe('CookieJar', () => {
  it('吸收上游 Set-Cookie 并生成请求头，Domain/Secure 被去掉', () => {
    const jar = new CookieJar(cn);
    jar.absorbSetCookie([
      'LEETCODE_SESSION=abc123; Domain=.leetcode.cn; Path=/; Secure; SameSite=None; HttpOnly',
      'csrftoken=tok; Path=/',
    ]);
    expect(jar.header()).toContain('LEETCODE_SESSION=abc123');
    expect(jar.header()).toContain('csrftoken=tok');
    expect(jar.isSignedIn()).toBe(true);
    expect(jar.csrfToken()).toBe('tok');
    const cookies = jar.toBrowserSetCookie();
    expect(cookies).toHaveLength(2);
    for (const c of cookies) {
      expect(c).not.toContain('Domain=');
      expect(c).not.toContain('Secure');
      expect(c).not.toContain('SameSite=None');
    }
  });

  it('过期 cookie 会被删除', () => {
    const jar = new CookieJar(cn);
    jar.set('a', '1');
    jar.absorbSetCookie(['a=1; Max-Age=0']);
    expect(jar.get('a')).toBeUndefined();
  });

  it('parseSetCookie 处理 Expires 与非法输入', () => {
    const p = parseSetCookie('x=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; HttpOnly');
    expect(p?.name).toBe('x');
    expect(p?.httpOnly).toBe(true);
    expect(p?.expires).toBeGreaterThan(Date.now());
    expect(parseSetCookie('garbage')).toBeUndefined();
  });

  it('可以持久化并恢复', () => {
    const jar = new CookieJar(cn);
    jar.absorbSetCookie(['LEETCODE_SESSION=s1', 'csrftoken=c1']);
    const snapshot = jar.toJSON();
    const restored = new CookieJar(cn);
    restored.loadJSON(snapshot);
    expect(restored.header()).toBe(jar.header());
  });
});

describe('请求/响应头改写', () => {
  it('剥掉 host/accept-encoding，补上 origin/referer/cookie', () => {
    const headers = buildUpstreamHeaders(
      {
        host: '127.0.0.1:1234',
        'accept-encoding': 'gzip, br',
        'user-agent': 'Mozilla/5.0',
        cookie: 'leak=1',
        'content-type': 'application/json',
      },
      { site: cn, path: '/problems/two-sum/', cookieHeader: 'LEETCODE_SESSION=abc' },
    );
    expect(headers.host).toBeUndefined();
    expect(headers['accept-encoding']).toBe('identity');
    expect(headers.origin).toBe('https://leetcode.cn');
    expect(headers.referer).toBe('https://leetcode.cn/problems/two-sum/');
    expect(headers.cookie).toBe('LEETCODE_SESSION=abc');
    expect(headers['user-agent']).toBe('Mozilla/5.0');
    expect(headers['content-type']).toBe('application/json');
  });

  it('响应头去掉禁止内嵌的字段并改写 Location', () => {
    const upstream = new Headers({
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'none'",
      'cross-origin-opener-policy': 'same-origin',
      'set-cookie': 'a=b',
      location: 'https://leetcode.cn/problemset/',
      'content-length': '999',
    });
    const out = buildBrowserHeaders(upstream, { site: cn, html: true });
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-security-policy']).toBeUndefined();
    expect(out['cross-origin-opener-policy']).toBeUndefined();
    expect(out['set-cookie']).toBeUndefined();
    expect(out['content-length']).toBeUndefined();
    expect(out.location).toBe('/problemset/');
    expect(out['cache-control']).toContain('no-store');
  });

  it('rewriteLocation 只改写本站域名', () => {
    expect(rewriteLocation('https://leetcode.cn/problemset/?a=1#x', cn)).toBe('/problemset/?a=1#x');
    expect(rewriteLocation('/already/relative', cn)).toBe('/already/relative');
    expect(rewriteLocation('https://static.leetcode.cn/x.js', cn)).toBe('https://static.leetcode.cn/x.js');
  });

  it('isHtmlResponse 只认 text/html', () => {
    expect(isHtmlResponse('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlResponse('application/json')).toBe(false);
    expect(isHtmlResponse(null)).toBe(false);
  });
});

describe('HTML 注入', () => {
  it('插到 <head> 之后，早于站点自身脚本', () => {
    const html = '<html><head><script id="__NEXT_DATA__"></script></head><body></body></html>';
    const out = injectIntoHtml(html, { bridgeSrc: '/__lc/bridge.js' });
    const idxBridge = out.indexOf('/__lc/bridge.js');
    const idxNext = out.indexOf('__NEXT_DATA__');
    expect(idxBridge).toBeGreaterThan(-1);
    expect(idxBridge).toBeLessThan(idxNext);
    expect(out).toContain('data-lc-local="1"');
  });

  it('没有 head 时也能注入', () => {
    expect(injectIntoHtml('<html><body>x</body></html>')).toContain('<head>');
  });
});

describe('Cloudflare 挑战识别', () => {
  it('识别 cf-mitigated 头', () => {
    const h = new Headers({ 'cf-mitigated': 'challenge' });
    expect(isCloudflareChallenge(403, h, '')).toBe(true);
  });

  it('识别 Just a moment 页面', () => {
    expect(isCloudflareChallenge(403, new Headers(), '<title>Just a moment...</title>')).toBe(true);
    expect(isCloudflareChallenge(200, new Headers(), '<html>ok</html>')).toBe(false);
  });

  it('生成带指引的错误页', () => {
    const html = challengePageHtml(com, 'Cloudflare 403');
    expect(html).toContain('leetcode.cn');
    expect(html).toContain('LEETCODE_SESSION');
  });
});
