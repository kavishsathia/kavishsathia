import { expect, test, type Page } from "@playwright/test";

// One page for the file: the JVM boots once, as it would for a visitor.
// Everything below runs the real cel-java verifier and runtime on CheerpJ.
test.describe.configure({ mode: "serial" });

let page: Page;
const errors: string[] = [];
const offsite: string[] = [];

test.beforeAll(async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop core-journey coverage");
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (host !== "127.0.0.1" && host !== "cjrtnc.leaningtech.com") offsite.push(r.url());
  });
  await page.goto("/tools/cel/units");
});

test.afterAll(async () => {
  await page?.close();
});

const summary = () => page.getByTestId("units-proof-summary");
const cell = (a: string, b: string) => page.getByTestId(`cell-${a}-${b}`);

async function prove(example?: string) {
  if (example) await page.getByTestId(`units-example-${example}`).click();
  await page.getByTestId("units-prove").click();
  await expect(summary()).toBeVisible({ timeout: 240_000 });
}

const coverage = (key: "gap" | "exhaustive" | "disjoint") => page.getByTestId(`coverage-${key}`);

/** Coverage is checked without any click; wait until all three answers are in and current. */
async function coverageSettled() {
  await expect(page.getByTestId("units-coverage-status")).toHaveCount(0, { timeout: 240_000 });
  for (const k of ["gap", "exhaustive", "disjoint"] as const) {
    await expect(coverage(k)).not.toHaveAttribute("data-verdict", "pending", { timeout: 120_000 });
  }
}

async function translate() {
  await page.getByTestId("units-translate").click();
  await expect(page.getByTestId("units-trace")).toBeVisible({ timeout: 120_000 });
}

test("coverage is checked automatically once the verifier is up, with no click", async () => {
  test.setTimeout(300_000);
  await coverageSettled();
  await expect(coverage("gap")).toHaveAttribute("data-verdict", "refuted");
  await expect(coverage("gap")).toContainText("leave gaps");
  await expect(coverage("gap")).toContainText("goes to other");
  await expect(coverage("exhaustive")).toHaveAttribute("data-verdict", "proved");
  await expect(coverage("disjoint")).toHaveAttribute("data-verdict", "proved");
  await expect(page.getByTestId("units-coverage-summary")).toContainText("separate disjointness proof");
  await coverage("exhaustive").click();
  await expect(page.getByTestId("units-detail")).toContainText("isAlwaysTrue");
  await expect(page.getByTestId("units-detail")).toContainText("VERIFIED");
});

test("agent tool calls: every pair proven disjoint, events translated by CEL", async () => {
  test.setTimeout(300_000);
  await prove("agent-disjoint");
  await expect(summary()).toHaveText("all 15 pairs proven disjoint under the assumption");
  await expect(cell("pay_small", "pay_large")).toHaveAttribute("data-verdict", "disjoint");
  await expect(cell("read_local", "read_local")).toHaveAttribute("data-verdict", "reachable");
  await coverageSettled();
  await expect(cell("pay_small", "(otherwise)")).toHaveAttribute("data-verdict", "disjoint");
  await expect(cell("(otherwise)", "(otherwise)")).toHaveAttribute("data-verdict", "reachable");
  await expect(page.getByTestId("units-coverage-summary")).toHaveText(
    "total and unambiguous: every in-domain event is translated to exactly one CSP event",
  );

  await cell("pay_small", "pay_large").click();
  const detail = page.getByTestId("units-detail");
  await expect(detail).toContainText("amount <= 100");
  await expect(detail).toContainText("Condition is not satisfiable.");

  await translate();
  await expect(page.getByTestId("translation-2")).toContainText("pay_small → pay.small");
  await expect(page.getByTestId("translation-3")).toContainText("pay_large → pay.large");
  await expect(page.getByTestId("translation-4")).toContainText("no unit matches → otherwise → other");
  await expect(page.getByTestId("translation-5")).toContainText("write → fs.write");
  await expect(page.getByTestId("units-trace")).toContainText(
    "⟨fs.read, fs.read_system, pay.small, pay.large, other, fs.write⟩",
  );
});

