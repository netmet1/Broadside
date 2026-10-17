import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArchiveIcon,
  CableIcon,
  CircleHelpIcon,
  Loader2Icon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  SquareAsteriskIcon,
  SquareTerminalIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/tauri/hosts";
import { GENERIC_MONOSPACE, cssFontFamily } from "@/lib/monospaceFonts";
import { DEFAULT_UI_PREFS, MAX_TERMINAL_SCROLLBACK } from "@/lib/uiPrefs";
import { auditInfo, setAuditEnabled } from "@/lib/tauri/logs";
import { useHint, useStatus } from "@/lib/status";
import { useTheme } from "next-themes";

import {
  type AppSettings,
  type ShortcutScope,
  destroyAllHosts,
  getAppSettings,
  resetAppSettings,
  setSudoAutofillEnabled,
  setHistoryScrubEnabled,
} from "@/lib/tauri/settings";
import { isExitGuardEnabled, setExitGuardEnabled } from "@/lib/exitGuard";
import { migrateLegacyProfiles } from "@/lib/useShellProfiles";
import { AdminUnlockDialog } from "@/components/AdminUnlockDialog";
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
import {
  SCOPE_LABELS,
  SECTION_KEYWORDS,
  SECTION_TITLES,
  SEARCH_STORAGE_KEY,
  sectionDomId,
} from "@/pages/settings/constants";
import { SettingsToc } from "@/pages/settings/SettingsToc";
import { StartupSection } from "@/pages/settings/StartupSection";
import { useSectionNav } from "@/pages/settings/useSectionNav";
import { ScopeIcon, SectionHeading } from "@/pages/settings/shared";
import { GridSection } from "@/pages/settings/GridSection";
import { TableColumnsBox } from "@/pages/settings/TableColumnsBox";
import { HIDEABLE_COLUMNS, ORDERABLE_COLUMNS } from "@/lib/hostColumns";
import {
  PROFILE_HIDEABLE_COLUMNS,
  PROFILE_ORDERABLE_COLUMNS,
} from "@/lib/profileColumns";
import { SessionsSection } from "@/pages/settings/SessionsSection";
import { CustomTerminalsSection } from "@/pages/settings/CustomTerminalsSection";
import { DismissedWarnings } from "@/pages/settings/DismissedWarnings";
import { SkillsSection } from "@/pages/settings/SkillsSection";
import { useAdminLock } from "@/pages/settings/useAdminLock";
import { useAppearance } from "@/pages/settings/useAppearance";
import { useBackupRestore } from "@/pages/settings/useBackupRestore";
import { useGuardRules } from "@/pages/settings/useGuardRules";
import { usePerfSettings } from "@/pages/settings/usePerfSettings";
import { useShortcuts } from "@/pages/settings/useShortcuts";

