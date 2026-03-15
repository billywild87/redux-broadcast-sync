import {
  combineReducers,
  configureStore,
  createSlice,
} from "@reduxjs/toolkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBroadcastMiddleware, createSyncableReducer } from "../index";
import type { BroadcastChannelLike } from "../types";

// ---------------------------------------------------------------------------
// Mock BroadcastChannel
// Delivery is async (setTimeout 0) to match real browser behavior and avoid
// "dispatching while constructing middleware" errors from Redux.
// ---------------------------------------------------------------------------

const buses = new Map<string, Set<MockBroadcastChannel>>();

class MockBroadcastChannel implements BroadcastChannelLike {
  private listeners: ((event: MessageEvent) => void)[] = [];

  constructor(readonly name: string) {
    if (!buses.has(name)) buses.set(name, new Set());
    buses.get(name)!.add(this);
  }

  postMessage(data: unknown) {
    for (const ch of [...(buses.get(this.name) ?? [])]) {
      if (ch !== this) {
        const event = new MessageEvent("message", { data });
        setTimeout(() => ch._dispatch(event), 0);
      }
    }
  }

  _dispatch(event: MessageEvent) {
    this.listeners.forEach((l) => l(event));
  }

  addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.listeners.push(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  close() {
    buses.get(this.name)?.delete(this);
  }
}

// ---------------------------------------------------------------------------
// Test slices & root reducer
// ---------------------------------------------------------------------------

const counterSlice = createSlice({
  name: "counter",
  initialState: { value: 0 },
  reducers: {
    increment: (state) => {
      state.value += 1;
    },
    set: (state, action: { type: string; payload: number }) => {
      state.value = action.payload;
    },
  },
});

const uiSlice = createSlice({
  name: "ui",
  initialState: { open: false },
  reducers: {
    toggle: (state) => {
      state.open = !state.open;
    },
  },
});

const rootReducer = combineReducers({
  counter: counterSlice.reducer,
  ui: uiSlice.reducer,
});

type RootState = ReturnType<typeof rootReducer>;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeStore(
  options: Parameters<typeof createBroadcastMiddleware>[0] = {},
) {
  const { middleware, cleanup } = createBroadcastMiddleware({
    fallbackTimeoutMs: 10,
    createChannel: (name) => new MockBroadcastChannel(name),
    ...options,
  });

  const store = configureStore({
    reducer: createSyncableReducer(rootReducer),
    middleware: (get) => get().concat(middleware),
  });

  return { store, cleanup };
}

/** Flush all pending timers (message deliveries + broadcast timers). */
function flush() {
  vi.runAllTimers();
}

/** Boot two stores and make both ready. */
function makePair(options: Parameters<typeof createBroadcastMiddleware>[0] = {}) {
  const a = makeStore(options);
  const b = makeStore(options);
  // Let REQUEST_STATE → INIT_RESPONSE exchange complete,
  // then let fallback timers fire for any store that got no peer response.
  vi.advanceTimersByTime(10);
  return { a, b };
}

/**
 * Factory that tracks created channels so tests can inject messages directly,
 * simulating an external context without going through postMessage delivery.
 */
function makeChannelFactory() {
  const channels: MockBroadcastChannel[] = [];
  return {
    factory: (name: string) => {
      const ch = new MockBroadcastChannel(name);
      channels.push(ch);
      return ch;
    },
    channels,
  };
}

/** Directly inject a raw message into a channel, bypassing async delivery. */
function inject(ch: MockBroadcastChannel, data: unknown) {
  ch._dispatch(new MessageEvent("message", { data }));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  buses.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initialization", () => {
  it("becomes ready after fallback timeout when no peer exists", () => {
    const { store, cleanup } = makeStore();

    store.dispatch(counterSlice.actions.increment());
    vi.advanceTimersByTime(10);

    expect((store.getState() as RootState).counter.value).toBe(1);
    cleanup();
  });

  it("receives initial state from a peer via INIT_RESPONSE", () => {
    const { store: storeA, cleanup: cleanupA } = makeStore();
    vi.advanceTimersByTime(10); // storeA ready via fallback

    storeA.dispatch(counterSlice.actions.set(42));
    flush(); // broadcast STATE_UPDATE (nobody receives it yet)

    const { store: storeB, cleanup: cleanupB } = makeStore();
    flush(); // REQUEST_STATE → INIT_RESPONSE exchange

    expect((storeB.getState() as RootState).counter.value).toBe(42);

    cleanupA();
    cleanupB();
  });
});

