import { isAction, type Middleware, type MiddlewareAPI } from "@reduxjs/toolkit";
import { SYNC_ACTION_TYPE } from "./reducer";
import { shallowDiff } from "./shallowDiff";
import type { BroadcastChannelLike, BroadcastMessage, BroadcastMiddlewareOptions } from "./types";


type BroadcastState = Record<string, unknown>;
type PendingUpdate = {
  senderId: string;
  seq: number;
  state: BroadcastState;
};

function isBroadcastMessage(value: unknown): value is BroadcastMessage {
  if (!value || typeof value !== "object") return false;

  const msg = value as Record<string, unknown>;

  return (
    typeof msg.type === "string" &&
    typeof msg.senderId === "string" &&
    (msg.type === "REQUEST_STATE" ||
      (typeof msg.seq === "number" &&
        msg.state !== null &&
        typeof msg.state === "object" &&
        (msg.type === "INIT_RESPONSE" || msg.type === "STATE_UPDATE")))
  );
}

export function createBroadcastMiddleware(options: BroadcastMiddlewareOptions = {}) {
  const {
    channelName = "redux-sync",
    debounceMs = 0,
    fallbackTimeoutMs = 50,
    excludeSlices = [],
    excludeActions = [],
    excludeAction,
    createChannel = (name) => new BroadcastChannel(name),
    generateId = () => crypto.randomUUID(),
    maxPendingUpdates = 100,
  } = options;

  const channel: BroadcastChannelLike = createChannel(channelName);
  const instanceId = generateId();

  // --- Lifecycle state ---
  let isInitialized = false;
  let isReadyForUpdates = false;
  let initFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Sequence tracking ---
  let nextOutgoingSeq = 0;
  const lastIncomingSeqBySender = new Map<string, number>();

  // --- Local state snapshot / scheduling ---
  let lastBroadcastSnapshot: BroadcastState | null = null;
  let scheduledBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Store reference ---
  let storeApi: MiddlewareAPI | null = null;

  // Updates received before initial sync completes
  const pendingUpdates: PendingUpdate[] = [];

  // --- Sequence helpers ---

  function isStaleMessage(senderId: string, seq: number): boolean {
    return seq <= (lastIncomingSeqBySender.get(senderId) ?? 0);
  }

  function rememberIncomingSeq(senderId: string, seq: number) {
    lastIncomingSeqBySender.set(senderId, seq);
  }

  // --- State helpers ---

  function filterState(state: BroadcastState): BroadcastState {
    if (excludeSlices.length === 0) return state;
    const filtered = { ...state };
    for (const slice of excludeSlices) delete filtered[slice];
    return filtered;
  }

  function refreshBroadcastSnapshot() {
    if (!storeApi) return;
    lastBroadcastSnapshot = filterState(storeApi.getState() as BroadcastState);
  }

  function applyRemoteState(state: BroadcastState) {
    if (!storeApi) return;

    storeApi.dispatch({
      type: SYNC_ACTION_TYPE,
      payload: state,
    });

    refreshBroadcastSnapshot();
  }

  function replayPendingUpdates() {
    if (!storeApi) return;

    for (const update of pendingUpdates) {
      if (isStaleMessage(update.senderId, update.seq)) continue;
      rememberIncomingSeq(update.senderId, update.seq);
      applyRemoteState(update.state);
    }

    pendingUpdates.length = 0;
  }

  function bufferPendingUpdate(update: PendingUpdate) {
    pendingUpdates.push(update);
    if (pendingUpdates.length > maxPendingUpdates) {
      pendingUpdates.shift();
    }
  }

  function markReadyForUpdates() {
    isReadyForUpdates = true;
    replayPendingUpdates();
  }

  function scheduleBroadcast(getState: () => unknown) {
    if (scheduledBroadcastTimer !== null) {
      clearTimeout(scheduledBroadcastTimer);
    }

    scheduledBroadcastTimer = setTimeout(() => {
      scheduledBroadcastTimer = null;

      const nextState = filterState(getState() as BroadcastState);
      const delta = shallowDiff(lastBroadcastSnapshot, nextState);

      if (delta === null) return;

      lastBroadcastSnapshot = nextState;

      channel.postMessage({
        type: "STATE_UPDATE",
        senderId: instanceId,
        seq: ++nextOutgoingSeq,
        state: delta,
      } satisfies BroadcastMessage);
    }, debounceMs);
  }

  // --- Outgoing channel messages ---

  function requestInitialState() {
    channel.postMessage({
      type: "REQUEST_STATE",
      senderId: instanceId,
    } satisfies BroadcastMessage);
  }

  function respondWithCurrentState() {
    if (!storeApi) return;

    channel.postMessage({
      type: "INIT_RESPONSE",
      senderId: instanceId,
      seq: ++nextOutgoingSeq,
      state: filterState(storeApi.getState() as BroadcastState),
    } satisfies BroadcastMessage);
  }

  // --- Incoming message handlers ---

  function handleInitResponse(
    msg: Extract<BroadcastMessage, { type: "INIT_RESPONSE" }>,
  ) {
    if (isReadyForUpdates || isStaleMessage(msg.senderId, msg.seq)) return;

    if (initFallbackTimer !== null) {
      clearTimeout(initFallbackTimer);
      initFallbackTimer = null;
    }

    rememberIncomingSeq(msg.senderId, msg.seq);
    applyRemoteState(msg.state);
    markReadyForUpdates();
  }

  function handleStateUpdate(
    msg: Extract<BroadcastMessage, { type: "STATE_UPDATE" }>,
  ) {
    if (!isReadyForUpdates) {
      bufferPendingUpdate({
        senderId: msg.senderId,
        seq: msg.seq,
        state: msg.state,
      });
      return;
    }

    if (isStaleMessage(msg.senderId, msg.seq)) return;

    rememberIncomingSeq(msg.senderId, msg.seq);
    applyRemoteState(msg.state);
  }

  function handleChannelMessage(event: MessageEvent) {
    const message = event.data;

    if (!isBroadcastMessage(message)) return;
    if (message.senderId === instanceId) return;
    if (!storeApi) return;

    switch (message.type) {
      case "REQUEST_STATE":
        respondWithCurrentState();
        return;
      case "INIT_RESPONSE":
        handleInitResponse(message);
        return;
      case "STATE_UPDATE":
        handleStateUpdate(message);
        return;
    }
  }

  // --- Initialization / teardown ---

  function startInitFallbackTimer() {
    initFallbackTimer = setTimeout(() => {
      initFallbackTimer = null;
      if (!isReadyForUpdates) {
        markReadyForUpdates();
      }
    }, fallbackTimeoutMs);
  }

  function initializeIfNeeded(api: MiddlewareAPI) {
    if (isInitialized) return;

    isInitialized = true;
    storeApi = api;

    refreshBroadcastSnapshot();
    channel.addEventListener("message", handleChannelMessage);

    requestInitialState();
    startInitFallbackTimer();
  }

  function clearTimers() {
    if (scheduledBroadcastTimer !== null) {
      clearTimeout(scheduledBroadcastTimer);
      scheduledBroadcastTimer = null;
    }
    if (initFallbackTimer !== null) {
      clearTimeout(initFallbackTimer);
      initFallbackTimer = null;
    }
  }

  function resetInternalState() {
    pendingUpdates.length = 0;
    isInitialized = false;
    isReadyForUpdates = false;
    lastBroadcastSnapshot = null;
    nextOutgoingSeq = 0;
    lastIncomingSeqBySender.clear();
    storeApi = null;
  }

  function cleanup() {
    clearTimers();
    channel.removeEventListener("message", handleChannelMessage);
    channel.close();
    resetInternalState();
  }

  const middleware: Middleware = (api) => {
    initializeIfNeeded(api);

    return (next) => (action) => {
      const result = next(action);

      if (isAction(action) && action.type !== SYNC_ACTION_TYPE && !excludeActions.includes(action.type) && !excludeAction?.(action)) {
        scheduleBroadcast(api.getState);
      }

      return result;
    };
  };

  return { middleware, cleanup };
}
