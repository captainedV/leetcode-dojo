/**
 * JavaScript / TypeScript 本地测试脚手架。
 *
 * 设计要点（与 python.ts 保持同样的分工）：
 *  1. **绝不修改用户代码文件**：生成物只写 `input.genDir`；
 *  2. 不往用户代码里插任何东西：`_lc_runner.js` 在运行时读用户文件，
 *     用 `node:vm` 建一个隔离 context，先把 `_lc_sandbox.js`（ListNode/TreeNode/Node
 *     与参数解析、结果序列化）注入 context，再在同一个 realm 里执行用户代码；
 *  3. LeetCode 的 JS 题面是顶层 `var twoSum = function () {}` / `function twoSum() {}` /
 *     `class Solution { twoSum() {} }`，没有 `module.exports`，所以入口符号用
 *     「先取全局对象属性（var/function 声明），再在同一个 realm 里用 `typeof` 探测
 *     词法声明（let/const/class）」两步拿到，不依赖 `vm.runInNewContext` 的返回值；
 *  4. 每个用例单独 try/catch，输出 `__LC_RESULT__` / `__LC_ERROR__` / `__LC_DONE__` 协议行。
 *
 * TypeScript 复用本文件的工厂（`createJsLikeHarness`），区别只在运行时先调用
 * Node 内置的 `module.stripTypeScriptTypes` 去掉类型注解。
 */
import type {
  HarnessArtifact,
  HarnessFile,
  HarnessInput,
  HarnessSupport,
  LanguageHarness,
  TypeKind,
} from './types.js';
import { CASES_FILE, classifyType, serializeCases } from './types.js';

/** 沙箱内的 entry 文件名 */
const PRELUDE_FILE = '_lc_sandbox.js';
/** 运行器文件名（也是调试入口） */
const RUNNER_FILE = '_lc_runner.js';

/**
 * 沙箱内运行时：数据结构 + 参数解析 + 结果序列化。
 *
 * 在 vm context 里执行，所有节点类都挂在 globalThis 上（**属性赋值**而不是 var 声明），
 * 这样用户代码里若自己写了 `class ListNode {}` 也不会因为重复声明而报错。
 */
