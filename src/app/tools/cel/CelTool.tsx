"use client";

import { useRef, useState } from "react";
import {
  checkEquivalence,
  checkPolicyEquivalence,
  checkPolicyInvariants,
  checkSatisfiable,
  checkValid,
  EngineUnavailableError,
  loadEngine,
  type EngineFailure,
  type LoadPhase,
  type PolicyInvariants,
  type VerificationResult,
  type VerifyOptions,
} from "@/lib/cel/engine";
import { nativeCount } from "@/lib/cel/z3bridge";

type Mode = "sat" | "valid" | "equiv" | "policy" | "policy-equiv";

const modes: { id: Mode; label: string; blurb: string }[] = [
  { id: "sat", label: "sat", blurb: "can it ever be true?" },
  { id: "valid", label: "valid", blurb: "is it true for every input?" },
  { id: "equiv", label: "equiv", blurb: "do A and B agree on every input?" },
  { id: "policy", label: "policy", blurb: "do the assume/assert invariants hold?" },
  { id: "policy-equiv", label: "policy ≡", blurb: "do A and B decide the same for every input?" },
];

type Example = { label: string; mode: Mode; a: string; b?: string; variables: string };

const examples: Example[] = [
  {
    label: "precedence bug",
    mode: "equiv",
    a: "(is_prod && port == 80) || (is_prod && port == 443)",
    b: "is_prod && port == 80 || port == 443",
    variables: "is_prod:bool\nport:int",
  },
  {
    label: "port range gap",
    mode: "valid",
    a: "!(port > 0 && port < 65536) || (port <= 80 || port >= 1025)",
    variables: "port:int",
  },
  { label: "division by zero", mode: "valid", a: "100 / x < 200", variables: "x:int" },
  { label: "error absorbed", mode: "valid", a: "x == 0 || 100 / x < 200", variables: "x:int" },
  {
    label: "reachable branch",
    mode: "sat",
    a: "role == 'admin' && port > 1024 && !(port in [8080, 8443])",
    variables: "role:string\nport:int",
  },
  {
    label: "strings",
    mode: "equiv",
    a: "name.startsWith('k8s-') && name.size() > 4",
    b: "name.startsWith('k8s-') && name != 'k8s-'",
    variables: "name:string",
  },
  {
    label: "unroll limit",
    mode: "valid",
    a: "tags.all(t, t.size() > 0) || tags.exists(t, t == '')",
    variables: "tags:list<string>",
  },
  {
    label: "policy invariants",
    mode: "policy",
    a: `name: admin_gate
rule:
  match:
    - condition: role == 'admin'
      output: 'true'
    - condition: role == 'ops' && port > 1024
      output: 'true'
    - output: 'false'
verification:
  invariants:
    - id: admin_always_allowed
      assume: role == 'admin'
      assert: rule.result == true
    - id: viewer_never_allowed
      assume: role == 'viewer'
      assert: rule.result == false
    - id: ops_low_ports_blocked
      assume: role == 'ops' && port < 1024
      assert: rule.result == false
    - id: ops_always_allowed
      assume: role == 'ops'
      assert: rule.result == true
`,
    variables: "role:string\nport:int",
  },
];

const DEFAULT = examples[0];

const phaseLabel: Record<LoadPhase | "verifying", string> = {
  z3: "loading z3 (~17 MB, cached)…",
  cheerpj: "starting the jvm…",
  jar: "loading the verifier (~9 MB, cached)…",
  verifying: "verifying…",
};

type Shown =
  | { kind: "result"; result: VerificationResult }
  | { kind: "policy"; invariants: PolicyInvariants }
  | { kind: "failure"; failure: EngineFailure }
  | { kind: "error"; message: string };

function StatusBadge({ status }: { status: VerificationResult["status"] }) {
  const glyph = status === "VERIFIED" ? "✓" : status === "VIOLATED" ? "✗" : "?";
  return (
    <span className="font-mono text-xs border border-border px-2 py-0.5 whitespace-nowrap">
      {glyph} {status}
    </span>
  );
}

function headline(mode: Mode, status: VerificationResult["status"]): string {
  if (status === "INCONCLUSIVE") return "inconclusive";
  const ok = status === "VERIFIED";
  if (mode === "sat") return ok ? "satisfiable" : "unsatisfiable";
  if (mode === "valid") return ok ? "holds for every input" : "fails for some input";
  return ok ? "equivalent" : "they diverge";
}

let loaded = false;

