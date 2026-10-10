/**
 * Example specs. Each one's expected TLC exit status is checked against the
 * shipped tla2tools.jar by wasm-src/pluscal/check-examples.mjs.
 */

export type Example = {
  id: string;
  label: string;
  /** One line on what it shows. */
  blurb: string;
  tla: string;
  cfg: string;
  /** EC.ExitStatus: 0 ok, 11 deadlock, 12 safety, 13 liveness. */
  expectStatus: number;
};

export const examples: Example[] = [
  {
    id: "peterson",
    label: "Peterson's mutex",
    blurb: "two processes, one critical section: mutual exclusion and starvation freedom both hold",
    tla: String.raw`---- MODULE Peterson ----
EXTENDS TLC, Naturals

(* --algorithm Peterson
variables flag = [i \in {0, 1} |-> FALSE], turn = 0;

fair process P \in {0, 1}
begin
a1: while TRUE do
  a2: flag[self] := TRUE;
  a3: turn := 1 - self;
  a4: await ~flag[1 - self] \/ turn = self;
  cs: skip;
  a5: flag[self] := FALSE;
  end while;
end process;
end algorithm; *)

\* No two processes in the critical section at once.
MutualExclusion == ~(pc[0] = "cs" /\ pc[1] = "cs")

\* Every process that wants in eventually gets in.
StarvationFree == \A p \in {0, 1} : (pc[p] = "a2") ~> (pc[p] = "cs")
====
`,
    cfg: `SPECIFICATION Spec
INVARIANT MutualExclusion
PROPERTY StarvationFree
`,
    expectStatus: 0,
  },
  {
    id: "peterson-broken",
    label: "a missing await",
    blurb: "the same algorithm without the await: TLC finds the interleaving that breaks mutual exclusion",
    tla: String.raw`---- MODULE Racy ----
EXTENDS TLC, Naturals

(* --algorithm Racy
variables flag = [i \in {0, 1} |-> FALSE], turn = 0;

process P \in {0, 1}
begin
a1: while TRUE do
  a2: flag[self] := TRUE;
  a3: turn := 1 - self;
  cs: skip;
  a5: flag[self] := FALSE;
  end while;
end process;
end algorithm; *)

MutualExclusion == ~(pc[0] = "cs" /\ pc[1] = "cs")
====
`,
    cfg: `SPECIFICATION Spec
INVARIANT MutualExclusion
`,
    expectStatus: 12,
  },
  {
    id: "wire",
    label: "bank transfer race",
    blurb: "two concurrent wire transfers both pass the balance check, and an account goes negative",
    tla: String.raw`---- MODULE Wire ----
EXTENDS Integers

(* --algorithm wire
variables
  people = {"alice", "bob"},
  acc = [p \in people |-> 5];

define
  NoOverdrafts == \A p \in people : acc[p] >= 0
end define;

process Wire \in 1..2
  variables
    sender = "alice",
    receiver = "bob",
    amount \in 1..acc[sender];
begin
  CheckFunds:
    if amount <= acc[sender] then
      Withdraw:
        acc[sender] := acc[sender] - amount;
      Deposit:
        acc[receiver] := acc[receiver] + amount;
    end if;
end process;
end algorithm; *)
====
`,
    cfg: `SPECIFICATION Spec
INVARIANT NoOverdrafts
`,
    expectStatus: 12,
  },
  {
    id: "diehard",
    label: "Die Hard jugs",
    blurb: "plain TLA+: claim the puzzle is unsolvable, and the counterexample is the solution",
    tla: String.raw`---- MODULE DieHard ----
EXTENDS Naturals

VARIABLES small, big

TypeOK == small \in 0..3 /\ big \in 0..5

Init == small = 0 /\ big = 0

FillSmall == small' = 3 /\ big' = big
FillBig == big' = 5 /\ small' = small
EmptySmall == small' = 0 /\ big' = big
EmptyBig == big' = 0 /\ small' = small

Min(m, n) == IF m < n THEN m ELSE n

SmallToBig == /\ big' = Min(big + small, 5)
              /\ small' = small - (big' - big)

BigToSmall == /\ small' = Min(big + small, 3)
              /\ big' = big - (small' - small)

Next == \/ FillSmall \/ FillBig
        \/ EmptySmall \/ EmptyBig
        \/ SmallToBig \/ BigToSmall

Spec == Init /\ [][Next]_<<small, big>>

\* "There is no way to measure exactly 4 gallons."
NotSolved == big /= 4
====
`,
    cfg: `SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT NotSolved
`,
    expectStatus: 12,
  },
  {
    id: "unfair",
    label: "liveness needs fairness",
    blurb: "without a fair process, TLC may stop scheduling it: the counterexample stutters forever",
    tla: String.raw`---- MODULE Counter ----
EXTENDS Naturals

(* --algorithm Counter
variable x = 0;

\* Write "fair process" and the property holds.
process Inc = 1
begin
  Loop: while x < 3 do
    x := x + 1;
  end while;
end process;
end algorithm; *)

ReachesThree == <>(x = 3)
====
`,
    cfg: `SPECIFICATION Spec
PROPERTY ReachesThree
`,
    expectStatus: 13,
  },
  {
    id: "sort",
    label: "insertion sort, every input",
    blurb: "checks the algorithm on all 27 arrays over 1..3, using the Community Modules' Range",
    tla: String.raw`---- MODULE Sort ----
EXTENDS Naturals, Sequences, Functions

CONSTANT N

(* --fair algorithm Sort
variables input \in [1..N -> 1..N], arr = input, i = 2, j = 0;
begin
  Outer: while i <= N do
    j := i;
    Inner: while j > 1 /\ arr[j - 1] > arr[j] do
      arr := [arr EXCEPT ![j - 1] = arr[j], ![j] = arr[j - 1]];
      j := j - 1;
    end while;
    i := i + 1;
  end while;
end algorithm; *)

Sorted == pc = "Done" => \A k \in 1..N - 1 : arr[k] <= arr[k + 1]
SameElements == Range(arr) = Range(input)
Terminates == <>(pc = "Done")
====
`,
    cfg: `CONSTANT N = 3
SPECIFICATION Spec
INVARIANT Sorted
INVARIANT SameElements
PROPERTY Terminates
`,
    expectStatus: 0,
  },
];
