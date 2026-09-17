import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Emscripten-generated glue for the LDLf tools.
    "public/wasm/**",
    "public/z3/**",
    "public/cel/z3-cel.js",
    "public/dafny/_framework/**",
    // Unmodified generated Emscripten/wasm-bindgen glue. The authored worker
    // remains linted at public/fpga/fpga-worker.js.
    "public/fpga/ivl.js",
    "public/fpga/ivlpp.js",
    "public/fpga/vvp.js",
    "public/fpga/surfer/surfer.js",
    "public/fpga/surfer/surfer.d.ts",
    "public/fpga/surfer/integration.js",
  ]),
]);

export default eslintConfig;
