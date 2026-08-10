/**
 * Enumerates traces accepted by a DFA.
 *
 * Two things make a naive search useless here. Lydia returns a *complete*
 * automaton, so there is a rejecting sink that swallows most paths — we prune
 * to the states that can still reach an accepting state before searching. And
 * any cycle admits infinitely many traces, so each state may only be entered a
 * bounded number of times; a loop body therefore appears at most `maxRepeat`
 * times and anything cut short is reported rather than silently dropped.
 */

import type { Automaton } from "./engine";

export type Trace = {
  /** Edge labels in order. Empty means the initial state is already accepting. */
  steps: string[];
  /** States visited, starting at the initial state; length is steps.length + 1. */
  states: string[];
};

export type TraceResult = {
  traces: Trace[];
  /** A branch was cut by the repeat bound or the limit, so this list is partial. */
  truncated: boolean;
};

export type TraceOptions = {
  /** How many times a loop body may repeat. */
  maxRepeat?: number;
  /** Stop after this many traces. */
  limit?: number;
  /** Give up on paths longer than this. */
  maxLength?: number;
};

/** States from which some accepting state is still reachable. */
function coReachable(automaton: Automaton): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const { from, to } of automaton.transitions) {
    const list = incoming.get(to);
    if (list) list.push(from);
    else incoming.set(to, [from]);
  }

  const seen = new Set(automaton.accepting);
  const queue = [...automaton.accepting];

  while (queue.length > 0) {
    const state = queue.pop() as string;
    for (const prev of incoming.get(state) ?? []) {
      if (!seen.has(prev)) {
        seen.add(prev);
        queue.push(prev);
      }
    }
  }

  return seen;
}

export function enumerateTraces(
  automaton: Automaton,
  options: TraceOptions = {},
): TraceResult {
  const maxRepeat = options.maxRepeat ?? 2;
  const limit = options.limit ?? 40;
  const maxLength = options.maxLength ?? 12;

  // Entering a state n+1 times means going round its loop n times.
  const maxVisits = maxRepeat + 1;

  const live = coReachable(automaton);
  if (!live.has(automaton.initial)) {
    // No accepting state is reachable at all — the formula is unsatisfiable.
    return { traces: [], truncated: false };
  }

  const outgoing = new Map<string, { to: string; label: string }[]>();
  for (const { from, to, label } of automaton.transitions) {
    if (!live.has(from) || !live.has(to)) continue;
    const list = outgoing.get(from);
    if (list) list.push({ to, label });
    else outgoing.set(from, [{ to, label }]);
  }

  const accepting = new Set(automaton.accepting);
  const traces: Trace[] = [];
  let truncated = false;

  // Breadth-first over path length so the shortest, most illustrative traces
  // come out first and survive the limit.
  type Frame = {
    state: string;
    steps: string[];
    states: string[];
    visits: Map<string, number>;
  };
  let frontier: Frame[] = [
    {
      state: automaton.initial,
      steps: [],
      states: [automaton.initial],
      visits: new Map([[automaton.initial, 1]]),
    },
  ];

  if (accepting.has(automaton.initial))
    traces.push({ steps: [], states: [automaton.initial] });

  while (frontier.length > 0) {
    if (traces.length >= limit) {
      truncated = true;
      break;
    }

    const next: Frame[] = [];

    for (const frame of frontier) {
      if (frame.steps.length >= maxLength) {
        truncated = true;
        continue;
      }

      for (const edge of outgoing.get(frame.state) ?? []) {
        const seen = frame.visits.get(edge.to) ?? 0;
        if (seen >= maxVisits) {
          truncated = true;
          continue;
        }

        const steps = [...frame.steps, edge.label];
        const states = [...frame.states, edge.to];
        if (accepting.has(edge.to)) {
          if (traces.length < limit) traces.push({ steps, states });
          else truncated = true;
        }

        const nextVisits = new Map(frame.visits);
        nextVisits.set(edge.to, seen + 1);
        next.push({ state: edge.to, steps, states, visits: nextVisits });
      }
    }

    frontier = next;
  }

  return { traces, truncated };
}

/** Renders a trace the way it reads in the diagram. */
export function formatTrace(trace: Trace): string {
  return trace.steps.length === 0 ? "ε" : trace.steps.join("  ·  ");
}
