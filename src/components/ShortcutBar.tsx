import { useMemo, useState } from "react";
import { PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHint } from "@/lib/status";

const MANAGE_VALUE = "__manage__";

/** Shortcut-command picker shown top-right on the Broadcast and Terminals
 * pages (D-054): alphabetized core + user shortcuts, a Go button, and a
 * "Manage shortcuts…" entry that deep-links to the Settings section. */
export function ShortcutBar({
  shortcuts,
  disabled,
  onRun,
  onManage,
}: {
  /** Core + user shortcut commands, unsorted. */
  shortcuts: string[];
  disabled?: boolean;
  onRun: (command: string) => void;
  onManage: () => void;
}) {
  const [selectedCmd, setSelectedCmd] = useState("");
  const hint = useHint();

  const sorted = useMemo(
    () =>
      [...new Set(shortcuts)].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      ),
    [shortcuts],
  );

  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={selectedCmd}
        onValueChange={(v) => {
          if (v === MANAGE_VALUE) {
            onManage();
            return;
          }
          setSelectedCmd(v);
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
          {sorted.map((cmd) => (
            <SelectItem key={cmd} value={cmd} className="font-mono text-xs">
              {cmd}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={MANAGE_VALUE} className="text-xs">
            Manage shortcuts…
          </SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || selectedCmd === ""}
        onClick={() => onRun(selectedCmd)}
        {...hint("Run the selected shortcut command")}
      >
        <PlayIcon />
        Go
      </Button>
    </div>
  );
}
