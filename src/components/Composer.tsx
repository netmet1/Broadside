import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Recallable past commands, newest first (Up/Down arrows, shell-style). */
  history?: string[];
  /** Max visible lines before the textarea scrolls instead of growing. */
  maxRows?: number;
};

/**
 * Broadcast command input. Behaves like the Claude Code prompt box: it wraps
 * long input and auto-grows its height (up to `maxRows`) instead of scrolling
 * the text out of view. Enter submits; Shift+Enter inserts a newline.
 *
 * Keeps the smooth animated caret (D-009 — composer only): the native caret is
 * hidden and a mirror element measures the caret's x/y (including wrapped
 * lines) so an animated bar eases to that position.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  history,
  maxRows = 8,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const [caret, setCaret] = useState({ left: 0, top: 0, height: 20 });
  const [focused, setFocused] = useState(false);
  // Shell-style history recall: index into `history` while browsing, with
  // the in-progress draft stashed so Down past the newest entry restores it.
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const draftRef = useRef("");

  // Grow the textarea to fit its content, capped at maxRows.
  const resize = useCallback(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const maxHeight = lineHeight * maxRows + 16; // + vertical padding
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
    ta.style.overflowY = ta.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [maxRows]);

  const syncCaret = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    const marker = markerRef.current;
    if (!input || !mirror || !marker) return;
    const caretIndex = input.selectionStart ?? value.length;
    // Mirror the text up to the caret, then read the marker's box; this places
    // the caret correctly even across soft-wrapped lines.
    mirror.textContent = value.slice(0, caretIndex);
    mirror.appendChild(marker);
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
    setCaret({
      left: marker.offsetLeft - input.scrollLeft,
      top: marker.offsetTop - input.scrollTop,
      height: lineHeight,
    });
  }, [value]);

  useLayoutEffect(() => {
    resize();
    syncCaret();
  }, [resize, syncCaret]);

  useEffect(() => {
    // selectionchange fires on the document for arrow keys / click moves.
    const handler = () => {
      if (document.activeElement === inputRef.current) syncCaret();
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [syncCaret]);

  // True when the caret sits on the first / last visual-logical line, used to
  // decide whether Up/Down recalls history or just moves between lines.
  const caretOnFirstLine = () => {
    const input = inputRef.current;
    if (!input) return true;
    const idx = input.selectionStart ?? 0;
    return !value.slice(0, idx).includes("\n");
  };
  const caretOnLastLine = () => {
    const input = inputRef.current;
    if (!input) return true;
    const idx = input.selectionEnd ?? value.length;
    return !value.slice(idx).includes("\n");
  };

  return (
    <div className="relative min-w-0 flex-1">
      <span
        aria-hidden
        className="composer-caret pointer-events-none absolute w-[1.5px] bg-primary"
        style={{
          // The marker lives inside the mirror, which carries the same px-3/py-2
          // padding as the textarea, so its offsetLeft/offsetTop already include
          // that padding — no extra offset here, or the caret drifts by the
          // padding amount.
          left: `${caret.left}px`,
          top: `${caret.top}px`,
          height: `${caret.height}px`,
          display: focused && !disabled ? undefined : "none",
        }}
      />
      {/* Mirror for caret measurement — must match the textarea's box model
          (font, padding, width, wrapping, line-height) so wrapped lines line
          up. The marker is a full line-height, top-aligned, zero-width box: a
          zero-height marker baseline-aligns and reports an offsetTop near the
          line's baseline, which dropped the caret below an empty input until
          text was typed. */}
      <div
        ref={mirrorRef}
        aria-hidden
        className="invisible absolute left-0 top-0 w-full whitespace-pre-wrap break-words px-3 py-2 font-mono text-sm leading-5"
      >
        <span ref={markerRef} className="inline-block h-5 w-0 align-top" />
      </div>
      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        onChange={(e) => {
          setHistIdx(null);
          onChange(e.target.value);
        }}
        onScroll={syncCaret}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !disabled) {
            e.preventDefault();
            setHistIdx(null);
            onSubmit();
            return;
          }
          // History recall wraps in both directions; the stashed draft is a
          // stop on the cycle (…oldest → draft → newest…). Only triggers at
          // the first/last line so multi-line editing keeps normal caret moves.
          if (
            e.key === "ArrowUp" &&
            history &&
            history.length > 0 &&
            caretOnFirstLine()
          ) {
            e.preventDefault();
            if (histIdx === null) {
              draftRef.current = value;
              setHistIdx(0);
              onChange(history[0]);
            } else if (histIdx === history.length - 1) {
              setHistIdx(null);
              onChange(draftRef.current);
            } else {
              setHistIdx(histIdx + 1);
              onChange(history[histIdx + 1]);
            }
            return;
          }
          if (
            e.key === "ArrowDown" &&
            history &&
            history.length > 0 &&
            caretOnLastLine()
          ) {
            e.preventDefault();
            if (histIdx === null) {
              draftRef.current = value;
              setHistIdx(history.length - 1);
              onChange(history[history.length - 1]);
            } else if (histIdx === 0) {
              setHistIdx(null);
              onChange(draftRef.current);
            } else {
              setHistIdx(histIdx - 1);
              onChange(history[histIdx - 1]);
            }
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn(
          // min-h-10 keeps the empty box a comfortable single line tall so the
          // smooth caret never pokes out below it before the first command
          // (B1/P1 — auto-resize can briefly under-measure on mount/font-load).
          "block min-h-10 max-h-[12rem] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm leading-5 shadow-xs outline-none transition-colors",
          "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "[caret-color:transparent]",
        )}
      />
    </div>
  );
}