const SANDBOX_PRELUDE = String.raw`/* LeetCode 本地测试脚手架 —— 沙箱内运行时（自动生成，请勿手工修改） */
(function () {
  'use strict';

  var g = globalThis;

  // 与 LeetCode 评测机一致的节点类。用户代码里若自己声明了同名类，会通过
  // __LC_USE_CTORS__ 覆盖下面这几个构造器（见 _lc_runner.js）。
  g.ListNode = class ListNode {
    constructor(val, next) {
      this.val = val === undefined ? 0 : val;
      this.next = next === undefined ? null : next;
    }
  };
  g.TreeNode = class TreeNode {
    constructor(val, left, right) {
      this.val = val === undefined ? 0 : val;
      this.left = left === undefined ? null : left;
      this.right = right === undefined ? null : right;
    }
  };
  g.Node = class Node {
    constructor(val, children) {
      this.val = val === undefined ? 0 : val;
      this.children = Array.isArray(children) ? children : [];
      this.neighbors = Array.isArray(children) ? children : [];
      this.next = null;
      this.left = null;
      this.right = null;
      this.random = null;
    }
  };

  var ctors = { ListNode: g.ListNode, TreeNode: g.TreeNode, Node: g.Node };

  g.__LC_USE_CTORS__ = function (list, tree, node) {
    if (typeof list === 'function') ctors.ListNode = list;
    if (typeof tree === 'function') ctors.TreeNode = tree;
    if (typeof node === 'function') ctors.Node = node;
  };

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function isBlank(v) {
    return v === null || v === undefined;
  }

  // ---- 节点构造：构造失败也退回普通对象，避免用户类签名不同直接炸掉 ----------

  function newListNode(v) {
    var node;
    try {
      node = new ctors.ListNode(v);
    } catch (e) {
      node = {};
    }
    if (isBlank(node) || typeof node !== 'object') node = {};
    node.val = v;
    if (node.next === undefined) node.next = null;
    return node;
  }

  function newTreeNode(v) {
    var node;
    try {
      node = new ctors.TreeNode(v);
    } catch (e) {
      node = {};
    }
    if (isBlank(node) || typeof node !== 'object') node = {};
    node.val = v;
    if (node.left === undefined) node.left = null;
    if (node.right === undefined) node.right = null;
    return node;
  }

  function newNode(v) {
    var node;
    try {
      node = new ctors.Node(v);
    } catch (e) {
      node = {};
    }
    if (isBlank(node) || typeof node !== 'object') node = {};
    node.val = v;
    if (!Array.isArray(node.children)) node.children = [];
    if (!Array.isArray(node.neighbors)) node.neighbors = [];
    return node;
  }

  // ---- 链表 ----------------------------------------------------------------

  function makeList(values) {
    if (!Array.isArray(values)) return null;
    var head = null;
    var tail = null;
    for (var i = 0; i < values.length; i++) {
      var node = newListNode(values[i]);
      if (head === null) {
        head = node;
        tail = node;
      } else {
        tail.next = node;
        tail = node;
      }
    }
    return head;
  }

  function dumpList(node) {
    var out = [];
    var guard = 0;
    while (!isBlank(node) && guard++ < 100000) {
      out.push(isBlank(node.val) ? null : node.val);
      node = node.next;
    }
    return out;
  }

  // ---- 二叉树（层序，末尾去 null） -----------------------------------------

  function makeTree(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    if (isBlank(values[0])) return null;
    var root = newTreeNode(values[0]);
    var queue = [root];
    var i = 1;
    while (queue.length > 0 && i < values.length) {
      var node = queue.shift();
      var left = values[i++];
      if (!isBlank(left)) {
        node.left = newTreeNode(left);
        queue.push(node.left);
      }
      if (i < values.length) {
        var right = values[i++];
        if (!isBlank(right)) {
          node.right = newTreeNode(right);
          queue.push(node.right);
        }
      }
    }
    return root;
  }

  function dumpTree(root) {
    if (isBlank(root)) return [];
    var out = [];
    var queue = [root];
    var i = 0;
    while (i < queue.length) {
      var node = queue[i++];
      if (isBlank(node)) {
        out.push(null);
        continue;
      }
      out.push(isBlank(node.val) ? null : node.val);
      queue.push(node.left === undefined ? null : node.left);
      queue.push(node.right === undefined ? null : node.right);
    }
    while (out.length > 0 && out[out.length - 1] === null) out.pop();
    return out;
  }

  // ---- N 叉树（children，层序 null 分隔） ----------------------------------

  function makeChildrenTree(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    if (isBlank(values[0])) return null;
    var root = newNode(values[0]);
    var parents = [root];
    var i = 1;
    while (parents.length > 0 && i < values.length) {
      while (i < values.length && isBlank(values[i])) i++;
      if (i >= values.length) break;
      var parent = parents.shift();
      var kids = [];
      while (i < values.length && !isBlank(values[i])) {
        var child = newNode(values[i++]);
        kids.push(child);
        parents.push(child);
      }
      parent.children = kids;
      if (i < values.length && isBlank(values[i])) i++;
    }
    return root;
  }

  function dumpChildren(root) {
    if (isBlank(root)) return [];
    var out = [isBlank(root.val) ? null : root.val, null];
    var queue = [root];
    var i = 0;
    while (i < queue.length) {
      var node = queue[i++];
      var kids = Array.isArray(node.children) ? node.children : [];
      for (var k = 0; k < kids.length; k++) {
        queue.push(kids[k]);
        out.push(isBlank(kids[k].val) ? null : kids[k].val);
      }
      out.push(null);
    }
    while (out.length > 0 && out[out.length - 1] === null) out.pop();
    return out;
  }

  // ---- 图（邻接表，克隆图题） ----------------------------------------------

  /**
   * Node 类型：LeetCode 上既可能是 N 叉树（层序 + null 分隔）也可能是克隆图（邻接表）。
   * 输入是「数组的数组」时按邻接表处理，否则按 N 叉树处理。
   */
  function makeNodeValue(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    if (Array.isArray(values[0])) return makeGraph(values);
    return makeChildrenTree(values);
  }

  function makeGraph(adj) {
    if (!Array.isArray(adj) || adj.length === 0) return null;
    var nodes = [];
    for (var i = 0; i < adj.length; i++) nodes.push(newNode(i + 1));
    for (var j = 0; j < adj.length; j++) {
      var raw = Array.isArray(adj[j]) ? adj[j] : [];
      var list = [];
      for (var k = 0; k < raw.length; k++) {
        var idx = Number(raw[k]) - 1;
        if (idx >= 0 && idx < nodes.length) list.push(nodes[idx]);
      }
      nodes[j].neighbors = list;
    }
    return nodes[0];
  }

  function dumpGraph(start) {
    if (isBlank(start)) return [];
    var seen = {};
    var order = [];
    var stack = [start];
    while (stack.length > 0) {
      var node = stack.pop();
      if (isBlank(node) || isBlank(node.val)) continue;
      if (seen[node.val]) continue;
      seen[node.val] = node;
      order.push(node);
      var nb = Array.isArray(node.neighbors) ? node.neighbors : [];
      for (var k = 0; k < nb.length; k++) {
        if (!isBlank(nb[k]) && !seen[nb[k].val]) stack.push(nb[k]);
      }
    }
    order.sort(function (a, b) {
      return a.val - b.val;
    });
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var cur = order[i];
      var list = [];
      var ns = Array.isArray(cur.neighbors) ? cur.neighbors : [];
      for (var m = 0; m < ns.length; m++) list.push(isBlank(ns[m]) ? null : ns[m].val);
      out.push(list);
    }
    return out;
  }
`;

