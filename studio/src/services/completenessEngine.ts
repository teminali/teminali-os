/**
 * Frontier Absolute Completeness & Zero-Half-Work Engine
 * 
 * CORE MANDATE:
 * 1. Zero Placeholders: Strictly bans "// TODO", "// Implement later", dummy empty stubs, or mock text.
 * 2. 100% End-to-End Wiring: Guarantees every button, input, keyboard shortcut, and state transition is connected to real logic.
 * 3. Autonomous Completion Pass: Automatically inspects generated code diffs and recursively completes any missing handlers before committing.
 */

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface FileAuditFinding {
  path: string;
  rule: string;
  detail: string;
}

export interface CompletenessScanResult {
  isFullyComplete: boolean;
  score: number; // 0 - 100%
  placeholdersDetected: string[];
  unwiredHandlersDetected: string[];
  remediationSuggestions: string[];
}

export class CompletenessEngine {
  private static INCOMPLETE_PATTERNS = [
    /\/\/\s*TODO/i,
    /\/\/\s*FIXME/i,
    /\/\/\s*implement\s+later/i,
    /\/\*\s*TODO/i,
    /alert\s*\(\s*["']not implemented["']\s*\)/i,
    /console\.log\s*\(\s*["']click["']\s*\)/i,
    /throw\s+new\s+Error\s*\(\s*["']Not implemented["']\s*\)/i,
  ];

  /**
   * Scans code string for half-work or placeholder shortcuts
   */
  public static scanCodeForCompleteness(code: string): CompletenessScanResult {
    const placeholders: string[] = [];
    const unwired: string[] = [];

    const lines = code.split("\n");
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      this.INCOMPLETE_PATTERNS.forEach((pattern) => {
        if (pattern.test(line)) {
          placeholders.push(`Line ${lineNum}: ${line.trim()}`);
        }
      });

      // Detect empty handler functions: onClick={() => {}}
      if (/on[A-Z]\w+\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/.test(line)) {
        unwired.push(`Line ${lineNum}: Empty inline handler -> ${line.trim()}`);
      }
    });

    const isFullyComplete = placeholders.length === 0 && unwired.length === 0;
    const score = Math.max(0, 100 - placeholders.length * 20 - unwired.length * 15);

    return {
      isFullyComplete,
      score,
      placeholdersDetected: placeholders,
      unwiredHandlersDetected: unwired,
      remediationSuggestions: isFullyComplete
        ? ["Code satisfies 100% Absolute Completeness Mandate."]
        : [
            "Replace all // TODO and stub comments with fully-wired production logic.",
            "Connect all empty inline event handlers to persistent state or dispatchers.",
          ],
    };
  }


  /**
   * The Teminali Design System contract, stated for the model.
   * Mirrors DESIGN.md — update both together.
   *
   * Scoped to UI work on purpose: a shell script or a Python utility must not
   * be pushed into React.
   */
  private static HOUSE_STYLE = `[TEMINALI DESIGN SYSTEM — APPLIES WHENEVER YOU BUILD OR EDIT WEB UI]:

STACK (unless the user names a different one):
- React + TypeScript + Vite. Strongly typed props and state; zero \`any\` types.
- Reuse the primitives in src/components/ui/ (Button, Badge, Card, Modal, SegmentedTabs, Input) rather than writing one-off styled markup. If a primitive needs improvement, change the primitive.
- Split sections into their own component files; never emit one monolithic file for a multi-section page.
- For a plain static page, still separate structure (index.html), styling (styles.css), and behaviour (script.js).

OBSIDIAN DARK VISUAL CONTRACT:
- Backgrounds: #09090c, #0c0c10, #0f0f13, #131317, #16161a. Never raw #000000, never washed-out #333.
- Accents: Postman Orange #FF6C37 (primary actions, active state, focus rings), Emerald #10b981 (live/success), Amber #f59e0b (warning), Violet #818cf8 (AI reasoning), Rose #f43f5e (destructive).
- Hairline 1px borders with top-edge luminance: 1px solid rgba(255,255,255,.08), top border rgba(255,255,255,.15), plus inset 0 1px 0 rgba(255,255,255,.10).
- Ambient radial glow accents in the backdrop; glass surfaces use backdrop-filter blur.
- Typography: Inter (or the system stack) for UI; JetBrains Mono / ui-monospace for code, metrics, badges, and keycaps. Never Arial.

NON-NEGOTIABLE OUTPUT QUALITY:
- Responsive at 375px, 768px, and 1440px+. A stylesheet with layout rules and no @media query is incomplete.
- box-sizing: border-box reset at the top of the stylesheet.
- ARIA labels on every icon-only control; alt text on every image; a label or aria-label on every input.
- Visible :focus-visible styling, and honour prefers-reduced-motion.
- Icons as inline SVG. Never reference an image path you have not created — a broken asset is a failed build.
- Include <meta name="description"> on a full page.`;

  private static MANDATE = `[FRONTIER ABSOLUTE COMPLETENESS & ZERO-HALF-WORK MANDATE]:
1. You are forbidden from emitting "// TODO", "// implement later", or mock placeholders.
2. Every component must be 100% complete, fully styled, and completely wired with working event handlers, state hooks, and error handling.
3. If creating an algorithm, build the entire working mathematical implementation.
4. If styling a UI, match every single pixel, color gradient, margin, and responsiveness rule completely.`;

  /** The completeness mandate, on its own. */
  public static mandate(): string {
    return this.MANDATE;
  }

  /**
   * The visual contract, on its own. It only earns its place when the model is
   * about to author UI, which is why the engine ranks it last under a budget.
   */
  public static houseStyle(): string {
    return this.HOUSE_STYLE;
  }

  /**
   * Enforces prompt instructions with the Absolute Completeness Mandate
   */
  public static wrapSystemPrompt(basePrompt: string): string {
    return `${basePrompt}\n\n${this.MANDATE}\n\n${this.HOUSE_STYLE}`;
  }
  /**
   * Audits the files a model just emitted against the delivery rules that
   * cannot be inferred from the code alone (responsiveness, accessible names,
   * design-system colours, dangling assets).
   *
   * Findings are fed back to the model so it corrects its own output. Rules are
   * deliberately conservative: a false finding costs a wasted generation turn.
   */
  public static auditGeneratedFiles(files: GeneratedFile[]): FileAuditFinding[] {
    const findings: FileAuditFinding[] = [];
    const emitted = new Set(files.map((file) => file.path.replace(/^\.\//, "")));
    const add = (path: string, rule: string, detail: string) => findings.push({ path, rule, detail });

    for (const { path, content } of files) {
      const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
      const isStyle = extension === ".css";
      const isMarkup = extension === ".html" || extension === ".htm";
      const isTyped = extension === ".ts" || extension === ".tsx";

      const placeholders = this.scanCodeForCompleteness(content);
      for (const placeholder of placeholders.placeholdersDetected) add(path, "placeholder", placeholder);
      for (const unwired of placeholders.unwiredHandlersDetected) add(path, "unwired-handler", unwired);

      // ── Stylesheet rules (also applied to inline <style> in markup) ──
      const styleSource = isStyle ? content : isMarkup ? (content.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1] || "") : "";
      if (styleSource.length > 800) {
        const hasLayout = /(display\s*:\s*(grid|flex)|grid-template|max-width\s*:|width\s*:)/i.test(styleSource);
        if (hasLayout && !/@media/.test(styleSource)) {
          add(path, "not-responsive", "Layout rules with no @media query; the page cannot adapt to 375px or 768px.");
        }
        if (!/box-sizing\s*:\s*border-box/i.test(styleSource)) {
          add(path, "missing-box-sizing", "No box-sizing: border-box reset.");
        }
        if (/(background(-color)?\s*:\s*(#000000|#000)\b)|(:\s*#000000\b)/i.test(styleSource)) {
          add(path, "raw-black", "Uses raw #000000; the Obsidian palette starts at #09090c.");
        }
        if (/font-family\s*:\s*['"]?(Arial|Helvetica)\b/i.test(styleSource)) {
          add(path, "off-system-font", "Arial/Helvetica as the primary face; use Inter (UI) and JetBrains Mono (code).");
        }
      }

      // ── Markup rules ──
      if (isMarkup) {
        for (const image of content.matchAll(/<img\b([^>]*)>/gi)) {
          if (!/\balt\s*=/i.test(image[1])) add(path, "missing-alt", `<img> without alt: ${image[0].slice(0, 70)}`);
        }

        for (const button of content.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
          const attributes = button[1];
          const label = button[2].replace(/<[^>]*>/g, "").replace(/&[a-z]+;/gi, "").trim();
          const named = /\baria-label\s*=|\baria-labelledby\s*=|\btitle\s*=/i.test(attributes);
          if (!label && !named) {
            add(path, "unnamed-control", `Icon-only <button> with no accessible name: ${button[0].slice(0, 70)}`);
          }
        }

        const labelledIds = new Set(
          [...content.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]),
        );
        // A control wrapped in <label>…</label> is labelled implicitly and needs
        // no for= or aria-label; flagging those would be a false positive.
        const labelRanges = [...content.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)].map(
          (match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const,
        );
        const insideLabel = (index: number) => labelRanges.some(([start, end]) => index > start && index < end);

        for (const input of content.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
          const attributes = input[2];
          const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
          if (type && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
          if (insideLabel(input.index ?? 0)) continue;
          const id = attributes.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
          const named = /\baria-label\s*=|\baria-labelledby\s*=/i.test(attributes) || (id && labelledIds.has(id));
          if (!named) add(path, "unlabelled-input", `<${input[1]}> with no label or aria-label: ${input[0].slice(0, 70)}`);
        }

        if (/<head\b/i.test(content) && !/<meta\b[^>]*name\s*=\s*["']description["']/i.test(content)) {
          add(path, "missing-meta-description", "No <meta name=\"description\"> for SEO.");
        }
      }

      // ── Dangling local assets, in markup or styles ──
      const references = [
        ...content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi),
        ...content.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi),
      ].map((match) => match[1]);
      for (const reference of references) {
        if (/^(https?:|data:|mailto:|tel:|#|\/\/)/i.test(reference) || reference.startsWith("/")) continue;
        const normalized = reference.replace(/^\.\//, "").split(/[?#]/)[0];
        if (!normalized || emitted.has(normalized)) continue;
        // Only flag real asset-looking paths, not framework-resolved module ids.
        if (/\.(png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|mp4|webm)$/i.test(normalized)) {
          add(path, "dangling-asset", `References ${normalized}, which was not created.`);
        }
      }

      // ── Type safety ──
      if (isTyped) {
        const anyCount = [...content.matchAll(/(:\s*any\b|\bas\s+any\b)/g)].length;
        if (anyCount > 0) add(path, "any-type", `${anyCount} use(s) of \`any\`; the contract requires strict typing.`);
      }
    }

    return findings;
  }

  /** Renders findings as the correction brief the model reads next turn. */
  public static formatAuditBrief(findings: FileAuditFinding[]): string {
    if (findings.length === 0) return "";
    const byPath = new Map<string, FileAuditFinding[]>();
    for (const finding of findings) {
      const existing = byPath.get(finding.path);
      if (existing) existing.push(finding);
      else byPath.set(finding.path, [finding]);
    }
    const sections = [...byPath.entries()].map(([path, items]) =>
      [`${path}:`, ...items.map((item) => `  - [${item.rule}] ${item.detail}`)].join("\n"),
    );
    return [
      "Automated review of the files you just wrote found the issues below.",
      "Re-emit only the affected files, complete and corrected, using the same path= fences. Do not explain; just fix them.",
      "",
      ...sections,
    ].join("\n");
  }
}
