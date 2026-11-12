/**
 * Python3 / Python 本地测试脚手架。
 *
 * 做法与 LeetCode 官方评测机一致：
 *  - 在一份“preamble 全局字典”（typing / ListNode / TreeNode / Node / 常用库）里 exec 用户代码，
 *    这样用户代码里 `Optional[ListNode]` 之类的注解、以及题面注释里 `# class TreeNode:` 的约定都能成立；
 *  - 不修改用户文件、不往用户文件里插任何代码；
 *  - 每个用例单独 try/except，输出 __LC_RESULT__ 协议行。
 */
import type { HarnessArtifact, HarnessFile, HarnessInput, LanguageHarness, HarnessSupport } from './types.js';
import { CASES_FILE, classifyType, inPlaceAnswerParam, serializeCases } from './types.js';
import type { TypeKind } from './types.js';

const PREAMBLE = String.raw`
import sys, os, json, time, io, traceback, math, re, string, bisect, heapq, itertools, functools
import collections, queue, random, decimal, fractions, statistics, typing
from typing import *
from collections import *
from bisect import *
from heapq import *
from itertools import *
from functools import *
from math import inf, nan

sys.setrecursionlimit(300000)

# LeetCode 的 Python3 模板（以及不少人手写的代码）会用 PEP 604 的 "ListNode | None" 注解，
# 这需要 Python 3.10+；本地若是 3.9，注解在 class 定义时就会 TypeError。
# 这里给我们注入的节点类加一个 metaclass，让 "ListNode | None" 在 3.9 上也能成立。
if sys.version_info < (3, 10):
    class _LcUnionMeta(type):
        def __or__(cls, other):
            return typing.Union[cls, other]

        def __ror__(cls, other):
            return typing.Union[other, cls]

    _LC_NODE_META = _LcUnionMeta
else:
    _LC_NODE_META = type

class ListNode(metaclass=_LC_NODE_META):
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

class TreeNode(metaclass=_LC_NODE_META):
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

class Node(metaclass=_LC_NODE_META):
    def __init__(self, val=None, children=None, next=None, left=None, right=None, neighbors=None, random=None):
        self.val = val
        self.children = children if children is not None else []
        self.next = next
        self.left = left
        self.right = right
        self.neighbors = neighbors if neighbors is not None else []
        self.random = random
`;

