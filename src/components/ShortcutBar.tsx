import { useMemo, useState } from "react";
import { PlayIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";

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
  onRun,
  onManage,
}: {
  /** Core + user shortcuts, unsorted. */
  shortcuts: ScopedShortcut[];
  /** The active terminal's scope (Terminals), or the fixed scope of an SSH-only
   * page. null = nothing runs (e.g. no active terminal) so the list is empty. */
  activeScope: ShortcutScope | null;
  disabled?: boolean;
  onRun: (command: string) => void;
  onManage: () => void;
}) {
  const [selected, setSelected] = useState("");
  const hint = useHint();

  // Only the shortcuts that run in the active terminal: matching scope or both.
  // De-duped by scope+command, sorted alphabetically by command.
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: ScopedShortcut[] = [];
    for (const s of shortcuts) {
      if (s.scope !== "both" && s.scope !== activeScope) continue;
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
  const selectedCmd = selected ? selected.slice(selected.indexOf(SEP) + 1) : "";

  // A `both` shortcut borrows the active terminal's icon; others use their own
  // scope (which, after filtering, equals the active scope anyway).
  const iconFor = (scope: ShortcutScope) => {
    const effective = scope === "both" ? activeScope : scope;
    return effective === "local" ? SquareTerminalIcon : TerminalIcon;
  };

  return (
    <div className="flex items-center gap-1.5">
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
          className="w-56 font-mono text-xs"
          aria-label="Shortcut command"
          {...hint("Pick a shortcut command, then press Go to run it")}
        >
          <SelectValue placeholder="Shortcut command…" />
        </SelectTrigger>
        <SelectContent>
          {items.map((s) => {
            const Icon = iconFor(s.scope);
            return (
              <SelectItem
                key={valueOf(s)}
                value={valueOf(s)}
                className="font-mono text-xs"
              >
                <span className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{s.command}</span>
                </span>
              </SelectItem>
            );
          })}
          <SelectSeparator />
          <SelectItem value={MANAGE_VALUE} className="text-xs">
            Manage shortcuts…
          </SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={!runnable}
        onClick={() => onRun(selectedCmd)}
        {...hint("Run the selected shortcut command")}
      >
        <PlayIcon />
        Go
      </Button>
    </div>
  );
}
