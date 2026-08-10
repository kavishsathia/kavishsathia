/**
 * LDLf modulo theories: predicates → letters → Lydia → Z3-pruned DFA.
 *
 * Lydia builds the automaton over free propositional letters, which is sound
 * but ignorant: it happily draws edges for letters like `x>10 ∧ x≤0` that no
 * value can realise. Mintermization closes the gap — Z3 classifies every
 * letter as realisable (with a witness) or contradictory, contradictory
 * edges are deleted, and unreachable states fall away. The unsat letters
 * also become don't-cares for label simplification, which is why the edge
 * labels stay short.
 */

import { translateRaw, type Automaton, type RawAutomaton } from "@/lib/ldlf/engine";
import { labelFor } from "@/lib/ldlf/labels";
import {
  extractPredicates,
  type Predicate,
} from "./predicates";
import { mintermize, type Minterm, type Z3Api } from "./z3";

export type MtResult = {
  /** The pruned automaton, edges labelled with predicate comparisons. */
  automaton: Automaton;
  /** Distinct predicates, index-aligned with minterm mask bits. */
  predicates: Predicate[];
  /** Every predicate combination, sat with witness or unsat with conflict. */
  minterms: Minterm[];
  /** All variables mentioned by any predicate, sorted. */
  variables: string[];
  /** `${from}->${to}` → a concrete assignment realising that edge. */
  edgeWitnesses: Map<string, Record<string, number>>;
  /** Letter-level edges deleted because their letter is contradictory. */
  prunedEdges: number;
  /** States that became unreachable once contradictory edges were gone. */
  prunedStates: number;
  /** Data the simulator needs to run the *complete* automaton. */
  sim: SimAutomaton;
};

export type SimAutomaton = {
  raw: RawAutomaton;
  /** rawBit[i] is the bit of predicates[i] in raw masks, or -1 if Lydia dropped it. */
  rawBit: number[];
  /** States (by name) from which acceptance is still possible in the pruned automaton. */
  live: Set<string>;
};

const stateName = (i: number) => `q${i}`;

export async function translateMt(
  input: string,
  options: {
    api?: Z3Api;
    onPhase?: (phase: "translating" | "checking", done?: number, total?: number) => void;
  } = {},
): Promise<MtResult> {
  const { formula, predicates, letters } = extractPredicates(input);

  options.onPhase?.("translating");
  const raw = await translateRaw(formula);

  options.onPhase?.("checking", 0, 1 << predicates.length);
  const minterms = await mintermize(predicates, {
    api: options.api,
    onProgress: (done, total) => options.onPhase?.("checking", done, total),
  });

  const satByMask = new Map(minterms.map((m) => [m.mask, m]));

  // Lydia can simplify a letter out of the formula entirely; those bits are
  // then absent from raw.variables and a raw mask constrains only the
  // predicates that survived.
  const rawBit = letters.map((letter) => raw.variables.indexOf(letter));
  const bitPred: number[] = raw.variables.map((v) => letters.indexOf(v));

  // A raw mask fixes the surviving predicates and leaves the dropped ones
  // free — it is realisable iff some completion of the free bits is sat.
  const freePreds = predicates.map((_, i) => i).filter((i) => rawBit[i] === -1);
  const realisable = new Map<number, Minterm | null>();
  function realise(rawMask: number): Minterm | null {
    const cached = realisable.get(rawMask);
    if (cached !== undefined) return cached;

    let base = 0;
    for (let bit = 0; bit < raw.variables.length; bit++) {
      if (rawMask & (1 << bit) && bitPred[bit] >= 0) base |= 1 << bitPred[bit];
    }
    let found: Minterm | null = null;
    for (let combo = 0; combo < 1 << freePreds.length; combo++) {
      let mask = base;
      freePreds.forEach((p, j) => {
        if (combo & (1 << j)) mask |= 1 << p;
      });
      const m = satByMask.get(mask);
      if (m && m.status !== "unsat") {
        found = m;
        break;
      }
    }
    realisable.set(rawMask, found);
    return found;
  }

  // Drop contradictory edges, then drop whatever became unreachable.
  const keptEdges = raw.transitions.filter((t) => realise(t.mask) !== null);
  const prunedEdges = raw.transitions.length - keptEdges.length;

  const adjacency = new Map<number, number[]>();
  for (const t of keptEdges) {
    const list = adjacency.get(t.from);
    if (list) list.push(t.to);
    else adjacency.set(t.from, [t.to]);
  }
  const reachable = new Set<number>([raw.initial]);
  const queue = [raw.initial];
  while (queue.length > 0) {
    const s = queue.pop() as number;
    for (const next of adjacency.get(s) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const edges = keptEdges.filter((t) => reachable.has(t.from));

  // The full raw alphabet's contradictory letters become don't-cares so
  // Quine–McCluskey can fold them into shorter labels.
  const dontCares: number[] = [];
  for (let mask = 0; mask < 1 << raw.variables.length; mask++) {
    if (realise(mask) === null) dontCares.push(mask);
  }

  const renderAtom = (bit: number, positive: boolean): string => {
    const pred = predicates[bitPred[bit]];
    return positive ? pred.display : pred.negatedDisplay;
  };

  const bundles = new Map<string, number[]>();
  for (const t of edges) {
    const k = `${stateName(t.from)}->${stateName(t.to)}`;
    const masks = bundles.get(k);
    if (masks) masks.push(t.mask);
    else bundles.set(k, [t.mask]);
  }

  const edgeWitnesses = new Map<string, Record<string, number>>();
  const transitions = Array.from(bundles.entries()).map(([k, masks]) => {
    const [from, to] = k.split("->");
    const witness = realise(masks[0])?.witness;
    if (witness) edgeWitnesses.set(k, witness);
    return {
      from,
      to,
      label: labelFor(masks, raw.variables, {
        dontCares,
        renderAtom,
        maxLength: 100,
      }),
    };
  });

  const states = Array.from(reachable)
    .sort((a, b) => a - b)
    .map(stateName);
  const accepting = raw.accepting.filter((s) => reachable.has(s)).map(stateName);

  const automaton: Automaton = {
    states,
    initial: stateName(raw.initial),
    accepting,
    transitions,
  };

  return {
    automaton,
    predicates,
    minterms,
    variables: Array.from(new Set(predicates.flatMap((p) => p.variables))).sort(),
    edgeWitnesses,
    prunedEdges,
    prunedStates: raw.states - reachable.size,
    sim: { raw, rawBit, live: liveStates(automaton) },
  };
}

/** States from which an accepting state is still reachable. */
function liveStates(automaton: Automaton): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const { from, to } of automaton.transitions) {
    const list = incoming.get(to);
    if (list) list.push(from);
    else incoming.set(to, [from]);
  }
  const live = new Set(automaton.accepting);
  const queue = [...automaton.accepting];
  while (queue.length > 0) {
    const s = queue.pop() as string;
    for (const prev of incoming.get(s) ?? []) {
      if (!live.has(prev)) {
        live.add(prev);
        queue.push(prev);
      }
    }
  }
  return live;
}
