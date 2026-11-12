/** Webview shell ↔ 扩展宿主 的消息协议。 */
import type { BridgeMessage, HostMessage } from '../bridge/protocol.js';

export interface ResultItem {
  kind: 'pass' | 'fail' | 'unknown' | 'info';
  text: string;
}

export type ShellAction =
  | 'runLocal'
  | 'debugLocal'
  | 'runOnLeetCode'
  | 'submit'
  | 'aiHint'
  | 'reloadSnippet'
  | 'regenerateHarness'
  | 'openProblem'
  | 'settings'
  | 'reloadPage'
  | 'focusLocal'
  | 'showLog'
  | 'toggleFocus'
  | 'openPanel'
  | 'navBack'
  | 'navForward'
  | 'navHome'
  | 'login';

export interface LangOption {
  slug: string;
  label: string;
  /** 本语言是否支持本地测试 */
  localHarness: boolean;
}

export type HostToShell =
  | {
      type: 'init';
      frameUrl: string;
      title: string;
      lang: string;
      langs: LangOption[];
      signedIn: boolean;
      fileName: string;
      harnessNote?: string;
    }
  | { type: 'bridge'; msg: HostMessage }
  | {
      type: 'state';
      lang?: string;
      title?: string;
      fileName?: string;
      signedIn?: boolean;
      /** 已登录账号名（用于在左栏显示） */
      signedInName?: string;
      harnessNote?: string;
    }
  | { type: 'reload' }
  | {
      /** 运行/提交结果：直接显示在左栏工具栏下方，不用去翻输出面板 */
      type: 'results';
      source: 'local' | 'judge';
      ok: boolean;
      title: string;
      detail?: string;
      items: ResultItem[];
    }
  | { type: 'toast'; text: string; level?: 'info' | 'warn' | 'error' }
  | { type: 'status'; text: string; level?: 'ok' | 'warn' | 'error' | 'busy' };

export type ShellToHost =
  | { type: 'ready' }
  | { type: 'bridge'; msg: BridgeMessage }
  | { type: 'action'; action: ShellAction }
  | { type: 'lang'; lang: string };
