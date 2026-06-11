import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  parseSlashSyntax,
  type SearchOptions,
} from "@/lib/search";
import { cn } from "@/lib/utils";

export type SearchMode = "find" | "filter";

type Props = {
  /** Modes this surface supports — PTY tabs pass ["find"] only (D-015). */
  modes: SearchMode[];
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  /** Result feedback, e.g. `12 matches in 4 hosts` or an error. */
  status: string;
  statusTone?: "normal" | "error";
  onQueryChange: (pattern: string, options: SearchOptions) => void;
  /** Find-mode next/previous navigation. */
  onNavigate?: (direction: 1 | -1) => void;
  onClose: () => void;
};

/**
 * Search bar shared by every Find/Filter surface (D-015): explicit `.*`
 * regex toggle as primary UX, `/pattern/flags` slash syntax flips it on,
 * `Aa` case toggle, `|ab|` whole-word toggle.
 */
export function SearchBar({
  modes,
  mode,
  onModeChange,
  status,
  statusTone = "normal",
  onQueryChange,
  onNavigate,
  onClose,
}: Props) {
  const [raw, setRaw] = useState("");
  const [regexOn, setRegexOn] = useState(false);
  const [caseOn, setCaseOn] = useState(false);
  const [wordOn, setWordOn] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Slash syntax is a one-way power shortcut: typing /…/ flips regex on.
  const slash = parseSlashSyntax(raw);
  useEffect(() => {
    if (slash && !regexOn) setRegexOn(true);
  }, [slash, regexOn]);

  const effectivePattern = slash ? slash.pattern : raw;
  const effectiveOptions: SearchOptions = {
    regex: regexOn || slash !== null,
    caseSensitive: slash ? slash.caseSensitive : caseOn,
    wholeWord: wordOn,
  };

  // Report the effective query whenever anything changes.
  const { regex, caseSensitive, wholeWord } = effectiveOptions;
  useEffect(() => {
    onQueryChange(effectivePattern, { regex, caseSensitive, wholeWord });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePattern, regex, caseSensitive, wholeWord]);

  const toggleRegex = () => {
    setRegexOn((on) => {
      const next = !on;
      // Editor norms (D-015): plain default insensitive, regex sensitive.
      setCaseOn(next);
      return next;
    });
  };

  const toggleClass = (active: boolean) =>
    cn(
      "rounded px-1.5 py-0.5 font-mono text-xs transition-colors",
      active
        ? "bg-primary/20 text-primary"
        : "text-muted-foreground hover:bg-accent hover:text-foreground",
    );

  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-background px-3 py-2">
      {modes.length > 1 && (
        <div className="flex rounded-md border border-border/60 p-0.5">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={cn(
                "rounded px-2 py-0.5 text-xs capitalize",
                m === mode
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      )}

      <Input
        ref={inputRef}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onNavigate && mode === "find") {
            e.preventDefault();
            onNavigate(e.shiftKey ? -1 : 1);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={mode === "find" ? "Find…" : "Filter lines…"}
        autoComplete="off"
        spellCheck={false}
        className="h-8 max-w-72 font-mono text-sm"
        aria-label={mode === "find" ? "Find" : "Filter"}
      />

      <button
        type="button"
        onClick={toggleRegex}
        className={toggleClass(effectiveOptions.regex)}
        title="Regular expression"
        aria-pressed={effectiveOptions.regex}
      >
        .*
      </button>
      <button
        type="button"
        onClick={() => setCaseOn((v) => !v)}
        className={toggleClass(effectiveOptions.caseSensitive)}
        title="Match case"
        aria-pressed={effectiveOptions.caseSensitive}
      >
        Aa
      </button>
      <button
        type="button"
        onClick={() => setWordOn((v) => !v)}
        className={toggleClass(effectiveOptions.wholeWord)}
        title="Whole word"
        aria-pressed={effectiveOptions.wholeWord}
      >
        |ab|
      </button>

      {mode === "find" && onNavigate && (
        <div className="flex">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onNavigate(-1)}
            aria-label="Previous match"
          >
            <ChevronUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onNavigate(1)}
            aria-label="Next match"
          >
            <ChevronDownIcon />
          </Button>
        </div>
      )}

      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          statusTone === "error" ? "text-red-400" : "text-muted-foreground",
        )}
      >
        {status}
      </span>

      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close search">
        <XIcon />
      </Button>
    </div>
  );
}
