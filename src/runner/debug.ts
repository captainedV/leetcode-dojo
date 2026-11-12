/**
 * 调试配置构造与「调试器类型降级」。
 *
 * 背景：`debugpy` / `cppdbg` / `java` / `go` 这些调试类型都不是 VS Code 内置的，
 * 分别由不同扩展注册。用户在 Cursor 里没装 Python 扩展时，直接 `startDebugging({type:'debugpy'})`
 * 会抛「配置的类型 debugpy 不受支持」——很难理解。
 * 这里改成：按扩展安装情况给出候选链，逐个尝试，全失败时给可操作的安装指引。
 */

export type DebugConfigRecord = Record<string, unknown>;

export interface DebugCandidate {
  /** debug adapter 类型 */
  type: string;
  /** 展示名 */
  label: string;
  config: DebugConfigRecord;
  /** 需要安装的扩展 id（空表示内置） */
  requires: string[];
}

export interface DebugPlan {
  candidates: DebugCandidate[];
  /** 全部不可用时的安装提示 */
  hint: string;
  /** 建议去 marketplace 搜索的关键词 */
  searchTerm: string;
}

export interface StepLike {
  label: string;
  cmd: string;
  args: string[];
  fatal?: boolean;
}

export interface DebugPlanInput {
  langSlug: string;
  /** local/ 目录（生成物所在） */
  localDir: string;
  /** 调试入口文件绝对路径 */
  entry: string;
  /** 用户源码绝对路径 */
  sourceAbs: string;
  /** 编译产物（cpp/rust）绝对路径 */
  binary?: string;
  /** 解析出来的 python 解释器路径（保证调试器与探测到的是同一个） */
  pythonPath?: string;
  /** 追加给调试入口的参数（例如 --raise-on-error） */
  extraArgs?: string[];
  platform?: NodeJS.Platform;
}

const PY_DEBUGGER = 'ms-python.debugpy';
const PY_EXT = 'ms-python.python';
const CPPTOOLS = 'ms-vscode.cpptools';
const CODELLDB = 'vadimcn.vscode-lldb';
const JAVA_EXT = 'redhat.java';
const GO_EXT = 'golang.go';
const RUBY_EXT = 'shopify.ruby-lsp';

/**
 * 调试模式下的编译参数：没有调试信息就没有断点。
 * - C/C++：去掉 -O*，加 -g -O0
 * - Rust：去掉 -O，加 -g -C opt-level=0
 * - Go：加 -gcflags（禁用内联与优化）
 * - Java：加 -g
 */
export function toDebugCompileSteps(langSlug: string, steps: StepLike[]): StepLike[] {
  return steps.map((step) => {
    if (step.label !== 'compile' && step.label !== 'build') return step;
    const isCmd = (bin: string) => new RegExp(`(^|[\\\\/])${bin}(\\.exe)?$`).test(step.cmd);
    if (langSlug === 'cpp' || langSlug === 'c') {
      if (!isCmd('g\\+\\+') && !isCmd('clang\\+\\+') && !isCmd('gcc') && !isCmd('clang')) return step;
      const rest = step.args.filter((a) => !/^-O/.test(a) && a !== '-g').concat(['-g', '-O0', '-fno-omit-frame-pointer']);
      return { ...step, args: rest };
    }
    if (langSlug === 'rust') {
      const rest = step.args.filter((a) => a !== '-O' && a !== '-g');
      return { ...step, args: ['-g', '-C', 'opt-level=0', ...rest] };
    }
    if (langSlug === 'golang') {
      if (step.args.some((a) => a.startsWith('-gcflags'))) return step;
      return { ...step, args: [...step.args, '-gcflags=all=-N -l'] };
    }
    if (langSlug === 'java') {
      if (step.args.includes('-g')) return step;
      return { ...step, args: ['-g', ...step.args] };
    }
    return step;
  });
}

