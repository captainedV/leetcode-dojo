/**
 * C 本地测试脚手架（gcc / clang，C11）。
 *
 * 与 C++ 版思路一致：生成物只写 `input.genDir`，用绝对路径 `#include` 引用用户代码
 * （因此 genDir 与用户目录可以不同），统一输出 `__LC_RESULT__` / `__LC_ERROR__` /
 * `__LC_DONE__` 协议行，actual 一律是字符串。
 *
 * C 语言的特殊约定（与 LeetCode 官方 C 判题机一致）：
 *  - 数组参数是 `(T* data, int dataSize)` 成对出现；
 *  - 二维数组是 `(T** rows, int rowsSize, int* rowsColSize)`；
 *  - 返回数组要额外传 `int* returnSize`，二维还要 `int** returnColumnSizes`；
 *  - 链表 `struct ListNode`、树 `struct TreeNode` 由脚手架提供定义。
 * 无法静态承接的类型（json / string[][] / ListNode[] / TreeNode[] / 图等）如实返回
 * `{ ok: false }`，不硬撑。
 */
import { join } from 'node:path';
import type { LcMetaData } from '../../core/types.js';
import type {
  HarnessArtifact,
  HarnessFile,
  HarnessInput,
  HarnessSupport,
  LanguageHarness,
} from './types.js';
import type { TypeKind } from './types.js';
import { CASES_FILE, classifyType, inPlaceAnswerParam, serializeCases } from './types.js';

/** 一个变量（参数或返回值）在 C 里的所有相关名字 */
interface CVarRef {
  /** 值本身 */
  value: string;
  /** 一维数组长度 */
  size: string;
  /** 二维数组行数 */
  rows: string;
  /** 二维数组列数 */
  cols: string;
}

/** C 里能承接的参数类型 → 声明 + 传给函数的名字 */
function cArgFor(kind: TypeKind, i: number): { lines: string[]; names: string[] } | null {
  const a = `a${i}`;
  switch (kind) {
    case 'int':
      return { lines: [`int ${a} = lc_to_int(lc_arg(args, ${i}));`], names: [a] };
    case 'long':
      return { lines: [`long long ${a} = lc_to_ll(lc_arg(args, ${i}));`], names: [a] };
    case 'double':
      return { lines: [`double ${a} = lc_to_double(lc_arg(args, ${i}));`], names: [a] };
    case 'bool':
      return { lines: [`bool ${a} = lc_to_bool(lc_arg(args, ${i}));`], names: [a] };
    case 'string':
      return { lines: [`char *${a} = lc_to_str(lc_arg(args, ${i}));`], names: [a] };
    case 'char':
      return { lines: [`char ${a} = lc_to_char(lc_arg(args, ${i}));`], names: [a] };
    case 'int[]':
      return {
        lines: [`int ${a}_size = 0;`, `int *${a} = lc_to_int_arr(lc_arg(args, ${i}), &${a}_size);`],
        names: [a, `${a}_size`],
      };
    case 'long[]':
      return {
        lines: [
          `int ${a}_size = 0;`,
          `long long *${a} = lc_to_ll_arr(lc_arg(args, ${i}), &${a}_size);`,
        ],
        names: [a, `${a}_size`],
      };
    case 'double[]':
      return {
        lines: [
          `int ${a}_size = 0;`,
          `double *${a} = lc_to_double_arr(lc_arg(args, ${i}), &${a}_size);`,
        ],
        names: [a, `${a}_size`],
      };
    case 'bool[]':
      return {
        lines: [
          `int ${a}_size = 0;`,
          `bool *${a} = lc_to_bool_arr(lc_arg(args, ${i}), &${a}_size);`,
        ],
        names: [a, `${a}_size`],
      };
    case 'string[]':
      return {
        lines: [
          `int ${a}_size = 0;`,
          `char **${a} = lc_to_str_arr(lc_arg(args, ${i}), &${a}_size);`,
        ],
        names: [a, `${a}_size`],
      };
    case 'char[]':
      return {
        lines: [
          `int ${a}_size = 0;`,
          `char *${a} = lc_to_char_arr(lc_arg(args, ${i}), &${a}_size);`,
        ],
        names: [a, `${a}_size`],
      };
    case 'int[][]':
      return {
        lines: [
          `int ${a}_rows = 0;`,
          `int *${a}_cols = NULL;`,
          `int **${a} = lc_to_int_mat(lc_arg(args, ${i}), &${a}_rows, &${a}_cols);`,
        ],
        names: [a, `${a}_rows`, `${a}_cols`],
      };
    case 'char[][]':
      return {
        lines: [
          `int ${a}_rows = 0;`,
          `int *${a}_cols = NULL;`,
          `char **${a} = lc_to_char_mat(lc_arg(args, ${i}), &${a}_rows, &${a}_cols);`,
        ],
        names: [a, `${a}_rows`, `${a}_cols`],
      };
    case 'listnode':
      return { lines: [`struct ListNode *${a} = lc_make_list(lc_arg(args, ${i}));`], names: [a] };
    case 'treenode':
      return { lines: [`struct TreeNode *${a} = lc_make_tree(lc_arg(args, ${i}));`], names: [a] };
    default:
      return null;
  }
}

/** 返回值声明（含 LeetCode 约定的 returnSize / returnColumnSizes 出参） */
function cReturnFor(kind: TypeKind): { decl: string; extraDecls: string[]; callExtras: string[] } | null {
  switch (kind) {
    case 'int':
      return { decl: 'int ret', extraDecls: [], callExtras: [] };
    case 'long':
      return { decl: 'long long ret', extraDecls: [], callExtras: [] };
    case 'double':
      return { decl: 'double ret', extraDecls: [], callExtras: [] };
    case 'bool':
      return { decl: 'bool ret', extraDecls: [], callExtras: [] };
    case 'string':
      return { decl: 'char *ret', extraDecls: [], callExtras: [] };
    case 'char':
      return { decl: 'char ret', extraDecls: [], callExtras: [] };
    case 'int[]':
      return { decl: 'int *ret', extraDecls: ['int _ret_size = 0;'], callExtras: ['&_ret_size'] };
    case 'long[]':
      return {
        decl: 'long long *ret',
        extraDecls: ['int _ret_size = 0;'],
        callExtras: ['&_ret_size'],
      };
    case 'double[]':
      return {
        decl: 'double *ret',
        extraDecls: ['int _ret_size = 0;'],
        callExtras: ['&_ret_size'],
      };
    case 'bool[]':
      return { decl: 'bool *ret', extraDecls: ['int _ret_size = 0;'], callExtras: ['&_ret_size'] };
    case 'string[]':
      return { decl: 'char **ret', extraDecls: ['int _ret_size = 0;'], callExtras: ['&_ret_size'] };
    case 'char[]':
      return { decl: 'char *ret', extraDecls: ['int _ret_size = 0;'], callExtras: ['&_ret_size'] };
    case 'int[][]':
      return {
        decl: 'int **ret',
        extraDecls: ['int _ret_size = 0;', 'int *_ret_cols = NULL;'],
        callExtras: ['&_ret_size', '&_ret_cols'],
      };
    case 'char[][]':
      return {
        decl: 'char **ret',
        extraDecls: ['int _ret_size = 0;', 'int *_ret_cols = NULL;'],
        callExtras: ['&_ret_size', '&_ret_cols'],
      };
    case 'listnode':
      return { decl: 'struct ListNode *ret', extraDecls: [], callExtras: [] };
    case 'treenode':
      return { decl: 'struct TreeNode *ret', extraDecls: [], callExtras: [] };
    default:
      return null;
  }
}

