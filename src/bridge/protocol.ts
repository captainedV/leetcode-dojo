/** 桥接脚本 ↔ Webview shell 的消息协议（两侧共用，纯类型）。 */

export type JudgeKind = 'run' | 'submit';

export interface NormalizedJudgeResult {
  state?: string;
  statusMsg?: string;
  statusCode?: number;
  runSuccess?: boolean;
  totalCorrect?: number;
  totalTestcases?: number;
  codeAnswer?: string[];
  expectedCodeAnswer?: string[];
  stdOutput?: string[];
  codeOutput?: string[];
  compareResult?: string;
  runtimeError?: string;
  compileError?: string;
  fullCompileError?: string;
  fullRuntimeError?: string;
  lastTestcase?: string;
  runtimePercentile?: number;
  memoryPercentile?: number;
  submissionId?: string;
  elapsedTime?: number;
  raw: unknown;
}

export type BridgeMessage =
  | { t: 'ready'; href: string; slug?: string }
  | { t: 'route'; slug?: string; href: string; pathname: string }
  | { t: 'state'; slug?: string; lang?: string; hasMonaco: boolean; editorFound: boolean }
  | {
      t: 'intercept';
      kind: JudgeKind;
      /** 替换后（本地）使用的语言 */
      lang?: string;
      /** 网页原本要用的语言，用于检测用户在网页上切了语言 */
      siteLang?: string;
      slug: string;
      codeLength: number;
      replaced: boolean;
    }
  | { t: 'judgeStarted'; kind: JudgeKind; submissionId: string }
  | { t: 'judgeResult'; kind: JudgeKind; result: NormalizedJudgeResult }
  | { t: 'judgeError'; kind: JudgeKind; message: string }
  | { t: 'needCode'; kind: JudgeKind }
  | { t: 'action'; action: 'focusLocal' | 'aiHint' }
  | { t: 'openExternal'; url: string }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export type HostMessage =
  | { t: 'push'; lang?: string; code?: string; fileName?: string; hideEditor?: boolean }
  | { t: 'hello' }
  | { t: 'hideEditor'; value: boolean }
  | { t: 'status' }
  | { t: 'requestCode' }
  | { t: 'history'; action: 'back' | 'forward' | 'reload' | 'home' };