const SERIALIZERS = String.raw`
def _mk_list_node(values):
    if values is None:
        return None
    head = None
    tail = None
    for v in values:
        n = ListNode(v)
        if head is None:
            head = n
            tail = n
        else:
            tail.next = n
            tail = n
    return head

def _dump_list_node(node):
    out = []
    seen = 0
    while node is not None:
        out.append(node.val)
        node = node.next
        seen += 1
        if seen > 100000:
            break
    return out

def _mk_tree(values):
    if not values:
        return None
    it = iter(values)
    root_val = next(it, None)
    if root_val is None:
        return None
    root = TreeNode(root_val)
    dq = deque([root])
    while dq:
        node = dq.popleft()
        try:
            v = next(it)
        except StopIteration:
            break
        if v is not None:
            node.left = TreeNode(v)
            dq.append(node.left)
        try:
            v = next(it)
        except StopIteration:
            break
        if v is not None:
            node.right = TreeNode(v)
            dq.append(node.right)
    return root

def _dump_tree(root):
    if root is None:
        return []
    out = []
    dq = deque([root])
    while dq:
        node = dq.popleft()
        if node is None:
            out.append(None)
            continue
        out.append(node.val)
        dq.append(node.left)
        dq.append(node.right)
    while out and out[-1] is None:
        out.pop()
    return out

def _mk_node_children(values):
    if values is None:
        return None
    if not values or values[0] is None:
        return None
    nodes = [None if v is None else Node(v) for v in values]
    kids = []
    i = 1
    cur = 0
    while i < len(nodes):
        n = nodes[i]
        if n is not None:
            kids.append(n)
            i += 1
        else:
            if cur < len(nodes) and nodes[cur] is not None:
                nodes[cur].children = kids
            kids = []
            cur += 1
            i += 1
    if cur < len(nodes) and nodes[cur] is not None:
        nodes[cur].children = kids
    return nodes[0]

def _dump_node_children(root):
    if root is None:
        return []
    out = [root.val, None]
    dq = deque([root])
    while dq:
        node = dq.popleft()
        for c in (node.children or []):
            dq.append(c)
            out.append(c.val)
        out.append(None)
    while out and out[-1] is None:
        out.pop()
    return out

def _ser_double(x):
    if isinstance(x, bool):
        return 'true' if x else 'false'
    try:
        v = float(x)
    except Exception:
        return str(x)
    if v == int(v) and abs(v) < 1e16:
        # 与 LeetCode 一致：整数型浮点仍输出小数位，交给比较器做归一化
        return format(v, '.5f')
    return repr(v)

def _to_serializable(value, kind):
    if kind == 'int':
        return str(int(value))
    if kind == 'long':
        return str(int(value))
    if kind == 'double':
        return _ser_double(value)
    if kind == 'bool':
        return 'true' if value else 'false'
    if kind == 'string':
        return value if isinstance(value, str) else str(value)
    if kind == 'char':
        return value if isinstance(value, str) else str(value)
    if kind == 'int[]':
        return json.dumps([int(x) if not isinstance(x, float) or x == int(x) else x for x in value])
    if kind == 'long[]':
        return json.dumps([int(x) for x in value])
    if kind == 'double[]':
        return json.dumps([float(x) for x in value])
    if kind == 'bool[]':
        return json.dumps([bool(x) for x in value])
    if kind == 'string[]':
        return json.dumps(list(value))
    if kind == 'char[]':
        return json.dumps(list(value))
    if kind == 'char[][]':
        return json.dumps([list(r) for r in value])
    if kind == 'int[][]':
        return json.dumps([list(r) for r in value])
    if kind == 'string[][]':
        return json.dumps([list(r) for r in value])
    if kind == 'listnode':
        return json.dumps(_dump_list_node(value))
    if kind == 'listnode[]':
        return json.dumps([_dump_list_node(n) for n in value])
    if kind == 'treenode':
        return json.dumps(_dump_tree(value))
    if kind == 'treenode[]':
        return json.dumps([_dump_tree(n) for n in value])
    if kind == 'node':
        if hasattr(value, 'children'):
            return json.dumps(_dump_node_children(value))
        return json.dumps(_dump_value(value))
    if kind == 'void':
        return json.dumps(_dump_value(value))
    return json.dumps(_dump_value(value))

def _dump_value(value):
    if isinstance(value, ListNode):
        return _dump_list_node(value)
    if isinstance(value, TreeNode):
        return _dump_tree(value)
    if isinstance(value, Node):
        if value.children:
            return _dump_node_children(value)
    if isinstance(value, (list, tuple)):
        return [_dump_value(v) for v in value]
    if isinstance(value, float):
        return int(value) if value == int(value) and abs(value) < 1e15 else value
    return value

def _parse_arg(raw, kind):
    if raw is None:
        return None
    text = raw.strip()
    if kind in ('int', 'long'):
        return int(text)
    if kind == 'double':
        return float(text)
    if kind == 'bool':
        return text.lower() == 'true'
    if kind == 'string':
        try:
            v = json.loads(text)
            return v if isinstance(v, str) else str(v)
        except Exception:
            return text.strip('"').strip("'")
    if kind == 'char':
        try:
            v = json.loads(text)
            return v if isinstance(v, str) else str(v)
        except Exception:
            return text.strip('"').strip("'")
    if kind in ('int[]', 'long[]', 'double[]', 'bool[]', 'string[]', 'char[]', 'char[][]', 'int[][]', 'string[][]', 'json'):
        return json.loads(text)
    if kind == 'listnode':
        return _mk_list_node(json.loads(text))
    if kind == 'listnode[]':
        return [_mk_list_node(v) for v in json.loads(text)]
    if kind == 'treenode':
        return _mk_tree(json.loads(text))
    if kind == 'treenode[]':
        return [_mk_tree(v) for v in json.loads(text)]
    if kind == 'graph':
        adj = json.loads(text)
        if not adj:
            return None
        nodes = [Node(i + 1) for i in range(len(adj))]
        for i, nb in enumerate(adj):
            nodes[i].neighbors = [nodes[j - 1] for j in nb]
        return nodes[0]
    if kind == 'node':
        return _mk_node_children(json.loads(text))
    try:
        return json.loads(text)
    except Exception:
        return text
`;

