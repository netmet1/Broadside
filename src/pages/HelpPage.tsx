import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { exportHelpPdf, helpPdfAvailable } from "@/lib/tauri/help";
import { errorMessage } from "@/lib/tauri/hosts";
import { useAppVersion } from "@/lib/useAppVersion";
import { useHint } from "@/lib/status";
import { SECTIONS, scrollToId } from "@/pages/help/content";
import { searchableText } from "@/pages/help/searchText";
import { queryPattern, useHelpHighlight } from "@/pages/help/useHelpHighlight";
import { cn } from "@/lib/utils";

/** Help scroll position, remembered while the app runs (sessionStorage clears on
 * restart). Mirrors the Settings tab's persistence pattern. */
const HELP_SCROLL_KEY = "help-scroll-top";
/** Sticky-offset to discount when picking the section nearest the top, matching
 * the `help-sec-` scroll-margin-top: 4rem rule in index.css. */
const STICKY_OFFSET_PX = 64;

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id}>
      <h2 className="font-heading text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

/** What each section can be found by: its title, its keywords, and every word
 * it actually says. Built once — the sections are fixed at module load, and
 * walking fourteen of them on every keystroke would be work for nothing. */
const SECTION_TEXT = new Map<string, string>(
  SECTIONS.map((s) => [
    s.id,
    `${s.title} ${s.keywords} ${searchableText(s.body)}`
      .replace(/\s+/g, " ")
      .toLowerCase(),
  ]),
);

