import { invoke } from "@tauri-apps/api/core";

/**
 * Session templates: a saved arrangement of terminal sessions, edited on the
 * Templates tab and opened from the Hosts tab.
 *
 * The TS mirror of `src-tauri/src/db/templates.rs`. A template is an ordered
 * list of references and nothing else: no layout is stored, so the grid a
 * launch produces is always the operator's own Grid settings applied to the
 * number of sessions, exactly as the Terminals tab does it.
 */

/** How a template refers to a host it cannot carry across machines. Not the id,
 * which names a row in one database; not the whole host, whose colour, tags,
 * notes and credentials are the receiving machine's business. */
export type HostRef = {
  label: string;
  hostname: string;
  port: number;
  username: string;
};

/** One session in a template, in the order it opens.
 *
 * A `host` item with no `hostId` is a placeholder: a reference that did not
 * resolve on this machine, kept so the operator can point it at a real host
 * rather than discovering the file was refused. */
export type TemplateItem =
  | { kind: "host"; hostId?: number | null; ref: HostRef }
  | { kind: "shell"; shellId: string; label: string }
  | { kind: "profile"; profileId: string; label: string };

/** What a template does when Broadside starts. `launch` opens the tabs and
 * leaves every pane on its Reconnect button; `connect` goes on to open the
 * shells, which is the one the editor guards. */
export type TemplateStartup = "off" | "launch" | "connect";

export type Template = {
  id: number;
  name: string;
  /** `#rrggbb`, or empty for none. */
  color: string;
  items: TemplateItem[];
  startup: TemplateStartup;
  created_at: string;
  updated_at: string;
};

export type TemplateInput = {
  name: string;
  color: string;
  items: TemplateItem[];
  startup: TemplateStartup;
};

/** The backend's ceiling on how many sessions one template may hold. Kept in
 * step with `MAX_ITEMS` in db/templates.rs. The editor's own warning fires far
 * below it: this is the wall, that is the advice. */
export const MAX_TEMPLATE_ITEMS = 64;

/** How many sessions a template may hold before the editor says something.
 * Not a limit, a remark: opening nine terminals at once is a real thing to
 * want and a real thing to do by accident. */
export const BUSY_TEMPLATE_ITEMS = 8;

export function listTemplates(): Promise<Template[]> {
  return invoke<Template[]>("list_templates");
}

export function getTemplate(id: number): Promise<Template> {
  return invoke<Template>("get_template", { id });
}

/** The one template set to open at launch, or null. */
export function startupTemplate(): Promise<Template | null> {
  return invoke<Template | null>("startup_template");
}

export function createTemplate(input: TemplateInput): Promise<Template> {
  return invoke<Template>("create_template", { input });
}

export function updateTemplate(
  id: number,
  input: TemplateInput,
): Promise<Template> {
  return invoke<Template>("update_template", { id, input });
}

export function deleteTemplate(id: number): Promise<number> {
  return invoke<number>("delete_template", { id });
}

/** Writes the template to a file, refreshing each host reference from the
 * database first so it says what the host is called now. Host ids are stripped
 * on the way out. */
export function exportTemplate(id: number, path: string): Promise<void> {
  return invoke<void>("export_template", { id, path });
}

/** Reads a template file and matches its host references against this machine's
 * hosts. Does not save: the result is loaded into the editor, and unmatched
 * references arrive as placeholders rather than failing the import. */
export function readTemplateFile(path: string): Promise<TemplateInput> {
  return invoke<TemplateInput>("read_template_file", { path });
}
