/**
 * TypeScript 本地测试脚手架。
 *
 * 复用 javascript.ts 的工厂：生成物完全一样（`_lc_cases.json` + `_lc_sandbox.js` + `_lc_runner.js`），
 * 差别只在运行器里 `STRIP_TYPES = true` —— 运行时先用 Node 内置的
 * `module.stripTypeScriptTypes`（Node >= 22.7）去掉类型注解，再在同一个 `node:vm`
 * 沙箱里执行，因此不需要本地装 tsc / ts-node。
 *
 * 注意依赖方向：本文件依赖 javascript.ts，javascript.ts 不依赖本文件。
 */
import { createJsLikeHarness } from './javascript.js';
import type { LanguageHarness } from './types.js';

/** Node 内置类型剥离所需的最低版本（见 https://nodejs.org/api/typescript.html） */
export const TS_STRIP_MIN_NODE = '22.7';

const NOTES = [
  'TypeScript 代码在运行时用 Node 内置的 module.stripTypeScriptTypes 剥离类型注解，需要 Node >= ' +
    TS_STRIP_MIN_NODE +
    '（本机 `node --version` 验证，例如 v25 支持）。',
  '若该 API 不可用，运行器会输出 __LC_ERROR__ {"fatal":"typescript_unsupported"}，请升级 Node 或改用 JavaScript。',
  '仅做“去类型”而不做模块编译：不支持 import / export / 装饰器等需要真正编译器的写法。',
];

export const TypeScriptHarness: LanguageHarness = createJsLikeHarness({
  slug: 'typescript',
  stripTypes: true,
  installHint:
    '需要本地安装 node >= ' + TS_STRIP_MIN_NODE + '（TypeScript 类型靠 Node 内置的 module.stripTypeScriptTypes 剥离）。',
  notes: NOTES,
});
