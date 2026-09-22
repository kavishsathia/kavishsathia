import type { Metadata } from "next";
import Link from "next/link";
import ChcTool from "./ChcTool";

export const metadata: Metadata = {
  title: "Constrained Horn clauses | Kavish Sathia",
  description:
    "Z3's Spacer engine solving constrained Horn clauses in the browser: inductive invariants when the clauses are satisfiable, derivation-tree counterexamples when they're not, each independently re-checked by Z3.",
};

export default function ChcPage() {
  return (
    <div className="h-dvh flex flex-col bg-background text-foreground">
      <header className="shrink-0 px-6 py-4 border-b border-border flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Link
          href="/tools"
          className="font-mono text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; tools
        </Link>
        <h1 className="font-mono text-sm tracking-wider text-muted">CONSTRAINED HORN CLAUSES</h1>
        <p className="hidden sm:block text-sm text-muted">
          Z3&apos;s Spacer engine, running in your browser
        </p>
      </header>

      <ChcTool />
    </div>
  );
}
