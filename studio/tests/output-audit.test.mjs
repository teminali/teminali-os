import assert from "node:assert/strict";
import test from "node:test";

import { CompletenessEngine } from "../src/services/completenessEngine.ts";

const rules = (findings) => findings.map((finding) => finding.rule).sort();

// A stylesheet large enough to trip the size guard, with real layout rules.
function stylesheet(extra = "") {
  return `
:root { --bg: #09090c; }
body { font-family: 'Inter', sans-serif; background: var(--bg); }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); max-width: 1180px; }
.card { width: 100%; padding: 2rem; border: 1px solid rgba(255,255,255,.08); }
.hero { display: flex; align-items: center; justify-content: center; min-height: 60vh; }
.footer { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1.6rem; }
.nav { display: flex; gap: 1.35rem; }
.btn { padding: .55rem 1.05rem; border-radius: 9px; cursor: pointer; }
${extra}
`.padEnd(900, " ");
}

test("a stylesheet with layout rules and no media query is flagged as not responsive", () => {
  const findings = CompletenessEngine.auditGeneratedFiles([
    { path: "styles.css", content: stylesheet("* { box-sizing: border-box; }") },
  ]);
  assert.deepEqual(rules(findings), ["not-responsive"]);
});

test("a responsive stylesheet with a reset produces no findings", () => {
  const findings = CompletenessEngine.auditGeneratedFiles([
    { path: "styles.css", content: stylesheet("* { box-sizing: border-box; }\n@media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }") },
  ]);
  assert.deepEqual(findings, []);
});

test("design-system violations in a stylesheet are caught", () => {
  const findings = CompletenessEngine.auditGeneratedFiles([
    {
      path: "styles.css",
      content: stylesheet("body { font-family: 'Arial', sans-serif; background-color: #000000; }\n@media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }"),
    },
  ]);
  assert.deepEqual(rules(findings), ["missing-box-sizing", "off-system-font", "raw-black"]);
});

test("a small snippet is not judged against page-level style rules", () => {
  // Avoids punishing a model for answering "how do I center a div".
  assert.deepEqual(
    CompletenessEngine.auditGeneratedFiles([{ path: "snippet.css", content: ".a { display: flex; }" }]),
    [],
  );
});

test("accessibility gaps in markup are caught", () => {
  const html = `<!DOCTYPE html><html><head><title>x</title></head><body>
    <img src="hero.png">
    <button><svg viewBox="0 0 1 1"></svg></button>
    <input type="email" placeholder="you@example.com">
  </body></html>`;
  const findings = CompletenessEngine.auditGeneratedFiles([{ path: "index.html", content: html }]);
  const found = rules(findings);
  assert.ok(found.includes("missing-alt"), "alt");
  assert.ok(found.includes("unnamed-control"), "button name");
  assert.ok(found.includes("unlabelled-input"), "input label");
  assert.ok(found.includes("missing-meta-description"), "meta description");
  assert.ok(found.includes("dangling-asset"), "hero.png was never created");
});

test("properly labelled markup produces no accessibility findings", () => {
  const html = `<!DOCTYPE html><html><head>
    <meta name="description" content="A real page.">
    <title>x</title></head><body>
    <img src="hero.png" alt="Product screenshot">
    <button aria-label="Close"><svg viewBox="0 0 1 1"></svg></button>
    <button>Save changes</button>
    <label for="email">Email</label><input id="email" type="email">
    <input type="hidden" name="csrf">
  </body></html>`;
  const findings = CompletenessEngine.auditGeneratedFiles([
    { path: "index.html", content: html },
    { path: "hero.png", content: "" },
  ]);
  assert.deepEqual(findings, []);
});

test("an asset is only dangling when the response did not also create it", () => {
  const html = `<head><meta name="description" content="x"></head><img src="logo.svg" alt="Logo">`;
  assert.deepEqual(
    rules(CompletenessEngine.auditGeneratedFiles([{ path: "index.html", content: html }])),
    ["dangling-asset"],
  );
  assert.deepEqual(
    CompletenessEngine.auditGeneratedFiles([
      { path: "index.html", content: html },
      { path: "logo.svg", content: "<svg/>" },
    ]),
    [],
  );
});

test("remote, data, and anchor references are never treated as dangling", () => {
  const html = `<head><meta name="description" content="x"></head>
    <img src="https://cdn.example/a.png" alt="a">
    <img src="data:image/png;base64,AAA" alt="b">
    <a href="#pricing">Pricing</a>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">`;
  assert.deepEqual(CompletenessEngine.auditGeneratedFiles([{ path: "index.html", content: html }]), []);
});

