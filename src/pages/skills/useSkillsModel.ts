import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  createSkill,
  deleteSkill,
  listSkills,
  reorderSkills,
  updateSkill,
  type Skill,
  type SkillInput,
} from "@/lib/tauri/skills";

/** Skill CRUD + the list. Wholesale reload after each mutation, mirroring
 * useGuardRules: the list is small and always-correct beats clever. */
export function useSkillsModel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setSkills(await listSkills());
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Saves a new skill or updates an existing one. Resolves to true on success
   * so the caller can close its form only when the save actually landed: the
   * backend rejects a broken step graph here. */
  const save = useCallback(
    async (id: number | null, input: SkillInput): Promise<boolean> => {
      try {
        if (id == null) await createSkill(input);
        else await updateSkill(id, input);
        await reload();
        toast.success(id == null ? "Skill created" : "Skill saved");
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (id: number) => {
      try {
        await deleteSkill(id);
        await reload();
        toast.success("Skill deleted");
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    [reload],
  );

  /** Moves one skill up or down the rail by one place.
   *
   * The list is updated first and persisted after, rather than reloading:
   * pressing an arrow four times in a row should feel like four moves, not four
   * round trips, and the order written is exactly the order already on screen.
   * A failed write reloads to put the rail back to the truth. */
  const move = useCallback(
    async (id: number, direction: -1 | 1) => {
      const from = skills.findIndex((s) => s.id === id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= skills.length) return;
      const next = [...skills];
      [next[from], next[to]] = [next[to]!, next[from]!];
      setSkills(next);
      try {
        await reorderSkills(next.map((s) => s.id));
      } catch (e) {
        toast.error(errorMessage(e));
        await reload();
      }
    },
    [skills, reload],
  );

  return { skills, loading, reload, save, remove, move };
}
