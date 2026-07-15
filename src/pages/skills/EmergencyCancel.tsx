import { OctagonXIcon } from "lucide-react";

import { useHint } from "@/lib/status";

/**
 * Emergency stop for a running skill: **double-click** kills the sequence on
 * every host at once.
 *
 * Deliberately not a confirm dialog. This exists for the moment a skill was
 * fired by accident or is visibly going wrong, when the cost of a dialog is
 * measured in whatever the sequence does next. A double-click is one quick
 * gesture but is not something a stray brush of the mouse can trigger — a
 * single click does nothing at all.
 *
 * It is irreversible and abrupt: it closes every PTY mid-step, so a host can be
 * left half-way through an `apt upgrade`. The graceful, per-host controls live
 * on each pane in RunPanel.
 */
export function EmergencyCancel({
  active,
  onCancel,
}: {
  /** Only a live run can be stopped; ghosted otherwise. */
  active: boolean;
  onCancel: () => void;
}) {
  const hint = useHint();
  return (
    <button
      type="button"
      disabled={!active}
      onDoubleClick={onCancel}
      className="flex w-full items-center justify-center gap-2 rounded-md border border-border/60 px-2 py-2 text-xs font-semibold text-muted-foreground transition-colors enabled:hover:border-destructive enabled:hover:bg-destructive enabled:hover:text-destructive-foreground disabled:opacity-40"
      {...hint(
        active
          ? "Emergency stop — double-click to irreversibly kill the running sequence on every host. Only press if a skill was fired by accident or is going wrong. Use the per-host controls for normal stopping."
          : "Emergency stop — available while a skill is running. Double-click kills the sequence on every host.",
      )}
    >
      <OctagonXIcon className="h-4 w-4 shrink-0" />
      Emergency stop
    </button>
  );
}
