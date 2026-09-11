// Cross-check the generated table against `javap -p com.microsoft.z3.Native`.
import { readFileSync } from "node:fs";
const table = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sigs = new Map();
for (const line of readFileSync(process.argv[3], "utf8").split("\n")) {
  const m = line.match(/native ([^ ]+) (INTERNAL[A-Za-z0-9_]+)\((.*)\);/);
  if (m) sigs.set(m[2], { ret: m[1], params: m[3] ? m[3].split(",").map((s) => s.trim()) : [] });
}
const expectJava = (p) => {
  if (p.kind === "in") return { handle: "long", int: "int", bool: "boolean", string: "java.lang.String", int64: "long", uint64: "long", double: p.raw === "FLOAT" ? "float" : "double" }[p.type];
  if (p.kind === "out") return { handle: "com.microsoft.z3.Native$LongPtr", int64: "com.microsoft.z3.Native$LongPtr", uint64: "com.microsoft.z3.Native$LongPtr", int: "com.microsoft.z3.Native$IntPtr", string: "com.microsoft.z3.Native$StringPtr" }[p.type];
  if (p.kind.endsWith("array")) return { handle: "long[]", int64: "long[]", int: "int[]", bool: "boolean[]" }[p.type];
  return "java.lang.Object";
};
const expectRet = (e) => ({ void: "void", handle: "long", int: "int", bool: "boolean", string: "java.lang.String", double: "double", uint64: "long", int64: "long" })[e.ret];
let bad = 0;
let callbacks = 0;
for (const e of table) {
  // Callback-taking entry points (user propagators) are deliberately not
  // bridged; their Java shape differs and the verifier never calls them.
  if (e.params.some((p) => p.kind === "fnptr" || p.kind === "out_managed_array" || p.raw === "VOID_PTR")) { callbacks++; continue; }
  const s = sigs.get(e.java);
  if (!s) { console.log("no javap sig for", e.java); bad++; continue; }
  const exp = e.params.map(expectJava);
  const ok = exp.length === s.params.length && exp.every((x, i) => x === s.params[i]) && expectRet(e) === s.ret;
  if (!ok) { bad++; console.log("MISMATCH", e.c, "\n  table:", expectRet(e), exp.join(","), "\n  javap:", s.ret, s.params.join(",")); }
}
console.log(`${table.length} entries: ${table.length - callbacks} checked against javap, ${callbacks} callback-based skipped, ${bad} mismatches`);
if (bad) process.exit(1);
