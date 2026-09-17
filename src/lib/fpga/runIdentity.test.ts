import { describe, expect, it } from "vitest";
import { RunIdentity } from "./runIdentity";

describe("run identity", () => {
  it("makes an operation inert when an edit invalidates it", () => {
    const identity = new RunIdentity();
    const run = identity.begin();
    identity.invalidate();
    expect(identity.isCurrent(run)).toBe(false);
  });

  it("makes a superseded operation inert without invalidating its replacement", () => {
    const identity = new RunIdentity();
    const oldRun = identity.begin();
    const newRun = identity.begin();
    expect(identity.isCurrent(oldRun)).toBe(false);
    expect(identity.isCurrent(newRun)).toBe(true);
  });
});
