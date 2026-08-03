import { TriangleAlertIcon } from "lucide-react";

import {
  shellNotice,
  type ShellCapability,
  type ShellIntegrationPref,
} from "@/lib/shells";
import { useHint } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * The amber chip that marks a host whose login shell Broadside cannot fully
 * drive (X4, D-067).
 *
 * One component rather than the four hand-rolled copies this replaces, because
 * the chip now has to say which of three things went wrong and the wording is
 * the whole point. It appears on the Hosts row, and in the Broadcast, PTY
 * Broadcast, MultiTerminal and Skills rails: those lists *mark* an unsupported
 * host rather than hiding it, since plain broadcast works perfectly well on
 * fish and a host that silently vanishes from a list is the hardest kind of bug
 * to report.
 *
 * The rails take the `compact` form: the triangle alone, no words. A rail is
 * 224px wide and already carries a colour dot, a label, sometimes a tag and a
 * connection dot, and a two-word chip in that row pushes the label it belongs
 * to into an ellipsis. The label is the thing you are reading; the mark only
 * has to catch the eye, and it says the rest on hover. The Hosts table has the
 * width for the full chip and keeps it.
 */
export function ShellChip({
  capability,
  loginShell,
  pref,
  compact = false,
  className,
}: {
  capability: ShellCapability | null | undefined;
  loginShell: string | null | undefined;
  /** The host's override, so the chip shows what will really happen rather than
   * what the probe would have decided on its own. */
  pref?: ShellIntegrationPref | null;
  /** Icon only, with the label moved to the hover tooltip. For rails. */
  compact?: boolean;
  className?: string;
}) {
  const hint = useHint();
  // The wording (including the fact that under an explicit "never" the shell's
  // name is not the reason, the setting is) is shared with the terminal pane's
  // strip, so the two cannot drift.
  const notice = shellNotice(capability, pref, loginShell);
  if (!notice) return null;
  const { label, message } = notice;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/20 font-medium text-amber-700 dark:text-amber-300",
        compact ? "p-0.5" : "px-1.5 py-0.5 text-[10px]",
        className,
      )}
      // The short label near the pointer as well as the long one in the status
      // bar: compact has nothing else to say what it is, and the two are read at
      // different moments (what is this? / what does it cost me?).
      title={compact ? label : undefined}
      aria-label={compact ? label : undefined}
      {...hint(message)}
    >
      <TriangleAlertIcon className={compact ? "h-3 w-3" : "h-2.5 w-2.5"} />
      {!compact && label}
    </span>
  );
}
