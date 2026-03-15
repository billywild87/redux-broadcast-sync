export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export type BroadcastMessage =
  | {
      type: "REQUEST_STATE";
      senderId: string;
    }
  | {
      type: "INIT_RESPONSE";
      senderId: string;
      seq: number;
      state: Record<string, unknown>;
    }
  | {
      type: "STATE_UPDATE";
      senderId: string;
      seq: number;
      state: Record<string, unknown>;
    };

export type BroadcastMiddlewareOptions = {
  /** Name of the shared BroadcastChannel. Default: "redux-sync" */
  channelName?: string;
  /** Debounce delay in ms before emitting a STATE_UPDATE. Default: 0 */
  debounceMs?: number;
  /** Timeout in ms before a new context declares itself ready if no peer responds. Default: 50 */
  fallbackTimeoutMs?: number;
  /** State slices to exclude from sync (e.g. local UI state). Default: [] */
  excludeSlices?: string[];
  /** Action types that will not trigger a sync (e.g. local-only actions). Default: [] */
  excludeActions?: string[];
  /** Predicate to exclude actions dynamically — return true to skip sync. */
  excludeAction?: (action: import("@reduxjs/toolkit").UnknownAction) => boolean;
  /** Custom channel factory — use this to inject a BroadcastChannel polyfill. */
  createChannel?: (name: string) => BroadcastChannelLike;
  /** Custom instance ID generator — useful when crypto.randomUUID is unavailable. */
  generateId?: () => string;
  /** Max STATE_UPDATEs buffered before INIT_RESPONSE — oldest are dropped if exceeded. Default: 100 */
  maxPendingUpdates?: number;
};
