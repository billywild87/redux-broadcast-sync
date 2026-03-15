import { describe, expect, it } from "vitest";
import { createSyncableReducer, SYNC_ACTION_TYPE } from "../reducer";

const initialState = { counter: 0, label: "hello" };

function rootReducer(
  state = initialState,
  action: { type: string; payload?: unknown },
) {
  if (action.type === "increment") {
    return { ...state, counter: state.counter + 1 };
  }
  return state;
}

describe("SYNC_ACTION_TYPE", () => {
  it("has the expected value", () => {
    expect(SYNC_ACTION_TYPE).toBe("@@BROADCAST_SYNC");
  });
});

describe("createSyncableReducer", () => {
  const reducer = createSyncableReducer(rootReducer);

  it("delegates to rootReducer for normal actions", () => {
    const state = reducer(undefined, { type: "increment" });
    expect(state).toEqual({ counter: 1, label: "hello" });
  });

  it("merges payload into current state on SYNC_ACTION_TYPE", () => {
    const base = { counter: 5, label: "hello" };
    const state = reducer(base, {
      type: SYNC_ACTION_TYPE,
      payload: { counter: 99 },
    });
    expect(state).toEqual({ counter: 99, label: "hello" });
  });

  it("applies full state patch on SYNC_ACTION_TYPE", () => {
    const base = { counter: 0, label: "hello" };
    const state = reducer(base, {
      type: SYNC_ACTION_TYPE,
      payload: { counter: 10, label: "world" },
    });
    expect(state).toEqual({ counter: 10, label: "world" });
  });

  it("ignores unknown actions", () => {
    const state = reducer(initialState, { type: "unknown" });
    expect(state).toBe(initialState);
  });
});
