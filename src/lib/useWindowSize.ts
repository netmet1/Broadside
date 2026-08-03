import { useSyncExternalStore } from "react";

/**
 * The window's current size, as the `1024x700` string the status bar shows.
 *
 * A string rather than a `{ width, height }` pair on purpose: `useSyncExternalStore`
 * compares snapshots by identity, and a fresh object every read would re-render
 * on every call. Two numbers formatted into one string compare by value, so the
 * bar only re-renders when the size actually changed.
 *
 * These are the webview's CSS pixels, which is the number that decides whether
 * the rails fit: the same units as `minWidth`/`minHeight` in `tauri.conf.json`,
 * so dragging the window to its smallest reads 1024x700 rather than some
 * scaled-up physical size on a display running at 125%.
 */
export function useWindowSize(): string {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

function snapshot(): string {
  return `${window.innerWidth}x${window.innerHeight}`;
}

/** Never reached (there is no SSR here), but `useSyncExternalStore` wants it. */
function serverSnapshot(): string {
  return "";
}

function subscribe(onChange: () => void): () => void {
  // A drag emits resize events far faster than the bar can usefully be read, so
  // they are coalesced to one per frame. The frame id is per-subscription, not
  // module-wide, so a second reader unmounting cannot cancel the first's.
  let frame = 0;
  const onResize = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      onChange();
    });
  };
  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    if (frame) cancelAnimationFrame(frame);
  };
}
