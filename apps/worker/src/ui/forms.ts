/**
 * The urlencoded POST body reader shared by the UI write forms (pages wave
 * 4): the login page's parse convention at a body-appropriate cap — a
 * non-form, oversized, or malformed body reads as EMPTY, so every form's
 * required-field validation re-renders instead of throwing (the issue form
 * answers "A title is required.", the settings/hook forms cite the empty
 * name). Form posts are bounded prose; the content-length cap bounds the
 * `arrayBuffer()` read (AGENTS.md streaming rule is about unbounded bodies).
 */

/** 512 KiB: an issue body is prose; no UI form approaches this. */
export const UI_FORM_MAX_BYTES = 512 * 1024;

/**
 * Read one urlencoded POST body at `maxBytes` (default UI_FORM_MAX_BYTES).
 * The file-editor form (pages wave 8) passes its own cap: the textarea carries
 * up to the display cap's worth of file content (MAX_DISPLAY_FILE_SIZE, 8 MiB
 * — upstream `setting.UI.MaxDisplayFileSize`), so its byte budget is that plus
 * urlencoded-escaping headroom; every other form keeps the prose default.
 */
export async function readUrlEncodedForm(req: Request, maxBytes: number = UI_FORM_MAX_BYTES): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type") ?? "";
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!contentType.startsWith("application/x-www-form-urlencoded") || length > maxBytes) {
    return new URLSearchParams();
  }
  try {
    return new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
  } catch {
    return new URLSearchParams();
  }
}