test("an edit makes results stale; coverage re-checks itself", async () => {
  test.setTimeout(240_000);
  const predicate = page.getByLabel("predicate of pay_large");
  await predicate.fill("tool == 'transfer' && amount >= 100");
  await expect(page.getByTestId("units-proof-stale")).toBeVisible();
  await expect(page.getByTestId("units-translation-stale")).toBeVisible();
  await expect(summary()).toHaveCount(0);
  await expect(page.getByTestId("units-coverage-status")).toBeVisible();
  // No click: the debounced run replaces the stale answer.
  await coverageSettled();
  await expect(coverage("exhaustive")).toHaveAttribute("data-verdict", "proved");
  // Exhaustive isn't disjoint: the stale pairwise proof can't vouch for the edit.
  await expect(page.getByTestId("units-coverage-summary")).toContainText("separate disjointness proof");
});

test("the fallback event must be distinct from every explicit event", async () => {
  const fallback = page.getByLabel("fallback CSP event");
  await fallback.fill("fs.write");
  await expect(page.getByTestId("unit-fallback")).toContainText(
    "fallback event fs.write is also emitted by write; it must be a distinct CSP event",
  );
  await expect(page.getByTestId("units-prove")).toBeDisabled();
  await expect(page.getByTestId("units-coverage-status")).toHaveText("fix the errors above — nothing checked");
  await fallback.fill("other");
  await expect(page.getByTestId("units-prove")).toBeEnabled();
});

test("overlap: the solver's witness, replayed through the runtime, is ambiguous", async () => {
  test.setTimeout(240_000);
  await prove("agent-overlap");
  await expect(summary()).toHaveText("2 overlapping, 0 not proven, 4 of 6 pairs proven disjoint");
  await expect(cell("pay_small", "pay_large")).toHaveAttribute("data-verdict", "overlap");
  await expect(cell("read_any", "read_secret")).toHaveAttribute("data-verdict", "overlap");

  await cell("pay_small", "pay_large").click();
  const detail = page.getByTestId("units-detail");
  await expect(detail).toContainText("Satisfying input:");
  await expect(detail).toContainText("amount = 100");
  await expect(detail).toContainText("free in the witness (the query doesn't constrain them; fill in any value): resource");
  await page.getByTestId("units-load-witness").click();
  const witnessEvent = page.getByTestId("event-3");
  await expect(witnessEvent.getByLabel("amount:int")).toHaveValue("100");
  await expect(witnessEvent.getByLabel("tool:string")).toHaveValue('"transfer"');
  await witnessEvent.getByLabel("resource:string").fill("'anything'");

  await translate();
  await expect(page.getByTestId("translation-0")).toContainText("ambiguous: pay_small → pay.small, pay_large → pay.large");
  await expect(page.getByTestId("translation-0")).toContainText("not sent to the fallback");
  await expect(page.getByTestId("translation-2")).toContainText("otherwise → other");
  await expect(page.getByTestId("translation-3")).toContainText("ambiguous: pay_small → pay.small, pay_large → pay.large");
  await expect(page.getByTestId("units-trace")).toContainText("no CSP trace: e1 is ambiguous");
});

test("boundaries: bounded quantifiers not proven, vacuous unit, runtime and input errors", async () => {
  test.setTimeout(240_000);
  await prove("boundaries");
  await expect(cell("export_pii", "export_plain")).toHaveAttribute("data-verdict", "not proven");
  await expect(cell("refund", "refund")).toHaveAttribute("data-verdict", "vacuous");
  await expect(summary()).toContainText("1 not proven");
  await expect(page.getByTestId("units-proof")).toContainText("vacuous (no event in the domain reaches it): refund");
  await cell("export_pii", "export_plain").click();
  await expect(page.getByTestId("units-detail")).toContainText("Inconclusive");

  await translate();
  await expect(page.getByTestId("translation-0")).toContainText("export_pii → export.pii");
  await expect(page.getByTestId("translation-2")).toContainText("rate: eval:");
  await expect(page.getByTestId("translation-2")).toContainText("ArithmeticException");
  await expect(page.getByTestId("translation-3")).toContainText("expected type 'int' but found 'string'");
  await expect(page.getByTestId("translation-4")).toContainText("outside the assumption — not translated");
  await expect(page.getByTestId("translation-4")).not.toContainText("otherwise →");

  // The bounded fallback-disjointness query is inconclusive, and the division can error.
  await coverageSettled();
  await expect(coverage("disjoint")).toHaveAttribute("data-verdict", "not-proven");
  await expect(coverage("exhaustive")).toHaveAttribute("data-verdict", "refuted");
});

