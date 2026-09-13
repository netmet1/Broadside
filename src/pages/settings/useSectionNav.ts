/**
 * Where the Settings page is scrolled to, and how to get somewhere else on it.
 *
 * Three jobs, all about the shared `<main>` the page scrolls in:
 *
 *  - **Which section is in view**, for the panel down the left, which lights it
 *    the way Help's does (and asks the same question, through
 *    lib/nearestSection).
 *  - **Remembering it**, so coming back to Settings lands where you left off.
 *  - **Going to a section**, from the panel or from the header's Jump to list.
 *
 * Moved out of SettingsPage, which was over two thousand lines and carried all
 * of it inline.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { nearestSectionId } from "@/lib/nearestSection";
import {
  SECTION_SCROLL_KEY,
  SECTION_TITLES,
  STICKY_OFFSET_PX,
  sectionDomId,
} from "@/pages/settings/constants";

const SECTION_IDS = SECTION_TITLES.map(sectionDomId);

function titleOf(id: string | null): string | null {
  if (id === null) return null;
  return SECTION_TITLES[SECTION_IDS.indexOf(id)] ?? null;
}

export type SectionNav = {
  /** The section nearest the top of the page, or null before the first read. */
  activeTitle: string | null;
  /** Scroll to a section and leave the search alone: what a click in the panel
   * does, since the panel only lists sections the search already kept. */
  scrollToSection: (title: string) => void;
  /** Clear the search, then scroll to a section: what the header's Jump to list
   * does, because it lists every section and the one picked may be filtered
   * out. */
  goToSection: (title: string) => void;
  /** A jump has been asked for, so every section has to be in the page. The
   * page reveals its sections a frame at a time on first mount, and a jump made
   * in those first frames used to aim at a section that was not there yet and
   * do nothing. */
  wantsAllSections: boolean;
};

export function useSectionNav({
  rootRef,
  visible,
  ready,
  focusSection,
  clearQuery,
  layoutKey,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  /** False while the tab is mounted but hidden. The scroll area is shared with
   * every other page, so nothing here may read or remember it meanwhile. */
  visible: boolean;
  /** The async settings have loaded, so the sections are their real height. */
  ready: boolean;
  /** A deep link is steering the scroll, so there is nothing to restore. */
  focusSection: string | null;
  clearQuery: () => void;
  /** Anything that changes which sections are on the page without scrolling it
   * (the search), so the highlight is asked again. */
  layoutKey: string;
}): SectionNav {
  const [activeTitle, setActiveTitle] = useState<string | null>(null);

  // Saving is gated until the restore below has run. When this tab is shown
  // again the shared <main> can be clamped to a shorter scrollHeight (coming
  // back from the taller Help page, say), which fires a scroll event, and saving
  // that clamped position would overwrite the real saved section with a
  // near-bottom one before the restore reads it (the Settings<->Help drift bug).
  const saveEnabled = useRef(false);

  // Track the section in view while the page is shown: highlight it, and
  // remember it once saving is allowed. Read once on the way in and whenever
  // the search changes the page, since neither of those has to scroll it.
  useEffect(() => {
    if (!visible) return;
    const scroller = rootRef.current?.closest("main");
    if (!scroller) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const title = titleOf(
        nearestSectionId(scroller, SECTION_IDS, STICKY_OFFSET_PX),
      );
      setActiveTitle(title);
      if (title && saveEnabled.current) {
        sessionStorage.setItem(SECTION_SCROLL_KEY, title);
      }
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(read);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    raf = requestAnimationFrame(read);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [visible, rootRef, layoutKey]);

  // Restore the last-viewed section when returning to the tab, once per visit,
  // and never when a deep link is steering the scroll instead.
  const didRestoreScroll = useRef(false);
  useEffect(() => {
    // Hidden but still mounted: stop saving, and re-arm so the scroll is
    // restored again the next time the tab is shown.
    if (!visible) {
      saveEnabled.current = false;
      didRestoreScroll.current = false;
      return;
    }
    if (didRestoreScroll.current) return;
    if (focusSection) {
      didRestoreScroll.current = true;
      saveEnabled.current = true;
      return;
    }
    // Wait until the async settings (and the probe panel they render) have
    // loaded: restoring before that lets the Performance section grow AFTER we
    // scroll, pushing the target down so we land above it (the reported drift).
    if (!ready) return;
    didRestoreScroll.current = true;
    const scroller = rootRef.current?.closest("main");
    const saved = sessionStorage.getItem(SECTION_SCROLL_KEY);
    if (!saved || saved === SECTION_TITLES[0]) {
      // Nothing meaningful to restore. Reset to the top so we don't keep the
      // scroll position inherited from the previously shown (possibly taller)
      // page, which the browser clamps to this page's bottom.
      scroller?.scrollTo({ top: 0 });
      saveEnabled.current = true;
      // A scroll that did not move the page sends no event, and the panel
      // still has to light something.
      scroller?.dispatchEvent(new Event("scroll"));
      return;
    }
    // Double rAF: let this commit paint, then scroll once layout is settled.
    // Only enable saving AFTER the restore scroll lands, so the restore itself
    // (and any clamp on remount) cannot clobber the saved section.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .getElementById(sectionDomId(saved))
          ?.scrollIntoView({ block: "start" });
        saveEnabled.current = true;
        scroller?.dispatchEvent(new Event("scroll"));
      }),
    );
  }, [visible, ready, focusSection, rootRef]);

  // A scroll request, carrying a serial number rather than being cleared once
  // it has been acted on. Clearing it meant the effect that performed the
  // scroll also had to write state, and the number does the same job: asking
  // for the same section twice produces a new object, so the second click
  // scrolls again. Its existence is also what reveals every section, in the
  // same render as the request, so by the time the effect runs the target is
  // in the page.
  const [scrollRequest, setScrollRequest] = useState<{
    title: string;
    n: number;
  } | null>(null);
  const scrollToSection = useCallback((title: string) => {
    setScrollRequest((r) => ({ title, n: (r?.n ?? 0) + 1 }));
  }, []);
  const goToSection = useCallback(
    (title: string) => {
      clearQuery();
      scrollToSection(title);
    },
    [clearQuery, scrollToSection],
  );
  useEffect(() => {
    if (!scrollRequest) return;
    document
      .getElementById(sectionDomId(scrollRequest.title))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollRequest]);

  return {
    activeTitle,
    scrollToSection,
    goToSection,
    wantsAllSections: scrollRequest !== null,
  };
}
