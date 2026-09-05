/**
 * A path's Monaco language id.
 *
 * One table, because there were two: the file tree had one and the live-edit
 * controller had another, and they disagreed. The controller's mapped `.tsx` to
 * `typescriptreact` and `.jsx` to `javascriptreact` — those are VS Code
 * language ids, not Monaco's, so a React file opened by the assistant rendered
 * with no highlighting at all while the same file opened from the tree
 * rendered correctly. Monaco's ids are `typescript` and `javascript`; TSX is a
 * dialect of TypeScript to it, not a language of its own.
 */
const LANGUAGES: Record<string, string> = {
  c: "c", cc: "cpp", cpp: "cpp", css: "css", csv: "plaintext", go: "go", h: "c", hpp: "cpp",
  htm: "html", html: "html", java: "java", js: "javascript", json: "json", jsx: "javascript",
  md: "markdown", mjs: "javascript", py: "python", rb: "ruby", rs: "rust", sh: "shell",
  sql: "sql", svg: "xml", toml: "toml", ts: "typescript", tsx: "typescript", txt: "plaintext",
  xml: "xml", yaml: "yaml", yml: "yaml",
};

export function languageForPath(path: string): string {
  return LANGUAGES[path.split(".").pop()?.toLowerCase() || ""] || "plaintext";
}
