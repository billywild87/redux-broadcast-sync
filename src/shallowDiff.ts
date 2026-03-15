export function shallowDiff(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): Record<string, unknown> | null {
  if (prev === null) return next;

  const delta: Record<string, unknown> = {};
  let changed = false;

  for (const key in next) {
    if (prev[key] !== next[key]) {
      delta[key] = next[key];
      changed = true;
    }
  }

  for (const key in prev) {
    if (!(key in next)) {
      delta[key] = undefined;
      changed = true;
    }
  }

  return changed ? delta : null;
}
