import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AppShell, type Page } from "@/components/AppShell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { isExitGuardEnabled } from "@/lib/exitGuard";
import {
  KEEPALIVE_SECS,
  SESSION_PREFS_EVENT,
  loadSessionPrefs,
} from "@/lib/sessionPrefs";
import { setSshKeepalive } from "@/lib/tauri/settings";
import { rememberHostsSide } from "@/lib/hostsSide";
import { loadStartPage } from "@/lib/startPage";
import { HostsPage } from "@/pages/HostsPage";
import { TemplatesPage, type TemplateFocus } from "@/pages/TemplatesPage";
import {
  planTemplateLaunch,
  type LaunchPlan,
  type LaunchSession,
} from "@/pages/templates/launch";
import {
  BUSY_TEMPLATE_ITEMS,
  startupTemplate,
  type Template,
  type TemplateItem,
} from "@/lib/tauri/templates";
import type { HelpSectionId } from "@/pages/help/sections";
import { BroadcastPage } from "@/pages/BroadcastPage";
import { TerminalsPage } from "@/pages/TerminalsPage";
import { useWorkspaces } from "@/pages/terminals/useWorkspaces";
import { cn } from "@/lib/utils";
import {
  sessionLabel,
  type TermSession,
  type SshTermSession,
  type LocalShellOpenOpts,
} from "@/pages/terminals/session";
import { listLocalShells, type LocalShell } from "@/lib/tauri/local";
import {
  missingShellNote,
  type ShellProfile,
} from "@/lib/localShellProfiles";
import { PtyBroadcastPage } from "@/pages/PtyBroadcastPage";
import { MultiTerminalPage } from "@/pages/MultiTerminalPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { SftpPage } from "@/pages/SftpPage";
import { LogsPage } from "@/pages/LogsPage";
// Settings (~2k lines) and Help (static docs) mount only when their tab is
// active, so they are code-split into their own chunks to shrink the initial
// bundle the app parses on launch (perf: slow cold start in the packaged exe).
const SettingsPage = lazy(() =>
  import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const HelpPage = lazy(() =>
  import("@/pages/HelpPage").then((m) => ({ default: m.HelpPage })),
);
import { UnlockDialog } from "@/components/UnlockDialog";
import { SettingsLoading } from "@/components/SettingsLoading";
import { Toaster } from "@/components/ui/sonner";
import { ToastRecorder } from "@/components/ToastRecorder";
import { StatusProvider } from "@/components/StatusProvider";
import { ActivityProvider } from "@/components/ActivityProvider";
import { UiPrefsProvider } from "@/components/UiPrefsProvider";
import {
  type Host,
  errorMessage,
  isCredentialsUnlocked,
  requiresMasterPassword,
} from "@/lib/tauri/hosts";
import { onPtySudo, onPtySudoRejected } from "@/lib/tauri/pty";
import { useWindowBlurredAttr } from "@/lib/windowFocus";

function App() {
  // Let the stylesheet know when the window is not the one taking keys, so the
  // app stops looking alive while it is asleep. Nothing else here reads it.
  useWindowBlurredAttr();

  // The tab Broadside opens on, from Settings > Startup (Hosts by default). A
  // template set to open at startup still takes over below, and lands on
  // Terminals once it has resolved.
  const [page, setPage] = useState<Page>(loadStartPage);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [sessions, setSessions] = useState<TermSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Monotonic creation counter: stamps each new tab with a stable `seq` so the
  // duplicate suffix and pane order survive drag-reordering. Never resets.
  const seqRef = useRef(0);
  const nextSeq = useCallback(() => seqRef.current++, []);
  // Which workspace each new tab lands in, and which one the Terminals tab
  // shows. See pages/terminals/useWorkspaces.
  const ws = useWorkspaces({ sessions, activeSessionId, setActiveSessionId });
  const {
    activeWorkspaceId,
    create: createWorkspace,
    adoptIfBlank,
    removeEmpty: removeEmptyWorkspace,
  } = ws;
  // Session ids with a live PTY connection (drives Hosts connected dots).
  const [connectedSessions, setConnectedSessions] = useState<Set<string>>(
    new Set(),
  );
  // Set when "Manage shortcuts…" is picked, Settings scrolls there on open.
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  // Which help section a link on another tab asked for. One-shot: consumed by
  // the Help page on the mount it causes, then cleared.
  const [helpFocus, setHelpFocus] = useState<HelpSectionId | null>(null);
  // Which template the Templates tab should load, from Add or Edit on the Hosts
  // tab. Carries a serial rather than being cleared, so pressing Edit on the
  // same row twice opens it twice.
  const [templateFocus, setTemplateFocus] = useState<TemplateFocus | null>(null);
  // Latch: once Settings has been opened it stays mounted (hidden) like the
  // other heavy pages, so re-visiting it doesn't pay the ~5s cost of remounting
  // its large Radix tree every time. The lazy chunk still loads only on first
  // open (kept out of the startup payload); after that the page persists.
  const [settingsMounted, setSettingsMounted] = useState(false);
  // True once Settings has mounted AND loaded its data, drives whether we show
  // the branded loader over the tab. Pre-warming (below) usually flips this
  // before the user ever clicks Settings, so the loader is rarely seen.
  const [settingsReady, setSettingsReady] = useState(false);
  const handleSettingsReady = useCallback(() => setSettingsReady(true), []);
  // Maximized terminal: the id of the session filling the whole window (null =
  // normal view). Tracking the id (not a bool) lets us drop back to the tabbed
  // view automatically when that terminal is closed. It follows the active
  // session while maximized (see the effect below), so it is always the id of
  // what is actually on screen rather than the id you maximized.
  const [maxSessionId, setMaxSessionId] = useState<string | null>(null);
  const maximized = maxSessionId !== null;
  // The Terminals grid filling the screen. A separate mode from maximizing one
  // terminal, and mutually exclusive with it: entering either clears the other.
  // Lives here because it hides AppShell's chrome, but it is driven from
  // TerminalsPage, which is where the grid layout is known.
  const [gridFullscreen, setGridFullscreen] = useState(false);

  // Exit guard (opt-in, on by default): warn before the window closes while any
  // terminal is still connected, so a stray Alt+F4 doesn't drop live sessions.
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  // The close handler is registered once but must see the live connection set
  // and toggle state, so both are read through refs the effects keep current.
  const connectedRef = useRef<Set<string>>(connectedSessions);
  useEffect(() => {
    connectedRef.current = connectedSessions;
  }, [connectedSessions]);
  // Latched true once the user confirms the quit, so our own destroy() isn't
  // re-intercepted by the guard.
  const closingRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const needsMaster = await requiresMasterPassword();
        if (!needsMaster) return;
        const unlocked = await isCredentialsUnlocked();
        if (!unlocked) setUnlockOpen(true);
      } catch {
        // App still works without unlock; the user just can't set credentials
        // until they try and get prompted.
      }
    })();
  }, []);

  // Sudo auto-fill transparency (D-065): toast whenever the backend answers a
  // sudo prompt with a stored password, on any tab.
  useEffect(() => {
    const unlisten = onPtySudo((p) =>
      toast.info(`Auto-filled sudo password for ${p.host_label}`),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // The auto-filled password bounced (sudo said "Sorry, try again."), warn so
  // the operator fixes the stored sudo password (D-065, 11.3). Auto-fill has
  // already stopped itself; the prompt is now the operator's to answer.
  useEffect(() => {
    const unlisten = onPtySudoRejected((p) =>
      toast.warning(
        `Possible wrong sudo password for ${p.host_label}. Auto-fill stopped; enter it manually`,
      ),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const openTerminal = useCallback((host: Host) => {
    const session: TermSession = {
      id: crypto.randomUUID(),
      type: "ssh",
      seq: nextSeq(),
      workspaceId: activeWorkspaceId,
      host,
    };
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
    setPage("terminals");
  }, [nextSeq, activeWorkspaceId]);

  /** Adopt a skill run's live shell as a terminal tab. The tab reuses the
   * backend session id as its own, so the very shell the skill was driving (its
   * root state, cwd and scrollback) carries over; TerminalView skips pty_open
   * for an adopted session. `snapshot` is the skill pane's scrollback as an ANSI
   * string, seeded into the new terminal so the run's history is visible. */
  const adoptTerminal = useCallback(
    (sessionId: string, host: Host, snapshot: string | null) => {
      const session: TermSession = {
        id: sessionId,
        type: "ssh",
        seq: nextSeq(),
        workspaceId: activeWorkspaceId,
        host,
        adopted: true,
        adoptSnapshot: snapshot ?? undefined,
      };
      setSessions((prev) =>
        prev.some((s) => s.id === sessionId) ? prev : [...prev, session],
      );
      setActiveSessionId(sessionId);
      setPage("terminals");
    },
    [nextSeq, activeWorkspaceId],
  );

  /** Open a terminal tab for every host at once (Hosts multi-select). */
  const openTerminals = useCallback((hostsToOpen: Host[]) => {
    if (hostsToOpen.length === 0) return;
    const newSessions: TermSession[] = hostsToOpen.map((host) => ({
      id: crypto.randomUUID(),
      type: "ssh" as const,
      seq: nextSeq(),
      workspaceId: activeWorkspaceId,
      host,
    }));
    setSessions((prev) => [...prev, ...newSessions]);
    setActiveSessionId(newSessions[0].id);
    setPage("terminals");
  }, [nextSeq, activeWorkspaceId]);

  /** A second tab on whatever this one is on: another session to the same host,
   * or another copy of the same local shell.
   *
   * Lands directly after the tab it came from rather than at the end of the
   * strip, because it is a copy of that one and the pair wants reading together.
   *
   * Three things are deliberately not carried over. A rename, because two tabs
   * called the same thing with no number between them is the confusion this is
   * most likely to cause, and the duplicate falling back to its derived label
   * picks up the " 02" suffix that tells them apart. And `adopted` /
   * `adoptSnapshot`, because those say "this tab took over a PTY a skill run had
   * already opened": there is exactly one of that PTY, and a copy of a tab is a
   * new shell, not a second claim on the same one. */
  const duplicateSession = useCallback(
    (id: string) => {
      const from = sessions.find((s) => s.id === id);
      if (!from) return;
      // Built out here, not inside the updater: `nextSeq` bumps a ref and
      // `setActiveSessionId` is a second write, and an updater that does either
      // is not a pure function of its argument. React is entitled to call it
      // twice, and in development it does.
      const copy: TermSession =
        from.type === "ssh"
          ? {
              id: crypto.randomUUID(),
              type: "ssh",
              seq: nextSeq(),
              workspaceId: from.workspaceId,
              host: from.host,
            }
          : {
              id: crypto.randomUUID(),
              type: "local",
              seq: nextSeq(),
              workspaceId: from.workspaceId,
              shell: from.shell,
              cwd: from.cwd,
              startupCommand: from.startupCommand,
              profileLabel: from.profileLabel,
              profileId: from.profileId,
              profileColor: from.profileColor,
            };
      setSessions((prev) => {
        const at = prev.findIndex((s) => s.id === id);
        if (at === -1) return prev;
        return [...prev.slice(0, at + 1), copy, ...prev.slice(at + 1)];
      });
      setActiveSessionId(copy.id);
    },
    [sessions, nextSeq],
  );

  /** Open a local shell (PowerShell / pwsh / Command Prompt / WSL) as a tab.
   * `opts` carries a saved profile's cwd / startup command / name when the open
   * came from a profile; absent for a plain shell pick. */
  const openLocalShell = useCallback(
    (shell: LocalShell, opts?: LocalShellOpenOpts) => {
      const session: TermSession = {
        id: crypto.randomUUID(),
        type: "local",
        seq: nextSeq(),
        workspaceId: activeWorkspaceId,
        shell,
        cwd: opts?.cwd,
        startupCommand: opts?.startupCommand,
        profileLabel: opts?.profileLabel,
        profileId: opts?.profileId,
        profileColor: opts?.profileColor,
      };
      setSessions((prev) => [...prev, session]);
      setActiveSessionId(session.id);
      setPage("terminals");
    },
    [nextSeq, activeWorkspaceId],
  );

  const handleConnectionChange = useCallback(
    (sessionId: string, connected: boolean) => {
      setConnectedSessions((prev) => {
        if (prev.has(sessionId) === connected) return prev;
        const next = new Set(prev);
        if (connected) {
          next.add(sessionId);
        } else {
          next.delete(sessionId);
        }
        return next;
      });
    },
    [],
  );

  /** Drag-to-reorder terminal tabs: move the dragged session so it lands in
   * front of the drop target, preserving every other tab's relative order. */
  const reorderSessions = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setSessions((prev) => {
      const from = prev.findIndex((s) => s.id === sourceId);
      const to = prev.findIndex((s) => s.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  /** Rename a local shell tab. Session-lifetime only, deliberately: session ids
   * are fresh UUIDs every run, so a persisted name would have nothing to
   * reattach to. An empty title clears the override and the tab falls back to
   * its profile or shell name. */
  const renameSession = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id && s.type === "local"
          ? { ...s, title: trimmed || undefined }
          : s,
      ),
    );
  }, []);

  const closeSession = useCallback((id: string) => {
    setSessions((prev) => {
      const closing = prev.find((s) => s.id === id);
      const next = prev.filter((s) => s.id !== id);
      setActiveSessionId((current) => {
        if (current !== id || !closing) return current;
        // The neighbour in the same workspace: the next one along has slid into
        // this one's place. None left means the workspace has emptied, and
        // useWorkspaces moves on to the next one.
        const before = prev.filter((s) => s.workspaceId === closing.workspaceId);
        const after = next.filter((s) => s.workspaceId === closing.workspaceId);
        if (after.length === 0) return null;
        const idx = before.findIndex((s) => s.id === id);
        return after[Math.min(idx, after.length - 1)].id;
      });
      return next;
    });
  }, []);

  /** Terminate every live terminal session for a host (from the Hosts tab).
   * Removing the sessions unmounts their TerminalViews, whose cleanup calls
   * ptyClose: the same teardown path as closing a tab. */
  const terminateHost = useCallback((hostId: number) => {
    setSessions((prev) => {
      const next = prev.filter(
        (s) => !(s.type === "ssh" && s.host.id === hostId),
      );
      if (next.length === prev.length) return prev;
      setActiveSessionId((current) => {
        if (current && !next.some((s) => s.id === current)) {
          // The last one left in the workspace the closed tab was in.
          const was = prev.find((s) => s.id === current)?.workspaceId;
          const same = next.filter((s) => s.workspaceId === was);
          return same.length ? same[same.length - 1].id : null;
        }
        return current;
      });
      return next;
    });
  }, []);

  /** Close every open terminal session at once. Clearing the list unmounts the
   * TerminalViews, whose cleanup calls ptyClose (same teardown as closing each
   * tab). Used by MultiTerminal's "Close all terminals" rail button. */
  const closeAllTerminals = useCallback(() => {
    setSessions((prev) => {
      if (prev.length === 0) return prev;
      setActiveSessionId(null);
      setMaxSessionId(null);
      return [];
    });
  }, []);

  /** Jump straight to a known session id: switch to the Terminals page and
   * select it. What the go-to-terminal icon on every selection rail does
   * (MultiTerminal, PTY Broadcast on all five of its tabs).
   *
   * By session and never by host, which the rails used to do: a rail row *is*
   * one open terminal, two rows can be the same machine, and jumping by host
   * sent both of them to whichever session happened to be first. A no-op if
   * the tab has since closed. */
  const jumpToSession = useCallback(
    (sessionId: string) => {
      if (!sessions.some((s) => s.id === sessionId)) return;
      setActiveSessionId(sessionId);
      setMaxSessionId(null);
      setPage("terminals");
    },
    [sessions],
  );

  /* ------------------------------------------------------------------ *
   * Templates. A template is a list of references; opening one resolves
   * them now (lib/templateLaunch) and then goes through exactly the same
   * session-making path as the Hosts tab and the "+" launcher. There is
   * one way to open a terminal in this application, and a template is not
   * a second one.
   * ------------------------------------------------------------------ */

  /** Turn a resolved plan into tabs. `connect` false makes every pane mount
   * onto its Reconnect button instead of opening a shell, which is what a
   * template set to "open the tabs at startup" asks for.
   *
   * `place` is the front or end of the workspace on screen, or a new workspace
   * named after `from` (the template). Opened into the shown workspace while
   * that is still the empty, unnamed default, the workspace takes the
   * template's name and colour, so the strip says what it holds once there are
   * more. */
  const launchTemplate = useCallback(
    (
      sessions: LaunchSession[],
      place: "front" | "end" | "new",
      connect: boolean,
      from?: { name: string; color: string },
    ) => {
      if (sessions.length === 0) return;
      let workspaceId = activeWorkspaceId;
      if (place === "new") {
        workspaceId = createWorkspace(from?.name, from?.color);
      } else if (from) {
        adoptIfBlank(from.name, from.color);
      }
      const made: TermSession[] = sessions.map((s) =>
        s.type === "ssh"
          ? {
              id: crypto.randomUUID(),
              type: "ssh" as const,
              seq: nextSeq(),
              workspaceId,
              host: s.host,
              startClosed: !connect,
            }
          : {
              id: crypto.randomUUID(),
              type: "local" as const,
              seq: nextSeq(),
              workspaceId,
              shell: s.shell,
              cwd: s.opts.cwd,
              startupCommand: s.opts.startupCommand,
              profileLabel: s.opts.profileLabel,
              profileId: s.opts.profileId,
              profileColor: s.opts.profileColor,
              startClosed: !connect,
            },
      );
      setSessions((prev) =>
        place === "front" ? [...made, ...prev] : [...prev, ...made],
      );
      // In a new workspace, this is also what brings it on screen.
      setActiveSessionId(made[0].id);
      setPage("terminals");
    },
    [nextSeq, activeWorkspaceId, createWorkspace, adoptIfBlank],
  );

  /** Several templates' sessions, one after another, each into a workspace of
   * its own: the dialog's New workspace with more than one template. */
  const launchIntoWorkspaces = useCallback(
    (
      templates: { template: Template; count: number }[],
      sessions: LaunchSession[],
    ) => {
      let at = 0;
      for (const { template, count } of templates) {
        const slice = sessions.slice(at, at + count);
        at += count;
        launchTemplate(slice, "new", true, template);
      }
    },
    [launchTemplate],
  );

  /** Move a tab to another workspace, or to a new one (`null`). The workspace
   * on screen stays on screen: the tab leaves it, and if it was the selected
   * one its neighbour takes over. */
  const moveToWorkspace = useCallback(
    (id: string, target: string | null) => {
      const moving = sessions.find((s) => s.id === id);
      if (!moving) return;
      const to = target ?? createWorkspace();
      if (to === moving.workspaceId) return;
      if (activeSessionId === id) {
        const same = sessions.filter(
          (s) => s.workspaceId === moving.workspaceId,
        );
        const idx = same.findIndex((s) => s.id === id);
        const rest = same.filter((s) => s.id !== id);
        setActiveSessionId(
          rest.length ? rest[Math.min(idx, rest.length - 1)].id : null,
        );
      }
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, workspaceId: to } : s)),
      );
    },
    [sessions, activeSessionId, createWorkspace],
  );

  /** How many tabs the workspace on screen holds, for the open-template
   * dialog: with none, front and end are the same place. */
  const activeWorkspaceCount = sessions.filter(
    (s) => s.workspaceId === activeWorkspaceId,
  ).length;
  const activeWorkspace = ws.workspaces.find(
    (w) => w.id === activeWorkspaceId,
  );


  /** Close a workspace: every tab in it, then the workspace itself, which
   * useWorkspaces removes once it is empty. Closing a tab is what ends its
   * shell, as everywhere else. */
  const closeWorkspace = useCallback(
    (id: string) => {
      if (!sessions.some((s) => s.workspaceId === id)) {
        removeEmptyWorkspace(id);
        return;
      }
      if (
        sessions.some((s) => s.id === activeSessionId && s.workspaceId === id)
      ) {
        setActiveSessionId(null);
      }
      setSessions((prev) => prev.filter((s) => s.workspaceId !== id));
    },
    [sessions, activeSessionId, removeEmptyWorkspace],
  );

  /**
   * Open saved profiles as local shell tabs: one from its row on the Hosts
   * tab's Profiles side, or every one ticked there.
   *
   * The shells are read here and now rather than taken from the list the page
   * is holding, for the same reason a template resolves its references at
   * launch: a WSL distro can be uninstalled between the table being drawn and
   * the button being pressed, and the answer that matters is the one at the
   * moment of opening.
   *
   * A profile whose shell has gone is reported and the others still open, which
   * is what a template launch does with an item it cannot resolve. Nothing asks
   * first when the same profile is already open, unlike opening a host twice:
   * two shells in one folder is an ordinary way to work, and the "+" launcher
   * has never asked either.
   */
  const openProfiles = useCallback(
    (picked: ShellProfile[]) => {
      if (picked.length === 0) return;
      void (async () => {
        try {
          const shells = await listLocalShells();
          const byId = new Map(shells.map((s) => [s.id, s] as const));
          const ready: LaunchSession[] = [];
          const missing: string[] = [];
          for (const p of picked) {
            const shell = byId.get(p.shellId);
            if (!shell) {
              // The advice only fits when this is the whole message, which is
              // the single-profile case.
              missing.push(missingShellNote(p, picked.length === 1));
              continue;
            }
            ready.push({
              type: "local",
              shell,
              opts: {
                cwd: p.cwd || undefined,
                startupCommand: p.startupCommand || undefined,
                profileLabel: p.label,
                profileId: p.id,
                profileColor: p.color || undefined,
              },
            });
          }
          // The same path a template and the "+" launcher take. There is one
          // way to open a terminal in this application.
          if (ready.length > 0) launchTemplate(ready, "end", true);
          if (missing.length === 1) {
            toast.error(missing[0]);
          } else if (missing.length > 1) {
            toast.error(
              `${missing.length} of these ${picked.length} profiles could not open: the shells they name are not on this machine.`,
            );
          }
        } catch (e) {
          toast.error(errorMessage(e));
        }
      })();
    },
    [launchTemplate],
  );

  /** A launch waiting on the operator: either because terminals are already
   * open and the arrangement will not match, or because there is something
   * about this one worth reading before it happens. */
  const [pendingLaunch, setPendingLaunch] = useState<{
    /** What is opening, in order, with how many sessions each can open here.
     * One for a single template; several from Multi-template. */
    templates: { template: Template; count: number }[];
    /** Every template's sessions, one template after another. */
    plan: LaunchPlan;
    /** Something is already open, so the three-way placement question applies. */
    placement: boolean;
  } | null>(null);

  const openTemplate = useCallback(
    (template: Template) => {
      void (async () => {
        try {
          const plan = await planTemplateLaunch(template.items);
          if (plan.sessions.length === 0) {
            toast.error(
              plan.skipped.length > 0
                ? `Nothing in "${template.name}" can open on this machine.`
                : `"${template.name}" has no sessions in it yet.`,
            );
            return;
          }
          const placement = sessions.length > 0;
          // Straight through when there is nothing to say: no terminals open,
          // everything resolved, and not a wall of them. Anything else is worth
          // one dialog, and only one.
          if (
            !placement &&
            plan.skipped.length === 0 &&
            plan.sessions.length <= BUSY_TEMPLATE_ITEMS
          ) {
            launchTemplate(plan.sessions, "end", true, template);
            return;
          }
          setPendingLaunch({
            templates: [{ template, count: plan.sessions.length }],
            plan,
            placement,
          });
        } catch (e) {
          toast.error(errorMessage(e));
        }
      })();
    },
    [sessions.length, launchTemplate],
  );

  /** Several templates at once (Multi-template on the Hosts tab), one after
   * another in the order given, which is the list's. One goes straight to
   * {@link openTemplate}. Two or more always ask first: the dialog lists the
   * order they will open in, which is the thing worth checking before a wall
   * of sessions arrives. A session that cannot open is named with the template
   * it came from. */
  const openTemplates = useCallback(
    (picked: Template[]) => {
      if (picked.length === 0) return;
      if (picked.length === 1) {
        openTemplate(picked[0]);
        return;
      }
      void (async () => {
        try {
          const plans = await Promise.all(
            picked.map((t) => planTemplateLaunch(t.items)),
          );
          const all = plans.flatMap((p) => p.sessions);
          if (all.length === 0) {
            toast.error(
              `Nothing in these ${picked.length} templates can open on this machine.`,
            );
            return;
          }
          setPendingLaunch({
            templates: picked.map((t, i) => ({
              template: t,
              count: plans[i].sessions.length,
            })),
            plan: {
              sessions: all,
              skipped: plans.flatMap((p, i) =>
                p.skipped.map((line) => `${picked[i].name}: ${line}`),
              ),
            },
            placement: sessions.length > 0,
          });
        } catch (e) {
          toast.error(errorMessage(e));
        }
      })();
    },
    [openTemplate, sessions.length],
  );

  /** The Terminals tab's Save as template: a new template holding the grid on
   * screen, opened in the editor to be named and saved. */
  const saveGridAsTemplate = useCallback((items: TemplateItem[]) => {
    setTemplateFocus((f) => ({ template: null, items, n: (f?.n ?? 0) + 1 }));
    setPage("templates");
  }, []);

  const editTemplate = useCallback((template: Template | null) => {
    setTemplateFocus((f) => ({ template, n: (f?.n ?? 0) + 1 }));
    setPage("templates");
  }, []);

  /** The Terminals launcher's Duplicate: an unsaved copy in the editor, to be
   * changed and then saved. Nothing is written until it is. */
  const duplicateTemplate = useCallback((template: Template) => {
    setTemplateFocus((f) => ({
      template: null,
      copyOf: template,
      n: (f?.n ?? 0) + 1,
    }));
    setPage("templates");
  }, []);

  const openHelpAt = useCallback((section: HelpSectionId) => {
    setHelpFocus(section);
    setPage("help");
  }, []);
  // The request is a one-shot. Cleared as soon as the Help page has taken it,
  // so coming back to the tab later lands where the reader left off rather
  // than jumping to a section they read last week.
  const clearHelpFocus = useCallback(() => setHelpFocus(null), []);

  const openGridSettings = useCallback(() => {
    setSettingsFocus("Grid");
    setPage("settings");
  }, []);

  // "Show all templates", from the Templates splash. The list of them lives on
  // the Hosts tab beside the list of machines, and that page is rebuilt on each
  // visit, so setting which side it opens on is all this takes.
  const browseTemplates = useCallback(() => {
    rememberHostsSide("templates");
    setPage("hosts");
  }, []);

  // New, on the Hosts section of the Terminals "+" menu: the Hosts tab on its
  // Hosts side, with the new-host form open. A one-shot like the Help focus,
  // cleared as soon as the page has taken it, so a later visit is a plain one.
  const [newHostRequested, setNewHostRequested] = useState(false);
  const openNewHost = useCallback(() => {
    rememberHostsSide("hosts");
    setNewHostRequested(true);
    setPage("hosts");
  }, []);
  const clearNewHostRequest = useCallback(() => setNewHostRequested(false), []);

  // The one template that opens itself. Read once, at launch, and acted on
  // before anything is on screen: `launch` makes the tabs and stops, `connect`
  // goes on to open the shells.
  //
  // Latched, because "once per run" is the whole contract and an effect is not
  // that on its own: StrictMode runs setup, cleanup and setup again on the same
  // instance in development, and a template that opens twice is twelve tabs
  // instead of six. The ref survives that, which `alive` alone does not.
  const startupDone = useRef(false);
  useEffect(() => {
    if (startupDone.current) return;
    startupDone.current = true;
    let alive = true;
    startupTemplate()
      .then(async (t) => {
        if (!alive || !t || t.startup === "off") return null;
        const plan = await planTemplateLaunch(t.items);
        return alive ? { t, plan } : null;
      })
      .then((ready) => {
        if (!ready || ready.plan.sessions.length === 0) return;
        launchTemplate(
          ready.plan.sessions,
          "end",
          ready.t.startup === "connect",
          ready.t,
        );
        if (ready.plan.skipped.length > 0) {
          toast.warning(
            `"${ready.t.name}" opened ${ready.plan.sessions.length} of ${
              ready.t.items.length
            } sessions. ${ready.plan.skipped[0]}`,
          );
        }
      })
      .catch(() => {
        // A template that will not open must never stop the application
        // starting. The tab is still there to look at.
      });
    return () => {
      alive = false;
    };
  }, [launchTemplate]);

  const openShortcutSettings = useCallback(() => {
    setSettingsFocus("shortcuts");
    setPage("settings");
  }, []);

  /** What the amber line on an idle-closed pane links to. */
  const openSessionSettings = useCallback(() => {
    setSettingsFocus("sessions");
    setPage("settings");
  }, []);

  // Push the keepalive preference down to the connection layer: once at
  // startup, and again whenever Settings changes it. It is a localStorage pref
  // (per machine, like the grid and column ones) and the SSH layer holds it in
  // a process-wide value read at connect time, so this is the one place the two
  // are joined up. Connections already open keep whatever they started with.
  useEffect(() => {
    const push = () => {
      const { keepalive } = loadSessionPrefs();
      setSshKeepalive(keepalive ? KEEPALIVE_SECS : 0).catch(() => {
        // Nothing useful to say: the worst case is that sessions behave as
        // they did before this setting existed.
      });
    };
    push();
    window.addEventListener(SESSION_PREFS_EVENT, push);
    return () => window.removeEventListener(SESSION_PREFS_EVENT, push);
  }, []);

  // Mount Settings the first time it's opened, then leave it mounted (below) so
  // re-visits are instant. We deliberately do NOT pre-warm at startup: mounting
  // this large tree is genuinely expensive, and doing it during launch (which
  // already mounts every other page) made the whole app hitch, worse on slow
  // machines. Instead we defer the mount two frames so the branded loader paints
  // first; its spinner is GPU-composited, so it keeps animating smoothly even
  // while the heavy first render blocks the main thread. One-time, per launch.
  useEffect(() => {
    if (page !== "settings" || settingsMounted) return;
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => setSettingsMounted(true));
    });
    return () => cancelAnimationFrame(outer);
  }, [page, settingsMounted]);

  const maximizeTerminal = useCallback((id: string) => {
    setActiveSessionId(id);
    setMaxSessionId(id);
    // One pane filling the screen and the whole grid filling it are two
    // different answers to the same question, so taking one drops the other.
    setGridFullscreen(false);
  }, []);
  const restoreTerminal = useCallback(() => setMaxSessionId(null), []);

  // F11 toggles the maximized terminal, the standard fullscreen key, and
  // (unlike Esc) one the shell and TUI apps like vim/less never use, so it's
  // safe to capture. Capture phase fires before xterm consumes the key.
  //
  // Esc is deliberately NOT a way out, here or in the fullscreen grid, and this
  // is the one place to record why, because it looks like an omission. Leaving
  // fullscreen on Esc means claiming the key from whatever is running in the
  // terminal, and the program most likely to be running full-screen in a
  // terminal is vi. There, Esc is not a convenience but the key the editor is
  // built around: taking one press of it to un-maximize a window is a worse
  // failure than any amount of hunting for the way back out. So the ways out
  // are F11 and the restore button in the banner (Ctrl+Shift+G and the strip's
  // own button, in the grid), and Esc reaches the terminal untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      e.preventDefault();
      e.stopPropagation();
      if (maximized) {
        setMaxSessionId(null);
      } else if (page === "terminals" && activeSessionId !== null) {
        setMaxSessionId(activeSessionId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [maximized, page, activeSessionId]);

  // Intercept the window close: if the guard is on and something is still
  // connected, hold the close and ask first. Registered once; reads the live
  // connection set / preference through refs and localStorage so it never goes
  // stale. Confirming sets closingRef and calls destroy(), which closes without
  // re-emitting the request (unlike close()).
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      if (closingRef.current) return;
      if (isExitGuardEnabled() && connectedRef.current.size > 0) {
        event.preventDefault();
        setExitConfirmOpen(true);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const confirmQuit = useCallback(() => {
    closingRef.current = true;
    setExitConfirmOpen(false);
    getCurrentWindow()
      .destroy()
      .catch(() => {
        // If destroy somehow fails, drop the latch so the guard still works.
        closingRef.current = false;
      });
  }, []);

  // A maximized terminal shows whichever session is active, because it is the
  // only pane on screen and being active is what makes a pane the visible one.
  // So the id has to follow the active session rather than remember the one
  // that was maximized, or Alt+Left/Right in a maximized terminal swaps the
  // terminal under a banner still naming the session you started from. It also
  // keeps the drop-back below honest: closing the session you maximized while
  // working in a different one should not throw you out of fullscreen.
  // Adjusted during render rather than in an effect: in an effect the banner
  // names the session you started from for one frame after Alt+Left has already
  // swapped the terminal underneath it, which is the exact confusion this
  // exists to prevent. It converges, because the assignment makes the condition
  // false.
  if (
    maxSessionId !== null &&
    activeSessionId !== null &&
    activeSessionId !== maxSessionId
  ) {
    setMaxSessionId(activeSessionId);
  }

  // Drop back to the tabbed view when the maximized terminal is gone (closed
  // or terminated) or we've left the Terminals page.
  if (
    maxSessionId !== null &&
    (page !== "terminals" || !sessions.some((s) => s.id === maxSessionId))
  ) {
    setMaxSessionId(null);
  }

  // Same for the fullscreen grid: navigating away must give the chrome back,
  // or the sidebar would be missing on a page that has no way to restore it.
  if (gridFullscreen && page !== "terminals") setGridFullscreen(false);

  const connectedHostIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of sessions) {
      if (s.type === "ssh" && connectedSessions.has(s.id)) ids.add(s.host.id);
    }
    return ids;
  }, [sessions, connectedSessions]);

  // Hosts with at least one open terminal tab (connected or not), drives the
  // "already open" guard rails on the Hosts page (H7/H8). Local shells excluded.
  const openHostIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of sessions) if (s.type === "ssh") ids.add(s.host.id);
    return ids;
  }, [sessions]);

  // SSH-only sessions for MultiTerminal, whose aggregate block view needs the
  // OSC 133 markers only the SSH path emits. PTY Broadcast now takes the full
  // session list, its local-shell tabs fan out to open PowerShell/cmd/WSL too.
  const sshSessions = useMemo(
    () => sessions.filter((s): s is SshTermSession => s.type === "ssh"),
    [sessions],
  );

  const maximizedSession =
    sessions.find((s) => s.id === maxSessionId) ?? null;

  return (
    <StatusProvider>
      <ActivityProvider>
      <UiPrefsProvider>
      <AppShell
        active={page}
        onNavigate={setPage}
        terminalCount={sessions.length}
        maximized={maximized}
        gridFullscreen={gridFullscreen}
        onRestore={restoreTerminal}
        maximizedHost={
          maximizedSession
            ? maximizedSession.type === "ssh"
              ? maximizedSession.host
              : // sessionLabel, not shell.label, so a renamed tab keeps its
                // name in the maximize banner too.
                { label: sessionLabel(maximizedSession), color: "#6b7280" }
            : null
        }
      >
      {page === "hosts" && (
        <HostsPage
          onOpenTerminal={openTerminal}
          onOpenTerminals={openTerminals}
          onTerminateHost={terminateHost}
          connectedHostIds={connectedHostIds}
          openHostIds={openHostIds}
          onEditTemplate={editTemplate}
          onOpenTemplates={openTemplates}
          onOpenProfiles={openProfiles}
          onOpenHelp={openHelpAt}
          startWithNewHost={newHostRequested}
          onNewHostConsumed={clearNewHostRequest}
        />
      )}
      {/* Templates stays mounted so a half-built arrangement survives a trip to
          the Hosts tab to check a hostname. */}
      <div className={page === "templates" ? "block h-full" : "hidden"}>
        <TemplatesPage
          visible={page === "templates"}
          connectedHostIds={connectedHostIds}
          focus={templateFocus}
          onOpenHelp={openHelpAt}
          onOpenGridSettings={openGridSettings}
          onBrowseTemplates={browseTemplates}
        />
      </div>
      {/* Broadcast stays mounted so output and host selection survive
          navigation (work-queue: "output history" persistence). */}
      <div className={page === "broadcast" ? "block h-full" : "hidden"}>
        <BroadcastPage
          visible={page === "broadcast"}
          connectedHostIds={connectedHostIds}
          onManageShortcuts={openShortcutSettings}
          onOpenTerminal={openTerminal}
        />
      </div>
      {/* PTY Broadcast stays mounted so host selection and dispatch history
          survive tab switches (work queue 2026-06-13). */}
      <div className={page === "ptybroadcast" ? "block h-full" : "hidden"}>
        <PtyBroadcastPage
          visible={page === "ptybroadcast"}
          sessions={sessions}
          connectedSessions={connectedSessions}
          onManageShortcuts={openShortcutSettings}
          onJumpToSession={jumpToSession}
        />
      </div>
      {/* Terminals stay mounted so sessions survive navigation. */}
      <div className={page === "terminals" ? "block h-full" : "hidden"}>
        <TerminalsPage
          sessions={sessions}
          activeId={activeSessionId}
          visible={page === "terminals"}
          connectedSessions={connectedSessions}
          onConnectionChange={handleConnectionChange}
          onActivate={setActiveSessionId}
          onCloseSession={closeSession}
          onReorder={reorderSessions}
          onRenameSession={renameSession}
          onDuplicateSession={duplicateSession}
          onMaximize={maximizeTerminal}
          maximized={maximized}
          gridFullscreen={gridFullscreen}
          onGridFullscreen={setGridFullscreen}
          onOpenLocalShell={openLocalShell}
          onOpenHosts={openTerminals}
          onNewHost={openNewHost}
          onSaveAsTemplate={saveGridAsTemplate}
          workspaces={ws.workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSwitchWorkspace={ws.switchTo}
          onNewWorkspace={ws.createAndShow}
          onRenameWorkspace={ws.rename}
          onRecolorWorkspace={ws.recolor}
          onCloseWorkspace={closeWorkspace}
          onMoveToWorkspace={moveToWorkspace}
          onOpenTemplate={openTemplate}
          onEditTemplate={editTemplate}
          onDuplicateTemplate={duplicateTemplate}
          onManageShortcuts={openShortcutSettings}
          onOpenSessionSettings={openSessionSettings}
        />
      </div>
      {/* MultiTerminal stays mounted so its aggregated block log survives tab
          switches (it subscribes to every session's pty:block stream). */}
      <div className={page === "multiterminal" ? "block h-full" : "hidden"}>
        <MultiTerminalPage
          visible={page === "multiterminal"}
          sessions={sshSessions}
          connectedSessions={connectedSessions}
          onManageShortcuts={openShortcutSettings}
          onCloseAllTerminals={closeAllTerminals}
          onJumpToSession={jumpToSession}
        />
      </div>
      {/* Skills stays mounted so a running skill (and its live per-host panes)
          survive tab switches. A run can last as long as an apt upgrade, and
          unmounting would tear down the xterm panes mid-run. */}
      <div className={page === "skills" ? "block h-full" : "hidden"}>
        <SkillsPage
          visible={page === "skills"}
          connectedHostIds={connectedHostIds}
          onAdoptTerminal={adoptTerminal}
          onOpenHelp={openHelpAt}
        />
      </div>
      {/* SFTP stays mounted so an open browser session survives navigation. */}
      <div className={page === "sftp" ? "block h-full" : "hidden"}>
        <SftpPage visible={page === "sftp"} onOpenTerminal={openTerminal} />
      </div>
      {/* Logs stay mounted so a loaded session survives navigation. */}
      <div className={page === "logs" ? "block h-full" : "hidden"}>
        <LogsPage visible={page === "logs"} />
      </div>
      {/* Settings stays mounted after first open so re-visits are instant; the
          hidden div keeps it out of view while another tab is active. */}
      {settingsMounted && (
        <div className={page === "settings" ? "block" : "hidden"}>
          <Suspense fallback={null}>
            <SettingsPage
              visible={page === "settings"}
              focusSection={settingsFocus}
              onFocusConsumed={() => setSettingsFocus(null)}
              onReady={handleSettingsReady}
            />
          </Suspense>
        </div>
      )}
      {/* Branded loader while Settings warms up (only seen if the tab is opened
          before the background pre-warm finishes). */}
      {page === "settings" && !settingsReady && <SettingsLoading />}
      {page === "help" && (
        <Suspense fallback={null}>
          <HelpPage focusSection={helpFocus} onFocusConsumed={clearHelpFocus} />
        </Suspense>
      )}
        <UnlockDialog
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          onUnlocked={() => {}}
        />
        {/* Opening a template when there is something to say first.
            With terminals already open the question is where the new tabs go:
            a workspace of their own, or the front or end of the one on screen.
            "Replace" is not one of the answers, because a launch never closes
            anything. With the workspace on screen empty, front and end are the
            same place, so they become one Open here. */}
        <AlertDialog
          open={pendingLaunch !== null}
          onOpenChange={(o) => {
            if (!o) setPendingLaunch(null);
          }}
        >
          {/* Wider when it asks where the tabs go: four buttons do not fit
              the default width, and the row ran out past the text above it
              (smoke 77-1). Same variant as the default, so it replaces it. */}
          <AlertDialogContent
            className={cn(
              pendingLaunch?.placement && "data-[size=default]:sm:max-w-lg",
            )}
          >

            <AlertDialogHeader>
              <AlertDialogTitle>
                {(pendingLaunch?.templates.length ?? 0) > 1 ? (
                  <>Open {pendingLaunch?.templates.length} templates?</>
                ) : (
                  <>
                    Open &ldquo;{pendingLaunch?.templates[0]?.template.name}
                    &rdquo;?
                  </>
                )}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  {(pendingLaunch?.templates.length ?? 0) > 1 && (
                    <>
                      <p>
                        They open one after another, in the order the Hosts
                        tab lists them:
                      </p>
                      <ol className="list-decimal space-y-0.5 pl-5">
                        {pendingLaunch?.templates.map(({ template, count }) => (
                          <li key={template.id}>
                            <span className="font-medium text-foreground">
                              {template.name}
                            </span>
                            {": "}
                            {count === 0
                              ? "nothing that can open here"
                              : `${count} ${count === 1 ? "session" : "sessions"}`}
                          </li>
                        ))}
                      </ol>
                    </>
                  )}
                  <p>
                    This opens{" "}
                    <span className="font-semibold text-foreground">
                      {pendingLaunch?.plan.sessions.length ?? 0}
                    </span>{" "}
                    {pendingLaunch?.plan.sessions.length === 1
                      ? "session"
                      : "sessions"}
                    , in the order they were arranged.
                  </p>
                  {pendingLaunch?.placement && (
                    <p>
                      {sessions.length}{" "}
                      {sessions.length === 1 ? "terminal is" : "terminals are"}{" "}
                      already open.{" "}
                      {activeWorkspaceCount > 0
                        ? "Open the new tabs in a workspace of their own, or add them to the front or end of this one. "
                        : "Open the new tabs in this empty workspace, or in a new one. "}
                      Nothing is closed either way.
                    </p>
                  )}
                  {(pendingLaunch?.plan.skipped.length ?? 0) > 0 && (
                    <>
                      <p className="font-medium text-foreground">
                        {pendingLaunch?.plan.skipped.length} of them cannot open
                        on this machine:
                      </p>
                      <ul className="list-disc space-y-0.5 pl-5 text-xs">
                        {pendingLaunch?.plan.skipped.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* Buttons top-aligned, so the caption under the front and end
                pair does not stretch Cancel and New workspace to its height. */}
            <AlertDialogFooter className="sm:items-start">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              {pendingLaunch?.placement && (
                <AlertDialogAction
                  variant="outline"
                  onClick={() => {
                    const p = pendingLaunch;
                    setPendingLaunch(null);
                    if (!p) return;
                    if (p.templates.length > 1) {
                      launchIntoWorkspaces(p.templates, p.plan.sessions);
                    } else {
                      launchTemplate(
                        p.plan.sessions,
                        "new",
                        true,
                        p.templates[0]?.template,
                      );
                    }
                  }}
                >
                  New workspace
                </AlertDialogAction>
              )}
              {/* Front and end are both "into the workspace on screen", so
                  once there is more than one workspace they say which, in a
                  line under the pair. */}
              <div className="flex flex-col items-center gap-1">
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  {pendingLaunch?.placement && activeWorkspaceCount > 0 && (
                    <AlertDialogAction
                      variant="outline"
                      onClick={() => {
                        const p = pendingLaunch;
                        setPendingLaunch(null);
                        if (p) launchTemplate(p.plan.sessions, "front", true);
                      }}
                    >
                      Add to the front
                    </AlertDialogAction>
                  )}
                  <AlertDialogAction
                    onClick={() => {
                      const p = pendingLaunch;
                      setPendingLaunch(null);
                      // One template opening into the empty, unnamed default
                      // workspace names it; several do not pick one to name it.
                      if (p) {
                        launchTemplate(
                          p.plan.sessions,
                          "end",
                          true,
                          p.templates.length === 1
                            ? p.templates[0]?.template
                            : undefined,
                        );
                      }
                    }}
                  >
                    {!pendingLaunch?.placement
                      ? "Open"
                      : activeWorkspaceCount > 0
                        ? "Add to the end"
                        : "Open here"}
                  </AlertDialogAction>
                </div>
                {pendingLaunch?.placement &&
                  ws.workspaces.length > 1 &&
                  activeWorkspace && (
                    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      into
                      <span
                        aria-hidden="true"
                        className={cn(
                          "inline-block h-2 w-2 shrink-0 rounded-full border border-border",
                          !activeWorkspace.color && "border-dashed",
                        )}
                        style={
                          activeWorkspace.color
                            ? { backgroundColor: activeWorkspace.color }
                            : undefined
                        }
                      />
                      <span className="max-w-40 truncate font-medium text-foreground">
                        {activeWorkspace.name}
                      </span>
                    </p>
                  )}
              </div>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={exitConfirmOpen} onOpenChange={setExitConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Quit with terminals connected?</AlertDialogTitle>
              <AlertDialogDescription>
                <span className="font-semibold text-foreground">
                  {connectedSessions.size}
                </span>{" "}
                terminal {connectedSessions.size === 1 ? "session is" : "sessions are"}{" "}
                still connected. Quitting now disconnects{" "}
                {connectedSessions.size === 1 ? "it" : "them"} and loses any
                unsaved work in those shells. You can turn this warning off in
                Settings, under Performance.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Stay open</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirmQuit}>
                Quit anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Toaster />
        <ToastRecorder />
      </AppShell>
      </UiPrefsProvider>
      </ActivityProvider>
    </StatusProvider>
  );
}

export default App;