export function debugPlanFor(input: DebugPlanInput): DebugPlan {
  const platform = input.platform ?? process.platform;
  const commonNode = {
    request: 'launch',
    program: input.entry,
    args: [input.sourceAbs, ...(input.extraArgs ?? [])],
    cwd: input.localDir,
    console: 'integratedTerminal',
  };
  const base = { name: 'LeetCode 本地调试', ...{} };

  switch (input.langSlug) {
    case 'python3':
    case 'python':
      return {
        searchTerm: 'Python Debugger',
        hint: '本地调试 Python 需要安装调试扩展（Python Debugger / Python）。安装后重试；也可以先点「本地运行」看结果。',
        candidates: [
          {
            type: 'debugpy',
            label: 'Python Debugger (debugpy)',
            requires: [PY_DEBUGGER],
            config: {
            ...base,
            ...commonNode,
            type: 'debugpy',
            justMyCode: false,
            ...(input.pythonPath ? { python: input.pythonPath } : {}),
          },
          },
          {
            type: 'python',
            label: 'Python 扩展调试器',
            requires: [PY_EXT],
            config: {
            ...base,
            ...commonNode,
            type: 'python',
            justMyCode: false,
            ...(input.pythonPath ? { python: input.pythonPath } : {}),
          },
          },
        ],
      };
    case 'javascript':
    case 'typescript':
      return {
        searchTerm: 'JavaScript Debugger',
        hint: 'JS/TS 调试依赖内置的 js-debug，若不可用请在扩展面板启用。',
        candidates: [
          { type: 'node', label: 'Node (内置)', requires: [], config: { ...base, ...commonNode, type: 'node', skipFiles: ['<node_internals>/**'] } },
          { type: 'pwa-node', label: 'JS Debug (pwa-node)', requires: [], config: { ...base, ...commonNode, type: 'pwa-node', skipFiles: ['<node_internals>/**'] } },
        ],
      };
    case 'cpp':
    case 'c': {
      const binary = input.binary ?? '';
      const candidates: DebugCandidate[] = [
        {
          type: 'cppdbg',
          label: 'C/C++ (ms-vscode.cpptools)',
          requires: [CPPTOOLS],
          config: {
            ...base,
            type: 'cppdbg',
            request: 'launch',
            name: 'LeetCode 本地调试 (C++)',
            program: binary,
            args: [],
            cwd: input.localDir,
            externalConsole: false,
            MIMode: platform === 'darwin' ? 'lldb' : 'gdb',
            ...(platform === 'darwin' ? { miDebuggerPath: 'lldb' } : {}),
          },
        },
        {
          type: 'lldb',
          label: 'CodeLLDB',
          requires: [CODELLDB],
          config: {
            ...base,
            type: 'lldb',
            request: 'launch',
            name: 'LeetCode 本地调试 (CodeLLDB)',
            program: binary,
            args: [],
            cwd: input.localDir,
          },
        },
      ];
      return {
        searchTerm: 'C++',
        hint: '本地调试 C/C++ 需要安装 C/C++ 扩展（ms-vscode.cpptools）或 CodeLLDB。也可以先点「本地运行」看结果。',
        candidates,
      };
    }
    case 'rust':
      return {
        searchTerm: 'CodeLLDB',
        hint: '本地调试 Rust 需要安装 CodeLLDB（vadimcn.vscode-lldb）。也可以先点「本地运行」看结果。',
        candidates: [
          {
            type: 'lldb',
            label: 'CodeLLDB',
            requires: [CODELLDB],
            config: {
              ...base,
              type: 'lldb',
              request: 'launch',
              name: 'LeetCode 本地调试 (Rust)',
              program: input.binary ?? '',
              args: [],
              cwd: input.localDir,
            },
          },
        ],
      };
    case 'java':
      return {
        searchTerm: 'Java Extension Pack',
        hint: '本地调试 Java 需要安装 Java 扩展（redhat.java / Extension Pack for Java）。',
        candidates: [
          {
            type: 'java',
            label: 'Java 调试器',
            requires: [JAVA_EXT],
            config: { ...base, type: 'java', request: 'launch', name: 'LeetCode 本地调试 (Java)', mainClass: 'Main', cwd: input.localDir },
          },
        ],
      };
    case 'golang':
      return {
        searchTerm: 'Go',
        hint: '本地调试 Go 需要安装 Go 扩展（golang.go，含 Delve 支持）。',
        candidates: [
          {
            type: 'go',
            label: 'Go 调试器',
            requires: [GO_EXT],
            config: { ...base, type: 'go', request: 'launch', name: 'LeetCode 本地调试 (Go)', mode: 'debug', program: input.localDir, cwd: input.localDir },
          },
        ],
      };
    case 'ruby':
      return {
        searchTerm: 'Ruby LSP',
        hint: '本地调试 Ruby 需要安装 Ruby LSP（shopify.ruby-lsp）与 debug gem。',
        candidates: [
          {
            type: 'rdbg',
            label: 'Ruby 调试器',
            requires: [RUBY_EXT],
            config: { ...base, type: 'rdbg', request: 'launch', name: 'LeetCode 本地调试 (Ruby)', command: 'ruby', script: input.entry },
          },
        ],
      };
    default:
      return {
        searchTerm: 'debugger',
        hint: `${input.langSlug} 暂不支持本地调试，请使用「本地运行」或「在 LeetCode 上运行」。`,
        candidates: [],
      };
  }
}

/**
 * 过滤出「当前环境真的能用」的调试候选：扩展已安装（或内置）的排在前面。
 * 已安装的候选即使 requires 不满足也保留（有些扩展会注册多个类型），但排在后面。
 */
export function orderDebugCandidates(
  plan: DebugPlan,
  isInstalled: (extensionId: string) => boolean,
): { usable: DebugCandidate[]; blocked: DebugCandidate[] } {
  const usable: DebugCandidate[] = [];
  const blocked: DebugCandidate[] = [];
  for (const c of plan.candidates) {
    const isBuiltin = c.requires.length === 0;
    const satisfied = isBuiltin || c.requires.every((id) => isInstalled(id));
    if (satisfied) usable.push(c);
    else blocked.push(c);
  }
  return { usable, blocked };
}

/** 生成给用户看的说明（哪些扩展在缺） */
export function describeBlocked(blocked: DebugCandidate[]): string {
  const ids = [...new Set(blocked.flatMap((c) => c.requires))];
  return ids.join(' / ');
}
