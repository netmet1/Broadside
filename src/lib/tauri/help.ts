import { invoke } from "@tauri-apps/api/core";

/** Whether this build carries the handbook PDF. It is built at release time, so
 * a development build normally does not have one and the button stays hidden
 * rather than offering a download that cannot happen. */
export function helpPdfAvailable(): Promise<boolean> {
  return invoke<boolean>("help_pdf_available");
}

/** Copies the bundled handbook to `dest`. Returns the size written, in bytes. */
export function exportHelpPdf(dest: string): Promise<number> {
  return invoke<number>("export_help_pdf", { dest });
}
