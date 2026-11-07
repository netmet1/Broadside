/**
 * The terminal panes' GPU renderer, the setting that turns it off, and the
 * budget of WebGL contexts it runs on.
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
 * The setting (Settings > Performance, on by default) follows the same rule:
 * turned off, the panes on screen move to the DOM renderer at once and hidden
 * ones as they come on screen; turned back on, panes take slots as above. It is
 * a preference of this computer, kept in localStorage like the exit guard,
 * since it is about this machine's graphics.
 */

import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/** Under the browsers' 16, with room for a context they have not let go of. */
export const MAX_GPU_PANES = 14;
const RETRY_AFTER_LOSS_MS = 30_000;
/** Absent until the setting is first turned off; absence reads as on. */
const GPU_KEY = "terminal-gpu-renderer";

let live = 0;
let unsupported = false;
/** Panes on the DOM renderer, in the order they got there. Each one's
 * callback takes a slot if it can (on screen, setting on, slot free) and says
 * whether it did. */
const waiting = new Set<() => boolean>();
/** Panes holding a context. Each one's callback lets it go if the pane is on
 * screen; a hidden one lets go when it next comes on screen. */
const holding = new Set<() => void>();

/** Whether the setting is on. Reads localStorage live. */
export function isGpuRenderingEnabled(): boolean {
  try {
    return localStorage.getItem(GPU_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Whether this computer can do it at all, as far as the panes have found so
 * far: false once a pane failed to load WebGL 2. */
export function isGpuRenderingSupported(): boolean {
  return !unsupported;
}

/** Turn the setting on or off, and move the panes on screen over now. */
export function setGpuRenderingEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(GPU_KEY, enabled ? "1" : "0");
  } catch {
    // Without storage it lasts until the app restarts, which is the best
    // there is.
  }
  if (enabled) offerSlot();
  else for (const letGo of holding) letGo();
}

function gpuWanted(): boolean {
  return !unsupported && isGpuRenderingEnabled();
}

function offerSlot() {
  for (const take of waiting) {
    if (live >= MAX_GPU_PANES || !gpuWanted()) return;
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
  /** Bring the renderer in line with the setting and the budget: take a slot
   * if one is free and the setting is on, let it go if the setting is off. For
   * the moment a pane comes on screen, before it is refitted. Returns whether
   * the renderer changed. */
  sync(): boolean;
  /** Before `term.dispose()`. Gives the context back and offers the slot on. */
  dispose(): void;
}

/**
 * Put `term` on the WebGL renderer, now if the setting and the budget allow
 * it, otherwise when they do. Call after `term.open()`.
 *
 * `onScreen` says whether the pane has pixels on screen now. `onRendererChange`
 * runs after the renderer changed under a pane that is on screen, outside
 * `sync()`: its cell size may have changed with it, so the pane wants a refit.
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
    if (disposed || addon || !term.element || !gpuWanted()) return false;
    if (live >= MAX_GPU_PANES || performance.now() < coolUntil) return false;
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
    holding.add(letGo);
    next.onContextLoss(() => {
      if (addon !== next) return;
      addon = null;
      live--;
      holding.delete(letGo);
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

  /** Back to the DOM renderer, giving the context back. */
  const detach = () => {
    if (!addon) return;
    const gone = addon;
    addon = null;
    live--;
    holding.delete(letGo);
    const gl = contextOf(gone);
    gone.dispose();
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  };

  // A slot offered from outside the pane's own refit: only taken on screen.
  function takeSlot(): boolean {
    if (!onScreen() || !attach()) return false;
    onRendererChange();
    return true;
  }

  // The setting was turned off: only let go on screen.
  function letGo() {
    if (!onScreen()) return;
    detach();
    waiting.add(takeSlot);
    onRendererChange();
  }

  if (!attach() && !unsupported) waiting.add(takeSlot);

  return {
    sync() {
      if (addon && !gpuWanted()) {
        detach();
        waiting.add(takeSlot);
        return true;
      }
      return attach();
    },
    dispose() {
      disposed = true;
      waiting.delete(takeSlot);
      clearTimeout(retryTimer);
      if (!addon) return;
      detach();
      offerSlot();
    },
  };
}
