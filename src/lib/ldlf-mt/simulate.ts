/**
 * Runs a concrete trace through the automaton.
 *
 * No solver involved: each step's values decide every predicate, that picks
 * exactly one letter, and the complete letter-level automaton always has the
 * edge. The interesting extra is the liveness check — the first step that
 * leaves the set of states from which acceptance is still possible is the
 * moment the trace became a lost cause, which is worth pointing at.
 */

import { evaluatePredicate, PredicateError, type Predicate } from "./predicates";
import type { SimAutomaton } from "./translate";

export type SimStep = {
  assignment: Record<string, number>;
  /** holds[i] is whether predicates[i] is true at this step. */
  holds: boolean[];
  /** State after taking this step. */
  state: string;
};

export type Simulation = {
  steps: SimStep[];
  accepted: boolean;
  /**
   * Index of the first step after which acceptance became impossible, or
   * null if the run stayed live throughout. -1 means it was doomed from the
   * start (the formula is unsatisfiable).
   */
  deadFrom: number | null;
};

export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationError";
  }
}

/**
 * Parses trace input: steps separated by `;` or newlines, each step a
 * comma-separated list of `var = value` assignments.
 */
export function parseTraceInput(
  input: string,
  variables: string[],
): Record<string, number>[] {
  const stepTexts = input
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

  return stepTexts.map((stepText, stepIndex) => {
    const assignment: Record<string, number> = {};
    for (const part of stepText.split(",")) {
      const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(-?\d+)\s*$/.exec(part);
      if (!m) {
        throw new SimulationError(
          `Step ${stepIndex + 1}: couldn't read '${part.trim()}' — write assignments like x = 5.`,
        );
      }
      assignment[m[1]] = parseInt(m[2], 10);
    }
    for (const v of variables) {
      if (assignment[v] === undefined) {
        throw new SimulationError(`Step ${stepIndex + 1}: no value for '${v}'.`);
      }
    }
    return assignment;
  });
}

const stateName = (i: number) => `q${i}`;

export function simulate(
  sim: SimAutomaton,
  predicates: Predicate[],
  assignments: Record<string, number>[],
): Simulation {
  const { raw, rawBit, live } = sim;

  // from-state → mask → to-state, over the complete automaton.
  const delta = new Map<number, Map<number, number>>();
  for (const t of raw.transitions) {
    let byMask = delta.get(t.from);
    if (!byMask) {
      byMask = new Map();
      delta.set(t.from, byMask);
    }
    byMask.set(t.mask, t.to);
  }

  const steps: SimStep[] = [];
  let state = raw.initial;
  let deadFrom: number | null = live.has(stateName(state)) ? null : -1;

  for (const [index, assignment] of assignments.entries()) {
    let holds: boolean[];
    try {
      holds = predicates.map((p) => evaluatePredicate(p, assignment));
    } catch (e) {
      throw new SimulationError(
        e instanceof PredicateError ? e.message : "Couldn't evaluate a predicate.",
      );
    }

    let mask = 0;
    holds.forEach((h, i) => {
      if (h && rawBit[i] >= 0) mask |= 1 << rawBit[i];
    });

    const to = delta.get(state)?.get(mask);
    if (to === undefined) {
      // A complete DFA always has the edge; missing means engine trouble.
      throw new SimulationError(`No transition from ${stateName(state)} — this is a bug.`);
    }
    state = to;

    if (deadFrom === null && !live.has(stateName(state))) deadFrom = index;
    steps.push({ assignment, holds, state: stateName(state) });
  }

  return {
    steps,
    accepted: raw.accepting.includes(state),
    deadFrom,
  };
}
