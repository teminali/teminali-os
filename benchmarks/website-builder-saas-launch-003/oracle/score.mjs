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
const normalizedHtml = html.replace(/\s+/g, " ");

function count(pattern, value) {
  return (value.match(pattern) || []).length;
}

function renderWith(renderer, ...args) {
  const container = { innerHTML: "" };
  renderer(container, ...args);
  return container.innerHTML;
}

function fakeInput(value, { valid = true } = {}) {
  return {
    value,
    validity: { valid },
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    focus() {},
  };
}

function fakeLeadForm({ email, honeypot = "" }) {
  const fields = {
    name: fakeInput("Ada Lovelace"),
    email: fakeInput(email, { valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) }),
    honeypot: fakeInput(honeypot),
    nameError: { textContent: "", setAttribute() {} },
    emailError: { textContent: "", setAttribute() {} },
    status: { textContent: "", setAttribute() {} },
  };
  return {
    fields,
    wasReset: false,
    addEventListener(event, handler) {
      if (event === "submit") this.submit = handler;
    },
    querySelector(selector) {
      const normalized = selector.toLowerCase();
      if (normalized.includes("name") && normalized.includes("error")) return fields.nameError;
      if (normalized.includes("email") && normalized.includes("error")) return fields.emailError;
      if (normalized.includes("email")) return fields.email;
      if (normalized.includes("name")) return fields.name;
      if (/(?:honeypot|website|spam|bot|url|hp)/.test(normalized)) return fields.honeypot;
      if (/(?:status|success|message)/.test(normalized)) return fields.status;
      return null;
    },
    reset() {
      this.wasReset = true;
    },
  };
}

