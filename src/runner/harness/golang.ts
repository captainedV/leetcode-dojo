/**
 * Go 本地测试脚手架。
 *
 * LeetCode 的 Go 题面形如：
 *   func twoSum(nums []int, target int) []int { ... }
 * 没有 `package` 声明、没有 `main`。所以这里：
 *  - 把用户代码**复制**到 genDir/_lc_solution_gen.go 并补一行 `package main`（绝不改动源文件）；
 *  - 另生成 _lc_main.go：读 `_lc_cases.json`、按 meta 类型构造实参、调用用户函数、序列化返回值；
 *  - 同时生成 genDir/go.mod（module lcuser，go 1.20），用 `go build -o _lc_bin .` 编译；
 *  - 每个用例包在 lcCall 里，用 `defer recover()` 把 panic 变成一个用例的 error，不影响其它用例。
 *
 * 输出协议与 python.ts 一致：__LC_RESULT__ / __LC_ERROR__ / __LC_DONE__。
 */
import type { LcMetaData } from '../../core/types.js';
import type { HarnessArtifact, HarnessFile, HarnessInput, HarnessSupport, LanguageHarness } from './types.js';
import { CASES_FILE, classifyType, serializeCases } from './types.js';
import type { TypeKind } from './types.js';

/** 模板里用 %BT% 占位，生成时替换成反引号（Go 的 struct tag 需要）。 */
function withBackticks(src: string): string {
  return src.split('%BT%').join('`');
}

const SUPPORTED_KINDS: TypeKind[] = [
  'int',
  'long',
  'double',
  'bool',
  'string',
  'char',
  'int[]',
  'long[]',
  'double[]',
  'bool[]',
  'string[]',
  'char[]',
  'char[][]',
  'int[][]',
  'string[][]',
  'listnode',
  'listnode[]',
  'treenode',
  'treenode[]',
  'json',
  'void',
];

/** 去掉注释，避免把题面注释里的 `type ListNode struct` 当成用户定义。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function checkSupports(meta: LcMetaData): HarnessSupport {
  if (meta.construct) {
    return { ok: false, reason: '设计类题目（多步操作）暂不支持本地脚手架' };
  }
  const types = [...(meta.params ?? []).map((p) => p.type), meta.return?.type ?? ''];
  for (const t of types) {
    const kind = classifyType(t);
    if (!SUPPORTED_KINDS.includes(kind)) {
      return { ok: false, reason: `暂不支持的类型：${t}` };
    }
  }
  return { ok: true };
}

/** 参数文本 → Go 值的解析函数名 */
const PARSE_FN: Partial<Record<TypeKind, string>> = {
  int: 'lcInt',
  long: 'lcLong',
  double: 'lcFloat',
  bool: 'lcBool',
  string: 'lcStr',
  char: 'lcChar',
  'int[]': 'lcInts',
  'long[]': 'lcLongs',
  'double[]': 'lcFloats',
  'bool[]': 'lcBools',
  'string[]': 'lcStrs',
  'char[]': 'lcBytes',
  'int[][]': 'lcIntMatrix',
  'char[][]': 'lcByteMatrix',
  'string[][]': 'lcStrMatrix',
  listnode: 'lcList',
  'listnode[]': 'lcLists',
  treenode: 'lcTree',
  'treenode[]': 'lcTrees',
  json: 'lcRaw',
};

/** Go 值 → 字符串（LeetCode 习惯）的序列化函数名 */
const SER_FN: Partial<Record<TypeKind, string>> = {
  int: 'lcSerInt',
  long: 'lcSerLong',
  double: 'lcSerFloat',
  bool: 'lcSerBool',
  string: 'lcSerStr',
  char: 'lcSerChar',
  'int[]': 'lcSerInts',
  'long[]': 'lcSerLongs',
  'double[]': 'lcSerFloats',
  'bool[]': 'lcSerBools',
  'string[]': 'lcSerStrs',
  'char[]': 'lcSerBytes',
  'int[][]': 'lcSerIntMatrix',
  'char[][]': 'lcSerByteMatrix',
  'string[][]': 'lcSerStrMatrix',
  listnode: 'lcSerList',
  'listnode[]': 'lcSerLists',
  treenode: 'lcSerTree',
  'treenode[]': 'lcSerTrees',
  json: 'lcSerJSON',
};

