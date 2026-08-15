export type Tool = {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  /**
   * Plain text only — the whole tool row is wrapped in a <Link>, so anchors
   * inside the description would nest and break.
   */
  description: string;
  tags: string[];
};

export const tools: Tool[] = [
  {
    id: "01",
    slug: "ldlf",
    title: "LDLf",
    subtitle: "Linear Dynamic Logic on finite traces, in the browser",
    description:
      "Write a formula in Linear Dynamic Logic over finite traces and watch it become a deterministic finite automaton. Runs entirely client-side — the Lydia translator compiled to WebAssembly, no server round-trip, no install.",
    tags: ["WebAssembly", "Automata", "Formal Methods"],
  },
  {
    id: "02",
    slug: "ldlf-mt",
    title: "LDLf modulo theories",
    subtitle: "Temporal logic over predicates, mintermized with Z3",
    description:
      "LDLf where atoms are linear integer predicates instead of opaque letters. Z3 turns the predicate combinations into an alphabet — keeping the satisfiable ones with concrete witnesses, pruning the contradictions — and Lydia builds the automaton. With a minterm debugger and a concrete-trace simulator, all in the browser.",
    tags: ["Z3", "SMT", "Automata", "WebAssembly"],
  },
  {
    id: "03",
    slug: "dafny",
    title: "Dafny",
    subtitle: "The full Dafny verifier, in the browser",
    description:
      "Not a port — Dafny 4.11 and Boogie, the same .NET assemblies the CLI runs, executing on the .NET runtime compiled to WebAssembly, with Boogie's z3 subprocess pipe rerouted into Z3 wasm. Write a program with pre/postconditions and loop invariants, and every proof obligation is discharged on your machine.",
    tags: ["Dafny", ".NET wasm", "Z3", "Verification"],
  },
];

export function getTool(slug: string): Tool | undefined {
  return tools.find((t) => t.slug === slug);
}
