/**
 * 常见运行时错误 → 给练习者的中文提示（纯函数，可单测）。
 *
 * 目的：用户点调试/本地运行时，第一眼看到的应该是「你这行代码为什么错、怎么改」，
 * 而不是一串 traceback。
 */

export interface ErrorHint {
  /** 匹配到的错误类型（例如 TypeError） */
  errorType?: string;
  /** 一句话说明 */
  hint: string;
}

const RULES: Array<{ test: RegExp; hint: string }> = [
  { test: /has no len\(\)/, hint: 'LeetCode 的链表/树参数是 ListNode / TreeNode 对象（.val / .next / .left / .right），不是 list，不能用 len()。' },
  { test: /'NoneType' object has no attribute '(val|next|left|right)'/, hint: '对空节点取属性了：先判空（if not node: return …）再用。' },
  { test: /'ListNode' object is not (subscriptable|iterable)/, hint: 'ListNode 不能下标/迭代：用 .val 和 .next 遍历。' },
  { test: /'TreeNode' object is not (subscriptable|iterable)/, hint: 'TreeNode 不能下标/迭代：用 .left / .right 递归。' },
  { test: /\bNameError\b/, hint: '有名字没定义：检查拼写，Python 里可能需要 import（如 from typing import List）。' },
  { test: /\bRecursionError\b/, hint: '递归太深：确认递归出口，或改迭代；本地递归上限已放宽但仍可能栈溢出。' },
  { test: /\bIndexError\b/, hint: '下标越界：注意空数组、末尾边界与 0-based 下标。' },
  { test: /\bKeyError\b/, hint: '字典里取了不存在的键：用 dict.get(k, default) 或先判断。' },
  { test: /\bZeroDivisionError\b/, hint: '除以 0：检查分母是否可能为 0。' },
  { test: /unhashable type/, hint: '把 list 当成了字典键：改用 tuple。' },
  { test: /\bSegmentation fault\b|exit code 139/, hint: '段错误（C/C++）：常见于空指针解引用或数组越界。' },
  { test: /\bstack overflow\b/i, hint: '栈溢出：递归太深或局部数组过大。' },
  { test: /IndexOutOfBoundsException/, hint: 'Java 数组/List 下标越界，注意 size 与边界。' },
  { test: /NullPointerException/, hint: 'Java 空指针：对象可能为 null，先判空。' },
  { test: /index out of range/, hint: '下标越界：注意空数组与末尾边界。' },
  { test: /cannot find symbol|cannot resolve symbol/, hint: '编译错误：类型/方法名拼错，或缺少 import。' },
  { test: /expected ';'|expected '\}'|redefinition of/, hint: '语法错误：常见于缺少分号/括号不配对。' },
  { test: /timeout|超时/i, hint: '超时：可能有死循环，或复杂度太高（调大 lcLocal.run.timeoutMs 只是权宜之计）。' },
];

export function hintForError(errorText: string | null | undefined): ErrorHint | undefined {
  if (!errorText) return undefined;
  const typeMatch = /^\s*([A-Za-z_]*(?:Error|Exception|fault))\b/m.exec(errorText) ?? /([A-Za-z]+Error):/.exec(errorText);
  const errorType = typeMatch?.[1];
  for (const rule of RULES) {
    if (rule.test.test(errorText)) return { errorType, hint: rule.hint };
  }
  return errorType ? { errorType, hint: `运行时抛出了 ${errorType}，看上面的栈帧定位到你的那一行。` } : undefined;
}