function parseFn(kind: TypeKind): string {
  return PARSE_FN[kind] ?? 'lcRaw';
}

function serFn(kind: TypeKind): string {
  return SER_FN[kind] ?? 'lcSerJSON';
}

const LIST_NODE_DEF = `type ListNode struct {
	Val  int
	Next *ListNode
}`;

const TREE_NODE_DEF = `type TreeNode struct {
	Val   int
	Left  *TreeNode
	Right *TreeNode
}`;

const GO_MOD = `module lcuser

go 1.20
`;

/** 生成 _lc_main.go 里的用例分派函数（用户函数名是静态写死的，Go 只能这样）。 */
function buildDispatch(input: HarnessInput, entryFound: boolean): string {
  if (!entryFound) {
    return ['func lcCompute(i int, raw []string) (string, string) {', '\treturn "", ""', '}', ''].join('\n');
  }
  const params = input.meta.params ?? [];
  const returnKind = classifyType(input.meta.return?.type ?? 'void');
  const lines: string[] = [];
  lines.push('func lcCompute(i int, raw []string) (string, string) {');
  lines.push('\tswitch i {');
  for (const c of input.testCases) {
    lines.push(`\tcase ${c.index}:`);
    lines.push('\t\treturn lcCall(func() string {');
    params.forEach((p, idx) => {
      lines.push(`\t\t\ta${idx} := ${parseFn(classifyType(p.type))}(raw[${idx}])`);
    });
    const argList = params.map((_p, idx) => `a${idx}`).join(', ');
    if (returnKind === 'void') {
      lines.push(`\t\t\t${input.meta.name}(${argList})`);
      if (params.length > 0) {
        lines.push(`\t\t\treturn ${serFn(classifyType(params[0].type))}(a0)`);
      } else {
        lines.push('\t\t\treturn "null"');
      }
    } else {
      lines.push(`\t\t\tret := ${input.meta.name}(${argList})`);
      lines.push(`\t\t\treturn ${serFn(returnKind)}(ret)`);
    }
    lines.push('\t\t})');
  }
  lines.push('\t}');
  lines.push('\treturn "", "case_not_found"');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

const GO_RUNTIME = String.raw`
type lcCase struct {
	I    int      %BT%json:"i"%BT%
	Args []string %BT%json:"args"%BT%
}

type lcPayload struct {
	Cases []lcCase %BT%json:"cases"%BT%
}

// 与 TS 侧协议完全对齐：{"i":0,"actual":"...","error":null,"durationMs":3}
type lcRecord struct {
	I          int     %BT%json:"i"%BT%
	Actual     string  %BT%json:"actual"%BT%
	Error      *string %BT%json:"error"%BT%
	DurationMs int64   %BT%json:"durationMs"%BT%
}

// 解析：把 _lc_cases.json 里的「参数原文」转成 Go 值。
func lcInt(s string) int {
	t := strings.TrimSpace(s)
	if v, err := strconv.Atoi(t); err == nil {
		return v
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return 0
	}
	return int(f)
}

func lcLong(s string) int64 {
	t := strings.TrimSpace(s)
	if v, err := strconv.ParseInt(t, 10, 64); err == nil {
		return v
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return 0
	}
	return int64(f)
}

func lcFloat(s string) float64 {
	t := strings.TrimSpace(s)
	v, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return 0
	}
	return v
}

func lcBool(s string) bool {
	t := strings.ToLower(strings.TrimSpace(s))
	return t == "true" || t == "1"
}

func lcStr(s string) string {
	t := strings.TrimSpace(s)
	var out string
	if err := json.Unmarshal([]byte(t), &out); err == nil {
		return out
	}
	return strings.Trim(t, "\"'")
}

func lcChar(s string) byte {
	v := lcStr(s)
	if len(v) == 0 {
		return 0
	}
	return v[0]
}

func lcInts(s string) []int {
	var v []int
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &v); err != nil {
		return nil
	}
	return v
}

func lcLongs(s string) []int64 {
	var v []int64
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &v); err != nil {
		return nil
	}
	return v
}

func lcFloats(s string) []float64 {
	var v []float64
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &v); err != nil {
		return nil
	}
	return v
}

func lcBools(s string) []bool {
	var v []bool
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &v); err != nil {
		return nil
	}
	return v
}

func lcStrs(s string) []string {
	var v []string
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &v); err != nil {
		return nil
	}
	return v
}

func lcBytes(s string) []byte {
	text := strings.TrimSpace(s)
	var ss []string
	if err := json.Unmarshal([]byte(text), &ss); err != nil {
		var one string
		if err2 := json.Unmarshal([]byte(text), &one); err2 == nil {
			return []byte(one)
		}
		return nil
	}
	out := make([]byte, 0, len(ss))
	for _, x := range ss {
		if len(x) > 0 {
			out = append(out, x[0])
		} else {
			out = append(out, 0)
		}
	}
	return out
}

func lcIntMatrix(s string) [][]int {
	var v [][]int
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &v); err != nil {
		return nil
	}
	return v
}

func lcStrMatrix(s string) [][]string {
	var v [][]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &v); err != nil {
		return nil
	}
	return v
}

func lcByteMatrix(s string) [][]byte {
	var rows [][]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &rows); err != nil {
		return nil
	}
	out := make([][]byte, 0, len(rows))
	for _, r := range rows {
		row := make([]byte, 0, len(r))
		for _, x := range r {
			if len(x) > 0 {
				row = append(row, x[0])
			} else {
				row = append(row, 0)
			}
		}
		out = append(out, row)
	}
	return out
}

func lcRaw(s string) interface{} {
	var v interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &v); err != nil {
		return s
	}
	return v
}

func lcBuildList(vals []int) *ListNode {
	if len(vals) == 0 {
		return nil
	}
	head := &ListNode{Val: vals[0]}
	cur := head
	for _, v := range vals[1:] {
		cur.Next = &ListNode{Val: v}
		cur = cur.Next
	}
	return head
}

func lcList(s string) *ListNode {
	var vals []int
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &vals); err != nil {
		return nil
	}
	return lcBuildList(vals)
}

func lcLists(s string) []*ListNode {
	var rows [][]int
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &rows); err != nil {
		return nil
	}
	out := make([]*ListNode, 0, len(rows))
	for _, vals := range rows {
		out = append(out, lcBuildList(vals))
	}
	return out
}

func lcToInt(v interface{}) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	case string:
		return lcInt(x)
	}
	return 0
}

func lcBuildTree(vals []interface{}) *TreeNode {
	if len(vals) == 0 || vals[0] == nil {
		return nil
	}
	root := &TreeNode{Val: lcToInt(vals[0])}
	queue := []*TreeNode{root}
	i := 1
	for len(queue) > 0 && i < len(vals) {
		node := queue[0]
		queue = queue[1:]
		if i < len(vals) {
			if vals[i] != nil {
				node.Left = &TreeNode{Val: lcToInt(vals[i])}
				queue = append(queue, node.Left)
			}
			i++
		}
		if i < len(vals) {
			if vals[i] != nil {
				node.Right = &TreeNode{Val: lcToInt(vals[i])}
				queue = append(queue, node.Right)
			}
			i++
		}
	}
	return root
}

func lcTree(s string) *TreeNode {
	var vals []interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &vals); err != nil {
		return nil
	}
	return lcBuildTree(vals)
}

func lcTrees(s string) []*TreeNode {
	var rows [][]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &rows); err != nil {
		return nil
	}
	out := make([]*TreeNode, 0, len(rows))
	for _, vals := range rows {
		out = append(out, lcBuildTree(vals))
	}
	return out
}

// 序列化：Go 值 → LeetCode 习惯的字符串形式。
func lcDump(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

func lcSerInt(v int) string { return strconv.Itoa(v) }

func lcSerLong(v int64) string { return strconv.FormatInt(v, 10) }

func lcSerFloat(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }

func lcSerBool(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func lcSerStr(v string) string { return v }

func lcSerChar(v byte) string { return string(rune(v)) }

func lcSerInts(v []int) string {
	if v == nil {
		return "[]"
	}
	return lcDump(v)
}

func lcSerLongs(v []int64) string {
	if v == nil {
		return "[]"
	}
	return lcDump(v)
}

func lcSerFloats(v []float64) string {
	if v == nil {
		return "[]"
	}
	return lcDump(v)
}

func lcSerBools(v []bool) string {
	if v == nil {
		return "[]"
	}
	return lcDump(v)
}

func lcSerStrs(v []string) string {
	if v == nil {
		return "[]"
	}
	return lcDump(v)
}

func lcSerBytes(v []byte) string {
	ss := make([]string, 0, len(v))
	for _, b := range v {
		ss = append(ss, string(rune(b)))
	}
	return lcDump(ss)
}

func lcSerIntMatrix(v [][]int) string {
	if v == nil {
		return "[]"
	}
	return lcDump(v)
}

func lcSerStrMatrix(v [][]string) string {
	if v == nil {
		return "[]"
	}
	return lcDump(v)
}

func lcSerByteMatrix(v [][]byte) string {
	out := make([][]string, 0, len(v))
	for _, row := range v {
		r := make([]string, 0, len(row))
		for _, b := range row {
			r = append(r, string(rune(b)))
		}
		out = append(out, r)
	}
	return lcDump(out)
}

func lcListVals(head *ListNode) []int {
	out := []int{}
	seen := 0
	for n := head; n != nil; n = n.Next {
		out = append(out, n.Val)
		seen++
		if seen > 100000 {
			break
		}
	}
	return out
}

func lcSerList(head *ListNode) string { return lcDump(lcListVals(head)) }

func lcSerLists(xs []*ListNode) string {
	out := make([][]int, 0, len(xs))
	for _, h := range xs {
		out = append(out, lcListVals(h))
	}
	return lcDump(out)
}

func lcTreeVals(root *TreeNode) []interface{} {
	out := []interface{}{}
	if root == nil {
		return out
	}
	queue := []*TreeNode{root}
	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		if node == nil {
			out = append(out, nil)
			continue
		}
		out = append(out, node.Val)
		queue = append(queue, node.Left, node.Right)
	}
	for len(out) > 0 && out[len(out)-1] == nil {
		out = out[:len(out)-1]
	}
	return out
}

func lcSerTree(root *TreeNode) string { return lcDump(lcTreeVals(root)) }

func lcSerTrees(xs []*TreeNode) string {
	out := make([][]interface{}, 0, len(xs))
	for _, r := range xs {
		out = append(out, lcTreeVals(r))
	}
	return lcDump(out)
}

func lcSerJSON(v interface{}) string { return lcDump(v) }

func lcCasesPath() string {
	if wd, err := os.Getwd(); err == nil {
		p := filepath.Join(wd, "_lc_cases.json")
		if _, err2 := os.Stat(p); err2 == nil {
			return p
		}
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "_lc_cases.json")
		if _, err2 := os.Stat(p); err2 == nil {
			return p
		}
	}
	return "_lc_cases.json"
}

func lcFatal(reason string) {
	b, err := json.Marshal(map[string]interface{}{"fatal": reason})
	if err != nil {
		fmt.Println("__LC_ERROR__ {\"fatal\":\"error\"}")
		return
	}
	fmt.Println("__LC_ERROR__ " + string(b))
}

// 一个用例一次调用：panic 被 recover 成该用例的 error，不影响后续用例。
func lcCall(f func() string) (out string, errMsg string) {
	defer func() {
		if r := recover(); r != nil {
			errMsg = fmt.Sprintf("panic: %v", r)
		}
	}()
	out = f()
	return
}

func main() {
	started := time.Now()
	data, err := os.ReadFile(lcCasesPath())
	if err != nil {
		lcFatal("cases_read_error")
		return
	}
	var payload lcPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		lcFatal("cases_parse_error")
		return
	}
	if !lcEntryFound {
		lcFatal("entry_not_found")
		return
	}
	for _, c := range payload.Cases {
		t0 := time.Now()
		actual, errMsg := lcCompute(c.I, c.Args)
		rec := lcRecord{I: c.I, Actual: actual, DurationMs: time.Since(t0).Milliseconds()}
		if errMsg != "" {
			msg := errMsg
			rec.Error = &msg
		}
		b, err := json.Marshal(rec)
		if err != nil {
			continue
		}
		fmt.Println("__LC_RESULT__ " + string(b))
	}
	done, err := json.Marshal(map[string]interface{}{"elapsedMs": time.Since(started).Milliseconds()})
	if err != nil {
		fmt.Println("__LC_DONE__ {\"elapsedMs\":0}")
		return
	}
	fmt.Println("__LC_DONE__ " + string(done))
}
`;

function buildMainFile(input: HarnessInput, entryFound: boolean): string {
  const params = input.meta.params ?? [];
  const kinds = [
    ...params.map((p) => classifyType(p.type)),
    classifyType(input.meta.return?.type ?? 'void'),
  ];
  const source = stripComments(input.sourceCode ?? '');
  const needsList = kinds.includes('listnode') || kinds.includes('listnode[]') || /\bListNode\b/.test(source);
  const needsTree = kinds.includes('treenode') || kinds.includes('treenode[]') || /\bTreeNode\b/.test(source);
  const userDefinesList = /\btype\s+ListNode\s+struct\b/.test(source);
  const userDefinesTree = /\btype\s+TreeNode\s+struct\b/.test(source);
  const defs: string[] = [];
  if (needsList && !userDefinesList) defs.push(LIST_NODE_DEF);
  if (needsTree && !userDefinesTree) defs.push(TREE_NODE_DEF);

  const head = GO_MAIN_HEAD.replace('__LC_ENTRY_FOUND__', entryFound ? 'true' : 'false').replace(
    '__LC_TYPE_DEFS__',
    defs.join('\n\n'),
  );
  const parts = [head, withBackticks(GO_RUNTIME), buildDispatch(input, entryFound)];
  return parts.join('\n');
}

const GO_MAIN_HEAD = String.raw`package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 让所有 import 都被用到（不同题目用到的 helper 不同）。
var (
	_ = filepath.Join
	_ = strconv.Itoa
	_ = strings.TrimSpace
	_ = time.Now
	_ = os.Getenv
	_ = fmt.Sprintf
	_ = json.Marshal
)

const lcEntryFound = __LC_ENTRY_FOUND__

__LC_TYPE_DEFS__
`;

function goSolutionFile(input: HarnessInput): string {
  const code = input.sourceCode ?? '';
  const stripped = stripComments(code);
  const hasPackage = /(^|\n)\s*package\s+[A-Za-z_]\w*/.test(stripped);
  return hasPackage ? code : `package main\n\n${code}`;
}

/** 用户代码里有没有这个入口函数（Go 无法运行时按名字查函数，只能静态判断）。 */
function hasEntryFunction(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\n)\\s*func\\s+${escaped}\\s*\\(`).test(stripComments(source));
}

export const GoHarness: LanguageHarness = {
  slug: 'golang',
  installHint: '需要本地安装 Go 工具链（命令行可用 `go version` 验证）。',
  supports(meta: LcMetaData): HarnessSupport {
    return checkSupports(meta);
  },
  generate(input: HarnessInput): HarnessArtifact {
    const entryFound = hasEntryFunction(input.sourceCode ?? '', input.meta.name);
    const files: HarnessFile[] = [
      { name: CASES_FILE, content: serializeCases(input) },
      { name: '_lc_solution_gen.go', content: goSolutionFile(input) },
      { name: '_lc_main.go', content: buildMainFile(input, entryFound) },
      { name: 'go.mod', content: GO_MOD },
    ];
    return {
      files,
      steps: [
        { label: 'compile', cmd: 'go', args: ['build', '-o', '_lc_bin', '.'], fatal: true },
        { label: 'run', cmd: './_lc_bin', args: [], fatal: false },
      ],
      debugEntry: '_lc_main.go',
      debugType: 'go',
      notes: [
        '用户代码被复制到 genDir/_lc_solution_gen.go 并补上 `package main`，不会改动你的源文件。',
        '需要 go 1.16+（使用 os.ReadFile）；go.mod 固定 go 1.20。',
        'ListNode / TreeNode 若用户代码已定义（顶层 type 声明）则不再重复生成。',
      ],
    };
  },
};
