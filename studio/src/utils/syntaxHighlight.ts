import Prism from "prismjs";

// Load essential language definitions
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-css";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";

export function highlightCode(code: string, lang: string = "javascript"): string {
  let normalizedLang = lang.toLowerCase().trim();

  // Alias mappings
  if (normalizedLang === "js") normalizedLang = "javascript";
  if (normalizedLang === "ts") normalizedLang = "typescript";
  if (normalizedLang === "htm" || normalizedLang === "html" || normalizedLang === "xml" || normalizedLang === "svg") {
    normalizedLang = "markup";
  }
  if (normalizedLang === "sh" || normalizedLang === "zsh" || normalizedLang === "shell") {
    normalizedLang = "bash";
  }
  if (normalizedLang === "py") normalizedLang = "python";
  if (normalizedLang === "yml") normalizedLang = "yaml";
  if (normalizedLang === "md") normalizedLang = "markdown";

  const grammar = Prism.languages[normalizedLang] || Prism.languages.javascript;
  if (!grammar) {
    return escapeHtml(code);
  }

  try {
    return Prism.highlight(code, grammar, normalizedLang);
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
