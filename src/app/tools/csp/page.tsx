import type { Metadata } from "next";
import Link from "next/link";
import CspTool from "./CspTool";

export const metadata: Metadata = {
  title: "CSP# | Kavish Sathia",
  description:
    "A runtime verifier for CSP#, the modelling language of the PAT model checker: write a model, paste a trace, and see whether the model can produce it — with the enabled events at every step. Runs entirely in the browser.",
};

export default function CspPage() {
  return (
    <div className="h-dvh flex flex-col bg-background text-foreground">
      <header className="shrink-0 px-6 py-4 border-b border-border flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Link
          href="/tools"
          className="font-mono text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; tools
        </Link>
        <h1 className="font-mono text-sm tracking-wider text-muted">CSP#</h1>
        <p className="hidden sm:block text-sm text-muted">
          is this trace one the model can produce?
        </p>
      </header>

      <CspTool />
    </div>
  );
}