/**
 * 序列化 / 反序列化（第二部分 prelude）：单独成串便于阅读。
 * 与上面的数据结构预置拼在一起写进 `_lc_sandbox.js`。
 */
const SANDBOX_CODEC = String.raw`
  // ---- 序列化 --------------------------------------------------------------

  function roundFloat(n) {
    if (!isFinite(n)) return n;
    if (Number.isInteger(n) || Math.abs(n) >= 1e12) return n;
    return Number(n.toPrecision(12));
  }

  function serDouble(v) {
    var n = Number(v);
    if (n !== n) return 'NaN';
    if (n === Infinity) return 'Infinity';
    if (n === -Infinity) return '-Infinity';
    if (Math.abs(n) >= 1e12) return String(n);
    if (Number.isInteger(n)) return n.toFixed(5);
    return String(roundFloat(n));
  }

  function numText(v) {
    if (typeof v === 'bigint') return v.toString();
    var n = Number(v);
    if (n !== n) return 'NaN';
    return String(Math.trunc(n));
  }

  function textOf(v) {
    if (isBlank(v)) return 'null';
    return typeof v === 'string' ? v : String(v);
  }

  function mapNum(arr) {
    return asArray(arr).map(function (x) {
      if (typeof x === 'bigint') return Number(x);
      var n = Number(x);
      return n !== n ? 0 : roundFloat(n);
    });
  }

  function mapText(arr) {
    return asArray(arr).map(function (x) {
      return isBlank(x) ? null : String(x);
    });
  }

  function mapBool(arr) {
    return asArray(arr).map(function (x) {
      return x === true || x === 'true' || x === 1;
    });
  }

  function mapRows(arr, fn) {
    return asArray(arr).map(function (row) {
      return fn(row);
    });
  }

  /**
   * Node 类型在 LeetCode 上既可能是 N 叉树（children）也可能是克隆图（neighbors），
   * 这里按对象形状判别后再序列化。
   */
  function dumpNodeValue(value) {
    if (isBlank(value)) return [];
    var kids = Array.isArray(value.children) ? value.children : [];
    var neighbors = Array.isArray(value.neighbors) ? value.neighbors : [];
    if (kids.length === 0 && neighbors.length > 0) return dumpGraph(value);
    return dumpChildren(value);
  }

  /** 对未知/整体类型做鸭子类型序列化（LeetCode 风格）。 */
  function dumpDeep(value) {
    if (isBlank(value)) return null;
    var t = typeof value;
    if (t === 'number') return roundFloat(value);
    if (t === 'bigint') return value.toString();
    if (t !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map(function (item) {
        return dumpDeep(item);
      });
    }
    if (Array.isArray(value.children)) return dumpChildren(value);
    if (Array.isArray(value.neighbors)) return dumpGraph(value);
    if (value.left !== undefined || value.right !== undefined) return dumpTree(value);
    if (value.next !== undefined) return dumpList(value);
    var obj = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) obj[keys[i]] = dumpDeep(value[keys[i]]);
    return obj;
  }

  /** 按 classifyType 的分类把返回值渲染成 LeetCode 习惯的字符串。 */
  function serialize(value, kind) {
    switch (kind) {
      case 'int':
        return numText(value);
      case 'long':
        return numText(value);
      case 'double':
        return serDouble(value);
      case 'bool':
        return value ? 'true' : 'false';
      case 'string':
        return textOf(value);
      case 'char':
        return textOf(value);
      case 'int[]':
        return JSON.stringify(mapNum(value));
      case 'long[]':
        return JSON.stringify(mapNum(value));
      case 'double[]':
        return JSON.stringify(mapNum(value));
      case 'bool[]':
        return JSON.stringify(mapBool(value));
      case 'string[]':
        return JSON.stringify(mapText(value));
      case 'char[]':
        return JSON.stringify(mapText(value));
      case 'char[][]':
        return JSON.stringify(mapRows(value, mapText));
      case 'string[][]':
        return JSON.stringify(mapRows(value, mapText));
      case 'int[][]':
        return JSON.stringify(mapRows(value, mapNum));
      case 'listnode':
        return JSON.stringify(dumpList(value));
      case 'listnode[]':
        return JSON.stringify(asArray(value).map(dumpList));
      case 'treenode':
        return JSON.stringify(dumpTree(value));
      case 'treenode[]':
        return JSON.stringify(asArray(value).map(dumpTree));
      case 'node':
        return JSON.stringify(dumpNodeValue(value));
      case 'graph':
        return JSON.stringify(dumpGraph(value));
      case 'void':
        return JSON.stringify(dumpDeep(value));
      default:
        return JSON.stringify(dumpDeep(value));
    }
  }

  // ---- 参数解析 ------------------------------------------------------------

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return undefined;
    }
  }

  function stripQuotes(text) {
    if (text.length >= 2) {
      var first = text.charAt(0);
      var last = text.charAt(text.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1);
    }
    return text;
  }

  /** raw 是 LeetCode 题面里的一行原文，例如 "[2,7,11,15]"、'9'、'abc'。 */
  function parseArg(raw, kind) {
    if (isBlank(raw)) return null;
    var text = String(raw).trim();
    if (text === '') return null;
    var parsed = parseJson(text);
    var isJson = parsed !== undefined;
    switch (kind) {
      case 'int':
      case 'long': {
        var n = isJson && typeof parsed === 'number' ? parsed : Number(text);
        if (n !== n) return 0;
        return Math.trunc(n);
      }
      case 'double': {
        var d = isJson && typeof parsed === 'number' ? parsed : Number(text);
        return d !== d ? 0 : d;
      }
      case 'bool':
        if (isJson && typeof parsed === 'boolean') return parsed;
        return text.toLowerCase() === 'true';
      case 'string':
      case 'char':
        if (isJson) return typeof parsed === 'string' ? parsed : String(parsed);
        return stripQuotes(text);
      case 'int[]':
      case 'long[]':
      case 'double[]':
        return mapNum(isJson ? parsed : []);
      case 'bool[]':
        return mapBool(isJson ? parsed : []);
      case 'string[]':
      case 'char[]':
        return mapText(isJson ? parsed : []);
      case 'char[][]':
      case 'string[][]':
        return mapRows(isJson ? parsed : [], mapText);
      case 'int[][]':
        return mapRows(isJson ? parsed : [], mapNum);
      case 'listnode':
        return isJson ? makeList(parsed) : null;
      case 'listnode[]':
        return isJson ? asArray(parsed).map(makeList) : [];
      case 'treenode':
        return isJson ? makeTree(parsed) : null;
      case 'treenode[]':
        return isJson ? asArray(parsed).map(makeTree) : [];
      case 'node':
        return isJson ? makeNodeValue(parsed) : null;
      case 'graph':
        return isJson ? makeGraph(parsed) : null;
      case 'json':
        return isJson ? parsed : stripQuotes(text);
      default:
        return isJson ? parsed : stripQuotes(text);
    }
  }

  g.__LC__ = { parseArg: parseArg, serialize: serialize };
})();
`;

