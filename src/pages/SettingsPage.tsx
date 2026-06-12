import { useCallback, useEffect, useState } from "react";
import {
  Loader2Icon,
  LockIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/tauri/hosts";
import { auditInfo, setAuditEnabled } from "@/lib/tauri/logs";
import { useStatus } from "@/lib/status";
import {
  type AppSettings,
  type HostLatency,
  type UserRule,
  getAppSettings,
  networkProbe,
  recalibrateProbe,
  saveGuardRules,
  setAppSettings,
} from "@/lib/tauri/settings";

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="font-heading text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const { hintsEnabled, setHintsEnabled } = useStatus();

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

  const load = useCallback(async () => {
    try {
      const s = await getAppSettings();
      setSettings(s);
      setMaxSessions(
        s.max_concurrent_sessions !== null ? String(s.max_concurrent_sessions) : "",
      );
      setDefaultTimeout(String(s.default_timeout_secs));
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

  const parsedMaxSessions = (() => {
    if (maxSessions.trim() === "") return null; // follow suggestion
    const n = Number(maxSessions);
    return Number.isInteger(n) && n >= 1 && n <= 2048 ? n : undefined;
  })();
  const parsedTimeout = (() => {
    const n = Number(defaultTimeout);
    return Number.isInteger(n) && n >= 1 && n <= 3600 ? n : undefined;
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

  /** Wholesale-replace persistence — the backend validates each rule. */
  const persistRules = async (rules: UserRule[]) => {
    try {
      await saveGuardRules(rules);
      setSettings((prev) => (prev ? { ...prev, user_rules: rules } : prev));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const splitList = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const addRule = async () => {
    if (!settings) return;
    const rule: UserRule = {
      id: `user-${crypto.randomUUID().slice(0, 8)}`,
      description: ruleDesc.trim(),
      commands: splitList(ruleCommands),
      required_flags: splitList(ruleFlags),
      path_patterns: splitList(rulePaths),
      arg_all_of: splitList(ruleArgs),
      enabled: true,
    };
    if (!rule.description || rule.commands.length === 0) {
      toast.error("Description and at least one command are required");
      return;
    }
    await persistRules([...settings.user_rules, rule]);
    setRuleDesc("");
    setRuleCommands("");
    setRuleFlags("");
    setRulePaths("");
    setRuleArgs("");
    setFormOpen(false);
  };

  const toggleRule = (id: string) => {
    if (!settings) return;
    persistRules(
      settings.user_rules.map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      ),
    );
  };

  const deleteRule = (id: string) => {
    if (!settings) return;
    persistRules(settings.user_rules.filter((r) => r.id !== id));
  };

  const probe = settings?.local_probe ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-10 p-6 pb-16">
      <h1 className="font-heading text-lg font-semibold">Settings</h1>

      {/* Performance / probe */}
      <section className="space-y-4">
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
          <Button variant="outline" size="sm" onClick={recalibrate} disabled={recalibrating}>
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

      {/* Network probe */}
      <section className="space-y-4">
        <SectionHeading
          title="Network probe"
          hint="TCP connect timing against every configured host, on demand."
        />
        <Button variant="outline" size="sm" onClick={runNetworkProbe} disabled={probing}>
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

      {/* Destructive guard rules */}
      <section className="space-y-4">
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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => deleteRule(r.id)}
                  aria-label={`Delete rule: ${r.description}`}
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
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rule-commands">Command names</Label>
              <Input
                id="rule-commands"
                value={ruleCommands}
                onChange={(e) => setRuleCommands(e.target.value)}
                placeholder="docker, podman"
                className="font-mono text-sm"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated. The rule fires when any of these is the command.
              </p>
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
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={addRule}>
                Add rule
              </Button>
              <Button variant="outline" size="sm" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
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
              <span className="min-w-0 flex-1 truncate">{r.description}</span>
              <span className="font-mono text-xs">{r.id}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Help */}
      <section className="space-y-3">
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

      {/* Audit */}
      <section className="space-y-3">
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
    </div>
  );
}
