/**
 * The terminal panes' GPU renderer, and the budget of WebGL contexts it runs
 * on.
 *
 * xterm 6's only other renderer is the DOM one, which turns every visible cell
 * into a span and makes long, dense scrollback slow to wheel through, worst in
 * a grid of tiles. The WebGL addon draws the same pane on one canvas.
 *
 * WebKit and Chromium both cap live WebGL contexts at 16 per page. Past that
 * the browser takes a context from the oldest, and the pane that held it goes
 * blank for three seconds (the addon waits that long for the context to come
 * back) before it falls back to the DOM renderer. Every open tab holds a
 * context, hidden or not, since a hidden pane stays mounted, so twenty tabs
 * would do that to the four that were opened first, most likely the ones in
 * use. So the app keeps its own count under the cap and the browser never has
 * to take one:
 *
 *   - A pane past the budget starts on the DOM renderer and waits for a slot.
 *   - Closing a pane that had one gives its context back at once (disposing the
 *     addon alone leaves the context alive until garbage collection, still
 *     counted against the cap) and offers the slot to the waiting panes, oldest
 *     first. A waiting pane takes it only while it is on screen, there and
 *     then; a hidden one takes it the next time it comes on screen, from the
 *     pane's own IntersectionObserver, before the refit that runs there.
 *     Renderers are never swapped on a hidden pane, the state behind the
 *     scrolling bugs that observer exists to prevent.
 *   - A context lost anyway (GPU reset, sleep and wake, a graphics switch)
 *     drops that pane to the DOM renderer, and it tries again 30 seconds
 *     later, or later still if it is hidden then. The wait keeps a pane from
 *     going back and forth if the browser's real cap turns out lower than ours.
 *   - A load that throws means WebGL 2 isn't there at all (no GPU, blocked, a
 *     Remote Desktop session without acceleration). No pane tries again.
 *
 * Setting localStorage "broadside.renderer" to "dom" keeps new and waiting
 * panes on the DOM renderer, to compare the two. Reopen a pane to switch it.
 */

import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/** Under the browsers' 16, with room for a context they have not let go of. */
const MAX_LIVE = 14;
const RETRY_AFTER_LOSS_MS = 30_000;

let live = 0;
let unsupported = false;
/** Panes waiting for a slot, in the order they started waiting. Each one's
 * callback takes the slot if it can and says whether it did. */
const waiting = new Set<() => boolean>();

function domOnly(): boolean {
  if (unsupported) return true;
  try {
    return localStorage.getItem("broadside.renderer") === "dom";
  } catch {
    return false;
  }
}

function offerSlot() {
  for (const take of waiting) {
    if (live >= MAX_LIVE) return;
    take();
  }
}

/** The addon's context, to give it back on close. Reaches into the addon's
 * internals, which is why the package is pinned to an exact version. */
function contextOf(addon: WebglAddon): WebGL2RenderingContext | undefined {
  return (addon as unknown as { _renderer?: { _gl?: WebGL2RenderingContext } })
    ._renderer?._gl;
}

export interface GpuRenderer {
  /** Take a slot now if this pane is waiting and one is free. For the moment a
   * pane comes on screen, before it is refitted. Returns whether it did. */
  retry(): boolean;
  /** Before `term.dispose()`. Gives the context back and offers the slot on. */
  dispose(): void;
}

/**
 * Put `term` on the WebGL renderer, now if the budget allows it, otherwise
 * when a slot comes free. Call after `term.open()`.
 *
 * `onScreen` says whether the pane has pixels on screen now. `onRendererChange`
 * runs after the renderer changed under a pane that is on screen, outside
 * `retry()`: its cell size may have changed with it, so the pane wants a refit.
 */
export function attachGpuRenderer(
  term: Terminal,
  onScreen: () => boolean,
  onRendererChange: () => void,
): GpuRenderer {
  let addon: WebglAddon | null = null;
  let disposed = false;
  let coolUntil = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const attach = (): boolean => {
    if (disposed || addon || !term.element || domOnly()) return false;
    if (live >= MAX_LIVE || performance.now() < coolUntil) return false;
    const next = new WebglAddon();
    try {
      term.loadAddon(next);
    } catch {
      next.dispose();
      unsupported = true;
      waiting.clear();
      return false;
    }
    addon = next;
    live++;
    waiting.delete(takeSlot);
    next.onContextLoss(() => {
      if (addon !== next) return;
      addon = null;
      live--;
      next.dispose();
      coolUntil = performance.now() + RETRY_AFTER_LOSS_MS;
      waiting.add(takeSlot);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(takeSlot, RETRY_AFTER_LOSS_MS);
      if (onScreen()) onRendererChange();
      offerSlot();
    });
    return true;
  };

  // A slot offered from outside the pane's own refit: only taken on screen.
  const takeSlot = (): boolean => {
    if (!onScreen() || !attach()) return false;
    onRendererChange();
    return true;
  };

  if (!attach() && !domOnly()) waiting.add(takeSlot);

  return {
    retry: attach,
    dispose() {
      disposed = true;
      waiting.delete(takeSlot);
      clearTimeout(retryTimer);
      if (!addon) return;
      const gl = contextOf(addon);
      addon.dispose();
      addon = null;
      live--;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      offerSlot();
    },
  };
}
