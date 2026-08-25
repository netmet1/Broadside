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

  // The initial load. Called here rather than through `reload` so the state
  // write is visibly in a continuation instead of behind a function the effect
  // body appears to run synchronously, and so a list arriving after the page
  // unmounts is dropped rather than written to a dead component. `reload`
  // stays for the imperative refreshes after a save or delete.
  useEffect(() => {
    let alive = true;
    listSkills()
      .then((s) => {
        if (alive) setSkills(s);
      })
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Saves a new skill or updates an existing one. Resolves to the saved
   * skill's id, or null when the save did not land: the backend rejects a
   * broken step graph here, so a caller must not close its form (or clear its
   * unsaved-changes mark) until this says which.
   *
   * The id and not just a flag, because the editor can now save without
   * closing: after the first save of a *new* skill it has to know what it just
   * created, or the next press of Save would create a second copy. */
  const save = useCallback(
    async (id: number | null, input: SkillInput): Promise<number | null> => {
      try {
        const saved = id == null ? await createSkill(input) : await updateSkill(id, input);
        await reload();
        toast.success(id == null ? "Skill created" : "Skill saved");
        return saved.id;
      } catch (e) {
        toast.error(errorMessage(e));
        return null;
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

  /** Swaps two skills' places in the rail.
   *
   * Two ids rather than "this one, one place up". The list on screen is no
   * longer the whole list: the pinned skill is lifted out of it, so the row
   * under the pin has a neighbour above it that is not its neighbour in here.
   * A direction can only ever mean the adjacent index, which would swap a row
   * with something invisible and look like the arrow did nothing. The caller
   * can see what is on screen, so it names both ends and this just does as it
   * is told.
   *
   * The list is updated first and persisted after, rather than reloading:
   * pressing an arrow four times in a row should feel like four moves, not four
   * round trips, and the order written is exactly the order already on screen.
   * A failed write reloads to put the rail back to the truth. */
  const swap = useCallback(
    async (aId: number, bId: number) => {
      const from = skills.findIndex((s) => s.id === aId);
      const to = skills.findIndex((s) => s.id === bId);
      if (from < 0 || to < 0 || from === to) return;
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

  return { skills, loading, reload, save, remove, swap };
}
