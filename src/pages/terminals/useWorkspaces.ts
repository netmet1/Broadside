/**
 * Workspaces: named groups of open terminal tabs. The Terminals tab shows one
 * workspace at a time; the others keep running out of sight.
 *
 * Session-only, on purpose. A workspace is live tabs, and a saved set of tabs
 * already exists: a template. Keeping a workspace past a restart would make it
 * a template under another name, so the way to keep one is Save as template,
 * and the way back is opening that template into a new workspace.
 *
 * The state lives in App beside `sessions`, because every place that opens a
 * tab has to know which workspace it lands in. Each session carries its
 * `workspaceId`; this hook owns the list of workspaces and which one is shown.
 *
 * Three rules hold it together, each applied during App's render (React's way
 * of adjusting state to changed state, guarded so each runs once per change):
 *
 *  - **The shown workspace follows the active tab.** Anything that makes a tab
 *    in another workspace active (the jump-to icon on MultiTerminal or PTY
 *    Broadcast, a template opened into a new workspace) brings its workspace
 *    with it, without having to know workspaces exist.
 *  - **A workspace that loses its last tab goes,** and the next one along is
 *    shown. One just created with nothing in it yet stays until it has had a
 *    tab and lost it, or is closed.
 *  - **There is always one.** The last one is never removed; when it empties
 *    it goes back to being the unnamed default, so the next template opened
 *    into it can give it a name.
 */

import { useCallback, useState } from "react";

import type { GridSizes } from "@/lib/gridShape";
import type { TermSession } from "@/pages/terminals/session";
import {
  loadLastLayout,
  type TermLayout,
} from "@/pages/terminals/useGridLayout";

export type Workspace = {
  id: string;
  name: string;
  /** `#rrggbb`, or empty for none. A template opened into a new workspace
   * passes on its own. */
  color: string;
  /** Named by the operator or by a template. An unnamed workspace takes the
   * name of the first template opened into it while it is empty. */
  named: boolean;
  /** How this workspace's grid shares the pane, dragged with the tiles
   * unlocked or brought by a template. Null shares it equally. Per workspace,
   * because each one is its own wall of tiles. */
  sizes: GridSizes | null;
  /** Opened from a snapshot with its sessions held: they wait, not connected,
   * behind a Connect button over the grid until it is pressed. */
  held: boolean;
  /** Its tabs one at a time, or all of them as a grid. Each workspace has its
   * own, so a wall of tiles can sit beside a workspace worked in one tab at a
   * time. A new workspace starts with the one shown when it was made; the
   * first, at launch, with the last one chosen (see loadLastLayout). */
  view: TermLayout;
};

/** What a new workspace is given beyond its name: whether its sessions are
 * held (see Workspace), and Tabs or Grid when that is not the shown
 * workspace's (a snapshot's). Its grid sizes follow with `setSizes`, once its
 * tabs exist, because they are kept by tab. */
export type WorkspaceExtras = { held?: boolean; view?: TermLayout };

function freshWorkspace(n: number, view: TermLayout): Workspace {
  return {
    id: crypto.randomUUID(),
    name: `Workspace ${n}`,
    color: "",
    named: false,
    sizes: null,
    held: false,
    view,
  };
}

/** The lowest "Workspace N" not already taken, so closing Workspace 2 and
 * making another gives Workspace 2 again rather than counting upwards forever. */
function nextNumber(list: readonly Workspace[]): number {
  const used = new Set(list.map((w) => w.name));
  let n = 1;
  while (used.has(`Workspace ${n}`)) n++;
  return n;
}

/** The tab to select on arriving in a workspace: the one it was left on if
 * that is still there, otherwise its first. */
function landingTab(
  wsId: string,
  list: readonly TermSession[],
  lastTab: ReadonlyMap<string, string>,
): string | null {
  const remembered = lastTab.get(wsId);
  if (
    remembered &&
    list.some((s) => s.id === remembered && s.workspaceId === wsId)
  ) {
    return remembered;
  }
  return list.find((s) => s.workspaceId === wsId)?.id ?? null;
}

function countByWorkspace(sessions: readonly TermSession[]) {
  const m = new Map<string, number>();
  for (const s of sessions) m.set(s.workspaceId, (m.get(s.workspaceId) ?? 0) + 1);
  return m;
}

