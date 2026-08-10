import type { Metadata } from "next";
import Link from "next/link";
import LdlfMtTool from "./LdlfMtTool";

export const metadata: Metadata = {
  title: "LDLf modulo theories | Kavish Sathia",
  description:
    "Linear Dynamic Logic on finite traces with refinement-style predicates as atoms — mintermized with Z3, translated to a pruned DFA, in the browser.",
};

export default function LdlfMtPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto max-w-2xl px-6 py-24 sm:py-32">
        <Link
          href="/tools"
          className="font-mono text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; tools
        </Link>

        <h1 className="font-mono text-sm tracking-wider text-muted mt-12 mb-6">
          LDLf MODULO THEORIES
        </h1>
        <p className="text-lg leading-relaxed mb-4">
          LDLf where the atoms are predicates over integers, not opaque
          letters.
        </p>
        <p className="text-sm leading-relaxed text-accent mb-12">
          The automaton construction doesn&apos;t care what atoms are, only
          that combinations of them can be checked for consistency. So each
          step carries linear integer predicates like{" "}
          <code className="font-mono text-xs">{"{x > 100}"}</code>, the
          satisfiable combinations become the alphabet (mintermization), and
          the contradictory ones are pruned away — every kept letter comes
          with a concrete witness value.{" "}
          <a
            href="https://github.com/whitemech/lydia"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-muted transition-colors"
          >
            Lydia
          </a>{" "}
          builds the automaton and{" "}
          <a
            href="https://github.com/Z3Prover/z3"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-muted transition-colors"
          >
            Z3
          </a>{" "}
          does the pruning, both compiled to WebAssembly — everything runs on
          your machine.
        </p>

        <LdlfMtTool />

        <div className="mt-16 pt-8 border-t border-border">
          <h2 className="font-mono text-xs tracking-wider text-muted mb-4">
            SYNTAX
          </h2>
          <p className="text-sm leading-relaxed text-accent mb-4">
            Formulas are standard LDLf —{" "}
            <code className="font-mono text-xs">tt</code>,{" "}
            <code className="font-mono text-xs">ff</code>,{" "}
            <code className="font-mono text-xs">end</code>,{" "}
            <code className="font-mono text-xs">last</code>, modalities{" "}
            <code className="font-mono text-xs">&lt;ρ&gt;φ</code> and{" "}
            <code className="font-mono text-xs">[ρ]φ</code>, regular
            expressions with <code className="font-mono text-xs">;</code>{" "}
            <code className="font-mono text-xs">+</code>{" "}
            <code className="font-mono text-xs">*</code>{" "}
            <code className="font-mono text-xs">φ?</code> — except that every
            atom is a predicate in braces:{" "}
            <code className="font-mono text-xs">{"{x > 10}"}</code>,{" "}
            <code className="font-mono text-xs">{"{2*x + y <= 7}"}</code>,{" "}
            <code className="font-mono text-xs">{"{x != 0}"}</code>. Combine
            them with <code className="font-mono text-xs">!</code>{" "}
            <code className="font-mono text-xs">&amp;</code>{" "}
            <code className="font-mono text-xs">|</code> outside the braces:{" "}
            <code className="font-mono text-xs">
              {"{x > 0} & !{y = 2}"}
            </code>
            .
          </p>
          <p className="text-sm leading-relaxed text-accent mb-4">
            Predicates are linear comparisons over integer variables (
            <code className="font-mono text-xs">&lt;</code>{" "}
            <code className="font-mono text-xs">&lt;=</code>{" "}
            <code className="font-mono text-xs">&gt;</code>{" "}
            <code className="font-mono text-xs">&gt;=</code>{" "}
            <code className="font-mono text-xs">=</code>{" "}
            <code className="font-mono text-xs">!=</code>). Syntactic variants
            of the same comparison —{" "}
            <code className="font-mono text-xs">{"{x > 5}"}</code>,{" "}
            <code className="font-mono text-xs">{"{5 < x}"}</code>,{" "}
            <code className="font-mono text-xs">{"{x - 5 > 0}"}</code> — are
            recognised as one atom. Each distinct atom doubles the alphabet,
            so at most eight are allowed.
          </p>
          <p className="text-sm leading-relaxed text-accent">
            Predicates only see the current step. That&apos;s a real boundary,
            not a missing feature: per-step predicates keep the construction a
            symbolic finite automaton and everything stays decidable, while
            predicates relating values <em>across</em> steps would make
            emptiness undecidable in general.
          </p>
        </div>

        <div className="mt-24 flex justify-end">
          <span className="text-muted text-lg">∎</span>
        </div>
      </main>
    </div>
  );
}
