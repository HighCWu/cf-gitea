/**
 * Go `json.MarshalIndent(v, "", "  ")` — the byte shape every provider request
 * body must carry (prepareJSONRequest, services/webhook/payloader.go:102).
 * Go's encoder escapes `<`, `>`, `&` (SetEscapeHTML default) plus U+2028/
 * U+2029 inside string values; those bytes can only occur inside string
 * literals (JSON's structural charset excludes them), so a whole-text replace
 * over JSON.stringify's output is exactly equivalent.
 */

export function goMarshalIndent(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
