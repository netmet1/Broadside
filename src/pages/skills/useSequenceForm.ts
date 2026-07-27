import { useCallback, useMemo, useState } from "react";

import {
  DEFAULT_MAX_STEP_REPEATS,
  NEXT,
  parseSequence,
  STOP,
  type SeqStep,
  type Skill,
  type SkillInput,
  type SkillParam,
} from "@/lib/tauri/skills";
import { branchTargetIds } from "@/pages/skills/flowGraph";

/** A fresh id for a new step. Short and readable, since it shows up in the branch
 * dropdowns, so `s3` beats a uuid. */
function nextStepId(steps: SeqStep[]): string {
  for (let n = 1; ; n++) {
    const id = `s${n}`;
    if (!steps.some((s) => s.id === id)) return id;
  }
}

function blankStep(id: string): SeqStep {
  return {
    kind: "run",
    id,
    command: "",
    interactive: false,
    timeoutSecs: 60,
    onTimeout: "pause",
    // Flow onward by default so a linear skill needs no branch wiring.
    onSuccess: NEXT,
    onFailure: STOP,
  };
}

/** Everything the form needs to seed itself. A whole `Skill` satisfies it, and
 * so does a clone's starting point, which has no id because it isn't a saved
 * skill yet. */
export type SkillDraft = Pick<Skill, "name" | "description" | "config_json">;

/** Form state for the sequence builder. Kept out of the component so the editor
 * stays presentational (and so this stays testable by hand). */