export function useWorkspaces({
  sessions,
  activeSessionId,
  setActiveSessionId,
}: {
  sessions: TermSession[];
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => [
    freshWorkspace(1, loadLastLayout()),
  ]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(
    () => workspaces[0]!.id,
  );
  // The tab each workspace had selected when it was left, so coming back lands
  // where you were rather than on its first tab.
  const [lastTab, setLastTab] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  // Rule 1: the shown workspace follows the active tab.
  const activeSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : undefined;
  if (activeSession && activeSession.workspaceId !== activeWorkspaceId) {
    if (workspaces.some((w) => w.id === activeSession.workspaceId)) {
      setActiveWorkspaceId(activeSession.workspaceId);
    }
  }

  // Rules 2 and 3: a workspace that has just lost its last tab.
  const [prevSessions, setPrevSessions] = useState(sessions);
  if (prevSessions !== sessions) {
    setPrevSessions(sessions);
    const before = countByWorkspace(prevSessions);
    const now = countByWorkspace(sessions);
    const emptied = new Set(
      workspaces
        .filter((w) => (before.get(w.id) ?? 0) > 0 && (now.get(w.id) ?? 0) === 0)
        .map((w) => w.id),
    );
    if (emptied.size > 0) {
      let next = workspaces.filter((w) => !emptied.has(w.id));
      if (next.length === 0) {
        // Everything has closed. Keep the one that was shown, unnamed again.
        const keep = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0]!;
        next = [
          {
            ...keep,
            name: "Workspace 1",
            color: "",
            named: false,
            sizes: null,
            held: false,
          },
        ];
      }
      setWorkspaces(next);
      if (!next.some((w) => w.id === activeWorkspaceId)) {
        // The shown one went: show its neighbour, the one that slid into its
        // place, or the one before it at the end of the strip.
        const at = workspaces.findIndex((w) => w.id === activeWorkspaceId);
        const target = next[Math.min(Math.max(at, 0), next.length - 1)]!;
        setActiveWorkspaceId(target.id);
        if (activeSession === undefined) {
          setActiveSessionId(landingTab(target.id, sessions, lastTab));
        }
      }
    }
  }

  /** Show another workspace, remembering where this one was left. */
  const switchTo = useCallback(
    (id: string) => {
      if (id === activeWorkspaceId) return;
      if (activeSessionId) {
        setLastTab((m) => new Map(m).set(activeWorkspaceId, activeSessionId));
      }
      setActiveWorkspaceId(id);
      setActiveSessionId(landingTab(id, sessions, lastTab));
    },
    [activeWorkspaceId, activeSessionId, sessions, lastTab, setActiveSessionId],
  );

  /** Make a workspace and return its id. It is not shown; the caller decides
   * (a tab made active in it brings it forward by rule 1). */
  const create = useCallback(
    (name?: string, color?: string, extras?: WorkspaceExtras): string => {
      const view =
        extras?.view ??
        workspaces.find((w) => w.id === activeWorkspaceId)?.view ??
        loadLastLayout();
      const more = { sizes: null, held: extras?.held ?? false, view };
      const ws: Workspace = name
        ? {
            id: crypto.randomUUID(),
            name,
            color: color ?? "",
            named: true,
            ...more,
          }
        : { ...freshWorkspace(nextNumber(workspaces), view), ...more };
      setWorkspaces((prev) => [...prev, ws]);
      return ws.id;
    },
    [workspaces, activeWorkspaceId],
  );

  /** A new, empty workspace, shown at once: what the strip's + and the rail's
   * New workspace do. */
  const createAndShow = useCallback(() => {
    const id = create();
    if (activeSessionId) {
      setLastTab((m) => new Map(m).set(activeWorkspaceId, activeSessionId));
    }
    setActiveWorkspaceId(id);
    setActiveSessionId(null);
  }, [create, activeSessionId, activeWorkspaceId, setActiveSessionId]);

  const rename = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === id ? { ...w, name: trimmed, named: true } : w)),
    );
  }, []);

  const recolor = useCallback((id: string, color: string) => {
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === id ? { ...w, color } : w)),
    );
  }, []);

  /** Set how a workspace's grid shares the pane (null: equally), outright or
   * from what it has now. */
  const setSizes = useCallback(
    (
      id: string,
      sizes: GridSizes | null | ((prev: GridSizes | null) => GridSizes | null),
    ) => {
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id === id
            ? { ...w, sizes: typeof sizes === "function" ? sizes(w.sizes) : sizes }
            : w,
        ),
      );
    },
    [],
  );

  /** Show a workspace's tabs one at a time, or as a grid. */
  const setView = useCallback((id: string, view: TermLayout) => {
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === id && w.view !== view ? { ...w, view } : w)),
    );
  }, []);

  /** A held workspace's Connect was pressed: it is an ordinary one now. */
  const release = useCallback((id: string) => {
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === id && w.held ? { ...w, held: false } : w)),
    );
  }, []);

  /** Move a workspace to where another one is, the way the tab strip reorders
   * tabs: dragged right it lands after the target, dragged left before it. */
  const reorder = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setWorkspaces((prev) => {
      const from = prev.findIndex((w) => w.id === sourceId);
      const to = prev.findIndex((w) => w.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  /** Give the shown workspace a template's name, colour and grid sizes, if it
   * is still the unnamed default and has nothing in it. Called just before the
   * template's tabs land in it. */
  const adoptIfBlank = useCallback(
    (name: string, color: string, extras?: WorkspaceExtras): string | null => {
      const ws = workspaces.find((w) => w.id === activeWorkspaceId);
      if (!ws || ws.named) return null;
      if (sessions.some((s) => s.workspaceId === ws.id)) return null;
      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id === ws.id
            ? {
                ...w,
                name,
                color,
                named: true,
                sizes: null,
                held: extras?.held ?? false,
                view: extras?.view ?? w.view,
              }
            : w,
        ),
      );
      return ws.id;
    },
    [workspaces, activeWorkspaceId, sessions],
  );

  /** Remove a workspace with no tabs in it. One with tabs goes by closing
   * them (rule 2), which is the caller's to do. Never the last one. */
  const removeEmpty = useCallback(
    (id: string) => {
      if (workspaces.length <= 1) return;
      if (sessions.some((s) => s.workspaceId === id)) return;
      const at = workspaces.findIndex((w) => w.id === id);
      const next = workspaces.filter((w) => w.id !== id);
      setWorkspaces(next);
      if (id === activeWorkspaceId) {
        const target = next[Math.min(Math.max(at, 0), next.length - 1)]!;
        setActiveWorkspaceId(target.id);
        setActiveSessionId(landingTab(target.id, sessions, lastTab));
      }
    },
    [workspaces, sessions, activeWorkspaceId, lastTab, setActiveSessionId],
  );

  return {
    workspaces,
    activeWorkspaceId,
    switchTo,
    create,
    createAndShow,
    rename,
    recolor,
    setSizes,
    setView,
    release,
    reorder,
    adoptIfBlank,
    removeEmpty,
  };
}
