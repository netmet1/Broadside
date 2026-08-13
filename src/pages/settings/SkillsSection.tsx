import { useState } from "react";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHint } from "@/lib/status";
import { SectionHeading } from "@/pages/settings/shared";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  setSkillLogPrefs,
  type SkillLogDetail,
  type SkillLogFormat,
  type SkillLogPrefs,
  type SkillLogWhere,
} from "@/lib/tauri/settings";

/** What each answer to "Where to log" actually does, shown under the dropdown
 * so the consequence is on the page rather than in the handbook. The middle one
 * is the only one that touches the host, and it says so. */
const WHERE_HINT: Record<SkillLogWhere, string> = {
  skill:
    "The run is written to the Log tab, under Skills. Broadside also asks each shell it opens to stop recording, so the skill's commands stay out of the host's own history.",
  remote:
    "Nothing is written to the Log tab. The skill's commands are left in the host's shell history, where an Up-arrow finds them, exactly as they were before this setting existed.",
  both: "The run is written to the Log tab, and the skill's commands are also left in the host's shell history.",
};

const DETAIL_HINT: Record<SkillLogDetail, string> = {
  summary: "One entry for the whole run on each host: how many commands, how many failed, how long it took, and how it ended.",
  itemized: "The summary, then one line per step: what ran, its exit code, whether it passed, and where the run went next.",
  panel:
    "The summary, then the step log exactly as the run panel showed it. The account you were already reading, kept instead of lost when the panel closes.",
  debug:
    "Everything itemized has, plus the line Broadside actually typed where it differs from the command, and what the host said back (trimmed at 2,000 characters).",
};

/**
 * Settings -> Skills. Three answers about the record a skill run leaves behind:
 * where it goes, how much of it there is, and how it reads.
 *
 * Saved on change rather than behind a Save button, like the audit and
 * help-hint toggles. "Takes effect immediately" is meant literally for the
 * first two: where a run is written is read when each host finishes, so a
 * change made while a skill is running still applies to it, and whether the
 * host keeps its own history is read when each host starts.
 */
export function SkillsSection({
  id,
  prefs,
  onChange,
}: {
  id: string;
  prefs: SkillLogPrefs;
  onChange: (prefs: SkillLogPrefs) => void;
}) {
  const hint = useHint();
  const [saving, setSaving] = useState(false);

  const save = async (next: SkillLogPrefs) => {
    // Optimistic: the dropdown has already moved, and putting it back on a
    // failure would be a second surprise on top of the first. The toast is the
    // report, and the next read of Settings is the correction.
    onChange(next);
    setSaving(true);
    try {
      await setSkillLogPrefs(next);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id={id} className="space-y-4">
      <SectionHeading
        title="Skills"
        hint="What a skill run writes down, and where. A run's record used to exist only as the commands left in each host's shell history; it can live here instead, in the Log tab under Skills, with the exit codes and the timings the history never had."
      />

      <div className="grid max-w-xl gap-1">
        <Label htmlFor="skill-log-where">Where to log</Label>
        <Select
          value={prefs.where}
          onValueChange={(v) => save({ ...prefs, where: v as SkillLogWhere })}
          disabled={saving}
        >
          <SelectTrigger
            id="skill-log-where"
            size="sm"
            className="w-full"
            {...hint("Where the record of a skill run is kept")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="skill">Skill log only (recommended)</SelectItem>
            <SelectItem value="remote">Remote history only</SelectItem>
            <SelectItem value="both">Both</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{WHERE_HINT[prefs.where]}</p>
      </div>

      <div className="grid max-w-xl gap-1">
        <Label htmlFor="skill-log-detail">Logging type</Label>
        <Select
          value={prefs.detail}
          onValueChange={(v) => save({ ...prefs, detail: v as SkillLogDetail })}
          disabled={saving}
        >
          <SelectTrigger
            id="skill-log-detail"
            size="sm"
            className="w-full"
            {...hint("How much of a run is written down")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="summary">Skill summary</SelectItem>
            <SelectItem value="itemized">Itemized</SelectItem>
            <SelectItem value="panel">Run panel log</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{DETAIL_HINT[prefs.detail]}</p>
      </div>

      <div className="grid max-w-xl gap-1">
        <Label htmlFor="skill-log-format">Output style</Label>
        <Select
          value={prefs.format}
          onValueChange={(v) => save({ ...prefs, format: v as SkillLogFormat })}
          disabled={saving}
        >
          <SelectTrigger
            id="skill-log-format"
            size="sm"
            className="w-full"
            {...hint("How the skill log reads in the Log tab")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="text">Readable text (recommended)</SelectItem>
            <SelectItem value="json">JSON</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          How the log reads on screen, not how it is stored: entries are always
          written as JSON, so this can be changed at any time and applies to
          everything already recorded. Export always writes the JSON, because an
          export is for something else to read.
        </p>
      </div>
    </section>
  );
}
