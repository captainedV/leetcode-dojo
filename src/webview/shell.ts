/**
 * Webview shell：左侧栏的容器页面。
 *  - 顶部一条紧凑优雅的原生感工具栏（导航 / 题目与难度徽章 / 语言 / 运行提交 / 布局控制 / 更多菜单）
 *  - 细流光进度条 + 底部是加载本地代理的 iframe（真实 LeetCode 页面）
 *  - 在 iframe（页面源）与扩展宿主之间转发消息
 */
import type { BridgeMessage, HostMessage } from '../bridge/protocol.js';
import type { HostToShell, LangOption, ShellAction, ShellToHost } from './protocol.js';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const frame = document.getElementById('frame') as HTMLIFrameElement;
const titleEl = document.getElementById('title') as HTMLElement;
const diffBadgeEl = document.getElementById('diffBadge') as HTMLElement;
const subEl = document.getElementById('subtitle') as HTMLElement;
const langSel = document.getElementById('lang') as HTMLSelectElement;
const statusEl = document.getElementById('status') as HTMLElement;
const statusTextEl = document.getElementById('statusText') as HTMLElement;
const loaderEl = document.getElementById('loader') as HTMLElement;
const toastEl = document.getElementById('toast') as HTMLElement;
const toastIconEl = document.getElementById('toastIcon') as HTMLElement;
const toastTextEl = document.getElementById('toastText') as HTMLElement;
const toastCloseEl = document.getElementById('toastClose') as HTMLElement;
const bar = document.getElementById('bar') as HTMLElement;
const focusBtn = document.getElementById('focusBtn') as HTMLElement | null;
const focusLabel = document.getElementById('focusLabel') as HTMLElement | null;
const moreBtn = document.getElementById('moreBtn') as HTMLElement | null;
const moreMenu = document.getElementById('moreMenu') as HTMLElement | null;

let pendingToBridge: HostMessage[] = [];
let toastTimer: number | undefined;
let focusing = true;

function send(msg: ShellToHost): void {
  vscode.postMessage(msg);
}

const TOAST_ICONS: Record<'info' | 'warn' | 'error', string> = {
  info: '✦',
  warn: '⚠',
  error: '✕',
};

function toast(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastIconEl.textContent = TOAST_ICONS[level];
  toastTextEl.textContent = text;
  toastEl.dataset.level = level;
  toastEl.classList.add('show');
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('show');
  }, 4600);
}

toastCloseEl?.addEventListener('click', () => {
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastEl.classList.remove('show');
});

function setBusy(busy: boolean): void {
  loaderEl?.classList.toggle('is-busy', busy);
}

function setStatus(text: string, level: 'ok' | 'warn' | 'error' | 'busy' = 'ok'): void {
  if (statusTextEl) statusTextEl.textContent = text;
  statusEl.dataset.level = level;
  setBusy(level === 'busy');
}

function syncFocusState(value?: boolean): void {
  if (typeof value === 'boolean') focusing = value;
  focusBtn?.classList.toggle('is-active', focusing);
  if (focusLabel) {
    focusLabel.textContent = focusing ? '专注题面' : '完整网页';
  }
  if (focusBtn) {
    focusBtn.title = focusing
      ? '当前仅展示题面（已隐藏网页编辑器）· 点击切换为显示完整网页'
      : '当前显示完整网页（含线上编辑器）· 点击切换为专注题面';
  }
}

function renderDifficulty(difficulty?: string): void {
  if (!diffBadgeEl) return;
  const raw = (difficulty ?? '').trim();
  if (!raw) {
    diffBadgeEl.hidden = true;
    diffBadgeEl.textContent = '';
    diffBadgeEl.dataset.diff = '';
    return;
  }
  const key = raw.toLowerCase();
  let label = raw;
  let norm = 'medium';
  if (key === 'easy' || raw === '简单') {
    label = '简单';
    norm = 'easy';
  } else if (key === 'medium' || raw === '中等') {
    label = '中等';
    norm = 'medium';
  } else if (key === 'hard' || raw === '困难') {
    label = '困难';
    norm = 'hard';
  }
  diffBadgeEl.textContent = label;
  diffBadgeEl.dataset.diff = norm;
  diffBadgeEl.hidden = false;
}

function formatDisplayTitle(title?: string, frontendId?: string): string {
  const cleanTitle = (title ?? '').trim() || 'LeetCode';
  if (frontendId && !cleanTitle.startsWith(`${frontendId}.`)) {
    return `${frontendId}. ${cleanTitle}`;
  }
  return cleanTitle;
}

function formatShortFile(fileName?: string): string {
  if (!fileName) return '';
  const parts = fileName.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || fileName;
}

