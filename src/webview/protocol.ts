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
  | 'resetLayout'
  | 'exitMode'
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
      frontendId?: string;
      difficulty?: string;
      lang: string;
      langs: LangOption[];
      signedIn: boolean;
      signedInName?: string;
      fileName: string;
      hideEditor?: boolean;
      harnessNote?: string;
    }
  | { type: 'bridge'; msg: HostMessage }
  | {
      type: 'state';
      lang?: string;
      langs?: LangOption[];
      title?: string;
      frontendId?: string;
      difficulty?: string;
      fileName?: string;
      signedIn?: boolean;
      /** 已登录账号名（用于在左栏显示） */
      signedInName?: string;
      hideEditor?: boolean;
      harnessNote?: string;
      busy?: boolean;
    }
  | { type: 'reload' }
  | {
      /** 运行/提交结果通知 */
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