/** 把某个变量的值按 LeetCode 习惯序列化进输出缓冲 `out` */
function cDump(ref: CVarRef, kind: TypeKind): string[] | null {
  const v = ref.value;
  switch (kind) {
    case 'int':
      return [`lc_dump_int(&out, ${v});`];
    case 'long':
      return [`lc_dump_ll(&out, ${v});`];
    case 'double':
      return [`lc_dump_double(&out, ${v});`];
    case 'bool':
      return [`lc_dump_bool(&out, ${v});`];
    case 'string':
      return [`lc_dump_str(&out, ${v});`];
    case 'char':
      return [`lc_dump_char(&out, ${v});`];
    case 'int[]':
      return [`lc_dump_int_arr(&out, ${v}, ${ref.size});`];
    case 'long[]':
      return [`lc_dump_ll_arr(&out, ${v}, ${ref.size});`];
    case 'double[]':
      return [`lc_dump_double_arr(&out, ${v}, ${ref.size});`];
    case 'bool[]':
      return [`lc_dump_bool_arr(&out, ${v}, ${ref.size});`];
    case 'string[]':
      return [`lc_dump_str_arr(&out, ${v}, ${ref.size});`];
    case 'char[]':
      return [`lc_dump_char_arr(&out, ${v}, ${ref.size});`];
    case 'int[][]':
      return [`lc_dump_int_mat(&out, ${v}, ${ref.rows}, ${ref.cols});`];
    case 'char[][]':
      return [`lc_dump_char_mat(&out, ${v}, ${ref.rows}, ${ref.cols});`];
    case 'listnode':
      return [`lc_dump_list(&out, ${v});`];
    case 'treenode':
      return [`lc_dump_tree(&out, ${v});`];
    default:
      return null;
  }
}

/** C 脚手架能承接的类型（参数与返回值共用一张表） */
const C_SUPPORTED_KINDS: TypeKind[] = [
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
  'int[][]',
  'char[][]',
  'listnode',
  'treenode',
  'void',
];