function fillLangs(langs: LangOption[], current: string): void {
  langSel.innerHTML = '';
  for (const l of langs) {
    const opt = document.createElement('option');
    opt.value = l.slug;
    opt.textContent = l.localHarness ? l.label : `${l.label} · 仅官方`;
    langSel.appendChild(opt);
  }
  if (current) langSel.value = current;
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

function closeMoreMenu(): void {
  if (!moreMenu || moreMenu.hidden) return;
  moreMenu.hidden = true;
  moreBtn?.setAttribute('aria-expanded', 'false');
}

moreBtn?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  if (!moreMenu) return;
  const willOpen = moreMenu.hidden;
  moreMenu.hidden = !willOpen;
  moreBtn.setAttribute('aria-expanded', String(willOpen));
});

document.addEventListener('click', (ev) => {
  if (!moreMenu || moreMenu.hidden) return;
  const target = ev.target as Node | null;
  if (target && (moreMenu.contains(target) || moreBtn?.contains(target))) return;
  closeMoreMenu();
});

/** 页面里的桥接脚本 → 宿主 */
window.addEventListener('message', (ev) => {
  const data = ev.data as { lcLocal?: boolean } & Record<string, unknown>;
  if (!data || typeof data !== 'object') return;
  if (ev.source === frame?.contentWindow && data.lcLocal) {
    const bMsg = data as unknown as BridgeMessage;
    if (bMsg.t === 'ready') {
      setBusy(false);
    }
    send({ type: 'bridge', msg: bMsg });
    return;
  }
  // 页面整体 reload（登录后跳转等）
  if (ev.source === frame?.contentWindow) {
    setStatus('页面加载中…', 'busy');
  }
});

/** 宿主 → shell */
window.addEventListener('message', (ev) => {
  const msg = ev.data as HostToShell;
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
  switch (msg.type) {
    case 'init': {
      titleEl.textContent = formatDisplayTitle(msg.title, msg.frontendId);
      renderDifficulty(msg.difficulty);
      subEl.textContent = formatShortFile(msg.fileName);
      subEl.title = msg.fileName || '';
      fillLangs(msg.langs, msg.lang);
      syncFocusState(msg.hideEditor ?? true);
      if (frame.getAttribute('src') !== msg.frameUrl) {
        setBusy(true);
        frame.setAttribute('src', msg.frameUrl);
      }
      setStatus(
        msg.signedIn ? (msg.signedInName ? `${msg.signedInName}` : '已登录') : '未登录',
        msg.signedIn ? 'ok' : 'warn',
      );
      bar.dataset.harness = msg.harnessNote ? 'limited' : '';
      break;
    }
    case 'state': {
      if (msg.langs && msg.langs.length) {
        fillLangs(msg.langs, msg.lang ?? langSel.value);
      } else if (msg.lang !== undefined && langSel.value !== msg.lang) {
        langSel.value = msg.lang;
      }
      if (msg.title !== undefined) {
        titleEl.textContent = formatDisplayTitle(msg.title, msg.frontendId);
      }
      if (msg.difficulty !== undefined) {
        renderDifficulty(msg.difficulty);
      }
      if (msg.fileName !== undefined) {
        subEl.textContent = formatShortFile(msg.fileName);
        subEl.title = msg.fileName;
      }
      if (msg.hideEditor !== undefined) {
        syncFocusState(msg.hideEditor);
      }
      if (msg.signedIn !== undefined) {
        setStatus(
          msg.signedIn ? (msg.signedInName ? `${msg.signedInName}` : '已登录') : '未登录',
          msg.signedIn ? 'ok' : 'warn',
        );
      }
      if (msg.busy !== undefined) {
        setBusy(msg.busy);
      }
      break;
    }
    case 'bridge': {
      toBridge(msg.msg);
      break;
    }
    case 'reload': {
      pendingToBridge = [];
      setBusy(true);
      const current = frame.getAttribute('src') ?? '';
      frame.setAttribute('src', 'about:blank');
      window.setTimeout(() => frame.setAttribute('src', current), 50);
      break;
    }
    case 'results': {
      setBusy(false);
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
    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
      break;
    }
  }
});

frame.addEventListener('load', () => {
  setBusy(false);
  if (statusEl.dataset.level === 'busy') {
    setStatus('就绪', 'ok');
  }
  flushPending();
});

syncFocusState(true);

for (const btn of Array.from(document.querySelectorAll<HTMLElement>('[data-act]'))) {
  btn.addEventListener('click', () => {
    const action = btn.dataset.act as ShellAction;
    closeMoreMenu();
    if (action === 'toggleFocus') {
      syncFocusState(!focusing);
    }
    send({ type: 'action', action });
  });
}

langSel.addEventListener('change', () => {
  send({ type: 'lang', lang: langSel.value });
});

// 顶栏与菜单快捷键透传
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    closeMoreMenu();
    return;
  }
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
