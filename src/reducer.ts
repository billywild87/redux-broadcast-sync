import type { Reducer, UnknownAction } from "@reduxjs/toolkit";

export const SYNC_ACTION_TYPE = "@@BROADCAST_SYNC";

/**
 * Wraps a root reducer so it can receive state patches from other contexts (iframes, tabs).
 *
 * Usage:
 *   const store = configureStore({
 *     reducer: createSyncableReducer(rootReducer),
 *   });
 */
export function createSyncableReducer<S>(
  rootReducer: Reducer<S>,
): Reducer<S, UnknownAction> {
  return function syncableReducer(
    state: S | undefined,
    action: UnknownAction,
  ): S {
    if (action.type === SYNC_ACTION_TYPE) {
      const current = rootReducer(state, { type: "@@INIT" });
      return { ...current, ...(action.payload as Partial<S>) };
    }
    return rootReducer(state, action);
  };
}
