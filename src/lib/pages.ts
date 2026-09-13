import type { Page } from "@/components/AppShell";

/**
 * Every page, by the name it goes by, in the order the left rail lists them
 * with Help last.
 *
 * Here rather than in AppShell because two things name the tabs: the rail, and
 * Settings > Startup's list of what Broadside can open on. One list means the
 * two can never call a tab different things, and a page added to the rail
 * cannot be missing from the startup choice.
 */
export const PAGES: readonly { page: Page; label: string }[] = [
  { page: "hosts", label: "Hosts" },
  { page: "templates", label: "Templates" },
  { page: "terminals", label: "Terminals" },
  { page: "broadcast", label: "Broadcast" },
  { page: "ptybroadcast", label: "PTY Broadcast" },
  { page: "multiterminal", label: "MultiTerminal" },
  { page: "skills", label: "Skills" },
  { page: "sftp", label: "SFTP" },
  { page: "logs", label: "Logs" },
  { page: "settings", label: "Settings" },
  { page: "help", label: "Help" },
];

export function pageLabel(page: Page): string {
  return PAGES.find((p) => p.page === page)?.label ?? page;
}
