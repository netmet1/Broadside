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
  SearchIcon,
  Trash2Icon,
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
import { auditInfo, setAuditEnabled } from "@/lib/tauri/logs";
import { useHint, useStatus } from "@/lib/status";
import { useUiPrefs } from "@/lib/uiPrefs";
import {
  type AppSettings,
  type HostLatency,
  type ShortcutCommand,
  type UserRule,
  backupAppData,
  getAppSettings,
  networkProbe,
  recalibrateProbe,
  saveGuardRules,
  saveShortcuts,
  setAppSettings,
  setUiSettings,
} from "@/lib/tauri/settings";

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="font-heading text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Stable DOM id for a settings section, used by the jump-to dropdown. */
function sectionDomId(title: string): string {
  return "settings-sec-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

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
  const hint = useHint();

  // Section search — filters which settings sections are shown.
  const [query, setQuery] = useState("");
  const sectionVisible = useCallback(
    (title: string) =>
      query.trim() === "" ||
      title.toLowerCase().includes(query.trim().toLowerCase()),
    [query],
  );
  const SECTION_TITLES = [
    "Performance",
    "Network probe",
    "Destructive command guard",
    "Shortcut commands",
    "Appearance",
    "Backup",
    "Help",
    "Audit log",
  ];
  const anyVisible = SECTION_TITLES.some(sectionVisible);

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
      toast.success(`Probe complete — suggests ${probe.suggested_max_sessions} sessions`);
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
    const next = editingShortcutId
      ? settings.user_shortcuts.map((s) =>
          s.id === editingShortcutId ? { ...s, command: cmd } : s,
        )
      : [
          ...settings.user_shortcuts,
          { id: `shortcut-${crypto.randomUUID().slice(0, 8)}`, command: cmd },
        ];
    if (await persistShortcuts(next)) {
      setShortcutCmd("");
      setEditingShortcutId(null);
      setShortcutSubmitAttempted(false);
      setShortcutFormOpen(false);
    }
  };

  const editShortcut = (s: ShortcutCommand) => {
    setEditingShortcutId(s.id);
    setShortcutCmd(s.command);
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

  const probe = settings?.local_probe ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-10 p-6 pb-16">
      <div className="flex items-center justify-between gap-4">
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
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sections…"
              className="h-8 pl-8 text-sm"
              aria-label="Search settings sections"
              {...hint("Filter the settings sections by name")}
            />
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
          hint="The local probe suggests a concurrency ceiling from this machine's resources. Suggestions are advisory — your override wins."
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
                Not probed yet — run Recalibrate to measure this machine.
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
              Leave empty to follow the probe suggestion. 1–2048.
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
            <p className="text-xs text-muted-foreground">1–3600. Overridable per command.</p>
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
          hint="TCP connect timing against every configured host, on demand."
        />
        <Button
          variant="outline"
          size="sm"
          onClick={runNetworkProbe}
          disabled={probing}
          {...hint("Measure TCP connect latency to every configured host")}
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
          hint="Broadcasts matching a rule require typed CONFIRM before they run. Core rules are built in and cannot be removed in v0.1a; your own rules can be toggled or deleted."
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
                  Command names can't contain spaces — separate multiple
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
          hint="One-click commands for the dropdown on the Broadcast and Terminals pages. Core shortcuts are built in; add, edit or delete your own."
        />

        {settings && settings.user_shortcuts.length > 0 && (
          <div className="space-y-1">
            {settings.user_shortcuts.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 rounded-md border border-border/40 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {s.command}
                </span>
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
              <Label htmlFor="shortcut-cmd">Command</Label>
              <Input
                id="shortcut-cmd"
                value={shortcutCmd}
                onChange={(e) => setShortcutCmd(e.target.value)}
                placeholder="df -h"
                className={`font-mono text-sm ${
                  shortcutSubmitAttempted && shortcutCmdMissing
                    ? "border-destructive"
                    : ""
                }`}
                autoComplete="off"
              />
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
          {settings?.core_shortcuts.map((cmd) => (
            <div
              key={cmd}
              className="flex items-center gap-3 rounded-md border border-border/30 px-3 py-1.5 text-sm text-muted-foreground"
            >
              <LockIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{cmd}</span>
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
          hint="Terminal font applies to the xterm panes; application font size scales the rest of the UI."
        />
        <div className="grid max-w-md gap-4">
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
            <p className="text-xs text-muted-foreground">8–32 px.</p>
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
              12–20 px. Scales the whole UI except terminal panes.
            </p>
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

      {/* Backup */}
      {sectionVisible("Backup") && (
      <section id={sectionDomId("Backup")} className="space-y-3">
        <SectionHeading
          title="Backup"
          hint="Snapshots the database — hosts, settings, trusted host keys and command history — into a folder you pick. Credentials are never included; they stay in Windows Credential Manager."
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
        <Button
          variant="outline"
          size="sm"
          onClick={runBackup}
          disabled={backingUp}
          {...hint("Save a timestamped snapshot of settings and hosts to a folder")}
        >
          {backingUp ? <Loader2Icon className="animate-spin" /> : <ArchiveIcon />}
          Back up now…
        </Button>
      </section>
      )}

      {/* Help */}
      {sectionVisible("Help") && (
      <section id={sectionDomId("Help")} className="space-y-3">
        <SectionHeading
          title="Help"
          hint="Contextual hints in the bottom bar while hovering buttons and actions."
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
          hint="Rolling record of broadcasts, key-trust decisions, PTY opens and session saves. Also toggleable on the Logs page."
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
    </div>
  );
}