export default function CelTool() {
  const [mode, setMode] = useState<Mode>(DEFAULT.mode);
  const [exprA, setExprA] = useState(DEFAULT.a);
  const [exprB, setExprB] = useState(DEFAULT.b ?? "");
  const [variables, setVariables] = useState(DEFAULT.variables);
  const [unknowns, setUnknowns] = useState("");
  const [timeoutSec, setTimeoutSec] = useState(10);
  const [unroll, setUnroll] = useState(5);
  const [phase, setPhase] = useState<LoadPhase | "verifying" | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const twoInputs = mode === "equiv" || mode === "policy-equiv";
  const isPolicy = mode === "policy" || mode === "policy-equiv";

  async function run() {
    setShown(null);
    const options: VerifyOptions = {
      variables,
      unknowns,
      timeoutMs: Math.max(1, Math.round(timeoutSec * 1000)),
      unrollLimit: Math.max(0, Math.round(unroll)),
    };
    try {
      if (!loaded) {
        await loadEngine((p) => setPhase(p));
        loaded = true;
      }
      setPhase("verifying");
      if (mode === "policy") {
        const out = await checkPolicyInvariants(exprA, options);
        setShown(out.ok ? { kind: "policy", invariants: out.value.invariants } : { kind: "failure", failure: out.failure });
      } else {
        const out =
          mode === "sat"
            ? await checkSatisfiable(exprA, options)
            : mode === "valid"
              ? await checkValid(exprA, options)
              : mode === "equiv"
                ? await checkEquivalence(exprA, exprB, options)
                : await checkPolicyEquivalence(exprA, exprB, options);
        setShown(out.ok ? { kind: "result", result: out.value } : { kind: "failure", failure: out.failure });
      }
    } catch (e) {
      setShown({
        kind: "error",
        message:
          e instanceof EngineUnavailableError
            ? `couldn't load the verifier — ${e.message}`
            : e instanceof Error
              ? e.message
              : "something went wrong",
      });
    } finally {
      setPhase(null);
    }
  }

  function applyExample(ex: Example) {
    setMode(ex.mode);
    setExprA(ex.a);
    setExprB(ex.b ?? "");
    setVariables(ex.variables);
    setShown(null);
    inputRef.current?.focus();
  }

  const pending = phase !== null;
  const canRun = exprA.trim() !== "" && (!twoInputs || exprB.trim() !== "");
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canRun && !pending) run();
    }
  };
  const area =
    "mt-2 w-full resize-y border border-border bg-white/50 px-4 py-3 font-mono text-sm leading-relaxed outline-none focus:border-muted transition-colors placeholder:text-muted/60";
  const label = "block font-mono text-xs tracking-wider text-muted";
  const chip = (active: boolean) =>
    `font-mono text-xs border px-2 py-1 transition-colors ${
      active ? "border-foreground text-foreground" : "border-border text-muted hover:border-muted hover:text-foreground"
    }`;

  return (
    <div className="flex flex-col lg:flex-row flex-1 min-h-0">
      {/* Inputs */}
      <div className="flex-1 min-w-0 min-h-[50vh] lg:min-h-0 overflow-y-auto border-b lg:border-b-0 lg:border-r border-border">
        <div className="px-6 py-5 max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            {modes.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setMode(m.id);
                  setShown(null);
                }}
                className={chip(mode === m.id)}
              >
                {m.label}
              </button>
            ))}
            <span className="font-mono text-xs text-muted ml-1">{modes.find((m) => m.id === mode)?.blurb}</span>
          </div>

          <label htmlFor="cel-a" className={`${label} mt-6`}>
            {isPolicy ? (twoInputs ? "POLICY A" : "POLICY") : twoInputs ? "EXPRESSION A" : "EXPRESSION"}
          </label>
          <textarea
            id="cel-a"
            ref={inputRef}
            value={exprA}
            onChange={(e) => setExprA(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            rows={isPolicy ? 16 : 3}
            className={area}
          />

          {twoInputs && (
            <>
              <label htmlFor="cel-b" className={`${label} mt-4`}>
                {isPolicy ? "POLICY B" : "EXPRESSION B"}
              </label>
              <textarea
                id="cel-b"
                value={exprB}
                onChange={(e) => setExprB(e.target.value)}
                onKeyDown={onKey}
                spellCheck={false}
                rows={isPolicy ? 16 : 3}
                className={area}
              />
            </>
          )}

          <label htmlFor="cel-vars" className={`${label} mt-4`}>
            VARIABLES
          </label>
          <textarea
            id="cel-vars"
            value={variables}
            onChange={(e) => setVariables(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            rows={2}
            placeholder={"port:int\nrole:string"}
            className={area}
          />
          <p className="mt-1 font-mono text-xs text-muted">
            name:type — int uint bool string double bytes dyn timestamp duration list&lt;T&gt; map&lt;K,V&gt; optional&lt;T&gt;
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={run}
              disabled={pending || !canRun}
              className="font-mono text-xs border border-border px-3 py-1.5 hover:border-muted hover:text-foreground text-muted transition-colors disabled:opacity-40 disabled:hover:border-border"
            >
              {phase ? phaseLabel[phase] : "verify →"}
            </button>
            <span className="font-mono text-xs text-muted">⌘↵</span>
            <button
              onClick={() => setShowOptions((v) => !v)}
              className="font-mono text-xs text-muted hover:text-foreground transition-colors"
            >
              {showOptions ? "− options" : "+ options"}
            </button>
          </div>

          {showOptions && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="cel-timeout" className="font-mono text-xs text-muted">
                  timeout (s)
                </label>
                <input
                  id="cel-timeout"
                  type="number"
                  min={1}
                  max={120}
                  value={timeoutSec}
                  onChange={(e) => setTimeoutSec(Number(e.target.value))}
                  className="mt-1 w-full border border-border bg-white/50 px-3 py-2 font-mono text-sm outline-none focus:border-muted"
                />
              </div>
              <div>
                <label htmlFor="cel-unroll" className="font-mono text-xs text-muted">
                  comprehension unroll limit
                </label>
                <input
                  id="cel-unroll"
                  type="number"
                  min={0}
                  max={20}
                  value={unroll}
                  onChange={(e) => setUnroll(Number(e.target.value))}
                  className="mt-1 w-full border border-border bg-white/50 px-3 py-2 font-mono text-sm outline-none focus:border-muted"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="cel-unknowns" className="font-mono text-xs text-muted">
                  unknown identifiers (one per line)
                </label>
                <textarea
                  id="cel-unknowns"
                  value={unknowns}
                  onChange={(e) => setUnknowns(e.target.value)}
                  spellCheck={false}
                  rows={2}
                  placeholder="request.headers"
                  className="mt-1 w-full resize-y border border-border bg-white/50 px-3 py-2 font-mono text-sm outline-none focus:border-muted placeholder:text-muted/60"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Side panel */}
      <div className="lg:w-[26rem] xl:w-[30rem] shrink-0 flex flex-col min-h-0 overflow-y-auto">
        {/* Result */}
        <div className="px-6 py-5 border-b border-border">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-xs tracking-wider text-muted">RESULT</span>
            {phase && <span className="font-mono text-xs text-muted">{phaseLabel[phase]}</span>}
          </div>
          <div className="mt-3">
            {shown === null ? (
              <p className="font-mono text-sm text-muted">nothing verified yet</p>
            ) : shown.kind === "result" ? (
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={shown.result.status} />
                  <span className="font-mono text-xs text-muted">{headline(mode, shown.result.status)}</span>
                </div>
                {shown.result.message && (
                  <pre className="mt-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                    {shown.result.message}
                  </pre>
                )}
              </div>
            ) : shown.kind === "policy" ? (
              <ul className="space-y-4">
                {shown.invariants.length === 0 && (
                  <li className="font-mono text-sm text-muted">no invariants declared</li>
                )}
                {shown.invariants.map((inv) => (
                  <li key={inv.id}>
                    <div className="flex flex-wrap items-center gap-3">
                      <StatusBadge status={inv.result.status} />
                      <span className="font-mono text-xs">{inv.id}</span>
                    </div>
                    {inv.result.message && (
                      <pre className="mt-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-muted">
                        {inv.result.message}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            ) : shown.kind === "failure" ? (
              <div>
                <span className="font-mono text-xs text-muted">
                  {shown.failure.kind === "compile" ? "didn't compile" : "the verifier threw"}
                </span>
                <pre className="mt-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {shown.failure.kind === "compile" ? shown.failure.error : shown.failure.rootError}
                </pre>
                {shown.failure.kind === "runtime" && (
                  <details className="mt-2">
                    <summary className="font-mono text-xs text-muted cursor-pointer">stack</summary>
                    <pre className="mt-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted">
                      {shown.failure.stack}
                    </pre>
                  </details>
                )}
              </div>
            ) : (
              <p className="font-mono text-sm text-muted">{shown.message}</p>
            )}
          </div>
        </div>

        {/* Examples */}
        <div className="px-6 py-5 border-b border-border">
          <span className="font-mono text-xs tracking-wider text-muted">EXAMPLES</span>
          <div className="mt-3 flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button key={ex.label} onClick={() => applyExample(ex)} className={chip(false)}>
                {ex.label}
              </button>
            ))}
          </div>
        </div>

        {/* About */}
        <div className="px-6 py-5">
          <span className="font-mono text-xs tracking-wider text-muted">ABOUT</span>
          <p className="mt-3 text-xs text-muted leading-relaxed">
            This is{" "}
            <a
              href="https://github.com/cel-expr/cel-java/tree/main/verifier"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              cel-java&apos;s verifier
            </a>
            , unmodified, on{" "}
            <a
              href="https://cheerpj.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              CheerpJ
            </a>{" "}
            — a JVM in WebAssembly. Its JNI binding to Z3 is replaced by a
            bridge generated from Z3&apos;s own API headers ({nativeCount}{" "}
            entry points), routed into a Z3 4.14.1 wasm build. Nothing leaves
            your machine; a hard query can freeze the tab until the timeout.{" "}
            <a
              href="https://github.com/kavishsathia/kavishsathia/tree/main/wasm-src/cel"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              How it&apos;s built
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
