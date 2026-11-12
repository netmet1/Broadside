/**
 * Workspace snapshots, on the App side: taking one from what is open, and
 * opening one again (prompts135).
 *
 * A snapshot is every workspace with tabs in it, each as a template would hold
 * it (its tabs as references, in tab order) plus its name, colour and grid
 * sizes. Opening one makes those workspaces again through the same path a
 * template takes, so there is still one way to open a session.
 *
 * **The hold.** A snapshot can be a lot of workspaces, and opening it would be
 * every login in all of them in the same second. So past a few workspaces
 * (Settings > Sessions, default two) every session is made without
 * connecting, and each workspace shows one Connect button over its grid
 * instead (see TerminalsPage). Nothing connects until somebody presses it,
 * one workspace at a time. Settings can switch the hold off, behind a warning.
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import { snapshotHolds } from "@/lib/sessionPrefs";
import {
  createSnapshot,
  updateSnapshot,
  type Snapshot,
  type SnapshotInput,
  type SnapshotWorkspace,
} from "@/lib/tauri/snapshots";
import {
  planTemplateLaunch,
  termSessionsFor,
  type LaunchPlan,
} from "@/pages/templates/launch";
import type { GridSizes } from "@/lib/gridShape";
import {
  layoutFromSizes,
  sessionTemplateItem,
  sizesFromLayout,
} from "@/pages/terminals/gridTemplate";
import type { TermSession } from "@/pages/terminals/session";
import type { Workspace, WorkspaceExtras } from "@/pages/terminals/useWorkspaces";

/** A snapshot about to open over tabs that are already there: the question
 * of whether to add to them or replace them is up. */
export type PendingSnapshot = {
  snapshot: Snapshot;
  plans: LaunchPlan[];
  /** Tabs open now, which Replace would close. */
  openTabs: number;
};

