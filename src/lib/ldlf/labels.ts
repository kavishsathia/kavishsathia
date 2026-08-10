/**
 * The WASM binding hands back one edge per letter, where a letter is a bitmask
 * over the propositions. A DFA over 3 propositions therefore has 8 parallel
 * edges between some pairs of states, which is unreadable.
 *
 * This folds each bundle of masks into one boolean label via Quine–McCluskey:
 * combine minterms into prime implicants, then greedily cover.
 */

type Implicant = {
  /** Bit i is the value of variable i, only meaningful where `care` bit i is set. */
  bits: number;
  /** Bit i set means variable i is fixed in this implicant. */
  care: number;
};

function popcount(n: number): number {
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  return c;
}

/** Every minterm covered by an implicant, given `varCount` variables. */
function covers(imp: Implicant, varCount: number): number[] {
  const free: number[] = [];
  for (let i = 0; i < varCount; i++) {
    if ((imp.care & (1 << i)) === 0) free.push(i);
  }

  const out: number[] = [];
  for (let combo = 0; combo < 1 << free.length; combo++) {
    let m = imp.bits & imp.care;
    free.forEach((v, j) => {
      if (combo & (1 << j)) m |= 1 << v;
    });
    out.push(m);
  }
  return out;
}

function primeImplicants(minterms: number[], varCount: number): Implicant[] {
  const allCare = (1 << varCount) - 1;
  let current: Implicant[] = minterms.map((m) => ({ bits: m, care: allCare }));
  const primes: Implicant[] = [];

  while (current.length > 0) {
    const merged: Implicant[] = [];
    const used = new Set<number>();
    const seen = new Set<string>();

    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const a = current[i];
        const b = current[j];
        if (a.care !== b.care) continue;

        const diff = (a.bits ^ b.bits) & a.care;
        if (popcount(diff) !== 1) continue;

        used.add(i);
        used.add(j);

        const care = a.care & ~diff;
        const bits = a.bits & care;
        const k = `${bits}:${care}`;
        if (!seen.has(k)) {
          seen.add(k);
          merged.push({ bits, care });
        }
      }
    }

    current.forEach((imp, i) => {
      if (!used.has(i)) primes.push(imp);
    });
    current = merged;
  }

  return primes;
}

function render(
  imp: Implicant,
  vars: string[],
  renderAtom: (varIndex: number, positive: boolean) => string,
): string {
  const parts: string[] = [];
  for (let i = 0; i < vars.length; i++) {
    if (imp.care & (1 << i)) {
      parts.push(renderAtom(i, (imp.bits & (1 << i)) !== 0));
    }
  }
  return parts.length === 0 ? "true" : parts.join(" & ");
}

export type LabelOptions = {
  /**
   * Letters that can never occur (e.g. unsatisfiable predicate combinations).
   * Treated as don't-cares: implicants may cover them for free, which
   * shortens labels, and they don't count toward the "covers everything"
   * check.
   */
  dontCares?: number[];
  /** How to print one atom; defaults to `vars[i]` / `!vars[i]`. */
  renderAtom?: (varIndex: number, positive: boolean) => string;
  /** Labels longer than this collapse to a count. */
  maxLength?: number;
};

/**
 * Turns a set of letters into the shortest boolean label we can cheaply find.
 * Returns "true" when the set covers every letter that can occur.
 */
export function labelFor(
  masks: number[],
  vars: string[],
  options: LabelOptions = {},
): string {
  const varCount = vars.length;
  if (varCount === 0) return "true";

  const renderAtom =
    options.renderAtom ?? ((i: number, pos: boolean) => (pos ? "" : "!") + vars[i]);
  const maxLength = options.maxLength ?? 60;
  const dontCares = new Set(options.dontCares ?? []);

  const total = 1 << varCount;
  const unique = Array.from(new Set(masks))
    .filter((m) => !dontCares.has(m))
    .sort((a, b) => a - b);
  if (unique.length === 0) return "false";
  if (unique.length === total - dontCares.size) return "true";

  // Don't-cares join the merge phase (they let implicants grow) but never
  // need to be covered themselves.
  const primes = primeImplicants([...unique, ...dontCares], varCount);

  // Greedy set cover over the minterms we still need.
  const remaining = new Set(unique);
  const chosen: Implicant[] = [];
  const coverage = primes.map((p) => ({
    imp: p,
    covered: covers(p, varCount).filter((m) => remaining.has(m)),
  }));

  while (remaining.size > 0) {
    let best: { imp: Implicant; covered: number[] } | null = null;
    for (const c of coverage) {
      const hits = c.covered.filter((m) => remaining.has(m));
      if (!best || hits.length > best.covered.filter((m) => remaining.has(m)).length) {
        best = { imp: c.imp, covered: hits };
      }
    }
    if (!best || best.covered.length === 0) break;

    chosen.push(best.imp);
    best.covered.forEach((m) => remaining.delete(m));
  }

  if (chosen.length === 0) return "…";

  const label = chosen.map((c) => render(c, vars, renderAtom)).join(" | ");
  return label.length > maxLength ? `${chosen.length} letters` : label;
}
