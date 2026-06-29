import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArchiveIcon,
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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
import {
  HIDEABLE_COLUMNS,
  loadHiddenCols,
  saveHiddenCols,
} from "@/lib/hostColumns";
import {
  reconcileDisabledShells,
  saveDisabledShells,
} from "@/lib/localShellPrefs";
import { type LocalShell, listLocalShells } from "@/lib/tauri/local";
import { auditInfo, setAuditEnabled } from "@/lib/tauri/logs";
import { useHint, useStatus } from "@/lib/status";
import { useTheme } from "next-themes";

import { useUiPrefs } from "@/lib/uiPrefs";
import {
  type AppSettings,
  type HostLatency,
  type ShortcutCommand,
  type ShortcutScope,
  type UserRule,
  backupAppData,
  restoreAppData,
  destroyAllHosts,
  getAppSettings,
  networkProbe,
  recalibrateProbe,
  resetAppSettings,
  saveGuardRules,
  saveShortcuts,
  setAppSettings,
  setSudoAutofillEnabled,
  setUiSettings,
} from "@/lib/tauri/settings";
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
  SECTION_SCROLL_KEY,
  SECTION_TITLES,
  SEARCH_STORAGE_KEY,
  STICKY_OFFSET_PX,
  sectionDomId,
} from "@/pages/settings/constants";
import { ScopeIcon, SectionHeading } from "@/pages/settings/shared";
import { useAdminLock } from "@/pages/settings/useAdminLock";

