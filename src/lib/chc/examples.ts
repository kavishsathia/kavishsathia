/** Example problems for the CHC page, all in CHC-COMP's SMT-LIB format. */

export type Example = { label: string; math: string; smt: string };

const smtExamples: { label: string; source: string }[] = [
  {
    label: "loop invariant",
    source: `; x := 0; y := 0
; while (*) { x := x + 1; y := y + 2 }
; assert y == 2 * x
;
; Spacer answers sat: the clauses have a model, and the
; model's inv is an inductive invariant proving the assert.
(set-logic HORN)

(declare-fun inv (Int Int) Bool)

; the loop is entered with x = y = 0
(assert (forall ((x Int) (y Int))
  (=> (and (= x 0) (= y 0)) (inv x y))))

; one iteration preserves inv
(assert (forall ((x Int) (y Int) (x1 Int) (y1 Int))
  (=> (and (inv x y) (= x1 (+ x 1)) (= y1 (+ y 2)))
      (inv x1 y1))))

; the assertion: no state in inv violates it
(assert (forall ((x Int) (y Int))
  (=> (and (inv x y) (not (= y (* 2 x)))) false)))

(check-sat)
(get-model)
`,
  },
  {
    label: "off by one",
    source: `; i := 0
; while (i <= 10) { i := i + 1 }   -- meant i < 10
; assert i <= 10 inside the loop body's successor
;
; unsat: false is derivable, and the derivation is a
; concrete run of the loop that breaks the assertion.
(set-logic HORN)

(declare-fun loop (Int) Bool)

(assert (forall ((i Int))
  (=> (= i 0) (loop i))))

(assert (forall ((i Int) (i1 Int))
  (=> (and (loop i) (<= i 10) (= i1 (+ i 1)))
      (loop i1))))

(assert (forall ((i Int))
  (=> (and (loop i) (> i 10)) false)))

(check-sat)
`,
  },
  {
    label: "mccarthy 91",
    source: `; int mc91(int n) {
;   if (n > 100) return n - 10;
;   return mc91(mc91(n + 11));
; }
; assert: n <= 101  ==>  mc91(n) == 91
;
; The recursive call is nested, so the clause for it has two
; predicates in its body: these clauses are nonlinear. The
; model is a summary of mc91, relating n to its result r.
(set-logic HORN)

(declare-fun mc (Int Int) Bool)

(assert (forall ((n Int) (r Int))
  (=> (and (> n 100) (= r (- n 10))) (mc n r))))

(assert (forall ((n Int) (t Int) (r Int))
  (=> (and (<= n 100) (mc (+ n 11) t) (mc t r))
      (mc n r))))

(assert (forall ((n Int) (r Int))
  (=> (and (mc n r) (<= n 101) (not (= r 91))) false)))

(check-sat)
`,
  },
  {
    label: "fibonacci",
    source: `; int fib(int n) {
;   if (n < 2) return n;
;   return fib(n - 1) + fib(n - 2);
; }
; claim: fib never returns 8   (false: fib(6) = 8)
;
; The counterexample is a derivation tree, not a path:
; each fib fact is built from two smaller ones.
(set-logic HORN)

(declare-fun fib (Int Int) Bool)

(assert (forall ((n Int) (r Int))
  (=> (and (>= n 0) (< n 2) (= r n)) (fib n r))))

(assert (forall ((n Int) (a Int) (b Int) (r Int))
  (=> (and (>= n 2) (fib (- n 1) a) (fib (- n 2) b) (= r (+ a b)))
      (fib n r))))

(assert (forall ((n Int) (r Int))
  (=> (and (fib n r) (= r 8)) false)))

(check-sat)
`,
  },
  {
    label: "two loops",
    source: `; assume n >= 0
; i := 0;           while (i < n) { i := i + 1 }
; j := 0;           while (i > 0) { i := i - 1; j := j + 1 }
; assert j == n
;
; One predicate per loop head. The second loop's invariant
; has to carry i + j == n, which only holds because the
; first loop ends with i == n.
(set-logic HORN)

(declare-fun up (Int Int) Bool)
(declare-fun down (Int Int Int) Bool)

(assert (forall ((i Int) (n Int))
  (=> (and (>= n 0) (= i 0)) (up i n))))

(assert (forall ((i Int) (n Int))
  (=> (and (up i n) (< i n)) (up (+ i 1) n))))

(assert (forall ((i Int) (j Int) (n Int))
  (=> (and (up i n) (>= i n) (= j 0)) (down i j n))))

(assert (forall ((i Int) (j Int) (n Int))
  (=> (and (down i j n) (> i 0)) (down (- i 1) (+ j 1) n))))

(assert (forall ((i Int) (j Int) (n Int))
  (=> (and (down i j n) (<= i 0) (not (= j n))) false)))

(check-sat)
`,
  },
];