export interface JsLikeHarnessOptions {
  /** 规范化 langSlug：javascript / typescript */
  slug: string;
  /** 运行时是否先用 Node 内置的 stripTypeScriptTypes 去类型（TS 为 true） */
  stripTypes: boolean;
  installHint?: string;
  notes?: string[];
}

/** classifyType 支持的全部输入字符串（用于生成运行时的类型映射）。 */
const CLASSIFY_KEYS = [
  'integer',
  'int',
  'long',
  'bigint',
  'double',
  'float',
  'boolean',
  'bool',
  'string',
  'str',
  'character',
  'char',
  'void',
  'integer[]',
  'int[]',
  'list[integer]',
  'long[]',
  'double[]',
  'float[]',
  'boolean[]',
  'bool[]',
  'string[]',
  'list[string]',
  'character[]',
  'char[]',
  'character[][]',
  'char[][]',
  'integer[][]',
  'int[][]',
  'list[list[integer]]',
  'string[][]',
  'listnode',
  'listnode[]',
  'list[listnode]',
  'treenode',
  'treenode[]',
  'list[treenode]',
  'node',
  'graph',
  'json',
  'array',
  'object',
  'nestedinteger',
];

/** 运行时类型映射：直接由 TS 侧 classifyType 生成，避免两边算法漂移。 */
function runtimeTypeMap(): Record<string, TypeKind> {
  const map: Record<string, TypeKind> = {};
  for (const key of CLASSIFY_KEYS) {
    map[key] = classifyType(key) === 'unknown' ? 'json' : classifyType(key);
  }
  return map;
}

