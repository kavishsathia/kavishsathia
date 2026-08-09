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
];

export function getTool(slug: string): Tool | undefined {
  return tools.find((t) => t.slug === slug);
}
