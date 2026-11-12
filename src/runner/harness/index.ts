/**
 * 语言脚手架注册表。
 */
import type { LanguageHarness } from './types.js';
import { PythonHarness, Python2Harness } from './python.js';
import { CppHarness } from './cpp.js';
import { CHarness } from './c.js';
import { JavaHarness } from './java.js';
import { JavaScriptHarness } from './javascript.js';
import { TypeScriptHarness } from './typescript.js';
import { GoHarness } from './golang.js';
import { RustHarness } from './rust.js';
import { RubyHarness } from './ruby.js';
import { normalizeLangSlug } from '../../core/langs.js';

const registry = new Map<string, LanguageHarness>();

export function registerHarness(h: LanguageHarness): void {
  registry.set(normalizeLangSlug(h.slug), h);
}

registerHarness(PythonHarness);
registerHarness(Python2Harness);
registerHarness(CppHarness);
registerHarness(CHarness);
registerHarness(JavaHarness);
registerHarness(JavaScriptHarness);
registerHarness(TypeScriptHarness);
registerHarness(GoHarness);
registerHarness(RustHarness);
registerHarness(RubyHarness);

export function getHarness(langSlug: string): LanguageHarness | undefined {
  return registry.get(normalizeLangSlug(langSlug));
}

export function hasHarness(langSlug: string): boolean {
  return registry.has(normalizeLangSlug(langSlug));
}

export function harnessLangs(): string[] {
  return [...registry.keys()];
}

export type { LanguageHarness } from './types.js';
