/**
 * Webview shell：左侧栏的容器页面。
 *  - 顶部一条原生感的工具栏（语言切换 / 本地运行 / 官方运行 / 提交 / 提示）
 *  - 下面是加载本地代理的 iframe（真实 LeetCode 页面）
 *  - 在 iframe（页面源）与扩展宿主之间转发消息
 */
import type { BridgeMessage, HostMessage } from '../bridge/protocol.js';
import type { HostToShell, LangOption, ResultItem, ShellAction, ShellToHost } from './protocol.js';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const frame = document.getElementById('frame') as HTMLIFrameElement;
const titleEl = document.getElementById('title') as HTMLElement;
const subEl = document.getElementById('subtitle') as HTMLElement;
const langSel = document.getElementById('lang') as HTMLSelectElement;
const statusEl = document.getElementById('status') as HTMLElement;
const toastEl = document.getElementById('toast') as HTMLElement;
const bar = document.getElementById('bar') as HTMLElement;
const resultsEl = document.getElementById('results') as HTMLElement;

let ready = false;
let pendingToBridge: HostMessage[] = [];

function send(msg: ShellToHost): void {
  vscode.postMessage(msg);
}

function toast(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  toastEl.textContent = text;
  toastEl.dataset.level = level;
  toastEl.classList.add('show');
  window.setTimeout(() => toastEl.classList.remove('show'), 4200);
}

function setStatus(text: string, level: 'ok' | 'warn' | 'error' | 'busy' = 'ok'): void {
  statusEl.textContent = text;
  statusEl.dataset.level = level;
}

const KIND_ICON: Record<ResultItem['kind'], string> = {
  pass: '✅',
  fail: '❌',
  unknown: '➖',
  info: 'ℹ️',
};

/** 在左栏直接渲染运行/提交结果，避免用户「找不到输出面板」 */
function renderResults(msg: Extract<HostToShell, { type: 'results' }>): void {
  const rows = msg.items ?? [];
  resultsEl.hidden = false;
  resultsEl.dataset.ok = String(msg.ok);
  // 失败时默认展开，成功时折叠（点一下可展开）
  resultsEl.dataset.open = msg.ok ? 'false' : 'true';
  resultsEl.innerHTML = `
    <div class="head" data-role="toggle" title="点击展开/收起">
      <span class="badge">${msg.ok ? '✅' : '❌'} ${escapeHtml(msg.title)}</span>
      <span class="meta">${escapeHtml(msg.detail ?? (msg.source === 'local' ? '本地测试' : 'LeetCode 官方判题'))}</span>
      <span class="spacer"></span>
      <span class="chev">${msg.ok ? '展开' : '收起'}</span>
    </div>
    ${msg.detail ? `<div class="detail">${escapeHtml(msg.detail)}</div>` : ''}
    <div class="body">${rows
      .map((r) => `<div class="row ${r.kind}"><span class="k">${KIND_ICON[r.kind] ?? '•'}</span><span>${escapeHtml(r.text)}</span></div>`)
      .join('')}</div>`;
  const head = resultsEl.querySelector('[data-role="toggle"]');
  head?.addEventListener('click', () => {
    const open = resultsEl.dataset.open === 'true';
    resultsEl.dataset.open = String(!open);
    const chev = resultsEl.querySelector('.chev');
    if (chev) chev.textContent = open ? '展开' : '收起';
  });
  maybeFitStage();
}

function escapeHtml(text: string): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function maybeFitStage(): void {
  // iframe 用 absolute 定位铺满 #stage，结果条会自动挤压 #stage 高度
  void bar.offsetHeight;
}

function fillLangs(langs: LangOption[], current: string): void {
  langSel.innerHTML = '';
  for (const l of langs) {
    const opt = document.createElement('option');
    opt.value = l.slug;
    opt.textContent = l.localHarness ? `${l.label}` : `${l.label}（仅官方判题）`;
    langSel.appendChild(opt);
  }
  langSel.value = current;
}

