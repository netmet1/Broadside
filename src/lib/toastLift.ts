import { useSyncExternalStore } from "react";

/**
 * How far above the bottom of the window toasts must sit, in pixels, so they
 * do not cover something a page has pinned to the bottom edge. 0 means the
 * toaster's own default applies.
 *
 * Today that is the SFTP Commander's transfer rail: its Cancel buttons sit in
 * the same bottom-right corner as the toasts, and a busy queue kept them
 * covered. A module-level store rather than a context, because the one writer
 * and the one reader (the Toaster) are far apart in the tree and nothing else
 * needs to re-render when it moves.
 */
let lift = 0;
const listeners = new Set<() => void>();

export function setToastLift(px: number) {
  const next = Math.max(0, Math.round(px));
  if (next === lift) return;
  lift = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToastLift(): number {
  return useSyncExternalStore(subscribe, () => lift);
}