function mainTemplate(useNodeChildren: boolean): string {
  const helper = useNodeChildren ? '_mk_node_children' : '_mk_tree';
  return String.raw`
def _load_user_module(source_path, preamble):
    import types as _types
    mod = _types.ModuleType('lc_user_solution')
    mod.__dict__.update(preamble)
    with open(source_path, 'r', encoding='utf-8') as f:
        src = f.read()
    code = compile(src, source_path, 'exec')
    exec(code, mod.__dict__)
    return mod

def main():
    argv = sys.argv[1:]
    source_path = argv[0]
    case_index = None
    if '--case' in argv:
        case_index = int(argv[argv.index('--case') + 1])
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, ${JSON.stringify(CASES_FILE)}), 'r', encoding='utf-8') as f:
        payload = json.load(f)
    meta = payload['meta']
    cases = payload['cases']
    preamble = dict(globals())
    try:
        mod = _load_user_module(source_path, preamble)
    except Exception:
        traceback.print_exc()
        print('__LC_ERROR__ ' + json.dumps({'fatal': 'load_error'}))
        return 2
    sys.setrecursionlimit(300000)

    arg_kinds = [classify(p['type']) for p in meta['params']]
    return_kind = classify(meta['return']['type'])
    method_name = meta['name']
    class_name = meta.get('classname') or 'Solution'

    cls = getattr(mod, class_name, None)
    if cls is None:
        cls = getattr(mod, 'Solution', None)
    fn = None
    if cls is not None and hasattr(cls, method_name):
        fn = getattr(cls(), method_name)
    elif hasattr(mod, method_name):
        fn = getattr(mod, method_name)
    else:
        print('__LC_ERROR__ ' + json.dumps({'fatal': 'entry_not_found', 'name': method_name, 'classname': class_name}))
        return 3

    started = time.time()
    for case in cases:
        if case_index is not None and case['i'] != case_index:
            continue
        buf = io.StringIO()
        old = sys.stdout
        t0 = time.time()
        rec = {'i': case['i'], 'actual': '', 'error': None}
        try:
            sys.stdout = buf
            args = [_parse_arg(raw, kind) for raw, kind in zip(case['args'], arg_kinds)]
            ret = fn(*args)
            if return_kind == 'void':
                idx = 0
                rec['actual'] = _to_serializable(args[idx], arg_kinds[idx]) if args else 'null'
            else:
                rec['actual'] = _to_serializable(ret, return_kind)
        except Exception:
            rec['error'] = traceback.format_exc(limit=4)
        finally:
            sys.stdout = old
        rec['durationMs'] = int((time.time() - t0) * 1000)
        logs = buf.getvalue()
        if logs:
            rec['logs'] = logs[-4000:]
        print('__LC_RESULT__ ' + json.dumps(rec))
    print('__LC_DONE__ ' + json.dumps({'elapsedMs': int((time.time() - started) * 1000)}))
    return 0

if __name__ == '__main__':
    sys.exit(main())
`;
}

/** LeetCode 类型 → python 侧分类函数（与 TS 侧 classifyType 保持一致） */
function classifyFn(): string {
  const map: Record<TypeKind, string> = {
    int: 'int',
    long: 'long',
    double: 'double',
    bool: 'bool',
    string: 'string',
    char: 'char',
    'int[]': 'int[]',
    'long[]': 'long[]',
    'double[]': 'double[]',
    'bool[]': 'bool[]',
    'string[]': 'string[]',
    'char[]': 'char[]',
    'char[][]': 'char[][]',
    'int[][]': 'int[][]',
    'string[][]': 'string[][]',
    listnode: 'listnode',
    'listnode[]': 'listnode[]',
    treenode: 'treenode',
    'treenode[]': 'treenode[]',
    node: 'node',
    graph: 'graph',
    json: 'json',
    void: 'void',
    unknown: 'json',
  };
  return `
_TYPE_MAP = ${JSON.stringify(map)}

def classify(lc_type):
    t = (lc_type or '').strip().lower()
    return _TYPE_MAP.get(t, 'json')
`;
}

/**
 * 调试专用入口：用**标准 import** 加载用户文件。
 * 断点绑定依赖 pydevd 追踪「被 import 的模块」，而 exec(compile(...)) 生成的
 * 代码对象在部分调试器/配置下不会被绑定——这是实测踩到的坑，所以调试走这条路径。
 * 为了不修改用户文件，preamble（typing/ListNode/TreeNode…）被注入 builtins。
 */