/**
 * 生成 `_lc_runner.js`。
 *
 * 注意：本模板里不要出现模板字符串（反引号）与额外的 `${`，
 * 否则 String.raw 会误当成插值。
 */
function buildRunner(opts: {
  stripTypes: boolean;
  sourcePath: string;
  argKinds: TypeKind[];
  returnKind: TypeKind;
}): string {
  const typeMapJson = JSON.stringify(runtimeTypeMap());
  return String.raw`/* LeetCode 本地测试脚手架 —— 运行器（自动生成，请勿手工修改）
 *
 * 用法：node _lc_runner.js [用户代码路径]
 * 也可以直接被调试器以 program=_lc_runner.js 启动（默认用户代码路径已写死）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- 生成时注入的本题信息 ----
const STRIP_TYPES = ${JSON.stringify(opts.stripTypes)};
const DEFAULT_SOURCE = ${JSON.stringify(opts.sourcePath)};
const DEFAULT_ARG_KINDS = ${JSON.stringify(opts.argKinds)};
const DEFAULT_RETURN_KIND = ${JSON.stringify(opts.returnKind)};
const CASES_FILE = ${JSON.stringify(CASES_FILE)};
const PRELUDE_FILE = ${JSON.stringify(PRELUDE_FILE)};
const TYPE_MAP = ${typeMapJson};

const RESULT_PREFIX = '__LC_RESULT__ ';
const ERROR_PREFIX = '__LC_ERROR__ ';
const DONE_PREFIX = '__LC_DONE__ ';

const logs = [];

function emit(line) {
  process.stdout.write(line + '\n');
}

function emitFatal(fatal, message) {
  const payload = { fatal: fatal };
  if (message) payload.message = String(message).slice(0, 2000);
  emit(ERROR_PREFIX + JSON.stringify(payload));
}

function formatError(err) {
  if (!err) return 'Error: unknown failure';
  let head;
  try {
    head = (err.name ? err.name + ': ' : '') + (err.message === undefined ? String(err) : err.message);
  } catch (e) {
    head = 'Error';
  }
  let stack = '';
  try {
    stack = String(err.stack || '');
  } catch (e) {
    stack = '';
  }
  let text = stack || head;
  if (stack && head && stack.indexOf(head) < 0) text = head + '\n' + stack;
  if (text.length > 4000) text = text.slice(0, 4000) + '\n...(truncated)';
  return text;
}

function classify(lcType) {
  const key = String(lcType || '').trim().toLowerCase();
  return TYPE_MAP[key] || 'json';
}

/** 读取用户代码；TypeScript 需要先剥离类型注解。 */
function loadUserSource(sourcePath) {
  const raw = fs.readFileSync(sourcePath, 'utf8');
  if (!STRIP_TYPES) return raw;
  let strip = null;
  try {
    strip = require('node:module').stripTypeScriptTypes || null;
  } catch (e) {
    strip = null;
  }
  if (typeof strip !== 'function') {
    const err = new Error(
      '当前 Node 不支持 module.stripTypeScriptTypes（需要 Node >= 22.7，当前 ' +
        process.version +
        '）。请升级 Node，或改用 JavaScript 版本。',
    );
    err.name = 'TypeScriptStripUnavailableError';
    throw err;
  }
  try {
    return strip(raw);
  } catch (e) {
    try {
      return strip(raw, { mode: 'transform' });
    } catch (e2) {
      const err = new Error('TypeScript 类型剥离失败：' + ((e && e.message) || String(e)));
      err.name = 'TypeScriptStripError';
      throw err;
    }
  }
}

function buildSandbox() {
  const format = (value) => {
    if (typeof value === 'string') return value;
    try {
      return require('node:util').inspect(value, { depth: 4, breakLength: 120 });
    } catch (e) {
      return String(value);
    }
  };
  const push = (...rest) => {
    logs.push(rest.map(format).join(' '));
  };
  return {
    __LC_CAPTURE__: {},
    console: {
      log: push,
      info: push,
      warn: push,
      error: push,
      debug: push,
      trace: push,
      dir: push,
      table: push,
    },
  };
}

function isIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(name || ''));
}

/** 在同一个 realm 里探测词法声明（let/const/class）并把入口符号抓出来。 */
function harvestSource(names) {
  const lines = ['(function () {', '  var c = globalThis.__LC_CAPTURE__;'];
  for (const name of names) {
    const json = JSON.stringify(name);
    lines.push('  try { if (typeof ' + name + ' !== "undefined" && ' + name + ' != null) c[' + json + '] = ' + name + '; } catch (e) {}');
  }
  lines.push('})();');
  return lines.join('\n');
}

/** 让沙箱里的 ListNode/TreeNode/Node 优先使用用户代码自己声明的同名类（如果有）。 */
const NODE_CTOR_PROBE = [
  '(function () {',
  '  var use = globalThis.__LC_USE_CTORS__;',
  '  if (typeof use !== "function") return;',
  '  var list = null;',
  '  var tree = null;',
  '  var node = null;',
  '  try { if (typeof ListNode === "function") list = ListNode; } catch (e) {}',
  '  try { if (typeof TreeNode === "function") tree = TreeNode; } catch (e) {}',
  '  try { if (typeof Node === "function") node = Node; } catch (e) {}',
  '  use(list, tree, node);',
  '})();',
].join('\n');

/**
 * 解析入口：返回一个「每个用例调用一次」的函数，找不到返回 null。
 * 支持 var/function 顶层声明、class Solution { method() {} }、static 方法。
 */
function resolveEntry(capture, meta) {
  const method = String(meta.name || '');
  if (!method) return null;

  const direct = capture[method];
  if (typeof direct === 'function') {
    return (args) => direct.apply(null, args);
  }

  const classNames = [];
  if (isIdentifier(meta.classname)) classNames.push(meta.classname);
  if (classNames.indexOf('Solution') < 0) classNames.push('Solution');

  for (const name of classNames) {
    const cls = capture[name];
    if (typeof cls !== 'function') continue;
    const proto = cls.prototype;
    if (proto && typeof proto[method] === 'function') {
      return (args) => {
        const instance = new cls();
        return proto[method].apply(instance, args);
      };
    }
    if (typeof cls[method] === 'function') {
      return (args) => cls[method].apply(cls, args);
    }
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2).filter((a) => a.charAt(0) !== '-');
  const sourcePath = argv[0] || DEFAULT_SOURCE;
  const here = __dirname;

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(here, CASES_FILE), 'utf8'));
  } catch (e) {
    emitFatal('cases_missing', '无法读取 ' + CASES_FILE + '：' + ((e && e.message) || String(e)));
    return 2;
  }
  const meta = payload.meta || {};
  const cases = Array.isArray(payload.cases) ? payload.cases : [];

  let source;
  try {
    source = loadUserSource(sourcePath);
  } catch (e) {
    const fatal =
      e && e.name === 'TypeScriptStripUnavailableError'
        ? 'typescript_unsupported'
        : e && e.name === 'TypeScriptStripError'
          ? 'typescript_strip_error'
          : 'load_error';
    emitFatal(fatal, (e && e.message) || String(e));
    return 2;
  }

  const sandbox = buildSandbox();
  const context = vm.createContext(sandbox);
  try {
    const prelude = fs.readFileSync(path.join(here, PRELUDE_FILE), 'utf8');
    vm.runInContext(prelude, context, { filename: PRELUDE_FILE });
  } catch (e) {
    emitFatal('scaffold_broken', formatError(e));
    return 2;
  }

  try {
    vm.runInContext(source, context, { filename: sourcePath });
  } catch (e) {
    emitFatal('load_error', formatError(e));
    return 2;
  }

  const capture = context.__LC_CAPTURE__ || {};
  const probeNames = [meta.name, meta.classname, 'Solution'].filter(
    (name, index, all) => isIdentifier(name) && all.indexOf(name) === index,
  );
  try {
    vm.runInContext(harvestSource(probeNames), context, { filename: 'lc_harvest.js' });
  } catch (e) {
    void e; // 探测失败不算致命：还有 var/function 声明的全局属性可用
  }
  for (const name of probeNames) {
    if (capture[name] === undefined && context[name] !== undefined) capture[name] = context[name];
  }
  try {
    vm.runInContext(NODE_CTOR_PROBE, context, { filename: 'lc_ctors.js' });
  } catch (e) {
    void e;
  }

  const invoke = resolveEntry(capture, meta);
  if (!invoke) {
    emitFatal('entry_not_found', '没找到入口函数 ' + String(meta.name || '?') + '（支持顶层 var/function 声明或 class Solution）。');
    return 3;
  }

  const helpers = context.__LC__;
  if (!helpers || typeof helpers.parseArg !== 'function') {
    emitFatal('scaffold_broken', '沙箱内运行时缺失 __LC__。');
    return 2;
  }

  const argKinds = Array.isArray(meta.params) && meta.params.length > 0
    ? meta.params.map((p) => classify(p && p.type))
    : DEFAULT_ARG_KINDS;
  const returnKind = meta.return && meta.return.type !== undefined ? classify(meta.return.type) : DEFAULT_RETURN_KIND;

  const started = Date.now();
  for (const item of cases) {
    const t0 = Date.now();
    const record = { i: item.i, actual: '', error: null };
    logs.length = 0;
    let args = [];
    try {
      args = argKinds.map((kind, index) => helpers.parseArg(item.args ? item.args[index] : null, kind));
      const returned = invoke(args);
      if (returnKind === 'void') {
        record.actual = args.length > 0 ? helpers.serialize(args[0], argKinds[0]) : 'null';
      } else {
        record.actual = helpers.serialize(returned, returnKind);
      }
    } catch (e) {
      record.error = formatError(e);
    }
    record.durationMs = Date.now() - t0;
    if (logs.length > 0) record.logs = logs.join('\n').slice(-4000);
    emit(RESULT_PREFIX + JSON.stringify(record));
  }

  emit(DONE_PREFIX + JSON.stringify({ elapsedMs: Date.now() - started }));
  return 0;
}

let exitCode = 0;
try {
  exitCode = main();
} catch (e) {
  emitFatal('scaffold_broken', formatError(e));
  exitCode = 2;
}
process.exitCode = exitCode;
`;
}