describe("STATE_UPDATE sync", () => {
  it("syncs a state delta from storeA to storeB", () => {
    const { a, b } = makePair();

    a.store.dispatch(counterSlice.actions.set(7));
    flush();

    expect((b.store.getState() as RootState).counter.value).toBe(7);

    a.cleanup();
    b.cleanup();
  });

  it("syncs in both directions", () => {
    const { a, b } = makePair();

    b.store.dispatch(counterSlice.actions.set(99));
    flush();

    expect((a.store.getState() as RootState).counter.value).toBe(99);

    a.cleanup();
    b.cleanup();
  });

  it("does not create an infinite sync loop via @@BROADCAST_SYNC", () => {
    const { a, b } = makePair();

    a.store.dispatch(counterSlice.actions.set(5));
    flush();

    expect((a.store.getState() as RootState).counter.value).toBe(5);
    expect((b.store.getState() as RootState).counter.value).toBe(5);

    a.cleanup();
    b.cleanup();
  });
});

describe("excludeSlices", () => {
  it("does not broadcast excluded slices", () => {
    const { a, b } = makePair({ excludeSlices: ["ui"] });

    a.store.dispatch(uiSlice.actions.toggle());
    flush();

    expect((a.store.getState() as RootState).ui.open).toBe(true);
    expect((b.store.getState() as RootState).ui.open).toBe(false);

    a.cleanup();
    b.cleanup();
  });

  it("still syncs non-excluded slices", () => {
    const { a, b } = makePair({ excludeSlices: ["ui"] });

    a.store.dispatch(counterSlice.actions.set(20));
    flush();

    expect((b.store.getState() as RootState).counter.value).toBe(20);

    a.cleanup();
    b.cleanup();
  });
});

describe("excludeActions", () => {
  it("does not trigger a sync for excluded action types", () => {
    const { a, b } = makePair({
      excludeActions: [counterSlice.actions.increment.type],
    });

    a.store.dispatch(counterSlice.actions.increment());
    flush();

    expect((a.store.getState() as RootState).counter.value).toBe(1);
    expect((b.store.getState() as RootState).counter.value).toBe(0);

    a.cleanup();
    b.cleanup();
  });

  it("still syncs non-excluded actions", () => {
    const { a, b } = makePair({
      excludeActions: [counterSlice.actions.increment.type],
    });

    a.store.dispatch(counterSlice.actions.set(50));
    flush();

    expect((b.store.getState() as RootState).counter.value).toBe(50);

    a.cleanup();
    b.cleanup();
  });
});

describe("excludeAction (predicate)", () => {
  it("does not sync when the predicate returns true", () => {
    const { a, b } = makePair({
      excludeAction: (action) => action.type.startsWith("counter/"),
    });

    a.store.dispatch(counterSlice.actions.set(99));
    flush();

    expect((a.store.getState() as RootState).counter.value).toBe(99);
    expect((b.store.getState() as RootState).counter.value).toBe(0);

    a.cleanup();
    b.cleanup();
  });

  it("still syncs when the predicate returns false", () => {
    const { a, b } = makePair({
      excludeAction: (action) => action.type.startsWith("ui/"),
    });

    a.store.dispatch(counterSlice.actions.set(42));
    flush();

    expect((b.store.getState() as RootState).counter.value).toBe(42);

    a.cleanup();
    b.cleanup();
  });

  it("can filter based on payload", () => {
    const { a, b } = makePair({
      excludeAction: (action) =>
        action.type === counterSlice.actions.set.type &&
        (action as unknown as { payload: number }).payload < 10,
    });

    a.store.dispatch(counterSlice.actions.set(5)); // excluded (payload < 10)
    flush();
    expect((b.store.getState() as RootState).counter.value).toBe(0);

    a.store.dispatch(counterSlice.actions.set(50)); // synced
    flush();
    expect((b.store.getState() as RootState).counter.value).toBe(50);

    a.cleanup();
    b.cleanup();
  });

  it("works alongside excludeActions (both apply)", () => {
    const { a, b } = makePair({
      excludeActions: [uiSlice.actions.toggle.type],
      excludeAction: (action) => action.type.startsWith("counter/increment"),
    });

    a.store.dispatch(uiSlice.actions.toggle()); // excluded via excludeActions
    a.store.dispatch(counterSlice.actions.increment()); // excluded via predicate
    flush();

    expect((b.store.getState() as RootState).ui.open).toBe(false);
    expect((b.store.getState() as RootState).counter.value).toBe(0);

    a.store.dispatch(counterSlice.actions.set(10)); // synced
    flush();
    expect((b.store.getState() as RootState).counter.value).toBe(10);

    a.cleanup();
    b.cleanup();
  });
});

