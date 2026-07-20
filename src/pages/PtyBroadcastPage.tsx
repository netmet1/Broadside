import { useEffect, useMemo, useState } from "react";
import { RadioTowerIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  LocalTermSession,
  SshTermSession,
  TermSession,
} from "@/pages/TerminalsPage";
import { SshBroadcastPanel } from "@/pages/ptyBroadcast/SshBroadcastPanel";
import { LocalBroadcastPanel } from "@/pages/ptyBroadcast/LocalBroadcastPanel";

/** The four fixed broadcast families. Always shown, even when no shell of that
 * kind is open (each panel renders its own empty state). */
type PtyTab = "ssh" | "powershell" | "cmd" | "wsl";

/** Persisted last-open tab (restored across restarts; defaults to SSH). */
const TAB_KEY = "pty-broadcast-tab";

function readTab(): PtyTab {
  const v = localStorage.getItem(TAB_KEY);
  return v === "powershell" || v === "cmd" || v === "wsl" ? v : "ssh";
}

/**
 * PTY Broadcast page. A command typed here is sent, as if keyed in, into every
 * checked open terminal — SSH sessions or local shells. The four fixed tabs keep
 * each broadcast within one shell language (SSH hosts, PowerShell, Command
 * Prompt, WSL) so a single command is always valid for its targets.
 *
 * The tab strip mirrors the SFTP page; all four panels stay mounted (CSS-hidden)
 * so selection and the dispatch report survive tab switches.
 */
export function PtyBroadcastPage({
  visible,
  sessions,
  connectedSessions,
  onManageShortcuts,
}: {
  visible: boolean;
  sessions: TermSession[];
  /** Session ids with a live connection — only these can receive input. */
  connectedSessions: Set<string>;
  onManageShortcuts: () => void;
}) {
  const [tab, setTab] = useState<PtyTab>(readTab);
  useEffect(() => {
    localStorage.setItem(TAB_KEY, tab);
  }, [tab]);

  // Split the open sessions into their four families once per change.
  const sshSessions = useMemo(
    () => sessions.filter((s): s is SshTermSession => s.type === "ssh"),
    [sessions],
  );
  const powershellSessions = useMemo(
    () =>
      sessions.filter(
        (s): s is LocalTermSession =>
          s.type === "local" &&
          (s.shell.kind === "powershell" || s.shell.kind === "pwsh"),
      ),
    [sessions],
  );
  const cmdSessions = useMemo(
    () =>
      sessions.filter(
        (s): s is LocalTermSession =>
          s.type === "local" && s.shell.kind === "cmd",
      ),
    [sessions],
  );
  const wslSessions = useMemo(
    () =>
      sessions.filter(
        (s): s is LocalTermSession =>
          s.type === "local" && s.shell.kind === "wsl",
      ),
    [sessions],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Tab switcher — fixed set, always shown. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/50 px-2 py-1.5">
        <TabButton
          active={tab === "ssh"}
          onClick={() => setTab("ssh")}
          icon={<RadioTowerIcon className="h-4 w-4" />}
          label="SSH"
          count={sshSessions.length}
        />
        <TabButton
          active={tab === "powershell"}
          onClick={() => setTab("powershell")}
          icon={<SquareTerminalIcon className="h-4 w-4" />}
          label="PowerShell"
          count={powershellSessions.length}
        />
        <TabButton
          active={tab === "cmd"}
          onClick={() => setTab("cmd")}
          icon={<SquareTerminalIcon className="h-4 w-4" />}
          label="Command Prompt"
          count={cmdSessions.length}
        />
        <TabButton
          active={tab === "wsl"}
          onClick={() => setTab("wsl")}
          icon={<TerminalIcon className="h-4 w-4" />}
          label="WSL"
          count={wslSessions.length}
        />
      </div>

      {/* Bodies stay mounted so selection + reports survive tab switches. */}
      <div className="min-h-0 flex-1">
        <div className={tab === "ssh" ? "h-full" : "hidden"}>
          <SshBroadcastPanel
            visible={visible && tab === "ssh"}
            sessions={sshSessions}
            connectedSessions={connectedSessions}
            onManageShortcuts={onManageShortcuts}
          />
        </div>
        <div className={tab === "powershell" ? "h-full" : "hidden"}>
          <LocalBroadcastPanel
            visible={visible && tab === "powershell"}
            family="PowerShell"
            sessions={powershellSessions}
            connectedSessions={connectedSessions}
            scope="local"
            onManageShortcuts={onManageShortcuts}
            storagePrefix="pty-broadcast-powershell"
          />
        </div>
        <div className={tab === "cmd" ? "h-full" : "hidden"}>
          <LocalBroadcastPanel
            visible={visible && tab === "cmd"}
            family="Command Prompt"
            sessions={cmdSessions}
            connectedSessions={connectedSessions}
            scope="local"
            onManageShortcuts={onManageShortcuts}
            storagePrefix="pty-broadcast-cmd"
          />
        </div>
        <div className={tab === "wsl" ? "h-full" : "hidden"}>
          <LocalBroadcastPanel
            visible={visible && tab === "wsl"}
            family="WSL"
            sessions={wslSessions}
            connectedSessions={connectedSessions}
            scope="ssh"
            onManageShortcuts={onManageShortcuts}
            storagePrefix="pty-broadcast-wsl"
          />
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
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  /** Open shells in this family, shown as a small pill when non-zero. */
  count: number;
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
      {count > 0 && (
        <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </button>
  );
}
