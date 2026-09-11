#!/usr/bin/env node
/**
 * Generates the Z3 JNI bridge table from Z3's own API headers.
 *
 * Z3's Java binding (com.microsoft.z3.Native) is generated from the
 * `def_API(...)` declarations in src/api/z3*.h — one JNI method per C entry
 * point, same parameter order, arrays passed as (count, array), out-params as
 * small holder objects. This script parses those same declarations and emits
 * a JSON table the browser bridge uses to marshal each `Native.INTERNALxxx`
 * call onto the Z3 wasm export `_Z3_xxx`.
 *
 * usage: node gen-z3-natives.mjs <z3/src/api dir> <out.json>
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [apiDir, outPath] = process.argv.slice(2);
if (!apiDir || !outPath) {
  console.error("usage: gen-z3-natives.mjs <z3/src/api> <out.json>");
  process.exit(2);
}

const HANDLE_TYPES = new Set([
  "CONTEXT", "CONFIG", "AST", "SORT", "FUNC_DECL", "SYMBOL", "APP", "PATTERN",
  "MODEL", "SOLVER", "PARAMS", "PARAM_DESCRS", "GOAL", "TACTIC", "PROBE",
  "SIMPLIFIER", "STATS", "AST_VECTOR", "AST_MAP", "APPLY_RESULT", "FUNC_INTERP",
  "FUNC_ENTRY", "FIXEDPOINT", "OPTIMIZE", "PARSER_CONTEXT", "CONSTRUCTOR",
  "CONSTRUCTOR_LIST", "RCF_NUM", "SOLVER_CALLBACK", "VOID_PTR",
]);

const SCALARS = new Set(["UINT", "INT", "BOOL", "INT64", "UINT64", "DOUBLE", "FLOAT", "STRING", "CHAR_PTR", "ERROR_CODE", "LBOOL", "PRINT_MODE", "VOID", "CHAR", "SYMBOL_KIND", "PARAMETER_KIND", "SORT_KIND", "AST_KIND", "DECL_KIND", "GOAL_PREC", "AST_PRINT_MODE"]);

function classify(t) {
  if (HANDLE_TYPES.has(t)) return "handle";
  if (t === "STRING") return "string";
  // Z3_get_lstring returns a length-delimited byte pointer; the Java binding
  // keeps it as a raw long.
  if (t === "CHAR_PTR") return "handle";
  if (t === "INT64") return "int64";
  if (t === "UINT64") return "uint64";
  if (t === "DOUBLE" || t === "FLOAT") return "double";
  if (t === "BOOL") return "bool";
  if (t === "VOID") return "void";
  // every remaining enum/int-like kind is a 32-bit integer on the C side
  return "int";
}

const javaName = (c) => {
  const parts = c.replace(/^Z3_/, "").split("_");
  return "INTERNAL" + parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
};

const table = [];
const seen = new Set();
for (const f of readdirSync(apiDir).filter((f) => /^z3.*\.h$/.test(f)).sort()) {
  const src = readFileSync(join(apiDir, f), "utf8");
  const re = /(def|extra)_API\s*\('(Z3_[a-z0-9_]+)',\s*([A-Z_0-9]+)\s*,\s*\(([\s\S]*?)\)\s*\)/g;
  for (const m of src.matchAll(re)) {
    // The lazy match stops before the parameter list's own closing paren;
    // put it back so the last parameter parses too.
    const [, , cName, ret] = m;
    const paramSrc = m[4] + ")";
    if (seen.has(cName)) continue;
    seen.add(cName);
    const params = [];
    const pre = /_(in|out|inout|in_array|out_array|inout_array|out_managed_array|fnptr)\(([^)]*)\)/g;
    for (const p of paramSrc.matchAll(pre)) {
      const kind = p[1];
      const args = p[2].split(",").map((s) => s.trim()).filter(Boolean);
      if (kind === "fnptr") params.push({ kind: "fnptr", type: args[0] });
      else if (kind.endsWith("array")) params.push({ kind, sizeIndex: Number(args[0]), type: classify(args[1]), raw: args[1] });
      else params.push({ kind, type: classify(args[0]), raw: args[0] });
    }
    table.push({ c: cName, java: javaName(cName), ret: classify(ret), retRaw: ret, params });
  }
}

table.sort((a, b) => a.c.localeCompare(b.c));
writeFileSync(outPath, JSON.stringify(table));
console.log(`wrote ${table.length} entries to ${outPath}`);
