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

async function translate() {
  await page.getByTestId("units-translate").click();
  await expect(page.getByTestId("units-trace")).toBeVisible({ timeout: 120_000 });
}

test("agent tool calls: every pair proven disjoint, events translated by CEL", async () => {
  test.setTimeout(300_000);
  await prove("agent-disjoint");
  await expect(summary()).toHaveText("all 15 pairs proven disjoint under the assumption");
  await expect(cell("pay_small", "pay_large")).toHaveAttribute("data-verdict", "disjoint");
  await expect(cell("read_local", "read_local")).toHaveAttribute("data-verdict", "reachable");

  await cell("pay_small", "pay_large").click();
  const detail = page.getByTestId("units-detail");
  await expect(detail).toContainText("amount <= 100");
  await expect(detail).toContainText("Condition is not satisfiable.");

  await translate();
  await expect(page.getByTestId("translation-2")).toContainText("pay_small → pay.small");
  await expect(page.getByTestId("translation-3")).toContainText("pay_large → pay.large");
  await expect(page.getByTestId("translation-4")).toContainText("unmapped");
  await expect(page.getByTestId("translation-5")).toContainText("outside the assumption");
  await expect(page.getByTestId("units-trace")).toContainText("⟨fs.read, fs.read_system, pay.small, pay.large⟩");
});

test("an edit makes both results stale", async () => {
  const predicate = page.getByLabel("predicate of pay_large");
  await predicate.fill("tool == 'transfer' && amount >= 100");
  await expect(page.getByTestId("units-proof-stale")).toBeVisible();
  await expect(page.getByTestId("units-translation-stale")).toBeVisible();
  await expect(summary()).toHaveCount(0);
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
});

test("a share link restores the workbench", async ({ browser }) => {
  await page.getByTestId("units-example-boundaries").click();
  await page.getByText("share this workbench").click();
  const url = page.url();
  expect(url).toContain("?w=");
  const context = await browser.newContext();
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByLabel("predicate of refund")).toHaveValue("tool == 'refund' && amount < 0");
  await context.close();
});

test("no page errors, nothing off-site but CheerpJ's runtime", async () => {
  expect(errors).toEqual([]);
  expect(offsite).toEqual([]);
});
