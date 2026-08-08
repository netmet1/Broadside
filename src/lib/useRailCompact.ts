/**
 * Does a controls rail still fit the window, and if not, say so once.
 *
 * A rail is a single non-wrapping row of buttons, and almost every dimension in
 * one is a rem: `h-7`, `px-2.5`, `text-[0.8rem]`, the gaps. `UiPrefsProvider`
 * writes the app font size onto the root element, so rem follows that setting
 * while the window's 1024px minimum does not. A row budgeted to fit at a 16px
 * app font wants a quarter more room at 20px, runs off the edge, and takes the
 * rightmost control with it into AppShell's horizontal scrollbar.
 *
 * So the rail asks whether it fits and drops its labels to icons when it does
 * not. What makes that safe to measure is that the answer cannot change the
 * question: the row's `clientWidth` is set by the pane around it, not by what
 * is in it, so shortening the contents never moves the number being compared
 * and the two states cannot oscillate.
 *
 * Growing back needs one more fact, because a compact row no longer overflows
 * and so has nothing left to measure. The width it wanted is recorded at the
 * moment it stopped fitting, and the labels return once the pane is at least
 * that wide again.
 *
 * `key` is whatever else changes what the row would measure: the app font size,
 * and which conditional controls are showing. When it changes, the remembered
 * width is void and the question starts again from full labels.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";

/** Slack required over the remembered full width before the labels come back,
 * so a row that fits by a hair does not sit on the boundary. */
const REGROW_MARGIN_PX = 8;

export function useRailCompact(
  ref: React.RefObject<HTMLElement | null>,
  key: string,
): boolean {
  const [compact, setCompact] = useState(false);
  /** The width the row wanted when it last failed to fit. Null until it has. */
  const fullWidth = useRef<number | null>(null);

  // Reset both when the row's identity changes, so the measuring effect below
  // never runs against a width belonging to a different row.
  //
  // Split in two on purpose. The flag is state, so it is adjusted during
  // render, React's documented way to reset state derived from a prop. The
  // remembered width is a ref, which a render must not touch, so it is cleared
  // in a *layout* effect. That is also a stronger guarantee than what was here
  // before: this used to rely on being declared above the measuring effect so
  // it would run first, and a layout effect runs before every passive effect
  // whatever the order they are written in.
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setCompact(false);
  }
  useLayoutEffect(() => {
    fullWidth.current = null;
  }, [key]);

  // `compact` is a dependency so that flipping it measures again against the
  // DOM it produced. Each pass can only move one way, so this settles.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (!compact) {
        // scrollWidth on an overflow-visible flex row is what its items want;
        // clientWidth is what the pane around it is giving them.
        if (el.scrollWidth > el.clientWidth) {
          fullWidth.current = el.scrollWidth;
          setCompact(true);
        }
        return;
      }
      const full = fullWidth.current;
      if (full !== null && el.clientWidth >= full + REGROW_MARGIN_PX) {
        setCompact(false);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, key, compact]);

  return compact;
}
