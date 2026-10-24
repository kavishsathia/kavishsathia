import type { Metadata } from "next";
import Link from "next/link";
import UnitsTool from "./UnitsTool";

export const metadata: Metadata = {
  title: "CEL translation units | Kavish Sathia",
  description:
    "Map concrete agent events onto an abstract CSP alphabet with CEL predicates, prove the mappings pairwise disjoint with Google's cel-java verifier and Z3, and translate concrete events with CEL's own runtime — all in the browser.",
};

export default function CelUnitsPage() {
  return (
    <div className="h-dvh flex flex-col bg-background text-foreground">
      <header className="shrink-0 px-6 py-4 border-b border-border flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Link href="/tools" className="font-mono text-sm text-muted hover:text-foreground transition-colors">
          &larr; tools
        </Link>
        <h1 className="font-mono text-sm tracking-wider text-muted">CEL TRANSLATION UNITS</h1>
        <p className="hidden sm:block text-sm text-muted">concrete events → CSP alphabet, proven disjoint</p>
        <Link
          href="/tools/cel"
          className="ml-auto font-mono text-xs text-muted hover:text-foreground transition-colors"
        >
          CEL verifier →
        </Link>
      </header>

      <UnitsTool />
    </div>
  );
}
