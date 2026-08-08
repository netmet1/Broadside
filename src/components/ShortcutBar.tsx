import { useMemo, useState } from "react";
import {
  CableIcon,
  PlayIcon,
  SquareTerminalIcon,
  TerminalIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ScopedShortcut } from "@/lib/useShortcuts";
import type { ShortcutScope } from "@/lib/tauri/settings";
import { useHint } from "@/lib/status";

const MANAGE_VALUE = "__manage__";
/** Joins scope + command into the Select value so an SSH and a local shortcut
 * with the same text stay distinct (and never collide as duplicate keys). */
const SEP = " ";

/** Shortcut-command picker shown top-right on the Broadcast, PTY Broadcast,
 * MultiTerminal and Terminals pages (D-054). The dropdown shows only the
 * shortcuts that run in the active terminal: a shortcut matches when its scope
 * equals the active scope or is `both`. A `both` shortcut takes the active
 * terminal's icon (host for SSH/WSL, square for cmd/PowerShell). */
export function ShortcutBar({
  shortcuts,
  activeScope,
  disabled,
  compact,
  onRun,
  onManage,
}: {
  /** Core + user shortcuts, unsorted. */
  shortcuts: ScopedShortcut[];
  /** The active terminal's scope (Terminals), or the fixed scope of an SSH-only
   * page. null = nothing runs (e.g. no active terminal) so the list is empty. */
  activeScope: ShortcutScope | null;
  disabled?: boolean;
  /** The rail this sits in has run out of room, so Go gives up its label and
   * keeps its icon (see lib/useRailCompact). */
  compact?: boolean;
  onRun: (command: string) => void;
  onManage: () => void;
}) {
  const [selected, setSelected] = useState("");
  const hint = useHint();

  // Only the shortcuts that run in the active terminal: matching scope or both.
  // De-duped by scope+command, sorted alphabetically by command.
  //
  // `both` means both shell *languages*, Linux and Windows, which is why it does
  // not reach a serial console: the far end of a console cable speaks neither,
  // and a list headed "runs everywhere" that puts `whoami` in front of a switch
  // is worse than a short list. A serial tab therefore shows the operator's own
  // serial shortcuts and nothing else, which is often nothing at all.
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: ScopedShortcut[] = [];
    // Serial is the only scope `both` is kept out of. Anything else, including
    // "no active terminal", keeps the behaviour it had, so the list a reader is
    // used to seeing does not change under them anywhere but on a cable.
    const bothApplies = activeScope !== "serial";
    for (const s of shortcuts) {
      const matches = s.scope === activeScope || (s.scope === "both" && bothApplies);
      if (!matches) continue;
      const key = s.scope + SEP + s.command;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out.sort((a, b) =>
      a.command.localeCompare(b.command, undefined, { sensitivity: "base" }),
    );
  }, [shortcuts, activeScope]);

  const valueOf = (s: ScopedShortcut) => s.scope + SEP + s.command;
  // A selection can linger after switching to a tab where it does not apply;
  // Go stays disabled until the selected shortcut is one of the current items.
  const runnable =
    !disabled && selected !== "" && items.some((s) => valueOf(s) === selected);

  // Nothing at all to pick. In practice this is a serial console and only a
  // serial console: SSH and Windows tabs always have the built-in commands
  // behind them, and a cable has none by design.
  //
  // The control stays live. Greying it out was the first attempt and it was the
  // wrong answer: the one thing wanted at that exact moment is the way to add
  // the first command, and that lives inside the list as Manage shortcuts…, so
  // a flat trigger locks the door on the room you were being sent to. The
  // trigger says No serial shortcuts so the state is legible without opening
  // it, and opening it says the same thing again, greyed and unpickable, above
  // the way out.
  const nothingToPick = items.length === 0;
  const emptyLabel =
    activeScope === "serial" ? "No serial shortcuts" : "No shortcuts";
  // Kept inside the status bar's one line (see HINT_BUDGET_PX). Why Broadside
  // ships no serial commands is a paragraph, and a paragraph belongs in Help,
  // which carries it; the hint's job is to say where the commands come from.
  const emptyHint =
    activeScope === "serial"
      ? "Broadside ships no serial commands: a console port might be anything. Add your own from Manage shortcuts in this list."
      : "No shortcut commands for this terminal. Add one from Manage shortcuts in this list.";
  const selectedCmd = selected ? selected.slice(selected.indexOf(SEP) + 1) : "";

  // A `both` shortcut borrows the active terminal's icon; others use their own
  // scope (which, after filtering, equals the active scope anyway).
  const iconFor = (scope: ShortcutScope) => {
    const effective = scope === "both" ? activeScope : scope;
    if (effective === "serial") return CableIcon;
    return effective === "local" ? SquareTerminalIcon : TerminalIcon;
  };

  return (
    // min-w-0 the whole way down to the trigger, through the hint wrapper as
    // well. The picker is the widest thing in either rail (14rem, which is 280px
    // at a 20px app font), so it is what should give up room first when the row
    // is tight; without min-w-0 at every level a flex item will not shrink below
    // its own content and the row runs off the edge instead. The Go wrapper is
    // shrink-0 for the opposite reason: the button inside it already refuses to
    // shrink, and a wrapper that does would clip it instead of the row giving.
    <div className="flex min-w-0 items-center gap-1.5">
      {/* The hint hangs on this wrapper rather than on the trigger so it is one
          element whichever state the picker is in, and so it survives the
          trigger being replaced by whatever Radix renders. */}
      <span
        className="flex min-w-0 flex-1"
        {...hint(
          nothingToPick
            ? emptyHint
            : "Pick a shortcut command, then press Go to run it",
        )}
      >
      <Select
        value={selected}
        onValueChange={(v) => {
          if (v === MANAGE_VALUE) {
            onManage();
            return;
          }
          setSelected(v);
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-56 min-w-0 font-mono text-xs"
          aria-label="Shortcut command"
        >
          <SelectValue
            placeholder={nothingToPick ? emptyLabel : "Shortcut command…"}
          />
        </SelectTrigger>
        <SelectContent>
          {items.map((s) => {
            const Icon = iconFor(s.scope);
            const label = s.label?.trim();
            return (
              <SelectItem
                key={valueOf(s)}
                value={valueOf(s)}
                className="text-xs"
              >
                <span className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {label ? (
                    <>
                      <span className="truncate">{label}</span>
                      <span className="truncate font-mono text-muted-foreground">
                        {s.command}
                      </span>
                    </>
                  ) : (
                    <span className="truncate font-mono">{s.command}</span>
                  )}
                </span>
              </SelectItem>
            );
          })}
          {/* A plain div, not a disabled SelectItem: it is a caption and not an
              option, so it should not be reachable by arrow key or typeahead,
              and it needs no fake value to be skipped over. */}
          {nothingToPick && (
            <div className="px-1.5 py-1 text-xs text-muted-foreground">
              {emptyLabel} yet
            </div>
          )}
          <SelectSeparator />
          <SelectItem value={MANAGE_VALUE} className="text-xs">
            Manage shortcuts…
          </SelectItem>
        </SelectContent>
      </Select>
      </span>
      <span
        className="shrink-0"
        {...(runnable
          ? {}
          : hint(nothingToPick ? emptyHint : "Pick a shortcut command first"))}
      >
        <Button
          size={compact ? "icon-sm" : "sm"}
          variant="outline"
          disabled={!runnable}
          onClick={() => onRun(selectedCmd)}
          aria-label={compact ? "Go" : undefined}
          {...(runnable ? hint("Run the selected shortcut command") : {})}
        >
          <PlayIcon />
          {!compact && "Go"}
        </Button>
      </span>
    </div>
  );
}