export function SettingsPage({
  visible = true,
  focusSection = null,
  onFocusConsumed,
  onReady,
}: {
  /** False while the tab is mounted but hidden (the page stays mounted between
   * visits). Gates the shared-<main> scroll bookkeeping so a hidden Settings
   * can't overwrite the saved section from another page's scrolling. */
  visible?: boolean;
  /** Section to scroll to after mount (e.g. "shortcuts" from the
   * "Manage shortcuts…" entry on Broadcast/Terminals). */
  focusSection?: string | null;
  onFocusConsumed?: () => void;
  /** Called once the initial settings load has settled, clears the branded
   * loader the shell shows while this (large) page warms up. */
  onReady?: () => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const { hintsEnabled, setHintsEnabled } = useStatus();
  const { theme, setTheme } = useTheme();
  const hint = useHint();

  // Appearance: fonts, host-table column visibility, local-shell launcher list.
  const {
    hostColumns,
    profileColumns,
    shells,
    disabledShells,
    toggleShell,
    termFontFamily,
    chooseFontFamily,
    fontOptions,
    unknownFont,
    termFontSize,
    setTermFontSize,
    termFontStrict,
    toggleTermFontStrict,
    appFontSize,
    setAppFontSize,
    scrollback,
    setScrollback,
    scrollbackShrinks,
    currentScrollback,
    savingUi,
    parsedTermFontSize,
    parsedAppFontSize,
    parsedScrollback,
    syncFromSettings: syncAppearanceFromSettings,
    saveFontSizes,
  } = useAppearance();

  // Opt-in admin lock (gates the sudo toggle, credential editing and Reset).
  // All lock/passcode/recovery state + handlers live in the hook, which loads
  // the current lock status on mount.
  const {
    lockStatus,
    adminLocked,
    refreshLock,
    unlockOpen,
    setUnlockOpen,
    passcodeFormOpen,
    setPasscodeFormOpen,
    pcNew,
    setPcNew,
    pcConfirm,
    setPcConfirm,
    pcSaving,
    savePasscode,
    recoveryCode,
    setRecoveryCode,
    recoverOpen,
    setRecoverOpen,
    recCode,
    setRecCode,
    recNewPc,
    setRecNewPc,
    submitRecover,
    removeLock,
  } = useAdminLock();

  // Warn-before-quit-with-connected-terminals guard (UI-only pref, default on).
  const [exitGuard, setExitGuard] = useState(isExitGuardEnabled);

  // Reset-everything-to-defaults (with a guard rail).
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resetEverything = async () => {
    setResetting(true);
    try {
      // Before anything is cleared, make sure the profiles an older build kept
      // in localStorage have been copied into the database. Somebody who
      // upgrades and resets before ever opening Terminals would otherwise lose
      // them exactly the way build 69 exists to stop. A copy that fails stops
      // the reset.
      await migrateLegacyProfiles();
      await resetAppSettings();
    } catch (e) {
      toast.error(errorMessage(e));
      setResetting(false);
      return;
    }
    // Clearing localStorage/sessionStorage resets every UI preference kept there
    // (theme, tab order, sorts, column widths, rail and header toggles). The
    // test for what may live there: losing it costs the operator a moment to
    // set again. Anything they typed and would miss is content and belongs in
    // the database, which this never touches. Shell profiles failed that test
    // and were wiped by this line until build 69 moved them. The remembered
    // serial speed per port was weighed and stays: it is one pick from a list,
    // made again the next time that port is opened. Reload so all providers
    // re-init from defaults.
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // Non-fatal; the DB-side reset already applied.
    }
    window.location.reload();
  };

  // Danger Zone: wipe every host + its stored credentials. Guarded by the admin
  // lock (button disabled), a "back up first" offer, and a typed-DESTROY gate.
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [destroyTyped, setDestroyTyped] = useState("");
  const destroyArmed = destroyTyped === "DESTROY";
  const [wasDestroyOpen, setWasDestroyOpen] = useState(destroyOpen);
  if (wasDestroyOpen !== destroyOpen) {
    setWasDestroyOpen(destroyOpen);
    if (!destroyOpen) setDestroyTyped("");
  }
  const destroyHosts = async () => {
    setDestroying(true);
    try {
      const n = await destroyAllHosts();
      toast.success(
        `Deleted ${n} ${n === 1 ? "host" : "hosts"} and their credentials`,
      );
      setDestroyOpen(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDestroying(false);
    }
  };

  // Section search, filters which settings sections are shown. Restored from
  // sessionStorage so it survives leaving and returning to the Settings tab.
  const [query, setQuery] = useState(
    () => sessionStorage.getItem(SEARCH_STORAGE_KEY) ?? "",
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    sessionStorage.setItem(SEARCH_STORAGE_KEY, query);
  }, [query]);
  // A section is kept when every word typed is somewhere in its title or its
  // keywords (SECTION_KEYWORDS), so "git" finds Custom terminals and "font
  // size" finds Appearance without having to be the exact heading. Every word
  // rather than the whole string: "custom git" is a reader narrowing down, not
  // a phrase anything is expected to contain.
  const sectionVisible = useCallback(
    (title: string) => {
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return true;
      const haystack = (
        title +
        " " +
        (SECTION_KEYWORDS[title] ?? "")
      ).toLowerCase();
      return terms.every((t) => haystack.includes(t));
    },
    [query],
  );
  const anyVisible = SECTION_TITLES.some(sectionVisible);

  // Which section is in view, remembering it between visits, and going to one
  // from the panel or the Jump to list. See ./settings/useSectionNav.
  const rootRef = useRef<HTMLDivElement>(null);
  const clearQuery = useCallback(() => setQuery(""), []);
  const nav = useSectionNav({
    rootRef,
    visible,
    ready: settings !== null,
    focusSection,
    clearQuery,
    layoutKey: query,
  });

  // Progressive reveal: on first mount, render the first section right away then
  // one more each frame. The first paint stays cheap (the page feels instant)
  // and the cost of building this large tree is spread across frames instead of
  // one long blocking commit. Because the page stays mounted between visits,
  // this runs only once; later visits already have revealCount maxed. A search
  // or deep-link (focusSection) needs every section at once, so those jump
  // straight to fully revealed (and never step back, so nothing unmounts).
  const [revealCount, setRevealCount] = useState(1);
  // A search, a deep link or a jump needs every section at once, so it jumps
  // straight to fully revealed. That is a synchronous decision and belongs in
  // render: in an effect it costs a frame in which the search has been typed
  // (or the section clicked) and the section it must reach is not in the tree
  // yet. It converges, because revealing them all makes the condition false.
  const revealAllNow =
    query.trim() !== "" || focusSection !== null || nav.wantsAllSections;
  if (revealCount < SECTION_TITLES.length && revealAllNow) {
    setRevealCount(SECTION_TITLES.length);
  }
  // The unhurried case: one more section per frame, so the first paint stays
  // cheap and the cost of this large tree is spread instead of landing in one
  // long commit. The page stays mounted between visits, so this runs once.
  useEffect(() => {
    if (revealCount >= SECTION_TITLES.length || revealAllNow) return;
    const id = requestAnimationFrame(() =>
      setRevealCount((n) => Math.min(n + 1, SECTION_TITLES.length)),
    );
    return () => cancelAnimationFrame(id);
  }, [revealCount, revealAllNow]);
  const sectionReady = useCallback(
    (title: string) => SECTION_TITLES.indexOf(title) < revealCount,
    [revealCount],
  );

  // Performance + network probe.
  const {
    maxSessions,
    setMaxSessions,
    defaultTimeout,
    setDefaultTimeout,
    bulkConfirmOver,
    setBulkConfirmOver,
    parsedBulkConfirmOver,
    savingPerf,
    recalibrating,
    probing,
    latencies,
    parsedMaxSessions,
    parsedTimeout,
    syncFromSettings: syncPerfFromSettings,
    savePerf,
    recalibrate,
    runNetworkProbe,
  } = usePerfSettings(setSettings);

  // Audit
  const [auditOn, setAuditOn] = useState<boolean | null>(null);

  // Shortcut commands (D-054). The ref stays here for the deep-link scroll.
  const shortcutsSectionRef = useRef<HTMLElement>(null);
  const {
    shortcutFormOpen,
    setShortcutFormOpen,
    shortcutCmd,
    setShortcutCmd,
    shortcutLabel,
    setShortcutLabel,
    shortcutScope,
    setShortcutScope,
    editingShortcutId,
    shortcutSubmitAttempted,
    shortcutCmdMissing,
    submitShortcut,
    editShortcut,
    deleteShortcut,
    cancelShortcutForm,
  } = useShortcuts(settings, setSettings);

  // Backup & Restore (shared with the Danger Zone "back up first" offer).
  const {
    backupIncludeCsv,
    setBackupIncludeCsv,
    backingUp,
    runBackup,
    restorePath,
    setRestorePath,
    restoring,
    restoreFileName,
    pickRestoreFile,
    runRestore,
  } = useBackupRestore();

  // Destructive-command guard rules (form + persistence into app settings).
  const {
    formOpen,
    setFormOpen,
    ruleDesc,
    setRuleDesc,
    ruleCommands,
    setRuleCommands,
    ruleFlags,
    setRuleFlags,
    rulePaths,
    setRulePaths,
    ruleArgs,
    setRuleArgs,
    ruleTip,
    setRuleTip,
    ruleSubmitAttempted,
    setRuleSubmitAttempted,
    ruleError,
    setRuleError,
    helpRule,
    setHelpRule,
    ruleDescMissing,
    ruleCommandsMissing,
    ruleCommandsHaveSpace,
    ruleCommandsInvalid,
    addRule,
    toggleRule,
    deleteRule,
  } = useGuardRules(settings, setSettings);

  // The initial load, written inside the effect rather than in a `load`
  // callback it calls, so the state writes are visibly in a continuation. The
  // liveness guard is new: this page is lazy-loaded and can be navigated away
  // from while the settings are still in flight.
  //
  // `onReady` is deliberately outside that guard. It tells the shell to drop
  // its branded loader, which is not this component's state, and skipping it
  // because Settings went away would leave the loader on screen for good.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const s = await getAppSettings();
        if (alive) {
          setSettings(s);
          syncPerfFromSettings(s);
          syncAppearanceFromSettings(s);
        }
      } catch (e) {
        toast.error(errorMessage(e));
      }
      try {
        const info = await auditInfo();
        if (alive) setAuditOn(info.enabled);
      } catch {
        // Audit info is non-critical for this page.
      }
      onReady?.();
    })();
    return () => {
      alive = false;
    };
  }, [syncPerfFromSettings, syncAppearanceFromSettings, onReady]);

  // Deep-link scroll (e.g. "Manage shortcuts…" from Broadcast/Terminals, or
  // "Grid settings" from the Templates canvas, or the Settings link on a pane
  // the idle timeout closed).
  //
  // Two ways in, because the shortcuts one predates the section ids and holds
  // its own ref. Anything else is addressed by section title, which is what the
  // jump-to dropdown already uses, so a new deep link needs no code here at
  // all: it passes the title and lands.
  useEffect(() => {
    if (!focusSection || !settings) return;
    if (focusSection === "shortcuts") {
      shortcutsSectionRef.current?.scrollIntoView({ behavior: "smooth" });
      onFocusConsumed?.();
      return;
    }
    // `sessions` is the other key that predates the ids, sent by the Settings
    // link on a pane the idle timeout closed. Named to its title here rather
    // than handled apart, so it gets the same two-frame scroll as the rest.
    const target = focusSection === "sessions" ? "Sessions" : focusSection;
    if (!SECTION_TITLES.includes(target)) return;
    // Two frames, like the restore above: the sections below this one are
    // revealed progressively, and scrolling before the commit lands puts the
    // target somewhere it is about to move from.
    //
    // The request is consumed *after* the scroll, not before. Consuming it
    // first clears the prop, which re-runs this effect, whose cleanup then
    // cancels the frame that was going to do the scrolling.
    const outer = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .getElementById(sectionDomId(target))
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
        onFocusConsumed?.();
      }),
    );
    return () => cancelAnimationFrame(outer);
  }, [focusSection, settings, onFocusConsumed]);

  const probe = settings?.local_probe ?? null;

  return (
    // Laid out like Help: a panel of sections down the left, the page beside
    // it. The content column keeps the width the page had on its own (max-w-3xl
    // of a max-w-5xl row, less the panel and the gap).
    <div ref={rootRef} className="mx-auto flex max-w-5xl gap-8 px-6">
      <aside className="hidden w-56 shrink-0 pt-6 lg:block">
        <SettingsToc
          query={query}
          onQueryChange={setQuery}
          titles={SECTION_TITLES.filter(sectionVisible)}
          activeTitle={nav.activeTitle}
          onPick={nav.scrollToSection}
        />
      </aside>
      <div className="min-w-0 flex-1 space-y-10 pb-16 pt-6">
      {/* Sticky header (S2), pinned to the top of the tab while the sections
          scroll. Where the panel shows, it holds only the title; below that
          width the panel hides, as Help's does, and the search box and the
          Jump to list come back here so nothing is lost with it. */}
      <div className="sticky top-0 z-20 -mt-6 flex items-center justify-between gap-4 border-b border-border/50 bg-background py-3">
        <h1 className="font-heading text-lg font-semibold">Settings</h1>
        <div className="flex items-center gap-2 lg:hidden">
          <Select value="" onValueChange={nav.goToSection}>
            <SelectTrigger
              size="sm"
              className="w-44"
              aria-label="Jump to section"
              {...hint("Jump straight to a settings section")}
            >
              <SelectValue placeholder="Jump to…" />
            </SelectTrigger>
            <SelectContent>
              {SECTION_TITLES.map((title) => (
                <SelectItem key={title} value={title} className="text-sm">
                  {title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative w-64">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sections…"
              className="h-8 pl-8 pr-7 text-sm"
              aria-label="Search settings sections"
              {...hint(
                "Filter the settings sections by what they are about, not only their name: “git” finds Custom terminals",
              )}
            />
            {query !== "" && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
                title="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {!anyVisible && (
        <p className="text-sm text-muted-foreground">
          No settings section matches “{query.trim()}”.
        </p>
      )}

      {/* Startup: which tab Broadside opens on. */}
      {sectionVisible("Startup") && sectionReady("Startup") && (
        <StartupSection id={sectionDomId("Startup")} visible={visible} />
      )}

      {/* Performance / probe */}
      {sectionVisible("Performance") && sectionReady("Performance") && (
      <section id={sectionDomId("Performance")} className="space-y-4">
        <SectionHeading
          title="Performance"
          hint="Suggests how many sessions this computer can comfortably run at once, based on its resources. It's only a suggestion."
        />
        <div className="flex items-start justify-between gap-4">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
            {probe ? (
              <>
                <span className="text-muted-foreground">CPU cores</span>
                <span className="font-mono text-xs leading-5">{probe.cpu_cores}</span>
                <span className="text-muted-foreground">Memory (available / total)</span>
                <span className="font-mono text-xs leading-5">
                  {(probe.available_memory_mb / 1024).toFixed(1)} /{" "}
                  {(probe.total_memory_mb / 1024).toFixed(1)} GB
                </span>
                <span className="text-muted-foreground">Suggested max sessions</span>
                <span className="font-mono text-xs leading-5">
                  {probe.suggested_max_sessions}
                </span>
                <span className="text-muted-foreground">Probed</span>
                <span className="font-mono text-xs leading-5">
                  {new Date(probe.probed_at).toLocaleString()}
                </span>
              </>
            ) : (
              <p className="col-span-2 text-sm text-muted-foreground">
                Not probed yet. Run Recalibrate to measure this machine.
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={recalibrate}
            disabled={recalibrating}
            {...hint("Re-measure this machine's resources for a session-count suggestion")}
          >
            {recalibrating ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Recalibrate
          </Button>
        </div>

        <div className="grid max-w-md gap-4">
          <div className="grid gap-1">
            <Label htmlFor="max-sessions">Max concurrent sessions</Label>
            <Input
              id="max-sessions"
              value={maxSessions}
              onChange={(e) => setMaxSessions(e.target.value)}
              placeholder={
                probe ? `Suggested: ${probe.suggested_max_sessions}` : "e.g. 64"
              }
              className={`w-40 font-mono text-sm ${parsedMaxSessions === undefined ? "border-destructive" : ""}`}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to follow the probe suggestion. 1-2048.
            </p>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="default-timeout">Default broadcast timeout (seconds)</Label>
            <Input
              id="default-timeout"
              value={defaultTimeout}
              onChange={(e) => setDefaultTimeout(e.target.value)}
              className={`w-40 font-mono text-sm ${parsedTimeout === undefined ? "border-destructive" : ""}`}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">1-3600. Overridable per command.</p>
          </div>
          {/* One number for every bulk action on the Terminals page: opening a
              batch of local shells, Reconnect all, Disconnect all and Close
              failed. It was a hardcoded 7, which is nobody's idea of a round
              number and was wrong in both directions depending on the operator.

              Close all is not on the list and asks every time regardless. It is
              the one action here that can take away work in progress, and a
              setting whose purpose is "stop asking me so often" must not be
              able to reach it. */}
          <div className="grid gap-1">
            <Label htmlFor="bulk-confirm-over">Ask before acting on more than</Label>
            <Input
              id="bulk-confirm-over"
              value={bulkConfirmOver}
              onChange={(e) => setBulkConfirmOver(e.target.value)}
              className={`w-40 font-mono text-sm ${parsedBulkConfirmOver === undefined ? "border-destructive" : ""}`}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              1-11 sessions. Opening a batch of local shells, Reconnect all,
              Disconnect all and Close failed confirm first past this many.
              Close all always asks.
            </p>
          </div>
          <div>
            <Button
              size="sm"
              onClick={savePerf}
              disabled={
                savingPerf ||
                parsedMaxSessions === undefined ||
                parsedTimeout === undefined ||
                parsedBulkConfirmOver === undefined
              }
            >
              {savingPerf && <Loader2Icon className="animate-spin" />}
              Save
            </Button>
          </div>
        </div>

        {/* Exit guard: warn before quitting while terminals are still
            connected. A local UI preference (saved immediately), separate from
            the Save button above. */}
        <div className="max-w-xl space-y-1 border-t border-border/40 pt-4">
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary"
              checked={exitGuard}
              onChange={(e) => {
                const next = e.target.checked;
                setExitGuardEnabled(next);
                setExitGuard(next);
              }}
            />
            Warn before quitting with terminals connected
          </label>
          <p className="text-xs text-muted-foreground">
            When on, closing the app while any terminal is still connected asks
            for confirmation first, so a stray close never drops a live session.
          </p>
        </div>
      </section>
      )}

      {/* Network probe */}
      {sectionVisible("Network probe") && sectionReady("Network probe") && (
      <section id={sectionDomId("Network probe")} className="space-y-4">
        <SectionHeading
          title="Network probe"
          hint="Test to check how quickly each saved host responds."
        />
        <Button
          variant="outline"
          size="sm"
          onClick={runNetworkProbe}
          disabled={probing}
          {...hint("Check how quickly each saved host responds")}
        >
          {probing ? <Loader2Icon className="animate-spin" /> : <RadarIcon />}
          Probe all hosts
        </Button>
        {latencies !== null && (
          <div className="max-w-md space-y-1">
            {latencies.length === 0 && (
              <p className="text-sm text-muted-foreground">No hosts configured.</p>
            )}
            {latencies.map((l) => (
              <div
                key={l.host_id}
                className="flex items-center justify-between rounded-md border border-border/40 px-3 py-1.5 text-sm"
              >
                <span className="truncate">{l.label}</span>
                {l.connect_ms !== null ? (
                  <span className="font-mono text-xs text-emerald-400">
                    {l.connect_ms} ms
                  </span>
                ) : (
                  <span className="font-mono text-xs text-red-400">unreachable</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {/* Destructive guard rules */}
      {sectionVisible("Destructive command guard") &&
        sectionReady("Destructive command guard") && (
      <section id={sectionDomId("Destructive command guard")} className="space-y-4">
        <SectionHeading
          title="Destructive command guard"
          hint={
            <>
              Matched rules require <strong>CONFIRM</strong> before they run.
              Built-in rules can't be removed; rules you add can be turned off or
              deleted.
            </>
          }
        />

        {settings && settings.user_rules.length > 0 && (
          <div className="space-y-1">
            {settings.user_rules.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-md border border-border/40 px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={r.enabled}
                  onChange={() => toggleRule(r.id)}
                  aria-label={`Enable rule: ${r.description}`}
                />
                <div className="min-w-0 flex-1">
                  <p className={r.enabled ? "" : "text-muted-foreground line-through"}>
                    {r.description}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {r.commands.join(" ")}
                    {r.required_flags.length > 0 && ` · flags: ${r.required_flags.join(" ")}`}
                    {r.path_patterns.length > 0 && ` · paths: ${r.path_patterns.join(" ")}`}
                    {r.arg_all_of.length > 0 && ` · args: ${r.arg_all_of.join(" ")}`}
                  </p>
                </div>
                {r.help_tip && r.help_tip.trim().length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      setHelpRule({ title: r.description, tip: r.help_tip! })
                    }
                    aria-label={`Help for rule: ${r.description}`}
                    {...hint("Why this rule exists and what it protects against")}
                  >
                    <CircleHelpIcon className="text-muted-foreground" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => deleteRule(r.id)}
                  aria-label={`Delete rule: ${r.description}`}
                  {...hint("Delete this rule")}
                >
                  <Trash2Icon className="text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {formOpen ? (
          <div className="max-w-md space-y-3 rounded-md border border-border/40 p-4">
            <div className="grid gap-1">
              <Label htmlFor="rule-desc">Description</Label>
              <Input
                id="rule-desc"
                value={ruleDesc}
                onChange={(e) => setRuleDesc(e.target.value)}
                placeholder="e.g. docker prune wipes unused data"
                className={
                  ruleSubmitAttempted && ruleDescMissing ? "border-destructive" : ""
                }
                autoComplete="off"
              />
              {ruleSubmitAttempted && ruleDescMissing && (
                <p className="text-xs text-destructive">
                  Description is required.
                </p>
              )}
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rule-commands">Command names</Label>
              <Input
                id="rule-commands"
                value={ruleCommands}
                onChange={(e) => setRuleCommands(e.target.value)}
                placeholder="docker, podman"
                className={`font-mono text-sm ${
                  ruleSubmitAttempted && ruleCommandsInvalid
                    ? "border-destructive"
                    : ""
                }`}
                autoComplete="off"
              />
              {ruleSubmitAttempted && ruleCommandsMissing ? (
                <p className="text-xs text-destructive">
                  At least one command is required.
                </p>
              ) : ruleSubmitAttempted && ruleCommandsHaveSpace ? (
                <p className="text-xs text-destructive">
                  Command names can't contain spaces; separate multiple
                  commands with commas.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Comma-separated. The rule fires when any of these is the
                  command.
                </p>
              )}
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rule-flags">Required flags (optional)</Label>
              <Input
                id="rule-flags"
                value={ruleFlags}
                onChange={(e) => setRuleFlags(e.target.value)}
                placeholder="f|--force, r|--recursive"
                className="font-mono text-sm"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated groups; every group must match. Within a group,
                | separates alternatives (short without dash, long with --).
              </p>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rule-paths">Path prefixes (optional)</Label>
              <Input
                id="rule-paths"
                value={rulePaths}
                onChange={(e) => setRulePaths(e.target.value)}
                placeholder="/etc, /var/lib"
                className="font-mono text-sm"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rule-args">Required arguments (optional)</Label>
              <Input
                id="rule-args"
                value={ruleArgs}
                onChange={(e) => setRuleArgs(e.target.value)}
                placeholder="prune, system"
                className="font-mono text-sm"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated; all must be present as arguments.
              </p>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rule-tip">Help tip (optional)</Label>
              <Input
                id="rule-tip"
                value={ruleTip}
                onChange={(e) => setRuleTip(e.target.value)}
                placeholder="Longer explanation shown via the rule's help icon"
                autoComplete="off"
              />
            </div>
            {ruleError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {ruleError}
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={addRule}>
                Add rule
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFormOpen(false);
                  setRuleSubmitAttempted(false);
                  setRuleError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRuleSubmitAttempted(false);
              setRuleError(null);
              setFormOpen(true);
            }}
            {...hint("Add your own destructive-command rule")}
          >
            <PlusIcon />
            Add rule
          </Button>
        )}

        <div className="space-y-1">
          <p className="pt-2 text-xs font-medium text-muted-foreground">
            Core rules (built in)
          </p>
          {settings?.core_rules.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-md border border-border/30 px-3 py-1.5 text-sm text-muted-foreground"
            >
              <LockIcon className="h-3.5 w-3.5 shrink-0" />
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6"
                onClick={() => setHelpRule({ title: r.description, tip: r.help_tip })}
                aria-label={`Help for core rule: ${r.description}`}
                {...hint("Why this rule exists and what it protects against")}
              >
                <CircleHelpIcon className="h-3.5 w-3.5" />
              </Button>
              <span className="min-w-0 flex-1 truncate">{r.description}</span>
              <span className="font-mono text-xs">{r.id}</span>
            </div>
          ))}
        </div>
      </section>
      )}

      {/* Shortcut commands (D-054) */}
      {sectionVisible("Shortcut commands") && sectionReady("Shortcut commands") && (
      <section
        ref={shortcutsSectionRef}
        id={sectionDomId("Shortcut commands")}
        className="space-y-4"
      >
        <SectionHeading
          title="Shortcut commands"
          hint="One-click commands for the dropdown on the Broadcast and Terminals pages. Each shortcut is scoped: SSH / WSL (Linux) commands run on SSH hosts and WSL tabs; Command Prompt / PowerShell commands run on local Windows shells. Core shortcuts are built in; add, edit or delete your own."
        />

        {settings && settings.user_shortcuts.length > 0 && (
          <div className="space-y-1">
            {settings.user_shortcuts.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 rounded-md border border-border/40 px-3 py-2 text-sm"
              >
                <span title={SCOPE_LABELS[s.scope]}>
                  <ScopeIcon scope={s.scope} />
                </span>
                {s.label?.trim() ? (
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="truncate">{s.label}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {s.command}
                    </span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {s.command}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => editShortcut(s)}
                  aria-label={`Edit shortcut: ${s.command}`}
                  {...hint("Edit this shortcut command")}
                >
                  <PencilIcon className="text-muted-foreground" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => deleteShortcut(s.id)}
                  aria-label={`Delete shortcut: ${s.command}`}
                  {...hint("Delete this shortcut command")}
                >
                  <Trash2Icon className="text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {shortcutFormOpen ? (
          <div className="max-w-md space-y-3 rounded-md border border-border/40 p-4">
            <div className="grid gap-1">
              <Label htmlFor="shortcut-label">
                Label{" "}
                <span className="text-xs text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="shortcut-label"
                value={shortcutLabel}
                onChange={(e) => setShortcutLabel(e.target.value)}
                placeholder={shortcutScope === "local" ? "List files" : "Disk free"}
                className="text-sm"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                A friendly name shown in the dropdown instead of the raw command.
                Leave blank to show the command itself.
              </p>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="shortcut-cmd">Command</Label>
              <Input
                id="shortcut-cmd"
                value={shortcutCmd}
                onChange={(e) => setShortcutCmd(e.target.value)}
                placeholder={shortcutScope === "local" ? "dir" : "df -h"}
                className={`font-mono text-sm ${
                  shortcutSubmitAttempted && shortcutCmdMissing
                    ? "border-destructive"
                    : ""
                }`}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="shortcut-scope">Runs in</Label>
              <Select
                value={shortcutScope}
                onValueChange={(v) => setShortcutScope(v as ShortcutScope)}
              >
                <SelectTrigger id="shortcut-scope" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ssh">
                    <span className="flex items-center gap-2">
                      <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {SCOPE_LABELS.ssh}
                    </span>
                  </SelectItem>
                  <SelectItem value="local">
                    <span className="flex items-center gap-2">
                      <SquareTerminalIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {SCOPE_LABELS.local}
                    </span>
                  </SelectItem>
                  <SelectItem value="both">
                    <span className="flex items-center gap-2">
                      <SquareAsteriskIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {SCOPE_LABELS.both}
                    </span>
                  </SelectItem>
                  <SelectItem value="serial">
                    <span className="flex items-center gap-2">
                      <CableIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {SCOPE_LABELS.serial}
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                SSH / WSL commands run on SSH hosts and WSL tabs; Command Prompt /
                PowerShell commands run on local Windows shells; Both runs in
                either of those (for example whoami). Serial console stands on
                its own, and Both does not reach it: the far end of a console
                cable is a switch or a firewall rather than a shell, so
                Broadside ships no commands for it and the picker on a serial
                tab stays empty until you add some here.
              </p>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={submitShortcut}>
                {editingShortcutId ? "Save shortcut" : "Add shortcut"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={cancelShortcutForm}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShortcutFormOpen(true)}
            {...hint("Add a shortcut command to the Broadcast/Terminals dropdown")}
          >
            <PlusIcon />
            Add shortcut
          </Button>
        )}

        <div className="space-y-1">
          <p className="pt-2 text-xs font-medium text-muted-foreground">
            Core shortcuts (built in)
          </p>
          {settings?.core_shortcuts.map((c) => (
            <div
              key={`${c.scope}:${c.command}`}
              className="flex items-center gap-3 rounded-md border border-border/30 px-3 py-1.5 text-sm text-muted-foreground"
            >
              <LockIcon className="h-3.5 w-3.5 shrink-0" />
              <span title={SCOPE_LABELS[c.scope]}>
                <ScopeIcon scope={c.scope} />
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {c.command}
              </span>
            </div>
          ))}
        </div>
      </section>
      )}

      {/* Appearance */}
      {sectionVisible("Appearance") && sectionReady("Appearance") && (
      <section id={sectionDomId("Appearance")} className="space-y-4">
        <SectionHeading
          title="Appearance"
          hint="Theme, the font used in terminals, and the overall app font size."
        />
        <div className="grid max-w-md gap-4">
          <div className="grid gap-1">
            <Label>Theme</Label>
            <div className="flex gap-1.5">
              {(["light", "dark", "system"] as const).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={theme === t ? "default" : "outline"}
                  onClick={() => setTheme(t)}
                  className="capitalize"
                >
                  {t}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Dark is the default. “System” follows your OS setting. Applies
              instantly; no Save needed.
            </p>
          </div>
          {/* Only the monospace fonts this machine actually has. It used to be a
              free-text CSS list, which meant a typo or an absent font fell
              through to the next name silently and the only symptom was a
              terminal that looked slightly off. Every entry here has been
              measured (see lib/monospaceFonts) and is drawn in itself, so the
              list doubles as the preview. */}
          <div className="grid gap-1">
            <Label htmlFor="term-font">Terminal font</Label>
            <Select value={termFontFamily} onValueChange={chooseFontFamily}>
              <SelectTrigger id="term-font" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fontOptions.map((f) => (
                  <SelectItem key={f} value={f}>
                    <span
                      className="text-sm"
                      // The generic has no face of its own to show, and the
                      // unrecognised stored value is by definition not
                      // installed, so neither can preview; both are plain.
                      style={
                        f === GENERIC_MONOSPACE || f === unknownFont
                          ? undefined
                          : { fontFamily: cssFontFamily(f) }
                      }
                    >
                      {f === GENERIC_MONOSPACE ? "System monospace" : f}
                    </span>
                    {f === unknownFont && (
                      <span className="text-xs text-muted-foreground">
                        (not installed)
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* "My font is missing" is nearly always a proportional font, and
                nearly always Segoe UI, so the list says what it holds
                rather than only what it excludes. A terminal needs every
                character the same width or nothing lines up: no columns, no
                box drawing, no cursor where the cursor should be. */}
            <p className="text-xs text-muted-foreground">
              {unknownFont !== null
                ? "Your saved font isn't installed on this machine, so it is listed as it was stored and left alone until you pick another."
                : "Fixed-width fonts installed on this machine only. A proportional font (Inter, Segoe UI, Arial) is not offered even when installed, because a terminal needs every character the same width. A font installed while Broadside is running appears after a restart."}{" "}
              Applies as you pick it; no Save needed.
            </p>
          </div>
          {/* The three number boxes are the only things in Appearance that need
              a Save, and they are boxed with it so it is obvious which controls
              it is for. Everything outside this frame writes as you touch it.
              They need one because they are free text: a numeric field has no
              valid intermediate state, and applying per keystroke would take the
              app font through 2px on the way from 16 to 20, which collapses the
              UI you are typing into. The font dropdown above has no such state,
              which is why it left.

              Scrollback makes the same argument in its strongest form. The
              journey from 1000 to 5000 passes through 5, 50 and 500, and each of
              those, applied, would trim every open pane to that many lines and
              throw the rest away. A font size applied too early is ugly for a
              keystroke; a scrollback applied too early destroys output. */}
          <div className="grid max-w-md gap-4 rounded-md border border-border/40 p-4">
            <div className="grid gap-1">
              <Label htmlFor="term-font-size">Terminal font size</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="term-font-size"
                  value={termFontSize}
                  onChange={(e) => setTermFontSize(e.target.value)}
                  className={`w-40 font-mono text-sm ${parsedTermFontSize === undefined ? "border-destructive" : ""}`}
                  autoComplete="off"
                />
                {/* Strict sits with the field it protects, not in a list of
                    toggles somewhere else: it is only about this number. */}
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-sm"
                  {...hint(
                    termFontStrict
                      ? "Strict: only this field changes the size. Ctrl and the wheel are left to the terminal, so mouse reporting works as before."
                      : "Not strict: Ctrl and the mouse wheel over a terminal resize the text, and the new size is saved here as you go.",
                  )}
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={termFontStrict}
                    onChange={(e) => toggleTermFontStrict(e.target.checked)}
                  />
                  <span className="font-medium">Strict</span>
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                8-32 px. Hold <span className="font-medium">Ctrl</span> and turn
                the mouse wheel over a terminal to change it from there; the size
                you land on is saved, no Save needed. Tick{" "}
                <span className="font-medium">Strict</span> to make this field
                the only way to set it, which also hands Ctrl and the wheel back
                to the terminal for anything that wants them itself.
              </p>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="app-font-size">Application font size</Label>
              <Input
                id="app-font-size"
                value={appFontSize}
                onChange={(e) => setAppFontSize(e.target.value)}
                className={`w-40 font-mono text-sm ${parsedAppFontSize === undefined ? "border-destructive" : ""}`}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                12-20 px. Scales the whole UI except terminal panes.
              </p>
            </div>
            {/* Why this is in Appearance rather than Performance, where its cost
                lives: it is a property of a terminal, and the terminal settings
                are here. The memory is said out loud instead. */}
            <div className="grid gap-1">
              <Label htmlFor="term-scrollback">Terminal scrollback</Label>
              <Input
                id="term-scrollback"
                value={scrollback}
                onChange={(e) => setScrollback(e.target.value)}
                className={`w-40 font-mono text-sm ${parsedScrollback === undefined ? "border-destructive" : ""}`}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                0-{MAX_TERMINAL_SCROLLBACK.toLocaleString()} lines kept above the
                top of the screen, per pane. The default is{" "}
                {DEFAULT_UI_PREFS.terminalScrollback.toLocaleString()}; anything
                older is dropped as new output arrives, so a command that prints
                more than this cannot be scrolled back to in full. Costs roughly
                2KB a line at 200 columns, so 5,000 lines is about 12MB{" "}
                <span className="font-medium">for every open pane</span>. 0 keeps
                nothing at all. Applies to terminal tabs and skill panes alike.
              </p>
              {/* Only when it would actually take something away. A warning that
                  is always on the screen is a warning nobody reads by the third
                  visit, and raising the limit loses nothing. */}
              {scrollbackShrinks && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  Lower than the current {currentScrollback.toLocaleString()}.
                  Saving trims every open pane to the new limit straight away, and
                  the lines above it are gone.
                </p>
              )}
            </div>
            <div>
              <Button
                size="sm"
                onClick={saveFontSizes}
                disabled={
                  savingUi ||
                  parsedTermFontSize === undefined ||
                  parsedAppFontSize === undefined ||
                  parsedScrollback === undefined
                }
              >
                {savingUi && <Loader2Icon className="animate-spin" />}
                Save
              </Button>
            </div>
          </div>
          <TableColumnsBox
            title="Host table columns"
            tableName="the Hosts table"
            alwaysShown="Label, hostname and actions"
            hideable={HIDEABLE_COLUMNS}
            orderable={ORDERABLE_COLUMNS}
            {...hostColumns}
          />
          <TableColumnsBox
            title="Profile table columns"
            tableName="the Profiles table (Hosts tab, Profiles side)"
            alwaysShown="Name and actions"
            hideable={PROFILE_HIDEABLE_COLUMNS}
            orderable={PROFILE_ORDERABLE_COLUMNS}
            {...profileColumns}
          />
          <div className="grid gap-1.5">
            <Label>Local shells in the launcher</Label>
            <p className="text-xs text-muted-foreground">
              Choose which detected local shells appear in the Terminals + menu.
              A shell you install later appears automatically (enabled); restart
              Broadside for a newly installed shell to be detected.
            </p>
            {shells.length === 0 ? (
              <p className="pt-1 text-xs text-muted-foreground">
                No local shells detected.
              </p>
            ) : (
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1">
                {shells.map((sh) => (
                  <label
                    key={sh.id}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={!disabledShells.has(sh.id)}
                      onChange={(e) => toggleShell(sh.id, e.target.checked)}
                    />
                    {sh.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      )}

      {/* Custom terminals: user-defined terminal apps (DB-backed). */}
      {sectionVisible("Custom terminals") &&
        sectionReady("Custom terminals") && (
          <CustomTerminalsSection id={sectionDomId("Custom terminals")} />
        )}

      {/* Grid: Terminals grid layout (localStorage, applies on next visit). */}
      {sectionVisible("Sessions") && sectionReady("Sessions") && (
        <SessionsSection id={sectionDomId("Sessions")} />
      )}

      {sectionVisible("Grid") && sectionReady("Grid") && (
        <GridSection id={sectionDomId("Grid")} />
      )}

      {/* Skills: what a run writes down, and where. */}
      {settings && sectionVisible("Skills") && sectionReady("Skills") && (
        <SkillsSection
          id={sectionDomId("Skills")}
          prefs={settings.skill_log}
          onChange={(skill_log) =>
            setSettings((s) => (s ? { ...s, skill_log } : s))
          }
        />
      )}

      {/* Backup & Restore */}
      {sectionVisible("Backup & Restore") && sectionReady("Backup & Restore") && (
      <section id={sectionDomId("Backup & Restore")} className="space-y-3">
        <SectionHeading
          title="Backup & Restore"
          hint="Back up a copy of your hosts, settings, trusted host keys and command history to a folder you pick, or restore an earlier backup. Saved passwords are never included; they stay in Windows Credential Manager."
        />
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary"
            checked={backupIncludeCsv}
            onChange={(e) => setBackupIncludeCsv(e.target.checked)}
          />
          Also export hosts to CSV (re-importable without this backup file)
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={runBackup}
            disabled={backingUp || restoring}
            {...hint("Save a timestamped snapshot of settings and hosts to a folder")}
          >
            {backingUp ? <Loader2Icon className="animate-spin" /> : <ArchiveIcon />}
            Back up now…
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={pickRestoreFile}
            disabled={backingUp || restoring}
            {...hint("Replace all current data with a backup .db file you choose")}
          >
            {restoring ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <RotateCcwIcon />
            )}
            Restore from backup…
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Restoring replaces all current hosts, settings and command history with
          the chosen backup. Saved passwords aren't in a backup, so a restored
          host may need its password re-entered. Custom local shells, trusted
          host keys and security settings are never taken from the file, but
          restore only a backup you made yourself.
        </p>
      </section>
      )}

      <AlertDialog
        open={restorePath !== null}
        onOpenChange={(open) => {
          if (!open && !restoring) setRestorePath(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore from this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces <strong>all current data</strong> (hosts, settings
              and command history) with the contents of{" "}
              <span className="font-mono">{restoreFileName}</span>. Your current
              data will be lost. Saved passwords aren't included in a backup, so
              restored hosts may need their password re-entered. Broadside will
              reload when the restore finishes.
              <br />
              <br />
              <strong>Only restore a backup you made yourself.</strong> A backup
              file is read with the same trust as the app's own database, so one
              from somebody else can decide what your copy of Broadside knows.
              Custom local shells and trusted host keys are never carried over,
              and sudo auto-fill is switched off, so a file cannot decide what
              runs, what is trusted, or where a password gets typed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void runRestore();
              }}
              disabled={restoring}
            >
              {restoring ? (
                <>
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                  Restoring…
                </>
              ) : (
                "Replace my data"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Help */}
      {sectionVisible("Help") && sectionReady("Help") && (
      <section id={sectionDomId("Help")} className="space-y-3">
        <SectionHeading
          title="Help"
          hint="Short help in the bottom bar while you hover over buttons and actions."
        />
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary"
            checked={hintsEnabled}
            onChange={async (e) => {
              const next = e.target.checked;
              try {
                await setHintsEnabled(next);
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          />
          Show help hints
        </label>
      </section>
      )}

      {/* Audit */}
      {sectionVisible("Audit log") && sectionReady("Audit log") && (
      <section id={sectionDomId("Audit log")} className="space-y-3">
        <SectionHeading
          title="Audit log"
          hint="A running record of broadcasts, host-key trust decisions, terminals opened and saved sessions. You can also turn this on or off on the Logs page."
        />
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary"
            checked={auditOn ?? true}
            disabled={auditOn === null}
            onChange={async (e) => {
              const next = e.target.checked;
              try {
                await setAuditEnabled(next);
                setAuditOn(next);
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          />
          Audit logging enabled
        </label>
      </section>
      )}

      {/* Security */}
      {sectionVisible("Security") && sectionReady("Security") && (
      <section id={sectionDomId("Security")} className="space-y-4">
        <SectionHeading
          title="Security"
          hint="Sudo password auto-fill, what a connect leaves in the host's shell history, plus an optional admin lock for the sensitive controls."
        />
        <label
          className={`flex w-fit items-center gap-2 text-sm ${adminLocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
        >
          <input
            type="checkbox"
            className="accent-primary"
            checked={settings?.sudo_autofill_enabled ?? true}
            disabled={settings === null || adminLocked}
            onChange={async (e) => {
              const next = e.target.checked;
              try {
                await setSudoAutofillEnabled(next);
                setSettings((prev) =>
                  prev ? { ...prev, sudo_autofill_enabled: next } : prev,
                );
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          />
          Sudo password auto-fill
        </label>
        <p className="max-w-xl text-xs text-muted-foreground">
          Auto Complete 'sudo' passwords. Turn it <strong>off</strong> to
          disable; Takes effect next time a new terminal is opened. Disabling
          does not delete stored passwords.
        </p>

        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary"
            checked={settings?.history_scrub_enabled ?? false}
            disabled={settings === null}
            onChange={async (e) => {
              const next = e.target.checked;
              try {
                await setHistoryScrubEnabled(next);
                setSettings((prev) =>
                  prev ? { ...prev, history_scrub_enabled: next } : prev,
                );
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          />
          Keep the connect line out of the host's shell history
        </label>
        <p className="max-w-xl text-xs text-muted-foreground">
          Opening an SSH terminal types one setup line at the host, which
          installs command tracking and reprints the login screen. It is written
          with a space in front of it, so any host whose{" "}
          <code>HISTCONTROL</code> ignores space-prefixed commands (the Debian
          and Ubuntu default) never records it. Run{" "}
          <code>{'echo "$HISTCONTROL"'}</code> on a host to see which kind it
          is: an answer with <code>ignorespace</code> or <code>ignoreboth</code>{" "}
          in it is a host where the space is already doing the work and this
          switch changes nothing you can see. Everywhere else bash keeps it,
          and an <strong>Up</strong> arrow finds it instead of your own last
          command. Turn this <strong>on</strong> to have the line delete its own
          entry as it goes past; it only ever removes an entry it has checked is
          its own, so none of your commands are at risk. It is{" "}
          <strong>off</strong> to begin with because a <code>history -d</code>{" "}
          is a write to your machines, and that is your call to make rather than
          ours. Takes effect next time a terminal is opened. zsh offers no way
          to delete a history entry, so this does nothing there.
        </p>

        <DismissedWarnings />

        {/* Admin lock (opt-in), gates the toggle above, credential editing and
            Reset. Authorization only: it stores no key, so a lost passcode never
            loses data (use the recovery code, or remove the lock). */}
        <div className="max-w-xl space-y-3 rounded-md border border-border/40 p-4">
          <div className="flex items-center gap-2">
            <LockIcon className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Admin lock</h3>
            <span
              className={`ml-auto rounded-full px-2 py-0.5 text-xs ${
                !lockStatus?.lock_set
                  ? "bg-muted text-muted-foreground"
                  : adminLocked
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {!lockStatus?.lock_set
                ? "Not set"
                : adminLocked
                  ? "Locked"
                  : "Unlocked"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Optional. When set, changing sudo auto-fill, adding or editing saved
            passwords, and Reset all ask for this passcode. Everyday use (opening
            terminals, broadcasts) never does. It locks again each time the app
            restarts.
          </p>

          {passcodeFormOpen ? (
            <div className="space-y-2">
              <div className="grid gap-1">
                <Label htmlFor="pc-new">
                  {lockStatus?.lock_set ? "New passcode" : "Passcode"}
                </Label>
                <Input
                  id="pc-new"
                  type="password"
                  value={pcNew}
                  onChange={(e) => setPcNew(e.target.value)}
                  className="max-w-xs"
                  autoComplete="new-password"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="pc-confirm">Confirm passcode</Label>
                <Input
                  id="pc-confirm"
                  type="password"
                  value={pcConfirm}
                  onChange={(e) => setPcConfirm(e.target.value)}
                  className="max-w-xs"
                  autoComplete="new-password"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={savePasscode} disabled={pcSaving}>
                  {pcSaving && <Loader2Icon className="animate-spin" />}
                  Save passcode
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPasscodeFormOpen(false);
                    setPcNew("");
                    setPcConfirm("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!lockStatus?.lock_set && (
                <Button
                  size="sm"
                  onClick={() => setPasscodeFormOpen(true)}
                  {...hint("Set an admin passcode to lock the sensitive controls")}
                >
                  Set admin passcode
                </Button>
              )}
              {adminLocked && (
                <>
                  <Button size="sm" onClick={() => setUnlockOpen(true)}>
                    Unlock…
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRecoverOpen(true)}
                    {...hint("Lost the passcode? Reset it with the recovery code")}
                  >
                    Use recovery code
                  </Button>
                </>
              )}
              {lockStatus?.lock_set && !adminLocked && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPasscodeFormOpen(true)}
                  >
                    Change passcode
                  </Button>
                  <Button variant="outline" size="sm" onClick={removeLock}>
                    Remove lock
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </section>
      )}

      {/* Reset everything to defaults (S), guard-railed. */}
      {sectionVisible("Reset") && sectionReady("Reset") && (
      <section id={sectionDomId("Reset")} className="space-y-3">
        <SectionHeading
          title="Reset"
          hint="Restore the whole app to its default preferences."
        />
        <Button
          variant="destructive"
          size="sm"
          disabled={adminLocked}
          onClick={() => setResetOpen(true)}
          {...hint(
            adminLocked
              ? "Locked by the admin passcode; unlock in the Security section first"
              : "Reset every preference (theme, layout, sorts, timeouts, fonts) to defaults",
          )}
        >
          Reset everything to defaults
        </Button>
        {adminLocked && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Reset is locked. Unlock in Settings → Security to enable it.
          </p>
        )}
        {/* Bottom banner help tip explaining exactly what reset does. */}
        <div className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
          This resets <strong>preferences only</strong>: theme, sidebar &amp;
          rail layout, tab order, table column widths &amp; sorting, header
          toggles, the broadcast timeout, fonts, help hints and the tab
          Broadside opens on all go back to their defaults. Your <strong>hosts, credentials, guard rules,
          shortcuts, command history and logs are kept</strong>. The app
          reloads to apply.
        </div>
      </section>
      )}

      {/* Danger Zone: wipe every host + its stored credentials. */}
      {sectionVisible("Danger Zone") && sectionReady("Danger Zone") && (
      <section id={sectionDomId("Danger Zone")} className="space-y-3">
        <SectionHeading
          title="Danger Zone"
          hint="Permanently delete all hosts and their saved credentials."
        />
        <Button
          variant="destructive"
          size="sm"
          disabled={adminLocked}
          onClick={() => setDestroyOpen(true)}
          {...hint(
            adminLocked
              ? "Locked by the admin passcode; unlock in the Security section first"
              : "Delete every host and remove its saved passwords from Windows Credential Manager",
          )}
        >
          Delete all hosts &amp; credentials
        </Button>
        {adminLocked && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Locked. Unlock in Settings → Security to enable it.
          </p>
        )}
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          This <strong>permanently deletes every host</strong> and removes each
          host's saved SSH password, key passphrase and sudo password from
          Windows Credential Manager. It only touches Broadside's own
          credentials. Your <strong>preferences, guard rules, shortcuts, command
          history and the admin lock are kept</strong>. This can't be undone, so
          back up first.
        </div>
      </section>
      )}

      <AlertDialog open={destroyOpen} onOpenChange={setDestroyOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">
              Delete all hosts &amp; credentials?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every host is permanently removed, along with its saved SSH
              password, key passphrase and sudo password in Windows Credential
              Manager. Preferences, guard rules, shortcuts, command history and
              the admin lock are <strong>not</strong> affected. This can't be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={runBackup}
                disabled={backingUp || destroying}
                {...hint("Snapshot the database (and optionally a hosts CSV) before wiping")}
              >
                {backingUp ? (
                  <>
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                    Backing up…
                  </>
                ) : (
                  <>
                    <ArchiveIcon className="h-4 w-4" />
                    Back up first
                  </>
                )}
              </Button>
              {/* Same state as the Backup & Restore section's checkbox, so the
                  two stay in sync (B3.1): toggling here toggles there too. */}
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={backupIncludeCsv}
                  onChange={(e) => setBackupIncludeCsv(e.target.checked)}
                  disabled={destroying}
                />
                Also include hosts CSV
              </label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="destroy-input" className="text-xs font-normal">
                Type <span className="font-mono font-semibold">DESTROY</span> to
                enable deletion (case-sensitive)
              </Label>
              <Input
                id="destroy-input"
                value={destroyTyped}
                onChange={(e) => setDestroyTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                disabled={destroying}
              />
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={destroying}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!destroyArmed || destroying}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog up while the wipe runs
                destroyHosts();
              }}
            >
              {destroying ? "Deleting…" : "Delete everything"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset everything to defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              Every preference returns to its default and the app reloads:
              theme, fonts, layouts, column widths and order, sorts, timeouts,
              the tab Broadside opens on, and the warnings you dismissed. Hosts,
              credentials, saved shell profiles, templates, skills, guard rules,
              shortcuts, command history and logs are <strong>not</strong>{" "}
              affected. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault(); // keep the dialog up until reload fires
                resetEverything();
              }}
              disabled={resetting}
            >
              Reset everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rule help-tip modal, the Dialog overlay blurs the window behind it. */}
      <Dialog
        open={helpRule !== null}
        onOpenChange={(open) => !open && setHelpRule(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{helpRule?.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-wrap pt-1">
              {helpRule?.tip}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      {/* Admin-lock: unlock prompt for this session. */}
      <AdminUnlockDialog
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
        onUnlocked={refreshLock}
      />

      {/* One-time recovery code, shown once after set/reset. */}
      <Dialog
        open={recoveryCode !== null}
        onOpenChange={(open) => !open && setRecoveryCode(null)}
      >
        <DialogContent keepOpenOnOutsideClick>
          <DialogHeader>
            <DialogTitle>Save your recovery code</DialogTitle>
            <DialogDescription>
              This is shown <strong>once</strong>. Store it somewhere safe; it's
              the only way to reset the admin passcode if you forget it. It is not
              kept in readable form.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-center font-mono text-sm tracking-wider">
            {recoveryCode}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (recoveryCode) {
                  navigator.clipboard?.writeText(recoveryCode).then(
                    () => toast.success("Recovery code copied"),
                    () => {},
                  );
                }
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setRecoveryCode(null)}>I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset the passcode with the recovery code. */}
      <Dialog open={recoverOpen} onOpenChange={setRecoverOpen}>
        <DialogContent keepOpenOnOutsideClick>
          <DialogHeader>
            <DialogTitle>Reset admin passcode</DialogTitle>
            <DialogDescription>
              Enter your recovery code and a new passcode. This issues a fresh
              recovery code.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="rec-code">Recovery code</Label>
              <Input
                id="rec-code"
                value={recCode}
                onChange={(e) => setRecCode(e.target.value)}
                className="font-mono"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rec-new">New passcode</Label>
              <Input
                id="rec-new"
                type="password"
                value={recNewPc}
                onChange={(e) => setRecNewPc(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecoverOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitRecover}>Reset passcode</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
