/**
 * LDLf -> DFA, running Lydia compiled to WebAssembly.
 *
 * The .wasm and its loader live in /public/wasm and are fetched on first use,
 * so nothing is downloaded until someone actually translates a formula.
 */

import { labelFor } from "./labels";

export type Automaton = {
  states: string[];
  initial: string;
  accepting: string[];
  transitions: { from: string; to: string; label: string }[];
};

export class EngineUnavailableError extends Error {
  constructor(cause?: string) {
    super(cause ?? "The LDLf engine could not be loaded.");
    this.name = "EngineUnavailableError";
  }
}

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

/** Shape of the JSON the C++ binding returns. */
type RawResult =
  | { ok: false; error: string }
  | {
      ok: true;
      variables: string[];
      initial: number;
      states: number;
      accepting: number[];
      transitions: { from: number; to: number; mask: number }[];
    };

type LydiaModule = {
  translate: (formula: string, logic: string) => string;
};

const WASM_URL = "/wasm/lydia.mjs";

let modulePromise: Promise<LydiaModule> | null = null;

function loadModule(): Promise<LydiaModule> {
  if (modulePromise) return modulePromise;

  modulePromise = (async () => {
    try {
      // Held in a variable so the bundler leaves this alone and the browser
      // resolves it against /public at runtime.
      const url = WASM_URL;
      const mod = (await import(/* webpackIgnore: true */ url)) as {
        default: () => Promise<LydiaModule>;
      };
      return await mod.default();
    } catch (e) {
      modulePromise = null;
      throw new EngineUnavailableError(e instanceof Error ? e.message : undefined);
    }
  })();

  return modulePromise;
}

/** Downloads and instantiates the engine without translating anything. */
export function preload(): void {
  void loadModule().catch(() => {
    /* surfaced on the next translate() */
  });
}

/** The letter-level automaton, before edges are folded into boolean labels. */
export type RawAutomaton = {
  /** Proposition names in bit order: bit i of a mask is variables[i]. */
  variables: string[];
  initial: number;
  states: number;
  accepting: number[];
  transitions: { from: number; to: number; mask: number }[];
};

export async function translateRaw(
  formula: string,
  logic: "ldlf" | "ltlf" = "ldlf",
): Promise<RawAutomaton> {
  const lydia = await loadModule();

  let raw: RawResult;
  try {
    raw = JSON.parse(lydia.translate(formula, logic)) as RawResult;
  } catch {
    throw new TranslationError("The engine returned a malformed result.");
  }

  if (!raw.ok) throw new TranslationError(raw.error);
  return raw;
}

export async function translate(
  formula: string,
  logic: "ldlf" | "ltlf" = "ldlf",
): Promise<Automaton> {
  const raw = await translateRaw(formula, logic);

  const name = (i: number) => `q${i}`;

  // One edge per letter comes back; fold parallel edges into one label.
  const bundles = new Map<string, number[]>();
  for (const t of raw.transitions) {
    const k = `${t.from}->${t.to}`;
    const masks = bundles.get(k);
    if (masks) masks.push(t.mask);
    else bundles.set(k, [t.mask]);
  }

  const transitions = Array.from(bundles.entries()).map(([k, masks]) => {
    const [from, to] = k.split("->").map(Number);
    return {
      from: name(from),
      to: name(to),
      label: labelFor(masks, raw.variables),
    };
  });

  return {
    states: Array.from({ length: raw.states }, (_, i) => name(i)),
    initial: name(raw.initial),
    accepting: raw.accepting.map(name),
    transitions,
  };
}

/** Renders an automaton as a mermaid state diagram. */
export function toMermaid(automaton: Automaton): string {
  const accepting = new Set(automaton.accepting);
  const lines = ["stateDiagram-v2", `  [*] --> ${automaton.initial}`];

  for (const { from, to, label } of automaton.transitions) {
    lines.push(`  ${from} --> ${to}: ${label}`);
  }
  for (const state of automaton.states) {
    if (accepting.has(state)) lines.push(`  ${state} --> [*]`);
  }

  return lines.join("\n");
}
