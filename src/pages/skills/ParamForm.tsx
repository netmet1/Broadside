import { useEffect, useMemo, useState } from "react";
import { Loader2Icon, TerminalIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, type Host } from "@/lib/tauri/hosts";
import {
  parseSequence,
  skillPreflight,
  type Skill,
  type SkillPreflight,
} from "@/lib/tauri/skills";
import { useHint } from "@/lib/status";

/**
 * The gate between picking a skill and dispatching it: collect the declared
 * parameters, show what will actually be sent, and say plainly that this opens
 * a live shell on each host.
 */
export function ParamForm({
  skill,
  hosts,
  starting,
  onCancel,
  onRun,
}: {
  skill: Skill;
  hosts: Host[];
  starting: boolean;
  onCancel: () => void;
  /** Runs with the collected values; `preflight` drives the CONFIRM dialog. */
  onRun: (params: Record<string, string>, preflight: SkillPreflight) => void;
}) {
  const hint = useHint();
  const config = useMemo(() => parseSequence(skill.config_json), [skill]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<SkillPreflight | null>(null);
  const [checking, setChecking] = useState(false);

  // Seed from each parameter's default whenever the skill changes.
  useEffect(() => {
    const seed: Record<string, string> = {};
    for (const p of config.params) seed[p.key] = p.default ?? "";
    setValues(seed);
    setPreflight(null);
  }, [config, skill.id]);

  const missing = config.params.filter(
    (p) => p.required && !(values[p.key] ?? "").trim(),
  );

  // Re-check as the values change: substitution happens backend-side, so the
  // guard verdict depends on what the user typed.
  useEffect(() => {
    if (missing.length > 0 || hosts.length === 0) {
      setPreflight(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    skillPreflight({
      skillId: skill.id,
      hostIds: hosts.map((h) => h.id),
      params: values,
    })
      .then((p) => {
        if (!cancelled) setPreflight(p);
      })
      .catch((e) => {
        if (!cancelled) toast.error(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // `missing` is derived from values, so depend on its length rather than the
    // array — a fresh array identity every render would loop.
  }, [skill.id, values, hosts, missing.length]);

  const ready = missing.length === 0 && preflight != null && !starting;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 p-6">
      <div>
        <h2 className="text-lg font-semibold">{skill.name}</h2>
        {skill.description && (
          <p className="text-sm text-muted-foreground">{skill.description}</p>
        )}
      </div>

      {config.params.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Inputs</h3>
          {config.params.map((p) => (
            <div key={p.key} className="space-y-1">
              <Label htmlFor={`param-${p.key}`} className="text-xs">
                {p.label || p.key}
                {p.required && <span className="ml-1 text-destructive">*</span>}
              </Label>
              <Input
                id={`param-${p.key}`}
                value={values[p.key] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [p.key]: e.target.value }))
                }
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </div>
          ))}
        </div>
      )}

      {/* Confirm what the values actually are before anything is typed at a
          host — the last chance to catch a wrong repo name or path. */}
      {config.params.length > 0 && missing.length === 0 && (
        <div className="space-y-1 rounded-md border border-border/60 bg-muted/20 p-3">
          <h3 className="text-xs font-medium text-muted-foreground">
            Confirm these values
          </h3>
          <dl className="space-y-0.5 font-mono text-xs">
            {config.params.map((p) => (
              <div key={p.key} className="flex gap-2">
                <dt className="shrink-0 text-muted-foreground">{p.key}:</dt>
                <dd className="min-w-0 break-all">{values[p.key] || "(empty)"}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* The locked pre-run notice. */}
      <div className="flex items-start gap-2 rounded-md border border-blue-300/60 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300/90">
        <TerminalIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <p>
            <span className="font-semibold">
              This opens a live shell on{" "}
              {hosts.length === 1 ? "1 host" : `${hosts.length} hosts`}
            </span>{" "}
            and types into it. You'll see each host's real terminal and can take
            over at any point.
          </p>
          <p className="break-words opacity-80">
            {hosts.map((h) => h.label).join(", ")}
          </p>
        </div>
      </div>

      {preflight && preflight.hostsMissingSudo.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
          <TriangleAlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold">
              This skill uses sudo, but these hosts have no sudo password stored
            </p>
            <p className="break-words opacity-90">
              {preflight.hostsMissingSudo.join(", ")}
            </p>
            <p className="mt-1 opacity-80">
              Their sudo steps will fail. Store a sudo password on the Hosts page,
              or run anyway and watch what happens.
            </p>
          </div>
        </div>
      )}

      {preflight && preflight.matchedRules.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs">
          <TriangleAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="font-semibold text-destructive">
              This skill contains destructive steps
            </p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {preflight.matchedRules.map((r) => (
                <li key={r.rule_id}>· {r.description}</li>
              ))}
            </ul>
            <p className="mt-1 text-muted-foreground">
              You'll be asked to type CONFIRM before it runs.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          disabled={!ready}
          onClick={() => preflight && onRun(values, preflight)}
          {...hint(`Open a shell on each checked host and run "${skill.name}"`)}
        >
          {starting || checking ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <TerminalIcon />
          )}
          Run on {hosts.length} {hosts.length === 1 ? "host" : "hosts"}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {missing.length > 0 && (
          <span className="text-xs text-muted-foreground">
            Fill in: {missing.map((p) => p.label || p.key).join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}
