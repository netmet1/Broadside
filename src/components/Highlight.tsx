import type { LineMatch } from "@/lib/search";

export type ActiveRange = { start: number; end: number } | null;

/** One line with `<mark>` spans; the active match scrolls into view. */
export function HighlightedLine({
  text,
  matches,
  activeRange,
}: {
  text: string;
  matches: LineMatch[];
  activeRange: ActiveRange;
}) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((m, idx) => {
    if (m.start > cursor) parts.push(text.slice(cursor, m.start));
    const isActive =
      activeRange !== null &&
      activeRange.start === m.start &&
      activeRange.end === m.end;
    parts.push(
      <mark
        key={idx}
        ref={
          isActive ? (el) => el?.scrollIntoView({ block: "center" }) : undefined
        }
        className={
          isActive
            ? "rounded-sm bg-amber-400 text-black"
            : "rounded-sm bg-amber-400/30 text-inherit"
        }
      >
        {text.slice(m.start, m.end)}
      </mark>,
    );
    cursor = m.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Whole multi-line text highlighted from a line→matches map. */
export function HighlightedText({
  text,
  lineMap,
  activeLine,
  activeRange,
}: {
  text: string;
  lineMap: Map<number, LineMatch[]>;
  /** Which line holds the active match (null when none in this text). */
  activeLine: number | null;
  activeRange: ActiveRange;
}) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const matches = lineMap.get(i);
        const suffix = i < lines.length - 1 ? "\n" : "";
        if (!matches) {
          return (
            <span key={i}>
              {line}
              {suffix}
            </span>
          );
        }
        return (
          <span key={i}>
            <HighlightedLine
              text={line}
              matches={matches}
              activeRange={activeLine === i ? activeRange : null}
            />
            {suffix}
          </span>
        );
      })}
    </>
  );
}