export function SettingsPage({
  focusSection = null,
  onFocusConsumed,
}: {
  /** Section to scroll to after mount (e.g. "shortcuts" from the
   * "Manage shortcuts…" entry on Broadcast/Terminals). */
  focusSection?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const { hintsEnabled, setHintsEnabled } = useStatus();
  const { prefs, apply: applyUiPrefs } = useUiPrefs();
  const { theme, setTheme } = useTheme();
  const hint = useHint();

  // Host-table column visibility (Appearance). Read by the Hosts tab on mount;
  // saved immediately on toggle.
  const [hiddenCols, setHiddenCols] = useState(loadHiddenCols);
  const toggleColumn = (id: string, visible: boolean) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      saveHiddenCols(next);
      return next;
    });
  };

  // Local-shell launcher visibility (Appearance). The detected shells plus the
  // user's hide list (stored by id); the Terminals "+" menu reads the same list.
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [disabledShells, setDisabledShells] = useState<Set<string>>(new Set());
  useEffect(() => {
    listLocalShells()
      .then((s) => {
        setShells(s);
        setDisabledShells(reconcileDisabledShells(s.map((x) => x.id)));
      })
      .catch(() => {
        // Non-fatal: the section just shows "no local shells detected".
      });
  }, []);
  const toggleShell = (id: string, enabled: boolean) => {
    setDisabledShells((prev) => {
      const next = new Set(prev);
      if (enabled) next.delete(id);
      else next.add(id);
      saveDisabledShells(next);
      return next;
    });
  };

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

  // Reset-everything-to-defaults (with a guard rail).
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resetEverything = async () => {
    setResetting(true);
    try {
      await resetAppSettings();
    } catch (e) {
      toast.error(errorMessage(e));
      setResetting(false);
      return;
    }
    // localStorage/sessionStorage hold only UI prefs in this app (theme, tab
    // order, sort, column widths, rail/header toggles) — clearing them resets
    // every persisted preference. Reload so all providers re-init from defaults.
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
  useEffect(() => {
    if (!destroyOpen) setDestroyTyped("");
  }, [destroyOpen]);
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

  // Section search — filters which settings sections are shown. Restored from
  // sessionStorage so it survives leaving and returning to the Settings tab.
  const [query, setQuery] = useState(
    () => sessionStorage.getItem(SEARCH_STORAGE_KEY) ?? "",
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    sessionStorage.setItem(SEARCH_STORAGE_KEY, query);
  }, [query]);
  const sectionVisible = useCallback(
    (title: string) =>
      query.trim() === "" ||
      title.toLowerCase().includes(query.trim().toLowerCase()),
    [query],
  );
  const anyVisible = SECTION_TITLES.some(sectionVisible);

  // The page scroll lives on the shared <main>; remember the section nearest
  // the top as the user scrolls so returning to Settings restores that spot.
  // Saving is gated until the restore below has run: when this tab remounts,
  // the shared <main> can be clamped to a shorter scrollHeight (e.g. coming
  // back from the taller Help page), which fires a scroll event. Saving that
  // clamped position would overwrite the real saved section with a near-bottom
  // one before the restore reads it (the Settings<->Help drift bug).
  const rootRef = useRef<HTMLDivElement>(null);
  const saveEnabled = useRef(false);
  useEffect(() => {
    const scroller = rootRef.current?.closest("main");
    if (!scroller) return;
    let raf = 0;
    const save = () => {
      raf = 0;
      if (!saveEnabled.current) return;
      const anchor = scroller.getBoundingClientRect().top + STICKY_OFFSET_PX;
      let best: string | null = null;
      let bestDist = Infinity;
      for (const title of SECTION_TITLES) {
        const el = document.getElementById(sectionDomId(title));
        if (!el) continue;
        const dist = Math.abs(el.getBoundingClientRect().top - anchor);
        if (dist < bestDist) {
          bestDist = dist;
          best = title;
        }
      }
      if (best) sessionStorage.setItem(SECTION_SCROLL_KEY, best);
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(save);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Restore the last-viewed section when returning to the tab — once per mount,
  // and never when a deep-link (focusSection) is steering the scroll instead.
  const didRestoreScroll = useRef(false);
  useEffect(() => {
    if (didRestoreScroll.current) return;
    // A deep-link (focusSection) owns the scroll — let it win, don't restore.
    if (focusSection) {
      didRestoreScroll.current = true;
      saveEnabled.current = true;
      return;
    }
    // Wait until the async settings (and the probe panel they render) have
    // loaded: restoring before that lets the Performance section grow AFTER we
    // scroll, pushing the target down so we land above it (the reported drift).
    if (!settings) return;
    didRestoreScroll.current = true;
    const saved = sessionStorage.getItem(SECTION_SCROLL_KEY);
    if (!saved || saved === SECTION_TITLES[0]) {
      // Nothing meaningful to restore. Reset to the top so we don't keep the
      // scroll position inherited from the previously shown (possibly taller)
      // page, which the browser clamps to this page's bottom (the lingering
      // Settings<->Help "lands at the bottom" case).
      rootRef.current?.closest("main")?.scrollTo({ top: 0 });
      saveEnabled.current = true;
      return;
    }
    // Double rAF: let this commit paint, then scroll once layout is settled.
    // Only enable saving AFTER the restore scroll lands, so the restore itself
    // (and any clamp on remount) cannot clobber the saved section.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .getElementById(sectionDomId(saved))
          ?.scrollIntoView({ block: "start" });
        saveEnabled.current = true;
      }),
    );
  }, [settings, focusSection]);

  // Jump-to-section dropdown: picking a section clears any search filter (so
  // the target is mounted) and smooth-scrolls to it — no button needed.
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const goToSection = useCallback((title: string) => {
    setQuery("");
    setPendingScroll(title);
  }, []);
  useEffect(() => {
    if (!pendingScroll) return;
    document
      .getElementById(sectionDomId(pendingScroll))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setPendingScroll(null);
  }, [pendingScroll]);

  // Performance section (saved together via Save)
  const [maxSessions, setMaxSessions] = useState("");
  const [defaultTimeout, setDefaultTimeout] = useState("30");
  const [savingPerf, setSavingPerf] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);

  // Network probe
  const [probing, setProbing] = useState(false);
  const [latencies, setLatencies] = useState<HostLatency[] | null>(null);

  // Audit
  const [auditOn, setAuditOn] = useState<boolean | null>(null);

  // Guard rule form
  const [formOpen, setFormOpen] = useState(false);
  const [ruleDesc, setRuleDesc] = useState("");
  const [ruleCommands, setRuleCommands] = useState("");
  const [ruleFlags, setRuleFlags] = useState("");
  const [rulePaths, setRulePaths] = useState("");
  const [ruleArgs, setRuleArgs] = useState("");
  const [ruleTip, setRuleTip] = useState("");
  // Drives the red outline on required fields after a failed submit.
  const [ruleSubmitAttempted, setRuleSubmitAttempted] = useState(false);
  // Backend rejection message shown inline in the form (keeps it open).
  const [ruleError, setRuleError] = useState<string | null>(null);

  // Help-tip modal (core + user rules)
  const [helpRule, setHelpRule] = useState<{ title: string; tip: string } | null>(
    null,
  );

  // Shortcut commands (D-054)
  const [shortcutFormOpen, setShortcutFormOpen] = useState(false);
  const [shortcutCmd, setShortcutCmd] = useState("");
  const [shortcutLabel, setShortcutLabel] = useState("");
  const [shortcutScope, setShortcutScope] = useState<ShortcutScope>("ssh");
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [shortcutSubmitAttempted, setShortcutSubmitAttempted] = useState(false);
  const shortcutsSectionRef = useRef<HTMLElement>(null);

  // Appearance
  const [termFontFamily, setTermFontFamily] = useState("");
  const [termFontSize, setTermFontSize] = useState("13");
  const [appFontSize, setAppFontSize] = useState("16");
  const [savingUi, setSavingUi] = useState(false);

  // Backup
  const [backupIncludeCsv, setBackupIncludeCsv] = useState(true);
  const [backingUp, setBackingUp] = useState(false);

  // Restore: picking a backup file opens a confirmation (it overwrites all
  // current data); confirming runs the restore and reloads the app.
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const restoreFileName = restorePath?.split(/[\\/]/).pop() ?? null;

  const load = useCallback(async () => {
    try {
      const s = await getAppSettings();
      setSettings(s);
      setMaxSessions(
        s.max_concurrent_sessions !== null ? String(s.max_concurrent_sessions) : "",
      );
      setDefaultTimeout(String(s.default_timeout_secs));
      setTermFontFamily(s.terminal_font_family);
      setTermFontSize(String(s.terminal_font_size));
      setAppFontSize(String(s.app_font_size));
    } catch (e) {
      toast.error(errorMessage(e));
    }
    try {
      setAuditOn((await auditInfo()).enabled);
    } catch {
      // Audit info is non-critical for this page.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep-link scroll (e.g. "Manage shortcuts…" from Broadcast/Terminals).
  useEffect(() => {
    if (focusSection === "shortcuts" && settings) {
      shortcutsSectionRef.current?.scrollIntoView({ behavior: "smooth" });
      onFocusConsumed?.();
    }
  }, [focusSection, settings, onFocusConsumed]);

  const parsedMaxSessions = (() => {
    if (maxSessions.trim() === "") return null; // follow suggestion
    const n = Number(maxSessions);
    return Number.isInteger(n) && n >= 1 && n <= 2048 ? n : undefined;
  })();
  const parsedTimeout = (() => {
    const n = Number(defaultTimeout);
    return Number.isInteger(n) && n >= 1 && n <= 3600 ? n : undefined;
  })();
  const parsedTermFontSize = (() => {
    const n = Number(termFontSize);
    return Number.isInteger(n) && n >= 8 && n <= 32 ? n : undefined;
  })();
  const parsedAppFontSize = (() => {
    const n = Number(appFontSize);
    return Number.isInteger(n) && n >= 12 && n <= 20 ? n : undefined;
  })();

  const savePerf = async () => {
    if (parsedMaxSessions === undefined || parsedTimeout === undefined) return;
    setSavingPerf(true);
    try {
      await setAppSettings({
        max_concurrent_sessions: parsedMaxSessions,
        default_timeout_secs: parsedTimeout,
      });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingPerf(false);
    }
  };

  const saveAppearance = async () => {
    if (parsedTermFontSize === undefined || parsedAppFontSize === undefined) {
      return;
    }
    setSavingUi(true);
    try {
      await setUiSettings({
        terminal_font_family: termFontFamily.trim(),
        terminal_font_size: parsedTermFontSize,
        app_font_size: parsedAppFontSize,
      });
      applyUiPrefs({
        terminalFontFamily:
          termFontFamily.trim() || prefs.terminalFontFamily,
        terminalFontSize: parsedTermFontSize,
        appFontSize: parsedAppFontSize,
      });
      toast.success("Appearance saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingUi(false);
    }
  };

  const recalibrate = async () => {
    setRecalibrating(true);
    try {
      const probe = await recalibrateProbe();
      setSettings((prev) => (prev ? { ...prev, local_probe: probe } : prev));
      toast.success(`Probe complete: suggests ${probe.suggested_max_sessions} sessions`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRecalibrating(false);
    }
  };

  const runNetworkProbe = async () => {
    setProbing(true);
    try {
      setLatencies(await networkProbe());
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setProbing(false);
    }
  };

  /** Wholesale-replace persistence — the backend validates each rule.
   * Returns whether the save succeeded; the caller decides what to do with a
   * failure (the add-rule form keeps itself open so input isn't lost). */
  const persistRules = async (rules: UserRule[]): Promise<string | null> => {
    try {
      await saveGuardRules(rules);
      setSettings((prev) => (prev ? { ...prev, user_rules: rules } : prev));
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  };

  const splitList = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const ruleDescMissing = ruleDesc.trim().length === 0;
  const ruleCommandTokens = splitList(ruleCommands);
  const ruleCommandsMissing = ruleCommandTokens.length === 0;
  // The backend rejects command names containing whitespace; catch it here so
  // the field can be highlighted instead of the save failing with a toast.
  const ruleCommandsHaveSpace = ruleCommandTokens.some((c) => /\s/.test(c));
  const ruleCommandsInvalid = ruleCommandsMissing || ruleCommandsHaveSpace;

  const addRule = async () => {
    if (!settings) return;
    // Invalid input keeps the form open with everything intact and the
    // offending field(s) highlighted — no reset, no disappearing form.
    if (ruleDescMissing || ruleCommandsInvalid) {
      setRuleSubmitAttempted(true);
      setRuleError(null);
      return;
    }
    const tip = ruleTip.trim();
    const rule: UserRule = {
      id: `user-${crypto.randomUUID().slice(0, 8)}`,
      description: ruleDesc.trim(),
      commands: ruleCommandTokens,
      required_flags: splitList(ruleFlags),
      path_patterns: splitList(rulePaths),
      arg_all_of: splitList(ruleArgs),
      help_tip: tip.length > 0 ? tip : null,
      enabled: true,
    };
    const err = await persistRules([...settings.user_rules, rule]);
    if (err) {
      // Backend rejected it — keep the form open so the user can fix it.
      setRuleError(err);
      setRuleSubmitAttempted(true);
      return;
    }
    setRuleDesc("");
    setRuleCommands("");
    setRuleFlags("");
    setRulePaths("");
    setRuleArgs("");
    setRuleTip("");
    setRuleSubmitAttempted(false);
    setRuleError(null);
    setFormOpen(false);
  };

  const toggleRule = async (id: string) => {
    if (!settings) return;
    const err = await persistRules(
      settings.user_rules.map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      ),
    );
    if (err) toast.error(err);
  };

  const deleteRule = async (id: string) => {
    if (!settings) return;
    const err = await persistRules(settings.user_rules.filter((r) => r.id !== id));
    if (err) toast.error(err);
  };

  /** Wholesale-replace persistence for shortcuts (mirrors guard rules). */
  const persistShortcuts = async (shortcuts: ShortcutCommand[]) => {
    try {
      await saveShortcuts(shortcuts);
      setSettings((prev) => (prev ? { ...prev, user_shortcuts: shortcuts } : prev));
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  };

  const shortcutCmdMissing = shortcutCmd.trim().length === 0;

  const submitShortcut = async () => {
    if (!settings) return;
    if (shortcutCmdMissing) {
      setShortcutSubmitAttempted(true);
      toast.error("Command is required");
      return;
    }
    const cmd = shortcutCmd.trim();
    const label = shortcutLabel.trim() || null; // empty label = show the command
    const next = editingShortcutId
      ? settings.user_shortcuts.map((s) =>
          s.id === editingShortcutId
            ? { ...s, command: cmd, scope: shortcutScope, label }
            : s,
        )
      : [
          ...settings.user_shortcuts,
          {
            id: `shortcut-${crypto.randomUUID().slice(0, 8)}`,
            command: cmd,
            scope: shortcutScope,
            label,
          },
        ];
    if (await persistShortcuts(next)) {
      setShortcutCmd("");
      setShortcutLabel("");
      setShortcutScope("ssh");
      setEditingShortcutId(null);
      setShortcutSubmitAttempted(false);
      setShortcutFormOpen(false);
    }
  };

  const editShortcut = (s: ShortcutCommand) => {
    setEditingShortcutId(s.id);
    setShortcutCmd(s.command);
    setShortcutLabel(s.label ?? "");
    setShortcutScope(s.scope);
    setShortcutSubmitAttempted(false);
    setShortcutFormOpen(true);
  };

  const deleteShortcut = (id: string) => {
    if (!settings) return;
    persistShortcuts(settings.user_shortcuts.filter((s) => s.id !== id));
  };

  const runBackup = async () => {
    try {
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a backup folder",
      });
      if (typeof dir !== "string") return;
      setBackingUp(true);
      const report = await backupAppData(dir, backupIncludeCsv);
      toast.success(
        report.csv_path
          ? `Backed up database (${report.host_count} hosts) + hosts CSV`
          : `Backed up database (${report.host_count} hosts)`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBackingUp(false);
    }
  };

  // Restore step 1: pick a backup .db file, then open the confirm dialog.
  const pickRestoreFile = async () => {
    try {
      const path = await openDialog({
        directory: false,
        multiple: false,
        title: "Choose a Broadside backup (.db)",
        filters: [{ name: "Broadside backup", extensions: ["db"] }],
      });
      if (typeof path !== "string") return;
      setRestorePath(path);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Restore step 2: overwrite the live database with the chosen snapshot, then
  // reload so every page re-reads the restored data from the (persistent) Rust
  // connection. Credentials aren't in a backup, so restored hosts re-prompt.
  const runRestore = async () => {
    if (!restorePath) return;
    setRestoring(true);
    try {
      const report = await restoreAppData(restorePath);
      toast.success(
        `Restored ${report.host_count} ${
          report.host_count === 1 ? "host" : "hosts"
        } — reloading…`,
      );
      setRestorePath(null);
      setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      toast.error(errorMessage(e));
      setRestoring(false);
    }
  };

  const probe = settings?.local_probe ?? null;

  return (
    <div ref={rootRef} className="mx-auto max-w-3xl space-y-10 p-6 pb-16">
      {/* Sticky header (S2): the jump-to dropdown + search stay pinned to the
          top of the tab while the sections scroll. -mx-6/px-6 lets the
          background span the page padding so content doesn't peek at the edges. */}
      <div className="sticky top-0 z-20 -mx-6 -mt-6 flex items-center justify-between gap-4 border-b border-border/50 bg-background px-6 py-3">
        <h1 className="font-heading text-lg font-semibold">Settings</h1>
        <div className="flex items-center gap-2">
          <Select value="" onValueChange={goToSection}>
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
              {...hint("Filter the settings sections by name")}
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

      {/* Performance / probe */}
      {sectionVisible("Performance") && (
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
          <div>
            <Button
              size="sm"
              onClick={savePerf}
              disabled={
                savingPerf ||
                parsedMaxSessions === undefined ||
                parsedTimeout === undefined
              }
            >
              {savingPerf && <Loader2Icon className="animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </section>
      )}

      {/* Network probe */}
      {sectionVisible("Network probe") && (
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
      {sectionVisible("Destructive command guard") && (
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
      {sectionVisible("Shortcut commands") && (
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
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                SSH / WSL commands run on SSH hosts and WSL tabs; Command Prompt /
                PowerShell commands run on local Windows shells; Both runs in
                every terminal (for example whoami).
              </p>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={submitShortcut}>
                {editingShortcutId ? "Save shortcut" : "Add shortcut"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShortcutFormOpen(false);
                  setEditingShortcutId(null);
                  setShortcutCmd("");
                  setShortcutLabel("");
                  setShortcutScope("ssh");
                  setShortcutSubmitAttempted(false);
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
      {sectionVisible("Appearance") && (
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
          <div className="grid gap-1">
            <Label htmlFor="term-font">Terminal font</Label>
            <Input
              id="term-font"
              value={termFontFamily}
              onChange={(e) => setTermFontFamily(e.target.value)}
              placeholder="Consolas, 'Cascadia Mono', monospace"
              className="font-mono text-sm"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              CSS font-family list; the font must be installed on this machine.
            </p>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="term-font-size">Terminal font size</Label>
            <Input
              id="term-font-size"
              value={termFontSize}
              onChange={(e) => setTermFontSize(e.target.value)}
              className={`w-40 font-mono text-sm ${parsedTermFontSize === undefined ? "border-destructive" : ""}`}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">8-32 px.</p>
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
          <div className="grid gap-1.5">
            <Label>Host table columns</Label>
            <p className="text-xs text-muted-foreground">
              Hide nice-to-have columns from the Hosts table. Label, hostname
              and actions always show.
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1">
              {HIDEABLE_COLUMNS.map((col) => (
                <label
                  key={col.id}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={!hiddenCols.has(col.id)}
                    onChange={(e) => toggleColumn(col.id, e.target.checked)}
                  />
                  {col.label}
                </label>
              ))}
            </div>
          </div>
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
          <div>
            <Button
              size="sm"
              onClick={saveAppearance}
              disabled={
                savingUi ||
                parsedTermFontSize === undefined ||
                parsedAppFontSize === undefined
              }
            >
              {savingUi && <Loader2Icon className="animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </section>
      )}

      {/* Backup & Restore */}
      {sectionVisible("Backup & Restore") && (
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
          Restoring replaces all current hosts, settings, trusted host keys and
          command history with the chosen backup. Saved passwords aren't in a
          backup, so a restored host may need its password re-entered.
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
              This replaces <strong>all current data</strong> — hosts, settings,
              trusted host keys and command history — with the contents of{" "}
              <span className="font-mono">{restoreFileName}</span>. Your current
              data will be lost. Saved passwords aren't included in a backup, so
              restored hosts may need their password re-entered. Broadside will
              reload when the restore finishes.
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
      {sectionVisible("Help") && (
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
      {sectionVisible("Audit log") && (
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
      {sectionVisible("Security") && (
      <section id={sectionDomId("Security")} className="space-y-4">
        <SectionHeading
          title="Security"
          hint="Sudo password auto-fill, plus an optional admin lock for the sensitive controls."
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

        {/* Admin lock (opt-in) — gates the toggle above, credential editing and
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

      {/* Reset everything to defaults (S) — guard-railed. */}
      {sectionVisible("Reset") && (
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
          toggles, the broadcast timeout, fonts and help hints all go back to
          their defaults. Your <strong>hosts, credentials, guard rules,
          shortcuts, command history and logs are kept</strong>. The app
          reloads to apply.
        </div>
      </section>
      )}

      {/* Danger Zone — wipe every host + its stored credentials. */}
      {sectionVisible("Danger Zone") && (
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
              Every preference returns to its default and the app reloads.
              Hosts, credentials, guard rules, shortcuts, command history and
              logs are <strong>not</strong> affected. This can't be undone.
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

      {/* Rule help-tip modal — the Dialog overlay blurs the window behind it. */}
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
        <DialogContent>
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
        <DialogContent>
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
  );
}