const C_PRELUDE = String.raw`/* 自动生成：LeetCode 本地测试脚手架公共头（请勿手改） */
#ifndef LC_PRELUDE_H_
#define LC_PRELUDE_H_

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdarg.h>
#include <ctype.h>
#include <math.h>
#include <limits.h>
#include <float.h>
#include <sys/time.h>

/* 节点结构体只做前置声明，完整定义在 _lc_nodes.h */
struct ListNode;
struct TreeNode;

/* ===================== 输出缓冲 ===================== */

typedef struct {
  char *buf;
  size_t len;
  size_t cap;
} lc_sb;

static void lc_sb_init(lc_sb *s) {
  s->buf = NULL;
  s->len = 0;
  s->cap = 0;
}

static void lc_sb_reserve(lc_sb *s, size_t extra) {
  size_t need = s->len + extra + 1;
  size_t cap;
  if (need <= s->cap) return;
  cap = s->cap ? s->cap : 64;
  while (cap < need) cap *= 2;
  s->buf = (char *)realloc(s->buf, cap);
  if (!s->buf) {
    fprintf(stderr, "lc: out of memory\n");
    exit(70);
  }
  s->cap = cap;
}

static void lc_sb_putn(lc_sb *s, const char *p, size_t n) {
  if (!p || n == 0) return;
  lc_sb_reserve(s, n);
  memcpy(s->buf + s->len, p, n);
  s->len += n;
  s->buf[s->len] = '\0';
}

static void lc_sb_putc(lc_sb *s, char c) { lc_sb_putn(s, &c, 1); }

static void lc_sb_puts(lc_sb *s, const char *p) {
  if (p) lc_sb_putn(s, p, strlen(p));
}

static void lc_sb_printf(lc_sb *s, const char *fmt, ...) {
  char tmp[1024];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(tmp, sizeof(tmp), fmt, ap);
  va_end(ap);
  lc_sb_puts(s, tmp);
}

static const char *lc_sb_cstr(lc_sb *s) { return s->buf ? s->buf : ""; }

static void lc_sb_free(lc_sb *s) {
  free(s->buf);
  s->buf = NULL;
  s->len = 0;
  s->cap = 0;
}

static char *lc_empty_str(void) {
  char *s = (char *)malloc(1);
  if (!s) {
    fprintf(stderr, "lc: out of memory\n");
    exit(70);
  }
  s[0] = '\0';
  return s;
}

static char *lc_str_dup(const char *text) {
  size_t n;
  char *out;
  if (!text) return lc_empty_str();
  n = strlen(text);
  out = (char *)malloc(n + 1);
  if (!out) {
    fprintf(stderr, "lc: out of memory\n");
    exit(70);
  }
  memcpy(out, text, n + 1);
  return out;
}

/* ===================== 极简 JSON ===================== */

typedef enum { LC_JNULL = 0, LC_JBOOL, LC_JNUM, LC_JSTR, LC_JARR, LC_JOBJ } lc_jkind;

typedef struct lc_json {
  lc_jkind kind;
  bool b;
  double num;
  char *num_text; /* NUM 的原文，保证整数精确 */
  char *str;      /* STR 的值 */
  struct lc_json **items;
  char **keys;
  struct lc_json **vals;
  int len;
  int cap;
} lc_json;

typedef struct {
  const char *s;
  size_t n;
  size_t i;
} lc_jparser;

static lc_json *lc_json_new(lc_jkind kind) {
  lc_json *j = (lc_json *)calloc(1, sizeof(lc_json));
  if (!j) {
    fprintf(stderr, "lc: out of memory\n");
    exit(70);
  }
  j->kind = kind;
  return j;
}

static void lc_json_grow(lc_json *parent) {
  int cap;
  if (parent->len < parent->cap) return;
  cap = parent->cap ? parent->cap * 2 : 8;
  parent->items = (lc_json **)realloc(parent->items, sizeof(lc_json *) * (size_t)cap);
  if (!parent->items) {
    fprintf(stderr, "lc: out of memory\n");
    exit(70);
  }
  if (parent->kind == LC_JOBJ) {
    parent->keys = (char **)realloc(parent->keys, sizeof(char *) * (size_t)cap);
    parent->vals = (lc_json **)realloc(parent->vals, sizeof(lc_json *) * (size_t)cap);
    if (!parent->keys || !parent->vals) {
      fprintf(stderr, "lc: out of memory\n");
      exit(70);
    }
  }
  parent->cap = cap;
}

static void lc_json_add(lc_json *parent, char *key, lc_json *child) {
  lc_json_grow(parent);
  parent->items[parent->len] = child;
  if (parent->kind == LC_JOBJ) {
    parent->keys[parent->len] = key;
    parent->vals[parent->len] = child;
  }
  parent->len++;
}

static void lc_skip_ws(lc_jparser *p) {
  while (p->i < p->n) {
    char c = p->s[p->i];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
      p->i++;
      continue;
    }
    break;
  }
}

static void lc_utf8_put(lc_sb *out, unsigned cp) {
  if (cp < 0x80) {
    lc_sb_putc(out, (char)cp);
  } else if (cp < 0x800) {
    lc_sb_putc(out, (char)(0xC0 | (cp >> 6)));
    lc_sb_putc(out, (char)(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    lc_sb_putc(out, (char)(0xE0 | (cp >> 12)));
    lc_sb_putc(out, (char)(0x80 | ((cp >> 6) & 0x3F)));
    lc_sb_putc(out, (char)(0x80 | (cp & 0x3F)));
  } else {
    lc_sb_putc(out, (char)(0xF0 | (cp >> 18)));
    lc_sb_putc(out, (char)(0x80 | ((cp >> 12) & 0x3F)));
    lc_sb_putc(out, (char)(0x80 | ((cp >> 6) & 0x3F)));
    lc_sb_putc(out, (char)(0x80 | (cp & 0x3F)));
  }
}

/** 解析一个 JSON 字符串，返回 malloc 出来的 C 字符串；失败返回 NULL */
static char *lc_parse_string(lc_jparser *p) {
  lc_sb out;
  if (p->i >= p->n || p->s[p->i] != '"') return NULL;
  p->i++;
  lc_sb_init(&out);
  while (p->i < p->n) {
    char c = p->s[p->i++];
    if (c == '"') {
      return out.buf ? out.buf : lc_empty_str();
    }
    if (c != '\\') {
      lc_sb_putc(&out, c);
      continue;
    }
    if (p->i >= p->n) {
      free(out.buf);
      return NULL;
    }
    {
      char e = p->s[p->i++];
      switch (e) {
        case '"': lc_sb_putc(&out, '"'); break;
        case '\\': lc_sb_putc(&out, '\\'); break;
        case '/': lc_sb_putc(&out, '/'); break;
        case 'b': lc_sb_putc(&out, '\b'); break;
        case 'f': lc_sb_putc(&out, '\f'); break;
        case 'n': lc_sb_putc(&out, '\n'); break;
        case 'r': lc_sb_putc(&out, '\r'); break;
        case 't': lc_sb_putc(&out, '\t'); break;
        case 'u': {
          unsigned cp = 0;
          int k;
          for (k = 0; k < 4; k++) {
            char h = p->i < p->n ? p->s[p->i] : '\0';
            unsigned d;
            if (h >= '0' && h <= '9') {
              d = (unsigned)(h - '0');
            } else if (h >= 'a' && h <= 'f') {
              d = (unsigned)(h - 'a' + 10);
            } else if (h >= 'A' && h <= 'F') {
              d = (unsigned)(h - 'A' + 10);
            } else {
              free(out.buf);
              return NULL;
            }
            cp = cp * 16 + d;
            p->i++;
          }
          lc_utf8_put(&out, cp);
          break;
        }
        default:
          free(out.buf);
          return NULL;
      }
    }
  }
  free(out.buf);
  return NULL;
}

static lc_json *lc_parse_number(lc_jparser *p) {
  size_t start = p->i;
  size_t len;
  char *text;
  lc_json *j;
  bool seen = false;
  while (p->i < p->n) {
    char c = p->s[p->i];
    if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
      p->i++;
      seen = true;
      continue;
    }
    break;
  }
  if (!seen) return NULL;
  len = p->i - start;
  text = (char *)malloc(len + 1);
  if (!text) {
    fprintf(stderr, "lc: out of memory\n");
    exit(70);
  }
  memcpy(text, p->s + start, len);
  text[len] = '\0';
  j = lc_json_new(LC_JNUM);
  j->num = strtod(text, NULL);
  j->num_text = text;
  return j;
}

static lc_json *lc_parse_value(lc_jparser *p);

static lc_json *lc_parse_array(lc_jparser *p) {
  lc_json *out;
  p->i++; /* [ */
  out = lc_json_new(LC_JARR);
  lc_skip_ws(p);
  if (p->i < p->n && p->s[p->i] == ']') {
    p->i++;
    return out;
  }
  while (1) {
    lc_json *item = lc_parse_value(p);
    if (!item) return NULL;
    lc_json_add(out, NULL, item);
    lc_skip_ws(p);
    if (p->i < p->n && p->s[p->i] == ',') {
      p->i++;
      continue;
    }
    if (p->i < p->n && p->s[p->i] == ']') {
      p->i++;
      return out;
    }
    return NULL;
  }
}

static lc_json *lc_parse_object(lc_jparser *p) {
  lc_json *out;
  p->i++; /* { */
  out = lc_json_new(LC_JOBJ);
  lc_skip_ws(p);
  if (p->i < p->n && p->s[p->i] == '}') {
    p->i++;
    return out;
  }
  while (1) {
    char *key;
    lc_json *val;
    lc_skip_ws(p);
    key = lc_parse_string(p);
    if (!key) return NULL;
    lc_skip_ws(p);
    if (p->i >= p->n || p->s[p->i] != ':') return NULL;
    p->i++;
    val = lc_parse_value(p);
    if (!val) return NULL;
    lc_json_add(out, key, val);
    lc_skip_ws(p);
    if (p->i < p->n && p->s[p->i] == ',') {
      p->i++;
      continue;
    }
    if (p->i < p->n && p->s[p->i] == '}') {
      p->i++;
      return out;
    }
    return NULL;
  }
}

static lc_json *lc_parse_value(lc_jparser *p) {
  char c;
  lc_skip_ws(p);
  if (p->i >= p->n) return NULL;
  c = p->s[p->i];
  if (c == '{') return lc_parse_object(p);
  if (c == '[') return lc_parse_array(p);
  if (c == '"') {
    char *text = lc_parse_string(p);
    lc_json *j;
    if (!text) return NULL;
    j = lc_json_new(LC_JSTR);
    j->str = text;
    return j;
  }
  if (c == 't' && p->n - p->i >= 4 && strncmp(p->s + p->i, "true", 4) == 0) {
    lc_json *j;
    p->i += 4;
    j = lc_json_new(LC_JBOOL);
    j->b = true;
    return j;
  }
  if (c == 'f' && p->n - p->i >= 5 && strncmp(p->s + p->i, "false", 5) == 0) {
    lc_json *j;
    p->i += 5;
    j = lc_json_new(LC_JBOOL);
    j->b = false;
    return j;
  }
  if (c == 'n' && p->n - p->i >= 4 && strncmp(p->s + p->i, "null", 4) == 0) {
    p->i += 4;
    return lc_json_new(LC_JNULL);
  }
  return lc_parse_number(p);
}

static lc_json *lc_parse(const char *text) {
  lc_jparser p;
  if (!text) return NULL;
  p.s = text;
  p.n = strlen(text);
  p.i = 0;
  return lc_parse_value(&p);
}

static lc_json *lc_obj_get(const lc_json *obj, const char *key) {
  int k;
  if (!obj || obj->kind != LC_JOBJ) return NULL;
  for (k = 0; k < obj->len; k++) {
    if (obj->keys[k] && strcmp(obj->keys[k], key) == 0) return obj->vals[k];
  }
  return NULL;
}

/** 取用例的第 k 个参数：args 里存的是「每个参数一行原文」，再解析一层 */
static lc_json *lc_arg(const lc_json *args, int k) {
  lc_json *raw;
  if (!args || args->kind != LC_JARR || k < 0 || k >= args->len) return NULL;
  raw = args->items[k];
  if (raw && raw->kind == LC_JSTR) {
    lc_json *inner = lc_parse(raw->str);
    if (inner) return inner;
  }
  return raw;
}

/* ===================== JSON → C 值 ===================== */

static long long lc_to_ll(const lc_json *j) {
  if (!j) return 0;
  if (j->kind == LC_JNUM) {
    if (j->num_text && strpbrk(j->num_text, ".eE") == NULL) {
      return (long long)strtoll(j->num_text, NULL, 10);
    }
    return (long long)llround(j->num);
  }
  if (j->kind == LC_JBOOL) return j->b ? 1 : 0;
  if (j->kind == LC_JSTR) return (long long)strtoll(j->str, NULL, 10);
  return 0;
}

static int lc_to_int(const lc_json *j) { return (int)lc_to_ll(j); }

static double lc_to_double(const lc_json *j) {
  if (!j) return 0.0;
  if (j->kind == LC_JNUM) return j->num;
  if (j->kind == LC_JBOOL) return j->b ? 1.0 : 0.0;
  if (j->kind == LC_JSTR) return strtod(j->str, NULL);
  return 0.0;
}

static bool lc_to_bool(const lc_json *j) {
  if (!j) return false;
  if (j->kind == LC_JBOOL) return j->b;
  if (j->kind == LC_JNUM) return j->num != 0;
  if (j->kind == LC_JSTR) return strcmp(j->str, "true") == 0 || strcmp(j->str, "1") == 0;
  return false;
}

static void lc_dump_json_into(lc_sb *s, const lc_json *j);

static char *lc_to_str(const lc_json *j) {
  if (!j) return lc_empty_str();
  if (j->kind == LC_JSTR) return lc_str_dup(j->str);
  if (j->kind == LC_JNUM) {
    char buf[64];
    if (j->num_text) return lc_str_dup(j->num_text);
    snprintf(buf, sizeof(buf), "%.12g", j->num);
    return lc_str_dup(buf);
  }
  if (j->kind == LC_JBOOL) return lc_str_dup(j->b ? "true" : "false");
  if (j->kind == LC_JNULL) return lc_empty_str();
  {
    lc_sb sb;
    char *out;
    lc_sb_init(&sb);
    lc_dump_json_into(&sb, j);
    out = sb.buf ? sb.buf : lc_empty_str();
    return out;
  }
}

static char lc_to_char(const lc_json *j) {
  char *text = lc_to_str(j);
  char c = (text && text[0]) ? text[0] : '\0';
  free(text);
  return c;
}

static int *lc_to_int_arr(const lc_json *j, int *out_size) {
  int *out;
  int k;
  if (out_size) *out_size = 0;
  if (!j || j->kind != LC_JARR) return NULL;
  out = (int *)malloc(sizeof(int) * (size_t)(j->len > 0 ? j->len : 1));
  for (k = 0; k < j->len; k++) out[k] = lc_to_int(j->items[k]);
  if (out_size) *out_size = j->len;
  return out;
}

static long long *lc_to_ll_arr(const lc_json *j, int *out_size) {
  long long *out;
  int k;
  if (out_size) *out_size = 0;
  if (!j || j->kind != LC_JARR) return NULL;
  out = (long long *)malloc(sizeof(long long) * (size_t)(j->len > 0 ? j->len : 1));
  for (k = 0; k < j->len; k++) out[k] = lc_to_ll(j->items[k]);
  if (out_size) *out_size = j->len;
  return out;
}

static double *lc_to_double_arr(const lc_json *j, int *out_size) {
  double *out;
  int k;
  if (out_size) *out_size = 0;
  if (!j || j->kind != LC_JARR) return NULL;
  out = (double *)malloc(sizeof(double) * (size_t)(j->len > 0 ? j->len : 1));
  for (k = 0; k < j->len; k++) out[k] = lc_to_double(j->items[k]);
  if (out_size) *out_size = j->len;
  return out;
}

static bool *lc_to_bool_arr(const lc_json *j, int *out_size) {
  bool *out;
  int k;
  if (out_size) *out_size = 0;
  if (!j || j->kind != LC_JARR) return NULL;
  out = (bool *)malloc(sizeof(bool) * (size_t)(j->len > 0 ? j->len : 1));
  for (k = 0; k < j->len; k++) out[k] = lc_to_bool(j->items[k]);
  if (out_size) *out_size = j->len;
  return out;
}

static char **lc_to_str_arr(const lc_json *j, int *out_size) {
  char **out;
  int k;
  if (out_size) *out_size = 0;
  if (!j || j->kind != LC_JARR) return NULL;
  out = (char **)malloc(sizeof(char *) * (size_t)(j->len > 0 ? j->len : 1));
  for (k = 0; k < j->len; k++) out[k] = lc_to_str(j->items[k]);
  if (out_size) *out_size = j->len;
  return out;
}

static char *lc_to_char_arr(const lc_json *j, int *out_size) {
  char *out;
  int k;
  if (out_size) *out_size = 0;
  if (!j) return NULL;
  if (j->kind == LC_JSTR) {
    int n = (int)strlen(j->str);
    out = (char *)malloc((size_t)n + 1);
    memcpy(out, j->str, (size_t)n + 1);
    if (out_size) *out_size = n;
    return out;
  }
  if (j->kind != LC_JARR) return NULL;
  out = (char *)malloc((size_t)j->len + 1);
  for (k = 0; k < j->len; k++) out[k] = lc_to_char(j->items[k]);
  out[j->len] = '\0';
  if (out_size) *out_size = j->len;
  return out;
}

static int **lc_to_int_mat(const lc_json *j, int *out_rows, int **out_cols) {
  int **rows;
  int *cols;
  int r;
  if (out_rows) *out_rows = 0;
  if (out_cols) *out_cols = NULL;
  if (!j || j->kind != LC_JARR) return NULL;
  rows = (int **)malloc(sizeof(int *) * (size_t)(j->len > 0 ? j->len : 1));
  cols = (int *)malloc(sizeof(int) * (size_t)(j->len > 0 ? j->len : 1));
  for (r = 0; r < j->len; r++) rows[r] = lc_to_int_arr(j->items[r], &cols[r]);
  if (out_rows) *out_rows = j->len;
  if (out_cols) *out_cols = cols;
  return rows;
}

static char **lc_to_char_mat(const lc_json *j, int *out_rows, int **out_cols) {
  char **rows;
  int *cols;
  int r;
  if (out_rows) *out_rows = 0;
  if (out_cols) *out_cols = NULL;
  if (!j || j->kind != LC_JARR) return NULL;
  rows = (char **)malloc(sizeof(char *) * (size_t)(j->len > 0 ? j->len : 1));
  cols = (int *)malloc(sizeof(int) * (size_t)(j->len > 0 ? j->len : 1));
  for (r = 0; r < j->len; r++) rows[r] = lc_to_char_arr(j->items[r], &cols[r]);
  if (out_rows) *out_rows = j->len;
  if (out_cols) *out_cols = cols;
  return rows;
}

/* 节点相关（定义在 _lc_nodes_impl.h，那时结构体一定完整） */
static struct ListNode *lc_make_list(const lc_json *j);
static struct TreeNode *lc_make_tree(const lc_json *j);
static void lc_dump_list(lc_sb *s, struct ListNode *node);
static void lc_dump_tree(lc_sb *s, struct TreeNode *tree);

/* ===================== 序列化（LeetCode 习惯） ===================== */

static void lc_quote_into(lc_sb *s, const char *text) {
  size_t i;
  lc_sb_putc(s, '"');
  if (text) {
    for (i = 0; text[i] != '\0'; i++) {
      unsigned char c = (unsigned char)text[i];
      switch (c) {
        case '"': lc_sb_puts(s, "\\\""); break;
        case '\\': lc_sb_puts(s, "\\\\"); break;
        case '\n': lc_sb_puts(s, "\\n"); break;
        case '\r': lc_sb_puts(s, "\\r"); break;
        case '\t': lc_sb_puts(s, "\\t"); break;
        case '\b': lc_sb_puts(s, "\\b"); break;
        case '\f': lc_sb_puts(s, "\\f"); break;
        default:
          if (c < 0x20) {
            lc_sb_printf(s, "\\u%04x", (unsigned)c);
          } else {
            lc_sb_putc(s, (char)c);
          }
      }
    }
  }
  lc_sb_putc(s, '"');
}

static void lc_dump_int(lc_sb *s, int v) { lc_sb_printf(s, "%d", v); }

static void lc_dump_ll(lc_sb *s, long long v) { lc_sb_printf(s, "%lld", v); }

static void lc_dump_double(lc_sb *s, double v) {
  char buf[64];
  if (isnan(v)) {
    lc_sb_puts(s, "NaN");
    return;
  }
  if (isinf(v)) {
    lc_sb_puts(s, v > 0 ? "Infinity" : "-Infinity");
    return;
  }
  snprintf(buf, sizeof(buf), "%.12g", v);
  lc_sb_puts(s, buf);
}

static void lc_dump_bool(lc_sb *s, bool v) { lc_sb_puts(s, v ? "true" : "false"); }

static void lc_dump_str(lc_sb *s, const char *v) { lc_sb_puts(s, v ? v : ""); }

static void lc_dump_char(lc_sb *s, char c) { lc_sb_putc(s, c); }

static void lc_dump_int_arr(lc_sb *s, const int *a, int n) {
  int k;
  lc_sb_putc(s, '[');
  for (k = 0; k < n; k++) {
    if (k) lc_sb_putc(s, ',');
    lc_dump_int(s, a[k]);
  }
  lc_sb_putc(s, ']');
}

static void lc_dump_ll_arr(lc_sb *s, const long long *a, int n) {
  int k;
  lc_sb_putc(s, '[');
  for (k = 0; k < n; k++) {
    if (k) lc_sb_putc(s, ',');
    lc_dump_ll(s, a[k]);
  }
  lc_sb_putc(s, ']');
}

static void lc_dump_double_arr(lc_sb *s, const double *a, int n) {
  int k;
  lc_sb_putc(s, '[');
  for (k = 0; k < n; k++) {
    if (k) lc_sb_putc(s, ',');
    lc_dump_double(s, a[k]);
  }
  lc_sb_putc(s, ']');
}

static void lc_dump_bool_arr(lc_sb *s, const bool *a, int n) {
  int k;
  lc_sb_putc(s, '[');
  for (k = 0; k < n; k++) {
    if (k) lc_sb_putc(s, ',');
    lc_dump_bool(s, a[k]);
  }
  lc_sb_putc(s, ']');
}

static void lc_dump_str_arr(lc_sb *s, char **a, int n) {
  int k;
  lc_sb_putc(s, '[');
  for (k = 0; k < n; k++) {
    if (k) lc_sb_putc(s, ',');
    lc_quote_into(s, a[k]);
  }
  lc_sb_putc(s, ']');
}

static void lc_dump_char_arr(lc_sb *s, const char *a, int n) {
  int k;
  lc_sb_putc(s, '[');
  for (k = 0; k < n; k++) {
    if (k) lc_sb_putc(s, ',');
    lc_quote_into(s, (char[2]){a[k], '\0'});
  }
  lc_sb_putc(s, ']');
}

static void lc_dump_int_mat(lc_sb *s, int **m, int rows, int *cols) {
  int r;
  lc_sb_putc(s, '[');
  for (r = 0; r < rows; r++) {
    if (r) lc_sb_putc(s, ',');
    lc_dump_int_arr(s, m[r], cols ? cols[r] : 0);
  }
  lc_sb_putc(s, ']');
}

static void lc_dump_char_mat(lc_sb *s, char **m, int rows, int *cols) {
  int r;
  lc_sb_putc(s, '[');
  for (r = 0; r < rows; r++) {
    if (r) lc_sb_putc(s, ',');
    lc_dump_char_arr(s, m[r], cols ? cols[r] : 0);
  }
  lc_sb_putc(s, ']');
}

static void lc_dump_json_into(lc_sb *s, const lc_json *j) {
  int k;
  if (!j) {
    lc_sb_puts(s, "null");
    return;
  }
  switch (j->kind) {
    case LC_JNULL:
      lc_sb_puts(s, "null");
      break;
    case LC_JBOOL:
      lc_sb_puts(s, j->b ? "true" : "false");
      break;
    case LC_JNUM:
      if (j->num_text) {
        lc_sb_puts(s, j->num_text);
      } else {
        lc_dump_double(s, j->num);
      }
      break;
    case LC_JSTR:
      lc_quote_into(s, j->str);
      break;
    case LC_JARR:
      lc_sb_putc(s, '[');
      for (k = 0; k < j->len; k++) {
        if (k) lc_sb_putc(s, ',');
        lc_dump_json_into(s, j->items[k]);
      }
      lc_sb_putc(s, ']');
      break;
    case LC_JOBJ:
      lc_sb_putc(s, '{');
      for (k = 0; k < j->len; k++) {
        if (k) lc_sb_putc(s, ',');
        lc_quote_into(s, j->keys[k]);
        lc_sb_putc(s, ':');
        lc_dump_json_into(s, j->vals[k]);
      }
      lc_sb_putc(s, '}');
      break;
  }
}

/* ===================== 输出协议 ===================== */

static long long lc_now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long long)tv.tv_sec * 1000LL + (long long)(tv.tv_usec / 1000);
}

static char *lc_read_file(const char *path) {
  FILE *f;
  long size;
  char *buf;
  if (!path) return NULL;
  f = fopen(path, "rb");
  if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return NULL;
  }
  size = ftell(f);
  if (size < 0) {
    fclose(f);
    return NULL;
  }
  rewind(f);
  buf = (char *)malloc((size_t)size + 1);
  if (!buf) {
    fclose(f);
    return NULL;
  }
  if (size > 0 && fread(buf, 1, (size_t)size, f) != (size_t)size) {
    free(buf);
    fclose(f);
    return NULL;
  }
  buf[size] = '\0';
  fclose(f);
  return buf;
}

/* 协议行前统一补一个换行，防止用户输出没有行尾导致协议行被污染 */
static void lc_emit_result(long long index, const char *actual, const char *error,
                           long long duration_ms) {
  lc_sb line;
  lc_sb_init(&line);
  lc_sb_printf(&line, "\n__LC_RESULT__ {\"i\":%lld,\"actual\":", index);
  lc_quote_into(&line, actual);
  lc_sb_puts(&line, ",\"error\":");
  if (error && error[0]) {
    lc_quote_into(&line, error);
  } else {
    lc_sb_puts(&line, "null");
  }
  lc_sb_printf(&line, ",\"durationMs\":%lld}\n", duration_ms);
  fputs(lc_sb_cstr(&line), stdout);
  fflush(stdout);
  lc_sb_free(&line);
}

static void lc_emit_fatal(const char *code) {
  lc_sb line;
  lc_sb_init(&line);
  lc_sb_puts(&line, "\n__LC_ERROR__ {\"fatal\":");
  lc_quote_into(&line, code);
  lc_sb_puts(&line, "}\n");
  fputs(lc_sb_cstr(&line), stdout);
  fflush(stdout);
  lc_sb_free(&line);
}

static void lc_emit_done(long long elapsed_ms) {
  printf("\n__LC_DONE__ {\"elapsedMs\":%lld}\n", elapsed_ms);
  fflush(stdout);
}

#endif /* LC_PRELUDE_H_ */
`;

