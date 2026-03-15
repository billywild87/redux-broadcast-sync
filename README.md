# redux-broadcast-sync

[![npm](https://img.shields.io/npm/v/redux-broadcast-sync)](https://www.npmjs.com/package/redux-broadcast-sync)
[![license](https://img.shields.io/npm/l/redux-broadcast-sync)](./LICENSE)
[![types](https://img.shields.io/npm/types/redux-broadcast-sync)](./src/types.ts)

Redux middleware to sync state across **iframes and browser tabs** via the [BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel).

- Syncs **state deltas** — only what changed is broadcast, not full state
- Works across iframes, tabs, and any browsing context on the same origin
- New contexts receive the current state **automatically on mount**
- Per-sender **sequence numbers** prevent stale or out-of-order updates
- Fully configurable: channel name, debounce, excluded slices and actions

---

## Installation

```bash
npm install redux-broadcast-sync
```

> `@reduxjs/toolkit` is a peer dependency — make sure it's installed in your project.

---

## Setup

```ts
// store.ts
import { combineReducers, configureStore } from "@reduxjs/toolkit";
import { createBroadcastMiddleware, createSyncableReducer } from "redux-broadcast-sync";

const rootReducer = combineReducers({
  user: userReducer,
  products: productsReducer,
});

const { middleware, cleanup } = createBroadcastMiddleware();

export const store = configureStore({
  reducer: createSyncableReducer(rootReducer),
  middleware: (getDefault) => getDefault().concat(middleware),
});

// HMR cleanup (Vite)
if (import.meta.hot) {
  import.meta.hot.dispose(cleanup);
}
```

No changes needed in your components or slices. Any `dispatch()` call automatically syncs the state delta to all other contexts sharing the same `channelName`.

---

## How it works

**On every dispatch:**

1. The reducer runs locally and updates the state
2. `shallowDiff` computes what changed since the last broadcast
3. Only the delta is sent via `BroadcastChannel.postMessage`
4. Other contexts receive it, merge the delta into their state, and re-render

**When a new context boots:**

1. It sends a `REQUEST_STATE` message on the channel
2. Any existing context replies with its full current state (`INIT_RESPONSE`)
3. The new context applies that state and is immediately in sync
4. If no peer responds within `fallbackTimeoutMs` (default: 50ms), it starts fresh with its own initial state

---

## API

### `createBroadcastMiddleware(options?)`

Returns `{ middleware, cleanup }`.

| Option | Type | Default | Description |
|:---|:---|:---|:---|
| `channelName` | `string` | `"redux-sync"` | Name of the shared BroadcastChannel |
| `debounceMs` | `number` | `0` | Debounce delay in ms before emitting a STATE_UPDATE |
| `fallbackTimeoutMs` | `number` | `50` | Timeout in ms before a new context declares itself ready if no peer responds |
| `excludeSlices` | `string[]` | `[]` | State slices to exclude from sync |
| `excludeActions` | `string[]` | `[]` | Action types that will not trigger a sync |
| `excludeAction` | `(action) => boolean` | `undefined` | Predicate to exclude actions dynamically |
| `createChannel` | `(name: string) => BroadcastChannel` | `new BroadcastChannel(name)` | Custom channel factory — inject a polyfill here |
| `generateId` | `() => string` | `crypto.randomUUID()` | Custom instance ID generator |
| `maxPendingUpdates` | `number` | `100` | Max STATE_UPDATEs buffered before INIT_RESPONSE arrives |

### `createSyncableReducer(rootReducer)`

Wraps your root reducer so it can receive state patches from other contexts.

```ts
const store = configureStore({
  reducer: createSyncableReducer(rootReducer),
});
```

### `SYNC_ACTION_TYPE`

The internal action type used to apply incoming state patches (`"@@BROADCAST_SYNC"`). Useful to filter it out in devtools or other middleware.

---

## Recipes

### iframes with shared Redux state

```ts
// Each iframe uses the same setup — state stays in sync automatically.

// iframe-a/store.ts
const { middleware } = createBroadcastMiddleware({ channelName: "app" });
export const store = configureStore({
  reducer: createSyncableReducer(rootReducer),
  middleware: (get) => get().concat(middleware),
});

// iframe-b/store.ts
const { middleware } = createBroadcastMiddleware({ channelName: "app" });
export const store = configureStore({
  reducer: createSyncableReducer(rootReducer),
  middleware: (get) => get().concat(middleware),
});
```

### Excluding local state

Use `excludeSlices` to prevent entire slices from being broadcast:

```ts
createBroadcastMiddleware({
  excludeSlices: ["ui", "notifications", "router"],
});
```

Use `excludeActions` to skip sync for specific action types:

```ts
createBroadcastMiddleware({
  excludeActions: ["ui/setHoveredRow", "ui/openDropdown"],
});
```

Use `excludeAction` for dynamic filtering with a predicate:

```ts
// Exclude an entire feature by prefix
createBroadcastMiddleware({
  excludeAction: (action) => action.type.startsWith("ui/"),
});

// Exclude based on payload
createBroadcastMiddleware({
  excludeAction: (action) => action.type === "items/select" && action.payload.temporary,
});
```

`excludeActions` and `excludeAction` can be combined — an action is excluded if either matches.

### Polyfill for unsupported environments

```ts
import { BroadcastChannel } from "broadcast-channel";

createBroadcastMiddleware({
  createChannel: (name) => new BroadcastChannel(name),
});
```

---

## Browser support

Requires the [BroadcastChannel API](https://caniuse.com/broadcastchannel) — supported in all modern browsers (Chrome 54+, Firefox 38+, Safari 15.4+).