function buildDebugRunner(): string {
  return [PREAMBLE, classifyFn(), SERIALIZERS, DEBUG_MAIN].join('\n');
}

function buildRunner(): string {
  return [PREAMBLE, classifyFn(), SERIALIZERS, mainTemplate(false)].join('\n');
}

function hasNodeType(input: HarnessInput): boolean {
  return input.meta.params.some((p) => classifyType(p.type) === 'node') || classifyType(input.meta.return.type) === 'node';
}

const DEBUG_MAIN = String.raw`
# ---- 把 preamble 注入 builtins，使「标准 import 的用户模块」也能用 List/Optional/TreeNode ----
import builtins as _builtins
import importlib as _importlib

for _name, _value in list(globals().items()):
    if _name.startswith('_'):
        continue
    try:
        setattr(_builtins, _name, _value)
    except Exception:
        pass

def _load_user_module(source_path):
    source_dir = os.path.dirname(os.path.abspath(source_path))
    stem = os.path.splitext(os.path.basename(source_path))[0]
    if source_dir not in sys.path:
        sys.path.insert(0, source_dir)
    _importlib.invalidate_caches()
    # 标准 import：调试器可在此文件里命中断点
    return _importlib.import_module(stem)

_ERROR_HINTS = [
    ('has no len()', 'LeetCode 的链表/树参数是 ListNode / TreeNode 对象（.val / .next / .left / .right），不是 list，不能对它用 len()。'),
    ('has no attribute \'val\'', '对空节点取了 .val：先判空（if not node: …）再用。'),
    ('has no attribute \'next\'', '对空节点取了 .next：先判空。'),
    ('NameError', '有名字没定义：可能缺 import，或函数/变量名写错了。'),
    ('RecursionError', '递归太深：检查递归出口，或改成迭代。'),
    ('IndexError', '下标越界：注意空数组和边界。'),
    ('KeyError', '字典里取不存在的键：用 dict.get(k, default) 或先判断。'),
    ('ZeroDivisionError', '除数为 0：检查分母是否可能为 0。'),
    ('unhashable type', '把 list 当字典键了：改用 tuple。'),
]

def _hint_for(error_text):
    for needle, hint in _ERROR_HINTS:
        if needle in error_text:
            return hint
    return None

def _print_human(rec, param_names=None):
    '''把结果打成人类可读的样子（调试终端里比一行 JSON 友好得多）。'''
    try:
        idx = rec.get('i', 0) + 1
        err = rec.get('error')
        if err:
            print('[LeetCode] 用例 %d · 运行出错' % idx)
            lines = [l for l in err.strip().split('\n') if l.strip()]
            if lines:
                print('[LeetCode]   ' + lines[-1].strip())
            import re as _re
            frames = []
            for line in lines[:-1]:
                m = _re.search(r'File "([^"]+)", line (\d+), in (\S+)', line)
                if m:
                    frames.append(m.groups())
            # 优先展示用户自己的栈帧（跳过我们的 runner 与 importlib）
            user_frames = [f for f in frames if '_lc_runner' not in f[0] and '_lc_debug_runner' not in f[0] and 'importlib' not in f[0]]
            show = user_frames[-1] if user_frames else (frames[-1] if frames else None)
            if show:
                print('[LeetCode]   在 %s:%s（%s）' % (os.path.basename(show[0]), show[1], show[2]))
            hint = _hint_for(err)
            if hint:
                print('[LeetCode]   提示：' + hint)
        else:
            print('[LeetCode] 用例 %d · 实际输出 %s' % (idx, rec.get('actual')))
        if rec.get('logs'):
            for line in rec['logs'].strip().split('\n')[:10]:
                print('[LeetCode]   stdout: ' + line)
    except Exception:
        pass

def main():
    argv = sys.argv[1:]
    if not argv:
        print('用法: _lc_debug_runner.py <solution.py> [--case N] [--raise-on-error]')
        return 2
    source_path = os.path.abspath(argv[0])
    case_index = None
    if '--case' in argv:
        case_index = int(argv[argv.index('--case') + 1])
    raise_on_error = '--raise-on-error' in argv
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, ${JSON.stringify(CASES_FILE)}), 'r', encoding='utf-8') as f:
        payload = json.load(f)
    meta = payload['meta']
    cases = payload['cases']

    mod = _load_user_module(source_path)

    arg_kinds = [classify(p['type']) for p in meta['params']]
    return_kind = classify(meta['return']['type'])
    method_name = meta['name']
    class_name = meta.get('classname') or 'Solution'

    cls = getattr(mod, class_name, None)
    if cls is None:
        cls = getattr(mod, 'Solution', None)
    if cls is not None and hasattr(cls, method_name):
        fn = getattr(cls(), method_name)
    elif hasattr(mod, method_name):
        fn = getattr(mod, method_name)
    else:
        print('__LC_ERROR__ ' + json.dumps({'fatal': 'entry_not_found', 'name': method_name}))
        return 3

    started = time.time()
    for case in cases:
        if case_index is not None and case['i'] != case_index:
            continue
        buf = io.StringIO()
        old = sys.stdout
        t0 = time.time()
        rec = {'i': case['i'], 'actual': '', 'error': None}
        pending_exc = None
        try:
            sys.stdout = buf
            args = [_parse_arg(raw, kind) for raw, kind in zip(case['args'], arg_kinds)]
            ret = fn(*args)
            if return_kind == 'void':
                rec['actual'] = _to_serializable(args[0], arg_kinds[0]) if args else 'null'
            else:
                rec['actual'] = _to_serializable(ret, return_kind)
        except Exception:
            rec['error'] = traceback.format_exc(limit=4)
            pending_exc = sys.exc_info()
        finally:
            sys.stdout = old
        rec['durationMs'] = int((time.time() - t0) * 1000)
        logs = buf.getvalue()
        if logs:
            rec['logs'] = logs[-4000:]
        _print_human(rec)
        print('__LC_RESULT__ ' + json.dumps(rec))
        if raise_on_error and pending_exc is not None and pending_exc[1] is not None:
            # 单用例调试：让异常继续抛出，调试器会停在出错的那一行
            raise pending_exc[1].with_traceback(pending_exc[2])
    print('__LC_DONE__ ' + json.dumps({'elapsedMs': int((time.time() - started) * 1000)}))
    return 0

if __name__ == '__main__':
    sys.exit(main())
`;

