import { useEffect, useState } from "react";
import { Columns2Icon, RadioTowerIcon } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { TransferMode } from "@/lib/tauri/sftp";
import { CommanderTab } from "@/pages/sftp/CommanderTab";
import { BroadcastTab } from "@/pages/sftp/BroadcastTab";
import { MODE_KEY, readTransferMode } from "@/pages/sftp/model";

type SftpTab = "commander" | "broadcast";

/** Persisted last-open tab (restored across restarts; defaults to Commander). */
const TAB_KEY = "sftp-tab";

/**
 * SFTP feature page. Two tabs (per the design):
 *  - **Commander** — dual-pane file manager (local left, remote right) with
 *    drag-and-drop transfers.
 *  - **Broadcast** — multi-host put/get across the selected hosts, with a
 *    typed-word guard and per-host progress.
 *
 * The "When a file already exists" clash mode lives on the tab row (right side)
 * so it applies to — and is visible in — both tabs. Bodies stay mounted (App
 * renders the page CSS-hidden) so an open session survives tab switches.
 */
export function SftpPage({ visible }: { visible: boolean }) {
  const [tab, setTab] = useState<SftpTab>(() =>
    localStorage.getItem(TAB_KEY) === "broadcast" ? "broadcast" : "commander",
  );
  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab]);

  // Shared clash mode for both tabs; persisted across restarts.
  const [mode, setMode] = useState<TransferMode>(readTransferMode);
  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  return (
    <div className="flex h-full flex-col">
      {/* Tab switcher; the shared clash mode sits on the right of the tabs. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/50 px-2 py-1.5">
        <TabButton
          active={tab === "commander"}
          onClick={() => setTab("commander")}
          icon={<Columns2Icon className="h-4 w-4" />}
          label="Commander"
        />
        <TabButton
          active={tab === "broadcast"}
          onClick={() => setTab("broadcast")}
          icon={<RadioTowerIcon className="h-4 w-4" />}
          label="Broadcast"
        />
        <div className="ml-auto flex items-center gap-2 pr-1">
          <span className="text-xs text-muted-foreground">
            When a file already exists:
          </span>
          <Select value={mode} onValueChange={(v) => setMode(v as TransferMode)}>
            <SelectTrigger size="sm" className="w-40" aria-label="Clash mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="overwrite_all">Overwrite all</SelectItem>
              <SelectItem value="newer_only">Newer only</SelectItem>
              <SelectItem value="skip_existing">Skip existing</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Bodies stay mounted so the session survives tab switches. */}
      <div className="min-h-0 flex-1">
        <div className={tab === "commander" ? "h-full" : "hidden"}>
          <CommanderTab visible={visible && tab === "commander"} mode={mode} />
        </div>
        <div className={tab === "broadcast" ? "h-full" : "hidden"}>
          <BroadcastTab visible={visible && tab === "broadcast"} mode={mode} />
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