export function HelpPage() {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The rendered sections, which is where the search marks its matches. */
  const contentRef = useRef<HTMLDivElement>(null);
  // The id of the section nearest the top of the scroll area, for the live TOC
  // highlight.
  const [activeId, setActiveId] = useState<string | null>(null);

  const hint = useHint();
  const version = useAppVersion();
  // The handbook is built at release time, so a build can legitimately be
  // without one. Ask before offering it: a button that always fails is worse
  // than no button.
  const [pdfReady, setPdfReady] = useState(false);
  useEffect(() => {
    helpPdfAvailable()
      .then(setPdfReady)
      .catch(() => setPdfReady(false));
  }, []);

  const savePdf = useCallback(async () => {
    try {
      const path = await saveDialog({
        title: "Save the Broadside handbook",
        defaultPath: `broadside-help${version ? `-v${version}` : ""}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof path !== "string") return;
      await exportHelpPdf(path);
      toast.success("Handbook saved");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [version]);

  const searching = query.trim() !== "";

  const visibleSections = useMemo(() => {
    if (query.trim() === "") return SECTIONS;
    // The same pattern the highlighter uses, so the spaces someone types stand
    // in for the punctuation the page writes: `ctrl shift g` finds the section
    // that says Ctrl+Shift+G, and `16 20` finds the one that says 16/20.
    const pattern = queryPattern(query, { flags: "i", floor: 1 });
    if (!pattern) return SECTIONS;
    return SECTIONS.filter((s) => pattern.test(SECTION_TEXT.get(s.id) ?? ""));
  }, [query]);

  // Filtering to a section is only half the answer: the section can be long,
  // and the words that matched are somewhere in it. Mark them and go to the
  // first one, so the search does not end with a hunt.
  const highlight = useHelpHighlight(contentRef, query, visibleSections);

  // Restore the last scroll position on mount, then track scrolling to (a) keep
  // the TOC highlight in sync and (b) remember the position for the next visit.
  // Saving is gated until after the restore so the shared <main> being clamped
  // on remount cannot overwrite the saved value with a wrong spot.
  const saveEnabled = useRef(false);
  useEffect(() => {
    const scroller = rootRef.current?.closest("main");
    if (!scroller) return;

    const computeActive = () => {
      const anchor = scroller.getBoundingClientRect().top + STICKY_OFFSET_PX;
      let best: string | null = null;
      let bestDist = Infinity;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (!el) continue;
        const dist = Math.abs(el.getBoundingClientRect().top - anchor);
        if (dist < bestDist) {
          bestDist = dist;
          best = s.id;
        }
      }
      setActiveId(best);
    };

    // Restore (next frame, so the content has laid out), then allow saving.
    // Always assign scrollTop (even 0) so we clear any position inherited from
    // the previously shown page sharing this <main>.
    const saved = Number(sessionStorage.getItem(HELP_SCROLL_KEY));
    requestAnimationFrame(() => {
      scroller.scrollTop = Number.isFinite(saved) && saved > 0 ? saved : 0;
      computeActive();
      saveEnabled.current = true;
    });

    let raf = 0;
    const onScroll = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        computeActive();
        if (saveEnabled.current) {
          sessionStorage.setItem(HELP_SCROLL_KEY, String(scroller.scrollTop));
        }
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={rootRef} className="mx-auto flex max-w-5xl gap-8 px-6 py-6">
      {/* Sticky table of contents (GitBook-style). Hidden on narrow widths,
          where the sections simply stack and scroll. */}
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-4 space-y-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter help"
              aria-label="Filter help sections"
              className="pl-8 pr-8"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* Where the marks are, and a way through them. A filter that keeps a
              section whose keywords matched but whose words did not is normal,
              so say "no matches on the page" rather than implying a dead end. */}
          {searching && (
            <div className="flex items-center justify-between gap-2 px-0.5 text-xs text-muted-foreground">
              {highlight.count === 0 ? (
                <span>No matches on the page</span>
              ) : (
                <>
                  <span>
                    Match {highlight.index + 1} of {highlight.count}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => highlight.go(-1)}
                      aria-label="Previous match"
                      className="rounded-sm p-0.5 hover:bg-accent hover:text-accent-foreground"
                    >
                      <ChevronUpIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => highlight.go(1)}
                      aria-label="Next match"
                      className="rounded-sm p-0.5 hover:bg-accent hover:text-accent-foreground"
                    >
                      <ChevronDownIcon className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </>
              )}
            </div>
          )}
          <nav className="space-y-0.5">
            {/* While filtering, each section says how many marks are in it, so
                a section kept for a keyword — a word deliberately not written on
                the page — reads as "keyword" instead of looking like a match the
                reader has failed to spot. */}
            {visibleSections.map((s) => {
              const marks = searching
                ? (highlight.countsById.get(s.id) ?? 0)
                : 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => scrollToId(s.id)}
                  aria-current={activeId === s.id ? "true" : undefined}
                  title={
                    !searching
                      ? undefined
                      : marks === 0
                        ? "Kept by a keyword: this wording is not on the page"
                        : marks === 1
                          ? "1 match on the page"
                          : `${marks} matches on the page`
                  }
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                    activeId === s.id
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  {searching && (
                    <span className="shrink-0 text-[0.7rem] tabular-nums opacity-70">
                      {marks === 0 ? "keyword" : marks}
                    </span>
                  )}
                </button>
              );
            })}
            {visibleSections.length === 0 && (
              <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                No sections match.
              </p>
            )}
          </nav>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Pinned to the top of the scroll area, so someone reading the
            glossary at the far end of the page can still see which tab they
            are on and still reach the handbook. Only the title and the button
            are pinned: the strip has to stay under the 4rem scroll-margin the
            sections are given in index.css, or jumping to a section would put
            its heading behind this. The standfirst below scrolls away. */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b bg-background py-3">
          <h1 className="min-w-0 truncate font-heading text-2xl font-semibold tracking-tight">
            Help center
          </h1>
          {pdfReady && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void savePdf()}
              {...hint(
                "Save everything on this page as a PDF handbook, cover and contents included.",
              )}
              className="shrink-0"
            >
              <DownloadIcon className="h-4 w-4" />
              Download PDF
            </Button>
          )}
        </header>
        <p className="mb-6 mt-3 text-sm text-muted-foreground">
          How Broadside works, tab by tab, with a glossary for the technical
          terms. Hover any control in the app to see a short explanation in the
          status bar.
        </p>

        <div ref={contentRef} className="space-y-10">
          {visibleSections.map((s) => (
            <Section key={s.id} id={s.id} title={s.title}>
              {s.body}
            </Section>
          ))}
          {visibleSections.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No help sections match your filter.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