function hexLuminance(value) {
  const hex = value.slice(1);
  const channels = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  return channels
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(first, second) {
  const light = Math.max(hexLuminance(first), hexLuminance(second));
  const dark = Math.min(hexLuminance(first), hexLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

function cssHexVariable(name) {
  const match = new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i").exec(css);
  return match?.[1] ?? null;
}

function tagById(tagName, id) {
  return new RegExp(`<${tagName}\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i").exec(html)?.[0] ?? "";
}

function tagByAnyId(id) {
  return new RegExp(`<[a-z][^>]*\\bid=["']${id}["'][^>]*>`, "i").exec(html)?.[0] ?? "";
}

function attributeValue(tag, name) {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? "";
}

function hasAttribute(tag, name, value) {
  const pattern = value === undefined
    ? new RegExp(`\\b${name}(?:\\s*=|\\s|>)`, "i")
    : new RegExp(`\\b${name}\\s*=\\s*["']${value}["']`, "i");
  return pattern.test(tag);
}

// Gate 1: Semantic Structure & Information Architecture (20 pts)
{
  const hasHeader = /<header[\s>]/i.test(html);
  const hasNav = /<nav[\s>]/i.test(html);
  const hasMain = /<main[\s>]/i.test(html);
  const hasFooter = /<footer[\s>]/i.test(html);
  const hasH1 = count(/<h1[\s>]/gi, html) === 1;
  const hasH2 = count(/<h2[\s>]/gi, html) >= 2;
  const pricingMarkup = renderWith(app.renderPricing, false, data.pricing);
  const hasTierHeadings = count(/<h3[\s>]/gi, pricingMarkup) === data.pricing.monthly.length;
  const passed = hasHeader && hasNav && hasMain && hasFooter && hasH1 && hasH2 && hasTierHeadings;
  checks.push({
    name: "semantic landmarks and heading tree",
    passed,
    points: 20,
  });
}

// Gate 2: Content & Claims Integrity (20 pts)
{
  const metricsMarkup = renderWith(app.renderMetrics, data.brand.verifiedMetrics);
  const pricingMonthly = renderWith(app.renderPricing, false, data.pricing);
  const pricingAnnual = renderWith(app.renderPricing, true, data.pricing);
  const exactMetrics = data.brand.verifiedMetrics.every(
    ({ label, value }) => metricsMarkup.includes(label) && metricsMarkup.includes(value),
  );
  const exactTiers = [...data.pricing.monthly, ...data.pricing.annual].every(
    ({ name, events }) => pricingMonthly.includes(name) || pricingAnnual.includes(name)
      ? pricingMonthly.includes(events) || pricingAnnual.includes(events)
      : false,
  );
  const annualDiscount = normalizedHtml.includes("Save 20%")
    && pricingMonthly.includes("$49/mo")
    && pricingAnnual.includes("$39/mo");
  const passed = normalizedHtml.includes(data.brand.name) && exactMetrics && exactTiers && annualDiscount;
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
    const valid = fakeLeadForm({ email: "developer@example.com" });
    app.setupLeadForm(valid);
    valid.submit({ preventDefault() {} });

    const invalid = fakeLeadForm({ email: "not-an-email" });
    app.setupLeadForm(invalid);
    invalid.submit({ preventDefault() {} });

    const spam = fakeLeadForm({ email: "bot@example.com", honeypot: "https://spam.invalid" });
    app.setupLeadForm(spam);
    spam.submit({ preventDefault() {} });

    const inputTags = html.match(/<input\b[^>]*>/gi) ?? [];
    const emailTag = inputTags.find((tag) => hasAttribute(tag, "type", "email")) ?? "";
    const describedBy = attributeValue(emailTag, "aria-describedby").split(/\s+/).filter(Boolean);
    const errorTag = describedBy.map(tagByAnyId).find((tag) => hasAttribute(tag, "aria-live", "polite")) ?? "";
    const statusTag = tagById("div", "form-status") || tagById("p", "form-status") || tagById("span", "form-status");
    const honeypotTag = inputTags.find((tag) => hasAttribute(tag, "tabindex", "-1")) ?? "";
    const honeypotId = attributeValue(honeypotTag, "id");
    const wrapperPattern = honeypotId
      ? new RegExp(`<[^>]+aria-hidden\\s*=\\s*["']true["'][^>]*>[\\s\\S]{0,1000}<input\\b[^>]*id=["']${honeypotId}["']`, "i")
      : null;
    const wrapperMatch = wrapperPattern?.exec(html)?.[0] ?? "";
    const wrapperTag = wrapperMatch.slice(0, wrapperMatch.indexOf(">") + 1);
    const wrapperClasses = attributeValue(wrapperTag, "class").split(/\s+/).filter(Boolean);
    const hiddenByAttribute = hasAttribute(wrapperTag, "hidden") || /style=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(wrapperTag);
    const hiddenByCss = wrapperClasses.some((className) => {
      const rule = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`, "i").exec(css)?.[1] ?? "";
      return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(rule)
        || (/position\s*:\s*absolute/i.test(rule) && /(?:clip|width\s*:\s*1px|height\s*:\s*1px|overflow\s*:\s*hidden)/i.test(rule));
    });
    const hiddenHoneypot = Boolean(wrapperMatch) && (hiddenByAttribute || hiddenByCss);
    const accessibleMarkup = hasAttribute(emailTag, "type", "email")
      && hasAttribute(emailTag, "required")
      && describedBy.length > 0
      && hasAttribute(errorTag, "aria-live", "polite")
      && hasAttribute(statusTag, "aria-live", "polite")
      && hasAttribute(honeypotTag, "tabindex", "-1")
      && hiddenHoneypot;
    passed = accessibleMarkup
      && valid.wasReset
      && valid.fields.status.textContent.length > 0
      && !invalid.wasReset
      && invalid.fields.emailError.textContent.length > 0
      && spam.fields.status.textContent.length === 0;
  } catch {
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
  const hasCustomProps = [
    /--color-[a-z0-9-]+\s*:/i,
    /--font-[a-z0-9-]+\s*:/i,
    /--space-[a-z0-9-]+\s*:/i,
    /--radius-[a-z0-9-]+\s*:/i,
  ].every((pattern) => pattern.test(css));
  const mediaQueries = count(/@media\s*\([^)]*(?:min|max)-width\s*:/gi, css);
  const hasTargetWidths = [375, 768, 1440].every((width) => css.includes(`${width}px`));
  const protectsViewport = /overflow-x\s*:\s*(?:hidden|clip)/i.test(css)
    || /max-width\s*:\s*100%/i.test(css);
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const passed = hasCustomProps && mediaQueries >= 3 && hasTargetWidths && protectsViewport && hasViewport;
  checks.push({
    name: "design system tokens and responsive media queries",
    passed,
    points: 20,
  });
}

// Gate 5: Accessibility & Performance (20 pts)
{
  const hasReducedMotion = /prefers-reduced-motion\s*:\s*reduce/i.test(css);
  const hasFocusVisible = css.includes(":focus-visible");
  const background = cssHexVariable("--color-bg");
  const text = cssHexVariable("--color-text");
  const contrastPasses = background && text && contrastRatio(background, text) >= 4.5;
  const hasExternalRuntime = /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i.test(html);
  const passed = hasReducedMotion && hasFocusVisible && contrastPasses && !hasExternalRuntime;
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
