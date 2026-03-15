import { describe, expect, it } from "vitest";
import { shallowDiff } from "../shallowDiff";

describe("shallowDiff", () => {
  it("returns next as-is when prev is null", () => {
    const next = { a: 1, b: 2 };
    expect(shallowDiff(null, next)).toEqual({ a: 1, b: 2 });
  });

  it("returns null when nothing changed", () => {
    const state = { a: 1, b: "x" };
    expect(shallowDiff(state, state)).toBeNull();
  });

  it("returns null when values are reference-equal", () => {
    const obj = { nested: true };
    expect(shallowDiff({ a: obj }, { a: obj })).toBeNull();
  });

  it("returns only the changed keys", () => {
    expect(shallowDiff({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({ b: 3 });
  });

  it("includes new keys added in next", () => {
    expect(shallowDiff({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: 2 });
  });

  it("detects a reference change as a change", () => {
    const prev = { a: { x: 1 } };
    const next = { a: { x: 1 } };
    expect(shallowDiff(prev, next)).toEqual({ a: { x: 1 } });
  });

  it("returns all keys when prev is null, even unchanged ones", () => {
    expect(shallowDiff(null, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("includes keys removed from next with value undefined", () => {
    expect(shallowDiff({ a: 1, b: 2 }, { a: 1 })).toEqual({ b: undefined });
  });

  it("returns null when a key is present in both with the same value", () => {
    expect(shallowDiff({ a: 1 }, { a: 1 })).toBeNull();
  });
});