test("fallback & coverage: gaps go to the fallback, a CEL error defeats exhaustiveness", async () => {
  test.setTimeout(240_000);
  await page.getByTestId("units-example-coverage").click();
  await coverageSettled();
  await expect(coverage("gap")).toContainText("goes to unclassified");
  await expect(coverage("exhaustive")).toHaveAttribute("data-verdict", "refuted");
  await expect(coverage("exhaustive")).toContainText('amount: 0, tool: "transfer"');
  await expect(page.getByTestId("units-coverage-summary")).toHaveCount(0);

  await coverage("exhaustive").click();
  await expect(page.getByTestId("units-detail")).toContainText("Condition is not always true. Counterexample input:");
  await page.getByTestId("units-load-witness").click();
  const loaded = page.getByTestId("event-4");
  await expect(loaded.getByLabel("amount:int")).toHaveValue("0");
  await loaded.getByLabel("resource:string").fill("'acct:1'");

  await translate();
  await expect(page.getByTestId("translation-1")).toContainText("no unit matches → otherwise → unclassified");
  await expect(page.getByTestId("translation-2")).toContainText("pay_large → pay.large");
  for (const i of [3, 4]) {
    await expect(page.getByTestId(`translation-${i}`)).toContainText("pay_large: eval:");
    await expect(page.getByTestId(`translation-${i}`)).not.toContainText("unclassified");
  }
  await expect(page.getByTestId("units-trace")).toHaveText("no CSP trace: e4 is an error");

  // Unsatisfiable assumption: flagged as vacuous, nothing useful proven.
  await page.getByTestId("units-assumption").fill("amount < 0 && amount > 0");
  await coverageSettled();
  await expect(page.getByTestId("units-coverage-vacuous")).toBeVisible();
  await expect(coverage("exhaustive")).toHaveAttribute("data-verdict", "not-proven");
  await expect(page.getByTestId("units-coverage-summary")).toHaveCount(0);
});

test("an undeclared variable or a non-bool predicate is an error, never disjoint", async () => {
  test.setTimeout(240_000);
  await page.getByTestId("units-example-agent-overlap").click();
  await page.getByLabel("predicate of read_secret").fill("user == 'root'");
  await page.getByLabel("predicate of pay_large").fill("amount + 1");
  await prove();
  await expect(summary()).toContainText("not proven:");
  await expect(cell("read_any", "read_secret")).toHaveAttribute("data-verdict", "error");
  await expect(cell("pay_large", "pay_large")).toHaveAttribute("data-verdict", "error");
  await cell("read_secret", "read_secret").click();
  await expect(page.getByTestId("units-detail")).toContainText("undeclared reference to 'user'");
  await cell("pay_large", "pay_large").click();
  await expect(page.getByTestId("units-detail")).toContainText("not bool");
  await coverageSettled();
  for (const k of ["gap", "exhaustive", "disjoint"] as const) {
    await expect(coverage(k)).toHaveAttribute("data-verdict", "error");
  }
  await expect(page.getByTestId("units-coverage-summary")).toHaveCount(0);
});

test("a share link restores the workbench, fallback included; old links get the default", async ({ browser }) => {
  await page.getByTestId("units-example-boundaries").click();
  await page.getByLabel("fallback CSP event").fill("rest");
  await page.getByText("share this workbench").click();
  const url = page.url();
  expect(url).toContain("?w=");
  const context = await browser.newContext();
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByLabel("predicate of refund")).toHaveValue("tool == 'refund' && amount < 0");
  await expect(other.getByLabel("fallback CSP event")).toHaveValue("rest");
  const old = Buffer.from(
    JSON.stringify({ s: "x:int", a: "", u: [["a", "x == 1", "ev.a"]], e: [{ x: "1" }], t: 10, k: 5 }),
  ).toString("base64url");
  await other.goto(`/tools/cel/units?w=${old}`);
  await expect(other.getByLabel("predicate of a")).toHaveValue("x == 1");
  await expect(other.getByLabel("fallback CSP event")).toHaveValue("other");
  await context.close();
});

test("no page errors, nothing off-site but CheerpJ's runtime", async () => {
  expect(errors).toEqual([]);
  expect(offsite).toEqual([]);
});
