export interface CompilationDiagnostic {
  file: string;
  line: number;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface SelfHealingResult {
  success: boolean;
  passesRun: number;
  initialErrorsCount: number;
  healedErrorsCount: number;
  diagnostics: CompilationDiagnostic[];
  healedFiles: Record<string, string>;
  verificationSummary: string;
  verificationLevel?: "typescript-compiler" | "limited-lexical";
  compilerVersion?: string;
  remainingErrorsCount?: number;
}

/**
 * This scanner deliberately reports only high-confidence lexical failures.
 * It is not presented as a TypeScript parser, type checker, or import checker.
 */
function lexicalDiagnostics(filename: string, source: string): CompilationDiagnostic[] {
  const diagnostics: CompilationDiagnostic[] = [];
  const lines = source.split("\n");

  lines.forEach((content, index) => {
    if (/^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/.test(content)) {
      diagnostics.push({
        file: filename,
        line: index + 1,
        code: "LEX_CONFLICT_MARKER",
        message: "Unresolved source-control conflict marker.",
        severity: "error",
      });
    }
    if (content.includes("\0")) {
      diagnostics.push({
        file: filename,
        line: index + 1,
        code: "LEX_NUL_BYTE",
        message: "Source contains a NUL byte.",
        severity: "error",
      });
    }
  });

  let line = 1;
  let quote: "'" | '"' | "`" | null = null;
  let quoteLine = 1;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let blockCommentLine = 1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "\n") {
      line += 1;
      lineComment = false;
      if (quote !== "`" && quote !== null) {
        diagnostics.push({
          file: filename,
          line: quoteLine,
          code: "LEX_UNTERMINATED_STRING",
          message: "String literal reaches a newline without a closing quote.",
          severity: "error",
        });
        quote = null;
      }
      escaped = false;
      continue;
    }
    if (lineComment) continue;
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      blockCommentLine = line;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      quoteLine = line;
    }
  }

  if (quote) {
    diagnostics.push({
      file: filename,
      line: quoteLine,
      code: "LEX_UNTERMINATED_LITERAL",
      message: `Unterminated ${quote === "`" ? "template" : "string"} literal.`,
      severity: "error",
    });
  }
  if (blockComment) {
    diagnostics.push({
      file: filename,
      line: blockCommentLine,
      code: "LEX_UNTERMINATED_COMMENT",
      message: "Unterminated block comment.",
      severity: "error",
    });
  }
  return diagnostics;
}

export class SelfHealingCompilerService {
  /**
   * Performs a read-only lexical audit until a compiler-backed server boundary
   * exists. It never rewrites source or claims TypeScript compiler success.
   */
  public static async analyzeAndHeal(
    files: Record<string, string>,
    onHealingStep?: (step: string) => void
  ): Promise<SelfHealingResult> {
    onHealingStep?.("Running limited read-only lexical diagnostics…");
    const diagnostics = Object.entries(files).flatMap(([filename, content]) => lexicalDiagnostics(filename, content));
    diagnostics.push({
      file: "<compiler-unavailable>",
      line: 1,
      code: "FRONTIER_LIMITED_VALIDATION",
      message: "A TypeScript compiler boundary is not available in this browser runtime; type and import validity are unknown.",
      severity: "warning",
    });
    const lexicalErrors = diagnostics.filter((item) => item.severity === "error").length;
    const verificationSummary =
      `Limited lexical scan only: ${lexicalErrors} high-confidence lexical error${lexicalErrors === 1 ? "" : "s"} detected. ` +
      "TypeScript syntax, types, imports, JSX, and behavior were not compiler-validated.";
    onHealingStep?.(verificationSummary);
    return {
      success: false,
      passesRun: 1,
      initialErrorsCount: lexicalErrors,
      healedErrorsCount: 0,
      diagnostics,
      healedFiles: { ...files },
      verificationSummary,
      verificationLevel: "limited-lexical",
      remainingErrorsCount: lexicalErrors,
    };
  }
}
