/**
 * Copies the Z3 wasm build out of node_modules into /public so the browser
 * can load it at runtime. Runs on postinstall; public/z3 is gitignored
 * because the wasm is ~34 MB.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "z3-solver", "build");
const dest = join(root, "public", "z3");

mkdirSync(dest, { recursive: true });
for (const file of ["z3-built.js", "z3-built.wasm"]) {
  copyFileSync(join(src, file), join(dest, file));
}
console.log("copied z3 wasm to public/z3");