const mathExamples: Record<string, string> = {
  "loop invariant": `// x := 0; y := 0
// while (*) { x := x + 1; y := y + 2 }
// assert y == 2 * x
//
// Each line is a clause, and its variables are universally
// quantified. sat means the clauses have a model: the model's
// inv is an inductive invariant that proves the assert.

pred inv(x: int, y: int)

// the loop is entered with x = y = 0
x == 0 && y == 0 ==> inv(x, y)

// one iteration preserves inv (primes name the next state)
inv(x, y) && x' == x + 1 && y' == y + 2 ==> inv(x', y')

// the assertion: no state in inv violates it
inv(x, y) ==> y == 2 * x
`,
  "off by one": `// i := 0
// while (i <= 10) { i := i + 1 }   -- meant i < 10
// assert i <= 10 at every loop head
//
// unsat: false is derivable, and the derivation is a
// concrete run of the loop that breaks the assertion.

pred loop(i: int)

i == 0 ==> loop(i)
loop(i) && i <= 10 ==> loop(i + 1)
loop(i) && i > 10 ==> false
`,
  "mccarthy 91": `// int mc91(int n) {
//   if (n > 100) return n - 10;
//   return mc91(mc91(n + 11));
// }
// assert: n <= 101  ==>  mc91(n) == 91
//
// The recursive call is nested, so its clause has two
// predicates in the body: these clauses are nonlinear. The
// model is a summary of mc91, relating n to its result r.

pred mc(n: int, r: int)

n > 100 ==> mc(n, n - 10)
n <= 100 && mc(n + 11, t) && mc(t, r) ==> mc(n, r)
mc(n, r) && n <= 101 ==> r == 91
`,
  fibonacci: `// int fib(int n) {
//   if (n < 2) return n;
//   return fib(n - 1) + fib(n - 2);
// }
// claim: fib never returns 8   (false: fib(6) = 8)
//
// The counterexample is a derivation tree, not a path:
// each fib fact is built from two smaller ones.

pred fib(n: int, r: int)

0 <= n < 2 ==> fib(n, n)
n >= 2 && fib(n - 1, a) && fib(n - 2, b) ==> fib(n, a + b)
fib(n, r) ==> r != 8
`,
  "two loops": `// assume n >= 0
// i := 0;  while (i < n) { i := i + 1 }
// j := 0;  while (i > 0) { i := i - 1; j := j + 1 }
// assert j == n
//
// One predicate per loop head. The second loop's invariant
// has to carry i + j == n, which only holds because the
// first loop ends with i == n.

pred up(i: int, n: int)
pred down(i: int, j: int, n: int)

n >= 0 ==> up(0, n)
up(i, n) && i < n ==> up(i + 1, n)
up(i, n) && i >= n ==> down(i, 0, n)
down(i, j, n) && i > 0 ==> down(i - 1, j + 1, n)
down(i, j, n) && i <= 0 ==> j == n
`,
};

export const examples: Example[] = smtExamples.map((e) => ({
  label: e.label,
  smt: e.source,
  math: mathExamples[e.label],
}));
