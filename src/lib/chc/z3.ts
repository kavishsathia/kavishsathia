/**
 * The site's Z3 wasm build, shared with the Dafny tool's loader. Spacer
 * needs nothing beyond the SMT-LIB entry point plus Z3_interrupt, which the
 * low-level API exposes but the Dafny loader's type leaves out.
 */

import { loadZ3LowLevel, SolverUnavailableError } from "@/lib/dafny/z3smt";
import type { Z3Low } from "./solve";

export { SolverUnavailableError };

export async function loadSpacer(): Promise<Z3Low> {
  return (await loadZ3LowLevel()) as unknown as Z3Low;
}