function sandboxFile(): string {
  return SANDBOX_PRELUDE + '\n' + SANDBOX_CODEC;
}

/** 该语言对这道题是否支持（三种语言共用同一套判定）。 */
export function jsLikeSupports(meta: HarnessInput['meta']): HarnessSupport {
  if (meta.construct) {
    return { ok: false, reason: '设计类题目（多步操作）暂不支持本地脚手架' };
  }
  const types = [...meta.params.map((p) => p.type), meta.return.type];
  const unknown = types.find((t) => classifyType(t) === 'unknown');
  if (unknown) return { ok: false, reason: `暂不支持的类型：${unknown}` };
  return { ok: true };
}

/**
 * JS / TS 共用工厂：生成 `_lc_cases.json` + `_lc_sandbox.js` + `_lc_runner.js`。
 *
 * 生成阶段只计算字符串，不触碰磁盘（写盘由 execute.ts 的 materialize 负责）。
 */
export function createJsLikeHarness(opts: JsLikeHarnessOptions): LanguageHarness {
  const notes = opts.notes ?? [];
  return {
    slug: opts.slug,
    installHint: opts.installHint ?? '需要本地安装 node（命令行可用 `node --version` 验证）。',
    supports: jsLikeSupports,
    generate(input: HarnessInput): HarnessArtifact {
      const argKinds = input.meta.params.map((p) => classifyType(p.type));
      const returnKind: TypeKind = classifyType(input.meta.return.type);

      const files: HarnessFile[] = [
        { name: CASES_FILE, content: serializeCases(input) },
        { name: PRELUDE_FILE, content: sandboxFile() },
        {
          name: RUNNER_FILE,
          content: buildRunner({
            stripTypes: opts.stripTypes,
            sourcePath: input.sourceAbsPath,
            argKinds,
            returnKind,
          }),
          executable: true,
        },
      ];

      return {
        files,
        steps: [
          {
            label: 'run',
            cmd: 'node',
            args: [RUNNER_FILE, input.sourceAbsPath],
            fatal: false,
          },
        ],
        debugEntry: RUNNER_FILE,
        debugType: 'node',
        notes,
      };
    },
  };
}

export const JavaScriptHarness: LanguageHarness = createJsLikeHarness({
  slug: 'javascript',
  stripTypes: false,
  installHint: '需要本地安装 node（命令行可用 `node --version` 验证）。',
  notes: [
    '在 node:vm 沙箱里执行你的代码，沙箱内提供 ListNode / TreeNode / Node 与 console。',
    '入口名取自题面 metaData（函数名或 Solution 上的方法名），不需要写 module.exports。',
    '沙箱不提供 require / 网络 / 文件系统，避免本地测试时执行越权代码。',
  ],
});