export function useSequenceForm(editing: SkillDraft | null) {
  const initial = useMemo(
    () => (editing ? parseSequence(editing.config_json) : null),
    [editing],
  );

  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [params, setParams] = useState<SkillParam[]>(initial?.params ?? []);
  const [steps, setSteps] = useState<SeqStep[]>(
    initial?.steps.length ? initial.steps : [blankStep("s1")],
  );
  const [startStepId, setStartStepId] = useState(
    initial?.startStepId || "s1",
  );
  const [allowTransfer, setAllowTransfer] = useState(
    initial?.allowTransfer ?? false,
  );
  const [maxStepRepeats, setMaxStepRepeats] = useState(
    initial?.maxStepRepeats ?? DEFAULT_MAX_STEP_REPEATS,
  );

  const addStep = useCallback(() => {
    setSteps((prev) => [...prev, blankStep(nextStepId(prev))]);
  }, []);

  /** Adds a step and returns its id, for the branch dropdowns' "add a new step".
   * The id is captured inside the updater (React runs it synchronously), so it
   * reflects the true current steps, never a stale closure. */
  const addStepReturningId = useCallback((): string => {
    let created = "";
    setSteps((prev) => {
      created = nextStepId(prev);
      return [...prev, blankStep(created)];
    });
    return created;
  }, []);

  const updateStep = useCallback((index: number, step: SeqStep) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? step : s)));
  }, []);

  /** Removes a step and repoints anything that branched to it at `stop`, so the
   * graph never dangles (the backend would refuse to save it). */
  const removeStep = useCallback(
    (index: number) => {
      setSteps((prev) => {
        const gone = prev[index];
        if (!gone) return prev;
        const rest = prev.filter((_, i) => i !== index);
        const repoint = (target: string) => (target === gone.id ? STOP : target);
        // The timeout target is a real branch too. Leaving it out here is how
        // deleting a step would silently leave a dangling "on timeout, go to"
        // reference that the backend then refuses to save.
        const repointTimeout = (t: string | undefined) =>
          t === undefined ? undefined : repoint(t);
        const next = rest.map((s): SeqStep => {
          switch (s.kind) {
            case "run":
              return {
                ...s,
                onSuccess: repoint(s.onSuccess),
                onFailure: repoint(s.onFailure),
                onTimeoutTarget: repointTimeout(s.onTimeoutTarget),
                match: s.match
                  ? {
                      ...s.match,
                      ifMatch: repoint(s.match.ifMatch),
                      ifNoMatch: repoint(s.match.ifNoMatch),
                    }
                  : undefined,
              };
            case "expect":
              return {
                ...s,
                onMatch: repoint(s.onMatch),
                onTimeoutTarget: repointTimeout(s.onTimeoutTarget),
              };
            case "send":
              return { ...s, next: repoint(s.next) };
            case "wait":
              return { ...s, next: repoint(s.next) };
          }
        });
        setStartStepId((cur) =>
          cur === gone.id ? (next[0]?.id ?? "") : cur,
        );
        return next;
      });
    },
    [],
  );

  /** Renames every step id to s1, s2, ... in list order and rewrites every
   * branch reference (and the start step) to match, so the flow is unchanged.
   * This is the safe form of "renumber": ids and the branches that point at
   * them move together, so nothing desyncs. Manual, not automatic, so ids don't
   * shift under you mid-drag. `next`/`stop` targets are untouched. */
  const renumberSteps = useCallback(() => {
    const map = new Map(steps.map((s, i) => [s.id, `s${i + 1}`]));
    const remap = (target: string) => map.get(target) ?? target;
    // The timeout target moves with the ids like every other branch (see the
    // matching note in removeStep).
    const remapTimeout = (t: string | undefined) =>
      t === undefined ? undefined : remap(t);
    setSteps(
      steps.map((s, i): SeqStep => {
        const id = `s${i + 1}`;
        switch (s.kind) {
          case "run":
            return {
              ...s,
              id,
              onSuccess: remap(s.onSuccess),
              onFailure: remap(s.onFailure),
              onTimeoutTarget: remapTimeout(s.onTimeoutTarget),
              match: s.match
                ? {
                    ...s.match,
                    ifMatch: remap(s.match.ifMatch),
                    ifNoMatch: remap(s.match.ifNoMatch),
                  }
                : undefined,
            };
          case "expect":
            return {
              ...s,
              id,
              onMatch: remap(s.onMatch),
              onTimeoutTarget: remapTimeout(s.onTimeoutTarget),
            };
          case "send":
            return { ...s, id, next: remap(s.next) };
          case "wait":
            return { ...s, id, next: remap(s.next) };
        }
      }),
    );
    setStartStepId((cur) => map.get(cur) ?? cur);
  }, [steps]);

  const moveStep = useCallback((index: number, dir: -1 | 1) => {
    setSteps((prev) => {
      const to = index + dir;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }, []);

  const addParam = useCallback(() => {
    setParams((prev) => [
      ...prev,
      { key: `param${prev.length + 1}`, label: "", required: false },
    ]);
  }, []);

  const updateParam = useCallback((index: number, param: SkillParam) => {
    setParams((prev) => prev.map((p, i) => (i === index ? param : p)));
  }, []);

  const removeParam = useCallback((index: number) => {
    setParams((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /** Local checks that give a better message than the backend's would. The
   * backend re-validates regardless; this is UX, that's the gate. */
  const problems = useMemo(() => {
    const out: string[] = [];
    if (!name.trim()) out.push("Give the skill a name.");
    if (steps.length === 0) out.push("Add at least one step.");
    const ids = new Set<string>();
    for (const s of steps) {
      if (!s.id.trim()) out.push("A step has an empty id.");
      else if (s.id === STOP || s.id === NEXT)
        out.push(`"${s.id}" is reserved as a branch target and can't be a step id.`);
      else if (ids.has(s.id)) out.push(`Two steps share the id "${s.id}".`);
      ids.add(s.id);
      if (s.kind === "run" && !s.command.trim())
        out.push(`Step ${s.id} has no command.`);
      // An empty output test matches everything, so it would silently take the
      // match branch every time rather than doing nothing.
      if (s.kind === "run" && s.match && !s.match.pattern.trim())
        out.push(`Step ${s.id} branches on its output but has no pattern.`);
      if (s.kind === "expect" && !s.pattern.trim())
        out.push(`Step ${s.id} has no pattern to wait for.`);
      if (s.kind === "send" && !s.input)
        out.push(`Step ${s.id} has nothing to send.`);
    }
    if (steps.length > 0 && !ids.has(startStepId))
      out.push("Pick which step runs first.");
    for (const p of params) {
      if (!/^[A-Za-z0-9_]+$/.test(p.key))
        out.push(
          `Input key "${p.key}" must be letters, numbers or underscores, since it's used as {{${p.key}}}.`,
        );
    }
    return out;
  }, [name, steps, startStepId, params]);

  /** Soft warnings that don't block saving. A `next` on the last step is valid
   * (it resolves to stop), but it's usually a sign the operator meant to add
   * another step, so say so rather than silently finishing the host. */
  const warnings = useMemo(() => {
    const out: string[] = [];
    const last = steps[steps.length - 1];
    if (last && branchTargetIds(last).includes(NEXT)) {
      out.push(
        `Step ${last.id} continues to the next step and nothing follows it, so the host finishes there. That is a fine way to end a skill. If you meant to carry on, add the next step or point it somewhere specific.`,
      );
    }
    return out;
  }, [steps]);

  const toInput = useCallback(
    (): SkillInput => ({
      name: name.trim(),
      description: description.trim(),
      icon: null,
      kind: "sequence",
      config_json: JSON.stringify({
        params,
        startStepId,
        steps,
        allowTransfer,
        maxStepRepeats,
      }),
    }),
    [
      name,
      description,
      params,
      startStepId,
      steps,
      allowTransfer,
      maxStepRepeats,
    ],
  );

  return {
    name,
    setName,
    description,
    setDescription,
    params,
    addParam,
    updateParam,
    removeParam,
    steps,
    addStep,
    addStepReturningId,
    updateStep,
    removeStep,
    moveStep,
    renumberSteps,
    startStepId,
    setStartStepId,
    allowTransfer,
    setAllowTransfer,
    maxStepRepeats,
    setMaxStepRepeats,
    problems,
    warnings,
    toInput,
  };
}