describe("debounceMs", () => {
  it("batches rapid dispatches into a single broadcast", () => {
    const { a, b } = makePair({ debounceMs: 50 });

    a.store.dispatch(counterSlice.actions.set(1));
    a.store.dispatch(counterSlice.actions.set(2));
    a.store.dispatch(counterSlice.actions.set(3));

    vi.advanceTimersByTime(49);
    expect((b.store.getState() as RootState).counter.value).toBe(0);

    vi.advanceTimersByTime(1); // debounce fires
    flush(); // deliver STATE_UPDATE
    expect((b.store.getState() as RootState).counter.value).toBe(3);

    a.cleanup();
    b.cleanup();
  });
});

describe("createChannel", () => {
  it("calls the custom factory with the channel name", () => {
    const factory = vi.fn((name: string) => new MockBroadcastChannel(name));
    const { cleanup } = makeStore({ channelName: "my-app", createChannel: factory });

    expect(factory).toHaveBeenCalledWith("my-app");
    cleanup();
  });
});

describe("generateId", () => {
  it("uses the return value of generateId as senderId in outgoing messages", () => {
    const { channels, factory } = makeChannelFactory();

    // storeA with a fixed, known ID
    const { cleanup: cleanupA } = makeStore({
      createChannel: factory,
      generateId: () => "my-fixed-id",
    });

    // storeB — will receive messages from storeA
    const { cleanup: cleanupB } = makeStore({ createChannel: factory });

    // Spy on storeB's channel to capture delivered messages
    const received: unknown[] = [];
    const orig = channels[1]._dispatch.bind(channels[1]);
    channels[1]._dispatch = (event: MessageEvent) => {
      received.push(event.data);
      orig(event);
    };

    vi.runAllTimers();

    const senderIds = received
      .filter((m): m is { senderId: string } => typeof m === "object" && m !== null)
      .map((m) => m.senderId);

    expect(senderIds).toContain("my-fixed-id");

    cleanupA();
    cleanupB();
  });
});

describe("maxPendingUpdates", () => {
  it("drops oldest buffered updates when the cap is exceeded", () => {
    const { channels, factory } = makeChannelFactory();

    const { cleanup: cleanupA } = makeStore({ createChannel: factory });
    vi.advanceTimersByTime(10); // storeA ready

    const { store: storeB, cleanup: cleanupB } = makeStore({
      createChannel: factory,
      maxPendingUpdates: 2,
    });
    // storeB is NOT ready yet — inject 3 STATE_UPDATEs (cap is 2, first one gets dropped)
    inject(channels[1], { type: "STATE_UPDATE", senderId: "x", seq: 1, state: { counter: { value: 1 } } });
    inject(channels[1], { type: "STATE_UPDATE", senderId: "x", seq: 2, state: { counter: { value: 2 } } });
    inject(channels[1], { type: "STATE_UPDATE", senderId: "x", seq: 3, state: { counter: { value: 3 } } });

    // Let INIT_RESPONSE arrive → storeB ready → replays buffer (seq 2 and 3 only)
    vi.runAllTimers();

    // seq=1 was dropped; last applied is seq=3
    expect((storeB.getState() as RootState).counter.value).toBe(3);

    cleanupA();
    cleanupB();
  });
});

describe("cleanup", () => {
  it("stops processing messages after cleanup", () => {
    const { a, b } = makePair();

    b.cleanup();

    a.store.dispatch(counterSlice.actions.set(77));
    flush();

    expect((b.store.getState() as RootState).counter.value).toBe(0);

    a.cleanup();
  });
});

