import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowDownIcon } from "lucide-react";

import { useHint } from "@/lib/status";

/** How far off the bottom counts as "scrolled up". Generous enough that the
 * button doesn't flicker in and out while output is arriving. */
const AWAY_PX = 120;

/**
 * A button that appears over a log when you have scrolled up, and takes you back
 * to the live end.
 *
 * The output views scroll themselves to the bottom as results land, so reading
 * something further up means fighting the page to get back down again in a log
 * that can be thousands of lines long. This is the way back.
 *
 * Render it as a sibling of the scroller inside a `relative` parent. It watches
 * the element rather than the data, so it works the same on all three pages
 * without knowing what any of them are showing.
 */
export function ScrollToBottom({
  scrollerRef,
  onJump,
  label = "Jump to the newest output",
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  /** Run after the jump, for a page that tracks whether it should keep
   * following the bottom as new output lands. */
  onJump?: () => void;
  label?: string;
}) {
  const hint = useHint();
  const [away, setAway] = useState(false);
  // Held in a ref so the observers below can be set up once per element rather
  // than being torn down and rebuilt every time the button appears.
  const awayRef = useRef(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      const next = el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX;
      if (next !== awayRef.current) {
        awayRef.current = next;
        setAway(next);
      }
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // Scrolling alone isn't enough: output arriving while you sit still changes
    // the distance to the bottom without firing a scroll event. The resize
    // observer catches the viewport changing, the mutation observer catches the
    // content growing under it.
    const resize = new ResizeObserver(update);
    resize.observe(el);
    const mutations = new MutationObserver(update);
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener("scroll", update);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [scrollerRef]);

  if (!away) return null;

  return (
    <button
      type="button"
      className="absolute bottom-4 right-6 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background/95 text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground"
      onClick={() => {
        const el = scrollerRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        onJump?.();
      }}
      aria-label="Scroll to the newest output"
      {...hint(label)}
    >
      <ArrowDownIcon className="h-4 w-4" />
    </button>
  );
}
