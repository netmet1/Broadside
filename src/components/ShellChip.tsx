import { TriangleAlertIcon } from "lucide-react";

import {
  capabilityChipLabel,
  capabilityIsWarning,
  effectiveCapability,
  shellCapabilityMessage,
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
 * Broadcast and Skills pickers — those lists *mark* an unsupported host rather
 * than hiding it, since plain broadcast works perfectly well on fish and a host
 * that silently vanishes from a list is the hardest kind of bug to report.
 */
export function ShellChip({
  capability,
  loginShell,
  pref,
  className,
}: {
  capability: ShellCapability | null | undefined;
  loginShell: string | null | undefined;
  /** The host's override, so the chip shows what will really happen rather than
   * what the probe would have decided on its own. */
  pref?: ShellIntegrationPref | null;
  className?: string;
}) {
  const hint = useHint();
  const effective = effectiveCapability(capability, pref);
  if (!capabilityIsWarning(effective)) return null;
  // `effective` is a warning, so it is not null — narrowed for the helpers.
  const cap = effective as ShellCapability;
  // A name is only worth showing when it is the host's own answer. Under an
  // explicit "never" the name is not the reason, the setting is.
  const named = pref === "never" ? null : loginShell;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300",
        className,
      )}
      {...hint(
        pref === "never"
          ? "Shell integration is set to Never on this host, so nothing is sent to its shell. Command block tracking and skills are unavailable. Change it in the host's settings."
          : shellCapabilityMessage(cap, named),
      )}
    >
      <TriangleAlertIcon className="h-2.5 w-2.5" />
      {pref === "never" ? "no integration" : capabilityChipLabel(cap, named)}
    </span>
  );
}
