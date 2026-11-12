/**
 * Rust 本地测试脚手架。
 *
 * LeetCode 的 Rust 题面形如：
 *   impl Solution {
 *       pub fn two_sum(nums: Vec<i32>, target: i32) -> Vec<i32> { ... }
 *   }
 * 通常**没有** `struct Solution;`、也没有 `main`。所以：
 *  - 生成 genDir/_lc_main.rs，把用户代码**原样嵌进**同一个文件（不用 include!，避免相对路径陷阱），
 *    前面补 `use` / `struct Solution;` / ListNode / TreeNode 定义（用户代码已定义的跳过）；
 *  - 后面拼上「极简 JSON 解析器 + 各类型转换 + 序列化 + main」，main 读 _lc_cases.json 跑用例；
 *  - 每个用例用 std::panic::catch_unwind 隔离，panic 只影响该用例；
 *  - 编译：rustc -O -o _lc_bin _lc_main.rs。
 *
 * 不引入任何第三方 crate（纯标准库）。
 */
import type { LcMetaData } from '../../core/types.js';
import type { HarnessArtifact, HarnessFile, HarnessInput, HarnessSupport, LanguageHarness } from './types.js';
import { CASES_FILE, classifyType, serializeCases } from './types.js';
import type { TypeKind } from './types.js';

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