export const PythonHarness: LanguageHarness = {
  slug: 'python3',
  installHint: '需要本地安装 python3（命令行可用 `python3 --version` 验证）。',
  supports(meta): HarnessSupport {
    if (meta.construct) {
      return { ok: false, reason: '设计类题目（如 LRUCache）需要多步操作序列，暂用「在 LeetCode 上运行」或 AI 脚手架。' };
    }
    const unknown = [...meta.params.map((p) => p.type), meta.return.type].find((t) => classifyType(t) === 'unknown');
    if (unknown) return { ok: false, reason: `暂不支持的类型：${unknown}` };
    return { ok: true };
  },
  generate(input: HarnessInput): HarnessArtifact {
    const files: HarnessFile[] = [];
    files.push({ name: CASES_FILE, content: serializeCases(input) });
    files.push({ name: '_lc_runner.py', content: buildRunner(), executable: true });
    if (input.debug) {
      // 调试入口：标准 import，断点能命中用户文件
      files.push({ name: '_lc_debug_runner.py', content: buildDebugRunner(), executable: true });
    }
    const ver = input.langSlug === 'python' ? 'python' : 'python3';
    const casesPath = CASES_FILE;
    void hasNodeType(input);
    void casesPath;
    void inPlaceAnswerParam(input.meta);
    return {
      files,
      steps: [
        {
          label: 'run',
          cmd: ver,
          args: ['_lc_runner.py', input.sourceAbsPath],
          fatal: false,
        },
      ],
      debugEntry: input.debug ? '_lc_debug_runner.py' : '_lc_runner.py',
      debugType: input.langSlug === 'python' ? 'python' : 'debugpy',
      notes: ['使用与 LeetCode 相同的 preamble（typing / ListNode / TreeNode）执行你的代码。'],
    };
  },
};

export const Python2Harness: LanguageHarness = {
  slug: 'python',
  installHint: '需要本地安装 python2（已停止维护，建议改用 Python3）。',
  supports(meta): HarnessSupport {
    return PythonHarness.supports(meta);
  },
  generate(input: HarnessInput): HarnessArtifact {
    return PythonHarness.generate({ ...input, langSlug: 'python' });
  },
};