test("loose typing is reported in TypeScript output", () => {
  const findings = CompletenessEngine.auditGeneratedFiles([
    { path: "src/App.tsx", content: "const data: any = load();\nconst node = element as any;" },
  ]);
  assert.deepEqual(rules(findings), ["any-type"]);
  assert.match(findings[0].detail, /2 use\(s\)/);
});

test("placeholders and empty handlers are still caught in generated files", () => {
  const findings = CompletenessEngine.auditGeneratedFiles([
    { path: "src/App.tsx", content: "// TODO: wire this up\nconst x = <button onClick={() => {}} />;" },
  ]);
  const found = rules(findings);
  assert.ok(found.includes("placeholder"));
  assert.ok(found.includes("unwired-handler"));
});

test("the correction brief groups findings by file and asks for a re-emit", () => {
  const brief = CompletenessEngine.formatAuditBrief([
    { path: "styles.css", rule: "not-responsive", detail: "No @media query." },
    { path: "styles.css", rule: "raw-black", detail: "Uses #000000." },
    { path: "index.html", rule: "missing-alt", detail: "<img> without alt." },
  ]);
  assert.match(brief, /styles\.css:/);
  assert.match(brief, /\[not-responsive\]/);
  assert.match(brief, /index\.html:/);
  assert.match(brief, /Re-emit only the affected files/);
  assert.equal(CompletenessEngine.formatAuditBrief([]), "");
});

test("a control wrapped in a label is not reported as unlabelled", () => {
  // Implicit association is valid HTML; flagging it would waste a correction turn.
  const html = `<head><meta name="description" content="x"></head>
    <label><input type="checkbox" id="annual"> Save 25% with the annual plan</label>
    <label>Search <input type="search" id="q"></label>`;
  assert.deepEqual(CompletenessEngine.auditGeneratedFiles([{ path: "index.html", content: html }]), []);
});

import { parseWorkspaceEdits } from "../src/services/liveEditProtocol.ts";

test("the full pipeline turns a defective scaffold answer into a correction brief", () => {
  // Exactly the shape the local model produced in the landing-page benchmark:
  // unlabelled fences, Arial, no media queries, a logo that was never created.
  const answer = [
    "Here is the landing page.",
    '```html\n<!DOCTYPE html><html><head><title>Nexus</title></head>' +
      '<body><img src="assets/logo.png"><button><svg/></button></body></html>\n```',
    "```css\n" +
      "body { font-family: 'Arial', sans-serif; background: #000000; }\n" +
      ".grid { display: grid; grid-template-columns: repeat(3, 1fr); max-width: 1180px; }\n" +
      ".hero { display: flex; min-height: 60vh; width: 100%; }\n" +
      ".card { width: 100%; padding: 2rem; border: 1px solid #222; }\n" +
      ".nav { display: flex; gap: 1rem; }\n" +
      ".footer { display: grid; grid-template-columns: repeat(5, 1fr); }\n" +
      "/* padding to clear the snippet guard */\n" + "/* x */\n".repeat(90) +
      "```",
    "```js\nconsole.log('ready');\n```",
  ].join("\n");

  // 1. Paths are inferred, so the files reach disk at all.
  const edits = parseWorkspaceEdits(answer, { userPrompt: "Build a landing page for Teminali Nexus" });
  assert.deepEqual(edits.map((edit) => edit.path), ["index.html", "styles.css", "script.js"]);

  // 2. The audit sees the real defects.
  const findings = CompletenessEngine.auditGeneratedFiles(
    edits.map((edit) => ({ path: edit.path, content: edit.content })),
  );
  const found = new Set(findings.map((finding) => finding.rule));
  for (const rule of ["missing-alt", "unnamed-control", "dangling-asset", "missing-meta-description", "not-responsive", "missing-box-sizing", "raw-black", "off-system-font"]) {
    assert.ok(found.has(rule), `expected the audit to catch ${rule}`);
  }

  // 3. The model gets an actionable brief naming the files to re-emit.
  const brief = CompletenessEngine.formatAuditBrief(findings);
  assert.match(brief, /index\.html:/);
  assert.match(brief, /styles\.css:/);
  assert.match(brief, /Re-emit only the affected files/);
});

test("a clean scaffold answer triggers no correction pass", () => {
  const answer = [
    '```html path="index.html"\n<!DOCTYPE html><html><head><meta name="description" content="Nexus."><title>x</title></head><body><main>Hi</main></body></html>\n```',
  ].join("\n");
  const edits = parseWorkspaceEdits(answer, { userPrompt: "build the page" });
  const findings = CompletenessEngine.auditGeneratedFiles(edits.map((e) => ({ path: e.path, content: e.content })));
  assert.deepEqual(findings, []);
  assert.equal(CompletenessEngine.formatAuditBrief(findings), "");
});