/** 集合类类型：原地修改（void）时按 &mut 传参。 */
const CONTAINER_KINDS: TypeKind[] = [
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
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** LeetCode 的 camelCase 方法名 → Rust / Ruby 的 snake_case。 */
export function snakeCase(name: string): string {
  return (name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
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

/** 参数文本 → Rust 值的表达式 */
function argExpr(kind: TypeKind, rawExpr: string): string {
  switch (kind) {
    case 'int':
      return `lc_j_i64(${rawExpr}) as i32`;
    case 'long':
      return `lc_j_i64(${rawExpr})`;
    case 'double':
      return `lc_j_f64(${rawExpr})`;
    case 'bool':
      return `lc_j_bool(${rawExpr})`;
    case 'string':
      return `lc_j_string(${rawExpr})`;
    case 'char':
      return `lc_j_char(${rawExpr})`;
    case 'int[]':
      return `lc_as_i32_vec(${rawExpr})`;
    case 'long[]':
      return `lc_as_i64_vec(${rawExpr})`;
    case 'double[]':
      return `lc_as_f64_vec(${rawExpr})`;
    case 'bool[]':
      return `lc_as_bool_vec(${rawExpr})`;
    case 'string[]':
      return `lc_as_string_vec(${rawExpr})`;
    case 'char[]':
      return `lc_as_char_vec(${rawExpr})`;
    case 'int[][]':
      return `lc_as_i32_matrix(${rawExpr})`;
    case 'char[][]':
      return `lc_as_char_matrix(${rawExpr})`;
    case 'string[][]':
      return `lc_as_string_matrix(${rawExpr})`;
    case 'listnode':
      return `lc_as_list(${rawExpr})`;
    case 'listnode[]':
      return `lc_as_list_vec(${rawExpr})`;
    case 'treenode':
      return `lc_as_tree(${rawExpr})`;
    case 'treenode[]':
      return `lc_as_tree_vec(${rawExpr})`;
    default:
      return `(${rawExpr}).clone()`;
  }
}

/** Rust 值 → 字符串（LeetCode 习惯）的序列化函数名 */
function dumpFn(kind: TypeKind): string {
  switch (kind) {
    case 'int':
      return 'lc_dump_i32';
    case 'long':
      return 'lc_dump_i64';
    case 'double':
      return 'lc_dump_f64';
    case 'bool':
      return 'lc_dump_bool';
    case 'string':
      return 'lc_dump_string';
    case 'char':
      return 'lc_dump_char';
    case 'int[]':
      return 'lc_dump_i32_vec';
    case 'long[]':
      return 'lc_dump_i64_vec';
    case 'double[]':
      return 'lc_dump_f64_vec';
    case 'bool[]':
      return 'lc_dump_bool_vec';
    case 'string[]':
      return 'lc_dump_string_vec';
    case 'char[]':
      return 'lc_dump_char_vec';
    case 'int[][]':
      return 'lc_dump_i32_matrix';
    case 'char[][]':
      return 'lc_dump_char_matrix';
    case 'string[][]':
      return 'lc_dump_string_matrix';
    case 'listnode':
      return 'lc_dump_list';
    case 'listnode[]':
      return 'lc_dump_list_vec';
    case 'treenode':
      return 'lc_dump_tree';
    case 'treenode[]':
      return 'lc_dump_tree_vec';
    default:
      return 'lc_dump_json';
  }
}

const RUST_JSON = String.raw`// ===== 极简 JSON 解析（不引入任何第三方 crate）=====
#[derive(Debug, Clone)]
enum LcJson {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Arr(Vec<LcJson>),
    Obj(Vec<(String, LcJson)>),
}

static LC_JNULL: LcJson = LcJson::Null;

fn lc_utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

struct LcParser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> LcParser<'a> {
    fn new(text: &'a str) -> LcParser<'a> {
        LcParser { s: text.as_bytes(), i: 0 }
    }

    fn skip_ws(&mut self) {
        while self.i < self.s.len() {
            let c = self.s[self.i];
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.i += 1;
            } else {
                break;
            }
        }
    }

    fn parse(&mut self) -> Option<LcJson> {
        self.skip_ws();
        if self.i >= self.s.len() {
            return None;
        }
        match self.s[self.i] {
            b'{' => self.parse_obj(),
            b'[' => self.parse_arr(),
            b'"' => self.parse_str().map(LcJson::Str),
            b't' => {
                if self.s[self.i..].starts_with(b"true") {
                    self.i += 4;
                    Some(LcJson::Bool(true))
                } else {
                    None
                }
            }
            b'f' => {
                if self.s[self.i..].starts_with(b"false") {
                    self.i += 5;
                    Some(LcJson::Bool(false))
                } else {
                    None
                }
            }
            b'n' => {
                if self.s[self.i..].starts_with(b"null") {
                    self.i += 4;
                    Some(LcJson::Null)
                } else {
                    None
                }
            }
            _ => self.parse_num(),
        }
    }

    fn parse_num(&mut self) -> Option<LcJson> {
        let start = self.i;
        while self.i < self.s.len() {
            let c = self.s[self.i];
            if c.is_ascii_digit() || c == b'-' || c == b'+' || c == b'.' || c == b'e' || c == b'E' {
                self.i += 1;
            } else {
                break;
            }
        }
        if self.i == start {
            return None;
        }
        let text = match std::str::from_utf8(&self.s[start..self.i]) {
            Ok(t) => t,
            Err(_) => return None,
        };
        if text.parse::<f64>().is_err() {
            return None;
        }
        Some(LcJson::Num(text.to_string()))
    }

    fn parse_str(&mut self) -> Option<String> {
        if self.i >= self.s.len() || self.s[self.i] != b'"' {
            return None;
        }
        self.i += 1;
        let mut out = String::new();
        while self.i < self.s.len() {
            let c = self.s[self.i];
            if c == b'"' {
                self.i += 1;
                return Some(out);
            }
            if c == b'\\' {
                self.i += 1;
                if self.i >= self.s.len() {
                    break;
                }
                let e = self.s[self.i];
                self.i += 1;
                match e {
                    b'n' => out.push('\n'),
                    b't' => out.push('\t'),
                    b'r' => out.push('\r'),
                    b'b' => out.push('\u{8}'),
                    b'f' => out.push('\u{c}'),
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'u' => {
                        if self.i + 4 > self.s.len() {
                            return Some(out);
                        }
                        let hex = match std::str::from_utf8(&self.s[self.i..self.i + 4]) {
                            Ok(t) => t,
                            Err(_) => return Some(out),
                        };
                        self.i += 4;
                        if let Ok(code) = u32::from_str_radix(hex, 16) {
                            if let Some(ch) = std::char::from_u32(code) {
                                out.push(ch);
                            }
                        }
                    }
                    _ => out.push(e as char),
                }
            } else if c < 0x80 {
                out.push(c as char);
                self.i += 1;
            } else {
                let len = lc_utf8_len(c);
                let end = if self.i + len > self.s.len() { self.s.len() } else { self.i + len };
                if let Ok(chunk) = std::str::from_utf8(&self.s[self.i..end]) {
                    out.push_str(chunk);
                }
                self.i = end;
            }
        }
        Some(out)
    }

    fn parse_arr(&mut self) -> Option<LcJson> {
        self.i += 1;
        let mut items: Vec<LcJson> = Vec::new();
        self.skip_ws();
        if self.i < self.s.len() && self.s[self.i] == b']' {
            self.i += 1;
            return Some(LcJson::Arr(items));
        }
        while self.i < self.s.len() {
            let v = match self.parse() {
                Some(v) => v,
                None => break,
            };
            items.push(v);
            self.skip_ws();
            if self.i >= self.s.len() {
                break;
            }
            let c = self.s[self.i];
            self.i += 1;
            if c == b',' {
                continue;
            }
            break;
        }
        Some(LcJson::Arr(items))
    }

    fn parse_obj(&mut self) -> Option<LcJson> {
        self.i += 1;
        let mut items: Vec<(String, LcJson)> = Vec::new();
        self.skip_ws();
        if self.i < self.s.len() && self.s[self.i] == b'}' {
            self.i += 1;
            return Some(LcJson::Obj(items));
        }
        while self.i < self.s.len() {
            let key = match self.parse_str() {
                Some(k) => k,
                None => break,
            };
            self.skip_ws();
            if self.i < self.s.len() && self.s[self.i] == b':' {
                self.i += 1;
            }
            let val = match self.parse() {
                Some(v) => v,
                None => break,
            };
            items.push((key, val));
            self.skip_ws();
            if self.i >= self.s.len() {
                break;
            }
            let c = self.s[self.i];
            self.i += 1;
            if c == b',' {
                continue;
            }
            break;
        }
        Some(LcJson::Obj(items))
    }
}

fn lc_j_parse(text: &str) -> Option<LcJson> {
    let mut p = LcParser::new(text);
    p.parse()
}

fn lc_j_at<'a>(args: &'a [LcJson], i: usize) -> &'a LcJson {
    match args.get(i) {
        Some(v) => v,
        None => &LC_JNULL,
    }
}

fn lc_j_field<'a>(v: &'a LcJson, name: &str) -> &'a LcJson {
    if let LcJson::Obj(kv) = v {
        for (k, val) in kv.iter() {
            if k.as_str() == name {
                return val;
            }
        }
    }
    &LC_JNULL
}

fn lc_j_arr<'a>(v: &'a LcJson) -> &'a [LcJson] {
    match v {
        LcJson::Arr(a) => a.as_slice(),
        _ => &[],
    }
}

fn lc_j_is_null(v: &LcJson) -> bool {
    matches!(v, LcJson::Null)
}

fn lc_str_to_i64(s: &str) -> i64 {
    let t = s.trim();
    match t.parse::<i64>() {
        Ok(n) => n,
        Err(_) => match t.parse::<f64>() {
            Ok(f) => f as i64,
            Err(_) => {
                if t == "true" {
                    1
                } else {
                    0
                }
            }
        },
    }
}

fn lc_j_i64(v: &LcJson) -> i64 {
    match v {
        LcJson::Num(s) => lc_str_to_i64(s),
        LcJson::Bool(b) => {
            if *b {
                1
            } else {
                0
            }
        }
        LcJson::Str(s) => lc_str_to_i64(s),
        _ => 0,
    }
}

fn lc_j_f64(v: &LcJson) -> f64 {
    match v {
        LcJson::Num(s) => s.trim().parse::<f64>().unwrap_or(0.0),
        LcJson::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        LcJson::Str(s) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn lc_j_bool(v: &LcJson) -> bool {
    match v {
        LcJson::Bool(b) => *b,
        LcJson::Str(s) => {
            let t = s.trim().to_lowercase();
            t == "true" || t == "1"
        }
        LcJson::Num(s) => s.trim().parse::<f64>().unwrap_or(0.0) != 0.0,
        _ => false,
    }
}

fn lc_j_string(v: &LcJson) -> String {
    match v {
        LcJson::Str(s) => s.clone(),
        LcJson::Num(s) => s.clone(),
        LcJson::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        LcJson::Null => String::new(),
        other => lc_j_dump(other),
    }
}

fn lc_j_char(v: &LcJson) -> char {
    let s = lc_j_string(v);
    s.chars().next().unwrap_or(' ')
}

fn lc_j_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn lc_num_str(n: f64) -> String {
    if n == n.trunc() && n.abs() < 1e15 {
        let i = n as i64;
        i.to_string()
    } else {
        n.to_string()
    }
}

fn lc_j_dump(v: &LcJson) -> String {
    match v {
        LcJson::Null => "null".to_string(),
        LcJson::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        LcJson::Num(s) => s.clone(),
        LcJson::Str(s) => lc_j_quote(s),
        LcJson::Arr(a) => {
            let items: Vec<String> = a.iter().map(lc_j_dump).collect();
            format!("[{}]", items.join(","))
        }
        LcJson::Obj(kv) => {
            let items: Vec<String> = kv
                .iter()
                .map(|(k, val)| format!("{}:{}", lc_j_quote(k), lc_j_dump(val)))
                .collect();
            format!("{{{}}}", items.join(","))
        }
    }
}
`;

const RUST_CONVERT = String.raw`// ===== 用例参数 → Rust 值 =====
fn lc_as_i32_vec(v: &LcJson) -> Vec<i32> {
    lc_j_arr(v).iter().map(|x| lc_j_i64(x) as i32).collect()
}

fn lc_as_i64_vec(v: &LcJson) -> Vec<i64> {
    lc_j_arr(v).iter().map(lc_j_i64).collect()
}

fn lc_as_f64_vec(v: &LcJson) -> Vec<f64> {
    lc_j_arr(v).iter().map(lc_j_f64).collect()
}

fn lc_as_bool_vec(v: &LcJson) -> Vec<bool> {
    lc_j_arr(v).iter().map(lc_j_bool).collect()
}

fn lc_as_string_vec(v: &LcJson) -> Vec<String> {
    lc_j_arr(v).iter().map(lc_j_string).collect()
}

fn lc_as_char_vec(v: &LcJson) -> Vec<char> {
    match v {
        LcJson::Str(s) => s.chars().collect(),
        _ => lc_j_arr(v).iter().map(lc_j_char).collect(),
    }
}

fn lc_as_i32_matrix(v: &LcJson) -> Vec<Vec<i32>> {
    lc_j_arr(v).iter().map(lc_as_i32_vec).collect()
}

fn lc_as_string_matrix(v: &LcJson) -> Vec<Vec<String>> {
    lc_j_arr(v).iter().map(lc_as_string_vec).collect()
}

fn lc_as_char_matrix(v: &LcJson) -> Vec<Vec<char>> {
    lc_j_arr(v).iter().map(lc_as_char_vec).collect()
}

fn lc_build_list(vals: &[i32]) -> Option<Box<ListNode>> {
    if vals.is_empty() {
        return None;
    }
    Some(Box::new(ListNode { val: vals[0], next: lc_build_list(&vals[1..]) }))
}

fn lc_as_list(v: &LcJson) -> Option<Box<ListNode>> {
    let vals: Vec<i32> = lc_j_arr(v).iter().map(|x| lc_j_i64(x) as i32).collect();
    lc_build_list(&vals)
}

fn lc_as_list_vec(v: &LcJson) -> Vec<Option<Box<ListNode>>> {
    lc_j_arr(v).iter().map(lc_as_list).collect()
}

fn lc_build_tree(vals: &[LcJson]) -> Option<Rc<RefCell<TreeNode>>> {
    if vals.is_empty() {
        return None;
    }
    if lc_j_is_null(&vals[0]) {
        return None;
    }
    let root = Rc::new(RefCell::new(TreeNode { val: lc_j_i64(&vals[0]) as i32, left: None, right: None }));
    let mut queue: std::collections::VecDeque<Rc<RefCell<TreeNode>>> = std::collections::VecDeque::new();
    queue.push_back(root.clone());
    let mut i: usize = 1;
    while !queue.is_empty() && i < vals.len() {
        let node = match queue.pop_front() {
            Some(n) => n,
            None => break,
        };
        if i < vals.len() {
            if !lc_j_is_null(&vals[i]) {
                let child = Rc::new(RefCell::new(TreeNode { val: lc_j_i64(&vals[i]) as i32, left: None, right: None }));
                node.borrow_mut().left = Some(child.clone());
                queue.push_back(child);
            }
            i += 1;
        }
        if i < vals.len() {
            if !lc_j_is_null(&vals[i]) {
                let child = Rc::new(RefCell::new(TreeNode { val: lc_j_i64(&vals[i]) as i32, left: None, right: None }));
                node.borrow_mut().right = Some(child.clone());
                queue.push_back(child);
            }
            i += 1;
        }
    }
    Some(root)
}

fn lc_as_tree(v: &LcJson) -> Option<Rc<RefCell<TreeNode>>> {
    lc_build_tree(lc_j_arr(v))
}

fn lc_as_tree_vec(v: &LcJson) -> Vec<Option<Rc<RefCell<TreeNode>>>> {
    lc_j_arr(v).iter().map(lc_as_tree).collect()
}
`;

const RUST_DUMP = String.raw`// ===== Rust 值 → 字符串（LeetCode 习惯）=====
fn lc_dump_i32(v: &i32) -> String {
    v.to_string()
}

fn lc_dump_i64(v: &i64) -> String {
    v.to_string()
}

fn lc_dump_f64(v: &f64) -> String {
    lc_num_str(*v)
}

fn lc_dump_bool(v: &bool) -> String {
    if *v {
        "true".to_string()
    } else {
        "false".to_string()
    }
}

fn lc_dump_string(v: &String) -> String {
    v.clone()
}

fn lc_dump_char(v: &char) -> String {
    v.to_string()
}

fn lc_dump_i32_vec(v: &Vec<i32>) -> String {
    let items: Vec<String> = v.iter().map(|x| x.to_string()).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_i64_vec(v: &Vec<i64>) -> String {
    let items: Vec<String> = v.iter().map(|x| x.to_string()).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_f64_vec(v: &Vec<f64>) -> String {
    let items: Vec<String> = v.iter().map(|x| lc_num_str(*x)).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_bool_vec(v: &Vec<bool>) -> String {
    let items: Vec<String> = v.iter().map(lc_dump_bool).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_string_vec(v: &Vec<String>) -> String {
    let items: Vec<String> = v.iter().map(|x| lc_j_quote(x)).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_char_vec(v: &Vec<char>) -> String {
    let items: Vec<String> = v.iter().map(|c| lc_j_quote(&c.to_string())).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_i32_matrix(v: &Vec<Vec<i32>>) -> String {
    let items: Vec<String> = v.iter().map(lc_dump_i32_vec).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_string_matrix(v: &Vec<Vec<String>>) -> String {
    let items: Vec<String> = v.iter().map(lc_dump_string_vec).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_char_matrix(v: &Vec<Vec<char>>) -> String {
    let items: Vec<String> = v.iter().map(lc_dump_char_vec).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_list(node: &Option<Box<ListNode>>) -> String {
    let mut items: Vec<String> = Vec::new();
    let mut cur: Option<&Box<ListNode>> = node.as_ref();
    let mut count: usize = 0;
    while let Some(n) = cur {
        items.push(n.val.to_string());
        cur = n.next.as_ref();
        count += 1;
        if count > 100000 {
            break;
        }
    }
    format!("[{}]", items.join(","))
}

fn lc_dump_list_vec(v: &Vec<Option<Box<ListNode>>>) -> String {
    let items: Vec<String> = v.iter().map(lc_dump_list).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_tree(root: &Option<Rc<RefCell<TreeNode>>>) -> String {
    if root.is_none() {
        return "[]".to_string();
    }
    let mut out: Vec<String> = Vec::new();
    let mut q: std::collections::VecDeque<Option<Rc<RefCell<TreeNode>>>> = std::collections::VecDeque::new();
    q.push_back(root.clone());
    while let Some(item) = q.pop_front() {
        match item {
            None => out.push("null".to_string()),
            Some(node) => {
                let n = node.borrow();
                out.push(n.val.to_string());
                q.push_back(n.left.clone());
                q.push_back(n.right.clone());
            }
        }
    }
    while out.last().map(|s| s.as_str() == "null").unwrap_or(false) {
        out.pop();
    }
    format!("[{}]", out.join(","))
}

fn lc_dump_tree_vec(v: &Vec<Option<Rc<RefCell<TreeNode>>>>) -> String {
    let items: Vec<String> = v.iter().map(lc_dump_tree).collect();
    format!("[{}]", items.join(","))
}

fn lc_dump_json(v: &LcJson) -> String {
    lc_j_dump(v)
}
`;

const RUST_MAIN = String.raw`// ===== 输出协议 + main =====
const LC_ENTRY_FOUND: bool = __LC_ENTRY_FOUND__;

fn lc_cases_path() -> String {
    if let Ok(wd) = std::env::current_dir() {
        let p = wd.join("_lc_cases.json");
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("_lc_cases.json");
            if p.exists() {
                return p.to_string_lossy().to_string();
            }
        }
    }
    "_lc_cases.json".to_string()
}

fn lc_fatal(reason: &str) {
    println!("__LC_ERROR__ {{\"fatal\":{}}}", lc_j_quote(reason));
}

fn lc_done(ms: i64) {
    println!("__LC_DONE__ {{\"elapsedMs\":{}}}", ms);
}

fn lc_print_result(i: i64, actual: &str, err: &Option<String>, duration_ms: i64) {
    let e = match err {
        Some(m) => lc_j_quote(m),
        None => "null".to_string(),
    };
    println!(
        "__LC_RESULT__ {{\"i\":{},\"actual\":{},\"error\":{},\"durationMs\":{}}}",
        i,
        lc_j_quote(actual),
        e,
        duration_ms
    );
}

fn lc_panic_msg(e: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = e.downcast_ref::<&str>() {
        return s.to_string();
    }
    if let Some(s) = e.downcast_ref::<String>() {
        return s.clone();
    }
    "panic".to_string()
}

fn main() {
    let started = std::time::Instant::now();
    let path = lc_cases_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            lc_fatal("cases_read_error");
            return;
        }
    };
    let root = match lc_j_parse(&text) {
        Some(v) => v,
        None => {
            lc_fatal("cases_parse_error");
            return;
        }
    };
    if !LC_ENTRY_FOUND {
        lc_fatal("entry_not_found");
        return;
    }
    let cases = lc_j_field(&root, "cases");
    for c in lc_j_arr(cases) {
        let idx = lc_j_i64(lc_j_field(c, "i"));
        let args = lc_j_field(c, "args");
        let t0 = std::time::Instant::now();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| lc_run(idx, lc_j_arr(args))));
        let duration = t0.elapsed().as_millis() as i64;
        match outcome {
            Ok(pair) => lc_print_result(idx, &pair.0, &pair.1, duration),
            Err(e) => lc_print_result(idx, "", &Some(lc_panic_msg(&e)), duration),
        }
    }
    lc_done(started.elapsed().as_millis() as i64);
}
`;

const LIST_NODE_DEF = `#[derive(PartialEq, Eq, Clone, Debug)]
pub struct ListNode {
    pub val: i32,
    pub next: Option<Box<ListNode>>,
}

impl ListNode {
    #[inline]
    pub fn new(val: i32) -> Self {
        ListNode { next: None, val }
    }
}`;

const TREE_NODE_DEF = `#[derive(Debug, PartialEq, Eq)]
pub struct TreeNode {
    pub val: i32,
    pub left: Option<Rc<RefCell<TreeNode>>>,
    pub right: Option<Rc<RefCell<TreeNode>>>,
}

impl TreeNode {
    #[inline]
    pub fn new(val: i32) -> Self {
        TreeNode { val, left: None, right: None }
    }
}`;

interface RustEntryInfo {
  found: boolean;
  /** LeetCode 的 Rust 方法默认是关联函数 Solution::f(...)；少数人写成 &self 方法 */
  takesSelf: boolean;
}

function detectEntry(source: string, name: string): RustEntryInfo {
  const stripped = stripComments(source);
  const candidates = [...new Set([snakeCase(name), name])].filter(Boolean);
  for (const c of candidates) {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fnRe = new RegExp(`\\bfn\\s+${escaped}\\s*\\(`);
    if (!fnRe.test(stripped)) continue;
    const selfRe = new RegExp(`\\bfn\\s+${escaped}\\s*\\(\\s*(&\\s*'(\\w+)\\s*)?(&\\s*)?(mut\\s+)?self\\b`);
    return { found: true, takesSelf: selfRe.test(stripped) };
  }
  return { found: false, takesSelf: false };
}

/** 生成 lc_run：按用例索引分派，调用用户函数并序列化结果。 */
function buildRun(input: HarnessInput, entry: RustEntryInfo): string {
  const params = input.meta.params ?? [];
  const returnKind = classifyType(input.meta.return?.type ?? 'void');
  const names = [...new Set([snakeCase(input.meta.name), input.meta.name])].filter(Boolean);
  const methodName = names[0];
  const lines: string[] = [];
  lines.push('fn lc_run(i: i64, args: &[LcJson]) -> (String, Option<String>) {');
  if (!entry.found) {
    lines.push('    let _ = (i, args);');
    lines.push('    (String::new(), Some("entry_not_found".to_string()))');
    lines.push('}');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('    match i {');
  for (const c of input.testCases) {
    lines.push(`        ${c.index} => {`);
    params.forEach((p, idx) => {
      const kind = classifyType(p.type);
      const mutKw = returnKind === 'void' && CONTAINER_KINDS.includes(kind) ? 'mut ' : '';
      lines.push(`            let ${mutKw}a${idx} = ${argExpr(kind, `lc_j_at(args, ${idx})`)};`);
    });
    const argList = params
      .map((p, idx) => {
        const kind = classifyType(p.type);
        return returnKind === 'void' && CONTAINER_KINDS.includes(kind) ? `&mut a${idx}` : `a${idx}`;
      })
      .join(', ');
    const call = entry.takesSelf
      ? `(Solution {}).${methodName}(${argList})`
      : `Solution::${methodName}(${argList})`;
    const outExpr =
      returnKind === 'void'
        ? params.length > 0
          ? `${dumpFn(classifyType(params[0].type))}(&a0)`
          : '"null".to_string()'
        : `${dumpFn(returnKind)}(&ret)`;
    if (returnKind === 'void') {
      lines.push(`            ${call};`);
    } else {
      lines.push(`            let ret = ${call};`);
    }
    lines.push(`            (${outExpr}, None)`);
    lines.push('        }');
  }
  lines.push('        _ => (String::new(), Some("case_not_found".to_string())),');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function buildMainFile(input: HarnessInput): string {
  const source = input.sourceCode ?? '';
  const stripped = stripComments(source);
  const params = input.meta.params ?? [];
  const kinds = [...params.map((p) => classifyType(p.type)), classifyType(input.meta.return?.type ?? 'void')];
  const needsList = kinds.includes('listnode') || kinds.includes('listnode[]') || /\bListNode\b/.test(stripped);
  const needsTree =
    kinds.includes('treenode') || kinds.includes('treenode[]') || /RefCell|\bRc\b|\bTreeNode\b/.test(stripped);
  const userHasList = /\bstruct\s+ListNode\b/.test(stripped);
  const userHasTree = /\bstruct\s+TreeNode\b/.test(stripped);
  const userHasSolution = /\bstruct\s+Solution\b/.test(stripped);

  const prelude: string[] = ['// ===== leetcode-local-ide：自动生成的本地测试脚手架，不修改你的源文件 ====='];
  if (needsTree && !/use\s+std::cell/.test(stripped)) prelude.push('use std::cell::RefCell;');
  if (needsTree && !/use\s+std::rc/.test(stripped)) prelude.push('use std::rc::Rc;');
  if (!userHasSolution) prelude.push('struct Solution;');
  if (needsList && !userHasList) prelude.push(LIST_NODE_DEF);
  if (needsTree && !userHasTree) prelude.push(TREE_NODE_DEF);

  const entry = detectEntry(source, input.meta.name);
  const parts = [
    prelude.join('\n\n'),
    '// ===== 以下为你的代码（原样嵌入）=====',
    source.trim() ? source : '// (空)',
    '// ===== 以下为自动生成的运行器 =====',
    RUST_JSON,
    RUST_CONVERT,
    RUST_DUMP,
    buildRun(input, entry),
    RUST_MAIN.replace('__LC_ENTRY_FOUND__', entry.found ? 'true' : 'false'),
  ];
  return parts.join('\n\n');
}

export const RustHarness: LanguageHarness = {
  slug: 'rust',
  installHint: '需要本地安装 Rust 工具链（命令行可用 `rustc --version` 验证）。',
  supports(meta: LcMetaData): HarnessSupport {
    return checkSupports(meta);
  },
  generate(input: HarnessInput): HarnessArtifact {
    const files: HarnessFile[] = [
      { name: CASES_FILE, content: serializeCases(input) },
      { name: '_lc_main.rs', content: buildMainFile(input) },
    ];
    return {
      files,
      steps: [
        { label: 'compile', cmd: 'rustc', args: ['-O', '-o', '_lc_bin', '_lc_main.rs'], fatal: true },
        { label: 'run', cmd: './_lc_bin', args: [], fatal: false },
      ],
      debugEntry: '_lc_main.rs',
      debugType: 'lldb',
      notes: [
        '用户代码被原样嵌入 genDir/_lc_main.rs（不用 include!，避免相对路径问题），源文件不会被改动。',
        '不引入第三方 crate：内置了一个极简 JSON 解析器。',
        'LeetCode 的 Rust 方法按关联函数调用（Solution::two_sum）；写成 &self 方法也能识别。',
        'void 返回（原地修改）时，容器类参数按 &mut 传入，答案取第一个参数。',
      ],
    };
  },
};