/**
 * 节点结构体定义（必须在用户代码之前 include，用户函数体里才有完整类型）。
 * 用户自己定义了同名结构体时跳过，避免重复定义。
 */
function cNodesTypesHeader(input: HarnessInput): string {
  const src = input.sourceCode;
  // 只认「定义」（带花括号），`struct ListNode* head` 这种参数声明不算
  const userHasListNode = /\bstruct\s+ListNode\s*\{/.test(src);
  const userHasTreeNode = /\bstruct\s+TreeNode\s*\{/.test(src);
  const lines: string[] = [];
  lines.push('/* 自动生成：LeetCode 本地测试脚手架的节点类型（请勿手改） */');
  lines.push('#ifndef LC_NODES_H_');
  lines.push('#define LC_NODES_H_');
  lines.push('');
  lines.push('#include "_lc_prelude.h"');
  lines.push('');
  if (userHasListNode) {
    lines.push('/* 用户代码里已经定义了 struct ListNode，这里不再重复定义 */');
  } else {
    lines.push('struct ListNode {');
    lines.push('  int val;');
    lines.push('  struct ListNode *next;');
    lines.push('};');
  }
  lines.push('');
  if (userHasTreeNode) {
    lines.push('/* 用户代码里已经定义了 struct TreeNode，这里不再重复定义 */');
  } else {
    lines.push('struct TreeNode {');
    lines.push('  int val;');
    lines.push('  struct TreeNode *left, *right;');
    lines.push('};');
  }
  lines.push('');
  lines.push('#endif /* LC_NODES_H_ */');
  lines.push('');
  return lines.join('\n');
}

/** 节点构造 + 序列化实现（放在用户代码之后 include：那时类型一定完整） */
function cNodesImplHeader(): string {
  return String.raw`/* 自动生成：节点构造与序列化实现（请勿手改） */
#ifndef LC_NODES_IMPL_H_
#define LC_NODES_IMPL_H_

#include "_lc_nodes.h"

static struct ListNode *lc_make_list(const lc_json *j) {
  struct ListNode *head = NULL;
  struct ListNode **tail = &head;
  int k;
  if (!j || j->kind != LC_JARR) return NULL;
  for (k = 0; k < j->len; k++) {
    struct ListNode *node = (struct ListNode *)malloc(sizeof(struct ListNode));
    if (!node) {
      fprintf(stderr, "lc: out of memory\n");
      exit(70);
    }
    node->val = lc_to_int(j->items[k]);
    node->next = NULL;
    *tail = node;
    tail = &node->next;
  }
  return head;
}

static struct TreeNode *lc_make_tree(const lc_json *j) {
  struct TreeNode **queue;
  int head = 0;
  int tail = 0;
  int cap;
  struct TreeNode *root;
  int k;
  if (!j || j->kind != LC_JARR || j->len == 0) return NULL;
  if (j->items[0]->kind == LC_JNULL) return NULL;
  root = (struct TreeNode *)malloc(sizeof(struct TreeNode));
  if (!root) {
    fprintf(stderr, "lc: out of memory\n");
    exit(70);
  }
  root->val = lc_to_int(j->items[0]);
  root->left = NULL;
  root->right = NULL;
  cap = j->len + 1;
  queue = (struct TreeNode **)malloc(sizeof(struct TreeNode *) * (size_t)cap);
  if (!queue) {
    fprintf(stderr, "lc: out of memory\n");
    exit(70);
  }
  queue[tail++] = root;
  k = 1;
  while (head < tail && k < j->len) {
    struct TreeNode *node = queue[head++];
    if (k < j->len) {
      if (j->items[k]->kind != LC_JNULL) {
        struct TreeNode *child = (struct TreeNode *)malloc(sizeof(struct TreeNode));
        if (!child) {
          fprintf(stderr, "lc: out of memory\n");
          exit(70);
        }
        child->val = lc_to_int(j->items[k]);
        child->left = NULL;
        child->right = NULL;
        node->left = child;
        queue[tail++] = child;
      }
      k++;
    }
    if (k < j->len) {
      if (j->items[k]->kind != LC_JNULL) {
        struct TreeNode *child = (struct TreeNode *)malloc(sizeof(struct TreeNode));
        if (!child) {
          fprintf(stderr, "lc: out of memory\n");
          exit(70);
        }
        child->val = lc_to_int(j->items[k]);
        child->left = NULL;
        child->right = NULL;
        node->right = child;
        queue[tail++] = child;
      }
      k++;
    }
  }
  free(queue);
  return root;
}

static void lc_dump_list(lc_sb *s, struct ListNode *node) {
  bool first = true;
  int guard = 0;
  lc_sb_putc(s, '[');
  while (node != NULL && guard++ < 200000) {
    if (!first) lc_sb_putc(s, ',');
    first = false;
    lc_dump_int(s, node->val);
    node = node->next;
  }
  lc_sb_putc(s, ']');
}

/* 二叉树按层序序列化，末尾的 null 去掉（与 LeetCode 展示一致） */
static void lc_dump_tree(lc_sb *s, struct TreeNode *tree) {
  struct TreeNode **queue;
  int head = 0;
  int tail = 0;
  int cap;
  int last = 0;
  int k;
  if (tree == NULL) {
    lc_sb_puts(s, "[]");
    return;
  }
  cap = 1024;
  queue = (struct TreeNode **)malloc(sizeof(struct TreeNode *) * (size_t)cap);
  if (!queue) {
    fprintf(stderr, "lc: out of memory\n");
    exit(70);
  }
  queue[tail++] = tree;
  while (head < tail) {
    struct TreeNode *cur = queue[head++];
    if (cur == NULL) continue;
    if (tail + 2 > cap) {
      cap *= 2;
      queue = (struct TreeNode **)realloc(queue, sizeof(struct TreeNode *) * (size_t)cap);
      if (!queue) {
        fprintf(stderr, "lc: out of memory\n");
        exit(70);
      }
    }
    queue[tail++] = cur->left;
    queue[tail++] = cur->right;
  }
  while (tail > 1 && queue[tail - 1] == NULL) tail--;
  lc_sb_putc(s, '[');
  for (k = 0; k < tail; k++) {
    if (k) lc_sb_putc(s, ',');
    if (queue[k] == NULL) {
      lc_sb_puts(s, "null");
    } else {
      lc_dump_int(s, queue[k]->val);
    }
  }
  lc_sb_putc(s, ']');
  (void)last;
  free(queue);
}

#endif /* LC_NODES_IMPL_H_ */
`;
}

/** C 字符串字面量（JSON.stringify 的转义对 C 字符串同样成立） */
function cString(text: string): string {
  return JSON.stringify(text);
}

function buildCEntry(input: HarnessInput): string {
  const entryName = (input.meta.name ?? '').trim();
  const returnKind = classifyType(input.meta.return.type);
  const inPlaceIndex = inPlaceAnswerParam(input.meta);
  const casesPath = join(input.genDir, CASES_FILE);

  const lines: string[] = [];
  lines.push('/* 自动生成：LeetCode 本地测试入口（请勿手改，重建脚手架会覆盖） */');
  lines.push('#include <stdio.h>');
  lines.push('#include <stdlib.h>');
  lines.push('#include <string.h>');
  lines.push('#include <stdbool.h>');
  lines.push('#include <math.h>');
  lines.push('');
  lines.push('#include "_lc_prelude.h"');
  lines.push('#include "_lc_nodes.h"');
  lines.push('');
  lines.push('/* 用绝对路径 include 用户代码：genDir 与用户目录不同也能编译；');
  lines.push('   用户文件里若自带 main，临时改名以免与脚手架 main 冲突。 */');
  lines.push('#define main _lc_user_main_disabled');
  lines.push(`#include ${cString(input.sourceAbsPath)}`);
  lines.push('#undef main');
  lines.push('');
  lines.push('/* 节点相关实现放在用户代码之后：此时 struct ListNode / TreeNode 一定是完整类型 */');
  lines.push('#include "_lc_nodes_impl.h"');
  lines.push('');
  lines.push('int main(void) {');
  lines.push('  char *payload_text;');
  lines.push('  lc_json *payload;');
  lines.push('  lc_json *cases;');
  lines.push('  long long started;');
  lines.push('  int case_idx;');
  lines.push(`  payload_text = lc_read_file(${cString(casesPath)});`);
  lines.push('  if (!payload_text) {');
  lines.push('    lc_emit_fatal("cases_not_found");');
  lines.push('    return 1;');
  lines.push('  }');
  lines.push('  payload = lc_parse(payload_text);');
  lines.push('  cases = lc_obj_get(payload, "cases");');
  lines.push('  if (!cases || cases->kind != LC_JARR) {');
  lines.push('    lc_emit_fatal("cases_malformed");');
  lines.push('    return 2;');
  lines.push('  }');

  if (entryName === '') {
    lines.push('  /* 没有函数名就无法生成调用，按协议报 entry_not_found */');
    lines.push('  lc_emit_fatal("entry_not_found");');
    lines.push('  return 3;');
    lines.push('}');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('  started = lc_now_ms();');
  lines.push('  for (case_idx = 0; case_idx < cases->len; case_idx++) {');
  lines.push('    lc_json *cur = cases->items[case_idx];');
  lines.push('    lc_json *args = lc_obj_get(cur, "args");');
  lines.push('    long long case_no = (long long)lc_to_ll(lc_obj_get(cur, "i"));');
  lines.push('    long long case_started = lc_now_ms();');
  lines.push('    lc_sb out;');
  lines.push('    char err[512];');
  lines.push('    lc_sb_init(&out);');
  lines.push('    err[0] = \'\\0\';');
  lines.push('    {');

  const callNames: string[] = [];
  let unsupported = false;
  input.meta.params.forEach((param, i) => {
    const kind = classifyType(param.type);
    const arg = cArgFor(kind, i);
    if (!arg) {
      unsupported = true;
      lines.push(`      strcpy(err, "该参数类型无法用 C 脚手架承接：${param.type}");`);
      return;
    }
    for (const line of arg.lines) lines.push(`      ${line}`);
    callNames.push(...arg.names);
  });

  if (unsupported) {
    // supports() 已经拦住了这类题目，这里只是兜底
    lines.push('    }');
    lines.push('    lc_emit_result(case_no, lc_sb_cstr(&out), err, lc_now_ms() - case_started);');
    lines.push('    lc_sb_free(&out);');
    lines.push('  }');
    lines.push('  lc_emit_done(lc_now_ms() - started);');
    lines.push('  return 0;');
    lines.push('}');
    lines.push('');
    return lines.join('\n');
  }

  if (returnKind === 'void') {
    lines.push(`      ${entryName}(${callNames.join(', ')});`);
    if (inPlaceIndex >= 0) {
      const kind = classifyType(input.meta.params[inPlaceIndex].type);
      const ref: CVarRef = {
        value: `a${inPlaceIndex}`,
        size: `a${inPlaceIndex}_size`,
        rows: `a${inPlaceIndex}_rows`,
        cols: `a${inPlaceIndex}_cols`,
      };
      const dump = cDump(ref, kind);
      if (dump) {
        for (const line of dump) lines.push(`      ${line}`);
      } else {
        lines.push('      lc_sb_puts(&out, "null");');
      }
    } else {
      lines.push('      lc_sb_puts(&out, "null");');
    }
  } else {
    const ret = cReturnFor(returnKind);
    if (!ret) {
      lines.push('      strcpy(err, "该返回值类型无法用 C 脚手架承接");');
    } else {
      for (const line of ret.extraDecls) lines.push(`      ${line}`);
      const allArgs = [...callNames, ...ret.callExtras];
      lines.push(`      ${ret.decl} = ${entryName}(${allArgs.join(', ')});`);
      const dump = cDump({ value: 'ret', size: '_ret_size', rows: '_ret_size', cols: '_ret_cols' }, returnKind);
      if (dump) {
        for (const line of dump) lines.push(`      ${line}`);
      }
    }
  }

  lines.push('    }');
  lines.push('    lc_emit_result(case_no, lc_sb_cstr(&out), err, lc_now_ms() - case_started);');
  lines.push('    lc_sb_free(&out);');
  lines.push('  }');
  lines.push('  lc_emit_done(lc_now_ms() - started);');
  lines.push('  return 0;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function cKindOk(kind: TypeKind): boolean {
  return C_SUPPORTED_KINDS.includes(kind);
}

export const CHarness: LanguageHarness = {
  slug: 'c',
  installHint:
    '需要本地 C 编译器 gcc 或 clang（macOS：`xcode-select --install`；Ubuntu：`apt install build-essential`）。',
  supports(meta: LcMetaData): HarnessSupport {
    if (meta.construct) {
      return { ok: false, reason: '设计类题目（多步操作）暂不支持本地脚手架' };
    }
    const allTypes = [...meta.params.map((p) => p.type), meta.return.type];
    for (const type of allTypes) {
      if (!cKindOk(classifyType(type))) {
        return { ok: false, reason: `暂不支持的类型：${type}` };
      }
    }
    return { ok: true };
  },
  generate(input: HarnessInput): HarnessArtifact {
    const notes = [
      '用 C11（gcc/clang）编译，入口文件通过绝对路径 include 你的代码，不会修改你的源文件。',
      '数组参数按 LeetCode C 约定成对传入：`(T* a, int aSize)`；返回数组需要 `int* returnSize` 出参。',
    ];
    const files: HarnessFile[] = [];
    files.push({ name: CASES_FILE, content: serializeCases(input) });
    files.push({ name: '_lc_prelude.h', content: C_PRELUDE });
    files.push({ name: '_lc_nodes.h', content: cNodesTypesHeader(input) });
    files.push({ name: '_lc_nodes_impl.h', content: cNodesImplHeader() });
    files.push({ name: '_lc_main.c', content: buildCEntry(input) });

    const binPath = join(input.genDir, '_lc_bin');
    return {
      files,
      steps: [
        {
          label: 'compile',
          cmd: 'gcc',
          args: [
            '-std=gnu11',
            '-O2',
            '-w',
            `-I${input.genDir}`,
            '-o',
            binPath,
            join(input.genDir, '_lc_main.c'),
          ],
          fatal: true,
        },
        { label: 'run', cmd: binPath, args: [], fatal: false },
      ],
      debugEntry: '_lc_main.c',
      debugType: 'cppdbg',
      notes,
    };
  },
};