export function useSnapshots({
  sessions,
  setSessions,
  setActiveSessionId,
  showTerminals,
  nextSeq,
  workspaces,
  activeWorkspaceId,
  createWorkspace,
  adoptIfBlank,
  setWorkspaceSizes,
}: {
  sessions: TermSession[];
  setSessions: React.Dispatch<React.SetStateAction<TermSession[]>>;
  setActiveSessionId: (id: string | null) => void;
  showTerminals: () => void;
  nextSeq: () => number;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  createWorkspace: (name?: string, color?: string, extras?: WorkspaceExtras) => string;
  adoptIfBlank: (name: string, color: string, extras?: WorkspaceExtras) => string | null;
  setWorkspaceSizes: (id: string, sizes: GridSizes | null) => void;
}) {
  /** What is open, as a snapshot: every workspace with a tab a snapshot can
   * hold, and how many tabs it could not (a serial console names a port on
   * this machine at a line speed, as with templates). Null with nothing to
   * keep. */
  const fromOpen = useCallback((): {
    data: Omit<SnapshotInput, "name">;
    skipped: number;
  } | null => {
    let skipped = 0;
    let active = 0;
    const kept: SnapshotWorkspace[] = [];
    for (const w of workspaces) {
      const tabs = sessions.filter((s) => s.workspaceId === w.id);
      const saved = tabs.flatMap((s) => {
        const item = sessionTemplateItem(s);
        return item ? [{ id: s.id, item }] : [];
      });
      skipped += tabs.length - saved.length;
      if (saved.length === 0) continue;
      if (w.id === activeWorkspaceId) active = kept.length;
      kept.push({
        name: w.name,
        color: w.color,
        named: w.named,
        layout: layoutFromSizes(w.sizes, saved.map((t) => t.id)),
        view: w.view,
        items: saved.map((t) => t.item),
      });
    }
    if (kept.length === 0) return null;
    return { data: { active, workspaces: kept }, skipped };
  }, [sessions, workspaces, activeWorkspaceId]);

  const skippedNote = (n: number) =>
    n === 0
      ? ""
      : ` ${n} serial ${n === 1 ? "console was" : "consoles were"} left out.`;

  /** Save what is open as a new snapshot. Resolves to whether it was saved. */
  const saveNew = useCallback(
    async (name: string): Promise<boolean> => {
      const open = fromOpen();
      if (!open) {
        toast.error("Nothing open that a snapshot can hold.");
        return false;
      }
      try {
        const s = await createSnapshot({ name, ...open.data });
        toast.success(
          `Saved snapshot "${s.name}": ${s.workspaces.length} ${
            s.workspaces.length === 1 ? "workspace" : "workspaces"
          }.${skippedNote(open.skipped)}`,
        );
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
    },
    [fromOpen],
  );

  /** Take an existing snapshot again from what is open now. */
  const retake = useCallback(
    async (s: Snapshot): Promise<boolean> => {
      const open = fromOpen();
      if (!open) {
        toast.error("Nothing open that a snapshot can hold.");
        return false;
      }
      try {
        const u = await updateSnapshot(s.id, { name: s.name, ...open.data });
        toast.success(`Updated "${u.name}" from the open workspaces.${skippedNote(open.skipped)}`);
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
    },
    [fromOpen],
  );

  /** Make the snapshot's workspaces. `replace` closes every open tab in the
   * same update, so the old workspaces empty and go as the new ones arrive. */
  const launch = useCallback(
    (snapshot: Snapshot, plans: LaunchPlan[], replace: boolean) => {
      const opening = snapshot.workspaces.filter(
        (_, i) => (plans[i]?.sessions.length ?? 0) > 0,
      ).length;
      const held = snapshotHolds(opening);
      const made: TermSession[] = [];
      let landing: string | null = null;
      let usedBlank = replace;
      snapshot.workspaces.forEach((w, i) => {
        const plan = plans[i];
        if (!plan || plan.sessions.length === 0) return;
        const extras = { held, view: w.view };
        let id: string | null = null;
        if (!usedBlank) {
          // An empty, unnamed workspace on screen takes the first one, as it
          // does a template, rather than being left behind empty.
          id = adoptIfBlank(w.name, w.color, extras);
          usedBlank = true;
        }
        id ??= createWorkspace(w.name, w.color, extras);
        const tabs = termSessionsFor(plan.sessions, id, !held, nextSeq);
        if (w.layout) {
          setWorkspaceSizes(
            id,
            sizesFromLayout(
              w.layout,
              tabs.map((t) => t.id),
              plan.skipped.length === 0,
            ),
          );
        }
        if (i === snapshot.active || landing === null) landing = tabs[0]!.id;
        made.push(...tabs);
      });
      if (made.length === 0) return;
      setSessions((prev) => (replace ? made : [...prev, ...made]));
      setActiveSessionId(landing);
      showTerminals();
      const skipped = plans.reduce((n, p) => n + p.skipped.length, 0);
      if (skipped > 0) {
        // Why, and not only how many: three PowerShell tabs on a Mac without
        // pwsh are one reason, said once, and an operator told only "3
        // sessions" is left to work out which three. Two reasons at most, so
        // a toast stays a toast.
        const reasons = [...new Set(plans.flatMap((p) => p.skipped))];
        const said = reasons.slice(0, 2).join(" ");
        const more = reasons.length > 2 ? ` (and ${reasons.length - 2} more)` : "";
        toast.warning(
          `${skipped} ${skipped === 1 ? "session" : "sessions"} in "${snapshot.name}" could not open. ${said}${more}`,
        );
      }
    },
    [
      adoptIfBlank,
      createWorkspace,
      setWorkspaceSizes,
      nextSeq,
      setSessions,
      setActiveSessionId,
      showTerminals,
    ],
  );

  const [pending, setPending] = useState<PendingSnapshot | null>(null);

  /** Open a snapshot. With tabs already open it asks first: add these
   * workspaces beside them, or close them and open only the snapshot. */
  const open = useCallback(
    (snapshot: Snapshot) => {
      void (async () => {
        try {
          const plans = await Promise.all(
            snapshot.workspaces.map((w) => planTemplateLaunch(w.items)),
          );
          if (plans.every((p) => p.sessions.length === 0)) {
            toast.error(`Nothing in "${snapshot.name}" can open on this machine.`);
            return;
          }
          if (sessions.length > 0) {
            setPending({ snapshot, plans, openTabs: sessions.length });
            return;
          }
          launch(snapshot, plans, false);
        } catch (e) {
          toast.error(errorMessage(e));
        }
      })();
    },
    [sessions.length, launch],
  );

  const resolvePending = useCallback(
    (how: "add" | "replace" | null) => {
      const p = pending;
      setPending(null);
      if (p && how) launch(p.snapshot, p.plans, how === "replace");
    },
    [pending, launch],
  );

  // What a save would hold right now, for the menu, the save dialog and the
  // Library's Update question: the last two warn about serial consoles before
  // anything is written, since a toast after the fact is easy to miss (87-1).
  const now = fromOpen();
  const serialOpen = sessions.filter((s) => sessionTemplateItem(s) === null).length;
  return {
    saveNew,
    retake,
    open,
    pending,
    resolvePending,
    canSave: now !== null,
    savable: {
      workspaces: now?.data.workspaces.length ?? 0,
      tabs: now?.data.workspaces.reduce((n, w) => n + w.items.length, 0) ?? 0,
      serialLeftOut: serialOpen,
    },
  };
}
