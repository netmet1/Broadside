import { useCallback, useMemo, useState } from "react";

import {
  parseSequence,
  STOP,
  type SeqStep,
  type Skill,
  type SkillInput,
  type SkillParam,
} from "@/lib/tauri/skills";

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
    onSuccess: STOP,
    onFailure: STOP,
  };
}

/** Form state for the sequence builder. Kept out of the component so the editor
 * stays presentational (and so this stays testable by hand). */
export function useSequenceForm(editing: Skill | null) {
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

  const addStep = useCallback(() => {
    setSteps((prev) => [...prev, blankStep(nextStepId(prev))]);
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
        const next = rest.map((s): SeqStep => {
          switch (s.kind) {
            case "run":
              return {
                ...s,
                onSuccess: repoint(s.onSuccess),
                onFailure: repoint(s.onFailure),
                match: s.match
                  ? {
                      ...s.match,
                      ifMatch: repoint(s.match.ifMatch),
                      ifNoMatch: repoint(s.match.ifNoMatch),
                    }
                  : undefined,
              };
            case "expect":
              return { ...s, onMatch: repoint(s.onMatch) };
            case "send":
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
      else if (s.id === STOP)
        out.push(`"${STOP}" is reserved as a branch target and can't be a step id.`);
      else if (ids.has(s.id)) out.push(`Two steps share the id "${s.id}".`);
      ids.add(s.id);
      if (s.kind === "run" && !s.command.trim())
        out.push(`Step ${s.id} has no command.`);
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

  const toInput = useCallback(
    (): SkillInput => ({
      name: name.trim(),
      description: description.trim(),
      icon: null,
      kind: "sequence",
      config_json: JSON.stringify({ params, startStepId, steps }),
    }),
    [name, description, params, startStepId, steps],
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
    updateStep,
    removeStep,
    moveStep,
    startStepId,
    setStartStepId,
    problems,
    toInput,
  };
}
