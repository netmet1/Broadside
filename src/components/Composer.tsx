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
};

/**
 * Broadcast command input with the smooth animated caret (D-009 — composer
 * only). The native caret is hidden; a mirror span measures the text up to
 * the selection point and an animated bar caret eases to that position.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  history,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const [caretLeft, setCaretLeft] = useState(0);
  const [focused, setFocused] = useState(false);
  // Shell-style history recall: index into `history` while browsing, with
  // the in-progress draft stashed so Down past the newest entry restores it.
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const draftRef = useRef("");

  const syncCaret = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    const caretIndex = input.selectionStart ?? value.length;
    mirror.textContent = value.slice(0, caretIndex);
    const textWidth = mirror.getBoundingClientRect().width;
    setCaretLeft(textWidth - input.scrollLeft);
  }, [value]);

  useLayoutEffect(syncCaret, [syncCaret]);

  useEffect(() => {
    // selectionchange fires on the document for arrow keys / click moves.
    const handler = () => {
      if (document.activeElement === inputRef.current) syncCaret();
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [syncCaret]);

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden">
      <span
        aria-hidden
        className="composer-caret pointer-events-none absolute top-1/2 h-5 w-[1.5px] -translate-y-1/2 bg-primary"
        style={{
          left: `calc(0.75rem + ${caretLeft}px)`,
          display: focused && !disabled ? undefined : "none",
        }}
      />
      {/* Mirror for caret measurement — identical font to the input. */}
      <span
        ref={mirrorRef}
        aria-hidden
        className="invisible absolute left-0 top-0 whitespace-pre font-mono text-sm"
      />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setHistIdx(null);
          onChange(e.target.value);
        }}
        onScroll={syncCaret}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !disabled) {
            e.preventDefault();
            setHistIdx(null);
            onSubmit();
            return;
          }
          // History recall wraps in both directions; the stashed draft is a
          // stop on the cycle (…oldest → draft → newest…).
          if (e.key === "ArrowUp" && history && history.length > 0) {
            e.preventDefault();
            if (histIdx === null) {
              draftRef.current = value;
              setHistIdx(0);
              onChange(history[0]);
            } else if (histIdx === history.length - 1) {
              // Past the oldest: wrap back through the draft.
              setHistIdx(null);
              onChange(draftRef.current);
            } else {
              setHistIdx(histIdx + 1);
              onChange(history[histIdx + 1]);
            }
            return;
          }
          if (e.key === "ArrowDown" && history && history.length > 0) {
            e.preventDefault();
            if (histIdx === null) {
              // From the draft, Down wraps to the oldest entry.
              draftRef.current = value;
              setHistIdx(history.length - 1);
              onChange(history[history.length - 1]);
            } else if (histIdx === 0) {
              // Past the newest: restore the draft, completing the cycle.
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
          "h-10 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-xs outline-none transition-colors",
          "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "[caret-color:transparent]",
        )}
      />
    </div>
  );
}
