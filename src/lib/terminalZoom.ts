/**
 * Ctrl + mouse wheel over a terminal changes the terminal font size.
 *
 * The size already lives in Settings -> Appearance and every open pane follows
 * it live, so zooming is not a second setting: a wheel notch moves the same
 * number one step and, unless the reader has said otherwise, writes it back.
 * That is the behaviour every terminal on this machine has, and typing a number
 * into Settings to read one line of output is a poor substitute for it.
 *
 * The escape hatch is `Strict`, next to the field. Strict means the number in
 * Settings is the number, full stop: the wheel is left alone entirely, and a
 * mouse that scrolls with Ctrl held by accident (or a hand that does) cannot
 * change it. Deliberately not the grid's meaning of the word, which is "your
 * drag lasts for this session": a font size that quietly reverted on restart
 * would be its own kind of surprise, and the reader who wants a permanent size
 * has the field right there.
 *
 * On the pane rather than the window, so Ctrl + wheel is only the zoom while
 * the pointer is over a terminal. The pane and not the terminal container
 * inside it, because the overlays (connecting, failed, the shell warning and
 * disconnected banners) are siblings of that container: a listener on it alone
 * had holes in it wherever one of those was drawn.
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import { setUiSettings } from "@/lib/tauri/settings";
import { useUiPrefs, type UiPrefs } from "@/lib/uiPrefs";

/** Same range the Settings field accepts and the backend clamps to. */
export const TERM_FONT_MIN = 8;
export const TERM_FONT_MAX = 32;

const STRICT_KEY = "terminal-font-strict";

/**
 * Whether the Settings field is the last word (default `false`).
 *
 * Off, Ctrl + wheel over a terminal resizes the text and saves the new size.
 * On, Ctrl + wheel is ignored and only the field changes anything.
 *
 * The default is off because a feature nobody can find is not a feature: the
 * gesture works out of the box and the checkbox is there for whoever wants it
 * to stop. (The grid's Strict defaults the other way because a drag is easy to
 * do by accident and hard to undo; a font size is one wheel notch back.)
 */
export function loadTerminalFontStrict(): boolean {
  return localStorage.getItem(STRICT_KEY) === "1";
}

/** No companion event (the grid prefs have one): the checkbox in Settings is
 * the only thing holding a copy of this, and the wheel handler re-reads it. */
export function saveTerminalFontStrict(v: boolean): void {
  localStorage.setItem(STRICT_KEY, v ? "1" : "0");
}

/** How long the wheel has to be still before the size is written to the
 * database. A spin is a dozen events; this makes it one write. */
const SAVE_DELAY_MS = 500;

// One timer for the whole app, not one per pane: this is a single setting, and
// two panes each holding their own pending write could land out of order.
let saveTimer: number | undefined;
let pending: UiPrefs | null = null;

/**
 * The size the wheel last asked for, which is not the same thing as the size
 * React has committed.
 *
 * `apply` is a state update on a continuous-priority event, so during a fast
 * spin the next notch can arrive before the render that carries the last one.
 * Stepping from the committed size there would compute the same result twice
 * and the zoom would stall halfway through the spin. Kept module-wide because
 * one font size is shared by every pane; a change made anywhere else (the
 * Settings field) lands here through the effect below.
 */
let requested: number | null = null;

function queueSave(next: UiPrefs): void {
  pending = next;
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    const p = pending;
    pending = null;
    if (!p) return;
    setUiSettings({
      terminal_font_family: p.terminalFontFamily,
      terminal_font_size: p.terminalFontSize,
      app_font_size: p.appFontSize,
    }).catch((e) => toast.error(errorMessage(e)));
  }, SAVE_DELAY_MS);
}

/**
 * Wire Ctrl + wheel on `ref` to the terminal font size.
 *
 * The listener is non-passive so it can take the event: left alone, the wheel
 * goes on to the terminal, where a full-screen program with mouse reporting on
 * would receive it as a scroll with a modifier. Taking it is the same trade
 * every terminal emulator makes for this gesture, and it only applies while
 * the pointer is over a pane and Ctrl is down.
 */
export function useTerminalFontZoom(
  ref: React.RefObject<HTMLElement | null>,
): void {
  const { prefs, apply } = useUiPrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Once a change has been committed, that is the size to step from next,
  // whether it came from the wheel or from the field in Settings.
  useEffect(() => {
    requested = prefs.terminalFontSize;
  }, [prefs.terminalFontSize]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      // Read at the event rather than held in state: the checkbox is on another
      // page that may not be mounted, and an unchecked box has to take effect
      // on the next notch, not the next remount.
      if (loadTerminalFontStrict()) return;
      // Ours now: preventDefault stops the webview acting on it, and stopping
      // it here in the capture phase keeps it away from xterm, which would
      // otherwise scroll the scrollback under the zoom (or hand the notch to a
      // full-screen program with mouse reporting on).
      e.preventDefault();
      e.stopPropagation();
      const current = prefsRef.current;
      const from = requested ?? current.terminalFontSize;
      const step = e.deltaY < 0 ? 1 : -1;
      const size = Math.min(
        Math.max(from + step, TERM_FONT_MIN),
        TERM_FONT_MAX,
      );
      if (size === from) return;
      requested = size;
      const next = { ...current, terminalFontSize: size };
      apply(next);
      // One toast that rewrites itself, so a spin through six sizes leaves one
      // line on screen rather than six.
      toast(`Terminal font ${size} px`, {
        id: "terminal-font-zoom",
        duration: 900,
      });
      queueSave(next);
    };

    // Capture, so the container sees the wheel on the way down to xterm rather
    // than after it: xterm's viewport handles wheel itself, and a zoom that
    // depended on the event bubbling back out would be at the mercy of that.
    const opts = { passive: false, capture: true } as const;
    el.addEventListener("wheel", onWheel, opts);
    return () => el.removeEventListener("wheel", onWheel, opts);
  }, [ref, apply]);
}