describe("pending buffer", () => {
  it("buffers STATE_UPDATE received before INIT_RESPONSE and replays it after", () => {
    const { channels, factory } = makeChannelFactory();

    const { cleanup: cleanupA } = makeStore({ createChannel: factory });
    vi.advanceTimersByTime(10); // storeA ready via fallback

    const { store: storeB, cleanup: cleanupB } = makeStore({ createChannel: factory });
    // channels[0] = storeA's channel, channels[1] = storeB's channel
    // storeB is NOT ready yet (INIT_RESPONSE exchange is still pending in timers)

    // Inject a STATE_UPDATE directly — storeB should buffer it, not apply it
    inject(channels[1], {
      type: "STATE_UPDATE",
      senderId: "external-context",
      seq: 1,
      state: { counter: { value: 99 } },
    });

    expect((storeB.getState() as RootState).counter.value).toBe(0);

    // Flush timers: REQUEST_STATE → INIT_RESPONSE → storeB ready → buffer replayed
    vi.runAllTimers();

    expect((storeB.getState() as RootState).counter.value).toBe(99);

    cleanupA();
    cleanupB();
  });
});

describe("sequence numbers", () => {
  it("ignores messages with a seq already seen (stale)", () => {
    const { channels, factory } = makeChannelFactory();

    const { cleanup: cleanupA } = makeStore({ createChannel: factory });
    const { store: storeB, cleanup: cleanupB } = makeStore({ createChannel: factory });
    vi.advanceTimersByTime(10); // both ready

    const senderId = "external-context";

    // seq=2 arrives first — applied
    inject(channels[1], {
      type: "STATE_UPDATE",
      senderId,
      seq: 2,
      state: { counter: { value: 10 } },
    });
    expect((storeB.getState() as RootState).counter.value).toBe(10);

    // seq=1 arrives out of order — stale, should be ignored
    inject(channels[1], {
      type: "STATE_UPDATE",
      senderId,
      seq: 1,
      state: { counter: { value: 999 } },
    });
    expect((storeB.getState() as RootState).counter.value).toBe(10);

    // seq=2 arrives again — duplicate, should be ignored
    inject(channels[1], {
      type: "STATE_UPDATE",
      senderId,
      seq: 2,
      state: { counter: { value: 999 } },
    });
    expect((storeB.getState() as RootState).counter.value).toBe(10);

    cleanupA();
    cleanupB();
  });
});

describe("isBroadcastMessage guard", () => {
  it("ignores malformed or unknown messages without throwing", () => {
    const { channels, factory } = makeChannelFactory();

    const { store: storeA, cleanup: cleanupA } = makeStore({ createChannel: factory });
    vi.advanceTimersByTime(10);

    // Various invalid payloads
    inject(channels[0], null);
    inject(channels[0], "raw string");
    inject(channels[0], 42);
    inject(channels[0], { type: "UNKNOWN_TYPE", senderId: "x" });
    inject(channels[0], { type: "STATE_UPDATE" }); // missing senderId, seq, state
    inject(channels[0], { type: "STATE_UPDATE", senderId: "x", seq: "not-a-number", state: {} });

    expect((storeA.getState() as RootState).counter.value).toBe(0);

    cleanupA();
  });
});

describe("3+ stores", () => {
  it("syncs a dispatch to all connected contexts", () => {
    const { a, b } = makePair();
    const c = makeStore();
    vi.advanceTimersByTime(10); // let c complete its init handshake

    a.store.dispatch(counterSlice.actions.set(42));
    flush();

    expect((b.store.getState() as RootState).counter.value).toBe(42);
    expect((c.store.getState() as RootState).counter.value).toBe(42);

    a.cleanup();
    b.cleanup();
    c.cleanup();
  });
});

describe("excludeSlices in INIT_RESPONSE", () => {
  it("does not include excluded slices in the initial state sent to a new peer", () => {
    const { store: storeA, cleanup: cleanupA } = makeStore({ excludeSlices: ["ui"] });
    vi.advanceTimersByTime(10); // storeA ready

    storeA.dispatch(uiSlice.actions.toggle()); // ui.open = true locally
    flush();

    // storeB joins — storeA sends INIT_RESPONSE without ui slice
    const { store: storeB, cleanup: cleanupB } = makeStore({ excludeSlices: ["ui"] });
    flush();

    // storeB should not have received storeA's ui state
    expect((storeB.getState() as RootState).ui.open).toBe(false);

    cleanupA();
    cleanupB();
  });
});