function toBridge(msg: HostMessage): void {
  const win = frame?.contentWindow;
  if (!win) {
    pendingToBridge.push(msg);
    return;
  }
  win.postMessage(msg, '*');
}

function flushPending(): void {
  const queue = pendingToBridge;
  pendingToBridge = [];
  for (const msg of queue) toBridge(msg);
}

/** 页面里的桥接脚本 → 宿主 */
window.addEventListener('message', (ev) => {
  const data = ev.data as { lcLocal?: boolean } & Record<string, unknown>;
  if (!data || typeof data !== 'object') return;
  if (ev.source === frame?.contentWindow && data.lcLocal) {
    send({ type: 'bridge', msg: data as unknown as BridgeMessage });
    return;
  }
  // 页面整体 reload（登录后跳转等）
  if (ev.source === frame?.contentWindow) {
    ready = false;
    setStatus('页面加载中…', 'busy');
  }
});

/** 宿主 → shell */
window.addEventListener('message', (ev) => {
  const msg = ev.data as HostToShell;
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
  switch (msg.type) {
    case 'init': {
      titleEl.textContent = msg.title || 'LeetCode';
      subEl.textContent = msg.fileName || '';
      fillLangs(msg.langs, msg.lang);
      if (frame.getAttribute('src') !== msg.frameUrl) {
        frame.setAttribute('src', msg.frameUrl);
      }
      setStatus(msg.signedIn ? '已登录' : '未登录', msg.signedIn ? 'ok' : 'warn');
      bar.dataset.harness = msg.harnessNote ? 'limited' : '';
      break;
    }
    case 'state': {
      if (msg.title !== undefined) titleEl.textContent = msg.title || 'LeetCode';
      if (msg.fileName !== undefined) subEl.textContent = msg.fileName;
      if (msg.lang !== undefined && langSel.value !== msg.lang) langSel.value = msg.lang;
      if (msg.signedIn !== undefined) {
        setStatus(msg.signedIn ? `已登录${msg.signedInName ? `：${msg.signedInName}` : ''}` : '未登录', msg.signedIn ? 'ok' : 'warn');
      }
      break;
    }
    case 'bridge': {
      toBridge(msg.msg);
      break;
    }
    case 'reload': {
      ready = false;
      pendingToBridge = [];
      const current = frame.getAttribute('src') ?? '';
      frame.setAttribute('src', 'about:blank');
      window.setTimeout(() => frame.setAttribute('src', current), 60);
      break;
    }
    case 'results': {
      // 结果现在显示在底部面板（LeetCode 面板），左侧不再挤占题面空间
      break;
    }
    case 'toast': {
      toast(msg.text, msg.level ?? 'info');
      break;
    }
    case 'status': {
      setStatus(msg.text, msg.level ?? 'ok');
      break;
    }
    default:
      break;
  }
});

frame.addEventListener('load', () => {
  setStatus('已加载', 'ok');
  flushPending();
});

const focusBtn = document.getElementById('focusBtn');
let focusing = true;
function syncFocusLabel(): void {
  if (focusBtn) focusBtn.textContent = focusing ? '只显示题面' : '显示完整网页';
}
syncFocusLabel();

for (const btn of Array.from(document.querySelectorAll<HTMLElement>('[data-act]'))) {
  btn.addEventListener('click', () => {
    const action = btn.dataset.act as ShellAction;
    if (action === 'toggleFocus') {
      focusing = !focusing;
      syncFocusLabel();
    }
    send({ type: 'action', action });
  });
}

langSel.addEventListener('change', () => {
  send({ type: 'lang', lang: langSel.value });
});

// 让 webview 内的键盘事件不要被 iframe 吃掉：提供一个快捷键透传（Cmd/Ctrl+Alt+Enter → 本地运行）
window.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.altKey) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      send({ type: 'action', action: 'runLocal' });
    } else if (ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      send({ type: 'action', action: 'submit' });
    } else if (ev.key.toLowerCase() === 'h') {
      ev.preventDefault();
      send({ type: 'action', action: 'aiHint' });
    }
  }
});

send({ type: 'ready' });
