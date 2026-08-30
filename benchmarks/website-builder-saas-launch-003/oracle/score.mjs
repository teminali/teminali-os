import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("target directory is required");

const targetRoot = path.resolve(target);
const html = await readFile(path.join(targetRoot, "src/index.html"), "utf8");
const css = await readFile(path.join(targetRoot, "src/styles.css"), "utf8");
const js = await readFile(path.join(targetRoot, "src/app.js"), "utf8");
const data = JSON.parse(await readFile(path.join(targetRoot, "src/site-data.json"), "utf8"));

const nonce = `${Date.now()}-${Math.random()}`;
const appUrl = `${pathToFileURL(path.join(targetRoot, "src/app.js"))}?oracle=${nonce}`;
const app = await import(appUrl);

const checks = [];

// Gate 1: Semantic Structure & Information Architecture (20 pts)
{
  const hasHeader = /<header[\s>]/i.test(html);
  const hasNav = /<nav[\s>]/i.test(html);
  const hasMain = /<main[\s>]/i.test(html);
  const hasFooter = /<footer[\s>]/i.test(html);
  const hasH1 = (html.match(/<h1[\s>]/gi) || []).length === 1;
  const hasH2 = (html.match(/<h2[\s>]/gi) || []).length >= 2;
  const passed = hasHeader && hasNav && hasMain && hasFooter && hasH1 && hasH2;
  checks.push({
    name: "semantic landmarks and heading tree",
    passed,
    points: 20,
  });
}

// Gate 2: Content & Claims Integrity (20 pts)
{
  const hasBrand = html.includes("DevStream") || js.includes("DevStream");
  const hasMetric1 = data.brand.verifiedMetrics.some(m => m.value === "1.2ms");
  const hasMetric2 = data.brand.verifiedMetrics.some(m => m.value === "10M events/sec");
  const passed = hasBrand && hasMetric1 && hasMetric2;
  checks.push({
    name: "verified claims and brand facts integrity",
    passed,
    points: 20,
  });
}

// Gate 3: Interactive Forms & Honeypot Validation (20 pts)
{
  let passed = false;
  try {
    const fakeForm = {
      addEventListener(event, handler) { this.handler = handler; },
      querySelector(selector) {
        if (selector === "#lead-email") return this.emailInput;
        if (selector === "#lead-hp") return this.hpInput;
        if (selector === "#email-error") return this.errorMsg;
        if (selector === "#form-status") return this.statusMsg;
        return null;
      },
      reset() { this.wasReset = true; },
      emailInput: { value: "test@example.com" },
      hpInput: { value: "" },
      errorMsg: { textContent: "" },
      statusMsg: { textContent: "" },
      wasReset: false,
    };
    app.setupLeadForm(fakeForm);
    fakeForm.handler({ preventDefault() {} });
    const success = fakeForm.wasReset && fakeForm.statusMsg.textContent.length > 0;

    // Honeypot spam test
    fakeForm.wasReset = false;
    fakeForm.hpInput.value = "spam-bot";
    fakeForm.handler({ preventDefault() {} });
    const honeypotBlocked = !fakeForm.wasReset;

    passed = success && honeypotBlocked;
  } catch (err) {
    passed = false;
  }
  checks.push({
    name: "interactive forms, client validation, and honeypot",
    passed,
    points: 20,
  });
}

// Gate 4: Responsive Design System Tokens (20 pts)
{
  const hasCustomProps = css.includes("--color-primary") && css.includes("--font-family");
  const hasMediaQueries = css.includes("@media") && (css.includes("max-width") || css.includes("min-width"));
  const passed = hasCustomProps && hasMediaQueries;
  checks.push({
    name: "design system tokens and responsive media queries",
    passed,
    points: 20,
  });
}

// Gate 5: Accessibility & Performance (20 pts)
{
  const hasReducedMotion = css.includes("prefers-reduced-motion");
  const hasFocusVisible = css.includes(":focus-visible") || css.includes(":focus");
  const hasAriaLive = html.includes("aria-live");
  const passed = hasReducedMotion && hasFocusVisible && hasAriaLive;
  checks.push({
    name: "accessibility focus states, ARIA, and reduced motion",
    passed,
    points: 20,
  });
}

const totalPoints = checks.reduce((sum, c) => sum + (c.passed ? c.points : 0), 0);
console.log(JSON.stringify({
  benchmark: "frontier-code-agents-003-website-builder-saas-launch",
  score: totalPoints,
  maxPoints: 100,
  checks,
  integrity: true
}, null, 2));
