import assert from "node:assert/strict";
import test from "node:test";

import { DiligenceEngine } from "../src/services/diligenceEngine.ts";

const rules = (findings) => findings.map((finding) => finding.rule).sort();

/** A command the runner actually executed. */
const did = (command, output = "ok") => ({
  command,
  risk: "auto",
  executed: true,
  code: 0,
  output,
  truncated: false,
});

/** A command that was parsed but never ran. */
const skipped = (command) => ({
  command,
  risk: "confirm",
  executed: false,
  code: null,
  output: "",
  truncated: false,
  note: "Skipped pending approval",
});

const audit = (overrides) =>
  DiligenceEngine.auditInvestigation({
    userPrompt: "",
    answerText: "",
    executions: [],
    canRunCommands: true,
    ...overrides,
  });

test("a question about real state is recognised across domains, not just disk", () => {
  for (const prompt of [
    "can you tell me how much storage my files on dowloads folder takes>",
    "how many tests are failing right now",
    "what is using port 3000",
    "which dependency is the biggest in the bundle",
    "list the files in the workspace",
    "is postgres running",
    "why is the build so slow",
    "audit my node_modules",
  ]) {
    assert.equal(DiligenceEngine.needsEvidence(prompt), true, prompt);
  }
});

test("design and opinion questions are not treated as inspections", () => {
  // Each of these trips a measurement word. None of them has anything to
  // measure, and demanding evidence would burn a generation turn.
  for (const prompt of [
    "how many ways could I refactor this function",
    "how much should I charge for this feature",
    "what is the best way to structure a reducer",
    "explain how much of a difference memoisation makes in general",
    "write me a poem about a large file",
  ]) {
    assert.equal(DiligenceEngine.needsEvidence(prompt), false, prompt);
  }
});

test("claiming no filesystem access while wired to a shell is a finding", () => {
  const findings = audit({
    userPrompt: "how much storage do my downloads take",
    answerText:
      "I'm unable to directly access or interact with your local file system, including the Downloads folder. Here are some general methods: on macOS, open Finder and press Command + I.",
  });
  assert.ok(rules(findings).includes("capability-denial"));
  assert.ok(rules(findings).includes("ungrounded-answer"));
  assert.ok(rules(findings).includes("deflected-to-user"));
});

test("printing the command and asking the operator to run it is deflection", () => {
  // Verbatim from Frontier Auto: it named the right command, printed it in a
  // ```bash block, and handed the work back. No denial, no "you can" — the
  // original pattern matched none of it and the turn was delivered as an answer.
  const findings = audit({
    userPrompt: "give me a total size of all the files in my desktop folder",
    answerText:
      "To calculate the total size of all files in your Desktop folder, I'll use the du command.\n" +
      "```bash\ndu -sh ~/Desktop\n```\n" +
      "Please run this command on your machine to get the result.",
  });
  assert.ok(rules(findings).includes("deflected-to-user"));
});

test("an answer built from real output is not deflection", () => {
  // The guard on the widened pattern: reporting what a command returned must
  // stay silent, or every grounded answer costs a wasted correction turn.
  const findings = audit({
    userPrompt: "give me a total size of all the files in my desktop folder",
    answerText: "I ran du -sh ~/Desktop: the Desktop holds 37 GB across 14,189 files.",
    executions: [{ command: "du -sh ~/Desktop", executed: true, output: "37G\t/Users/t/Desktop" }],
  });
  assert.equal(rules(findings).includes("deflected-to-user"), false);
});

test("the same answer is not a finding when the host has no shell", () => {
  const findings = audit({
    userPrompt: "how much storage do my downloads take",
    answerText: "I'm unable to access your local file system.",
    canRunCommands: false,
  });
  assert.deepEqual(findings, []);
});

test("an aggregate with no breakdown is sent back for decomposition", () => {
  const findings = audit({
    userPrompt: "how much storage do my downloads take",
    answerText: "Your Downloads folder is 2.4 GiB.",
    executions: [did("du -sh ~/Downloads", "2.4G\t/Users/x/Downloads")],
  });
  assert.deepEqual(rules(findings), ["aggregate-without-breakdown"]);
});

test("a decomposed answer with units disclosed passes clean", () => {
  const findings = audit({
    userPrompt: "how much storage do my downloads take",
    answerText:
      "Downloads is 2.4 GiB (Finder will show ~2.57 GB, decimal). Telegram Desktop is 1.0 G of it, node_modules another 675 M.",
    executions: [
      did("du -sh ~/Downloads"),
      did("du -sh ~/Downloads/* | sort -hr"),
    ],
  });
  assert.deepEqual(findings, []);
});

test("decomposition is recognised in non-disk domains too", () => {
  const findings = audit({
    userPrompt: "which dependency is the biggest in the bundle",
    answerText: "electron is the biggest at 192 MiB, then monaco-editor.",
    executions: [did("npm ls --depth=1"), did("du -sh node_modules/* | sort -hr | head")],
  });
  assert.deepEqual(findings, []);
});

test("advising a delete on name-lookalikes without checking identity is a finding", () => {
  const findings = audit({
    userPrompt: "how much storage do my downloads take",
    answerText:
      "You have FrontierCut-1.12.6.dmg and FrontierCut-1.12.6 (1).dmg — the second is a duplicate, so it is safe to delete it and free 113 MiB.",
    executions: [did("du -sh ~/Downloads"), did("du -sh ~/Downloads/* | sort -hr")],
  });
  assert.ok(rules(findings).includes("unverified-destructive-advice"));
});

test("the same advice passes once identity was actually established", () => {
  const findings = audit({
    userPrompt: "how much storage do my downloads take",
    answerText:
      "FrontierCut-1.12.6.dmg and FrontierCut-1.12.6 (1).dmg look like duplicates but their checksums differ, so do not delete either blindly. Total is 2.4 GiB.",
    executions: [
      did("du -sh ~/Downloads"),
      did("du -sh ~/Downloads/* | sort -hr"),
      did("md5 a.dmg b.dmg", "70472dd4...\n4ca7697c..."),
    ],
  });
  assert.deepEqual(findings, []);
});

test("a size from du with no unit named is flagged, a size without du is not", () => {
  const withDu = audit({
    userPrompt: "how much space is left on disk",
    answerText: "You have 38 G free.",
    executions: [did("df -h /"), did("du -sh /var/* | sort -hr")],
  });
  assert.ok(rules(withDu).includes("undisclosed-units"));

  // No size tool ran, so there is no binary/decimal ambiguity to disclose.
  const withoutDu = audit({
    userPrompt: "how many tests are failing",
    answerText: "3 tests fail in the parser suite.",
    executions: [did("npm test", "3 failing")],
  });
  assert.equal(rules(withoutDu).includes("undisclosed-units"), false);
});

test("a command that was parsed but never approved does not count as evidence", () => {
  const findings = audit({
    userPrompt: "what is using port 3000",
    answerText: "Port 3000 is probably held by your dev server.",
    executions: [skipped("lsof -i :3000")],
  });
  assert.ok(rules(findings).includes("ungrounded-answer"));
});

test("the brief tells the model what to run, not merely that it failed", () => {
  const brief = DiligenceEngine.formatDiligenceBrief(
    audit({
      userPrompt: "how much storage do my downloads take",
      answerText: "I'm unable to access your files.",
    }),
  );
  assert.match(brief, /frontier-run/);
  assert.match(brief, /capability-denial/);
});

test("the doctrine is appended without discarding the base prompt", () => {
  const wrapped = DiligenceEngine.wrapSystemPrompt("BASE PROMPT");
  assert.match(wrapped, /^BASE PROMPT/);
  assert.match(wrapped, /INVESTIGATION DOCTRINE/);
  // Flash runs an 8k window; doctrine that crowds out the user's files is a
  // net loss however correct it reads.
  assert.ok(wrapped.length - "BASE PROMPT".length < 1200, "doctrine must stay compact");
});

// ── Regressions found by an independent review of the first implementation ──

test("no rule fires without a shell, including the destructive-advice rule", () => {
  // Rules 1-3 were gated on canRunCommands and rules 4/6 need an executed
  // command, so only rule 5 could reach a shell-less host — and it did, telling
  // it to run `md5`.
  const findings = audit({
    userPrompt: "clean up my downloads",
    answerText: "You have a duplicate copy of that installer; delete it to free 113 MB.",
    executions: [],
    canRunCommands: false,
  });
  assert.deepEqual(findings, []);
});

test("a breakdown is demanded only when something was actually aggregated", () => {
  // A command that already names the specific thing has no aggregate to
  // decompose. Demanding one costs a full generation turn and, because there is
  // only one diligence correction per exchange, spends the budget a real gap
  // would have needed.
  const specific = [
    ["what is holding port 3000 on this machine", "Port 3000 is held by node, pid 4471.", "lsof -i :3000"],
    ["how many tests are failing right now", "3 tests fail in the parser suite.", "npm test"],
    ["what version of node is installed", "Node 26.4.0.", "node -v"],
  ];
  for (const [userPrompt, answerText, command] of specific) {
    const findings = audit({ userPrompt, answerText, executions: [did(command)] });
    assert.equal(
      rules(findings).includes("aggregate-without-breakdown"),
      false,
      `${command} has no aggregate to decompose`,
    );
  }

  // A genuine aggregate still gets sent back.
  const summed = audit({
    userPrompt: "how much storage do my downloads take",
    answerText: "Downloads is 2.4 GiB.",
    executions: [did("du -sh ~/Downloads")],
  });
  assert.deepEqual(rules(summed), ["aggregate-without-breakdown"]);
});

test("an unrelated git command does not launder the destructive-advice rule", () => {
  // `git status` establishes nothing about whether two installers are the same
  // file, and one `stat` call has nothing to compare against.
  const answerText =
    "FrontierCut-1.12.6.dmg and FrontierCut-1.12.6 (1).dmg are duplicates, so it is safe to delete the second.";
  for (const command of ["git status", "stat ~/Downloads/a.dmg", "shasum -a 256 a.dmg"]) {
    const findings = audit({
      userPrompt: "how much storage do my downloads take",
      answerText,
      executions: [did("du -sh ~/Downloads/* | sort -hr"), did(command)],
    });
    assert.ok(
      rules(findings).includes("unverified-destructive-advice"),
      `${command} does not compare two things`,
    );
  }

  // Two operands is what makes it a comparison.
  const compared = audit({
    userPrompt: "how much storage do my downloads take",
    answerText,
    executions: [did("du -sh ~/Downloads/* | sort -hr"), did("md5 a.dmg b.dmg")],
  });
  assert.equal(rules(compared).includes("unverified-destructive-advice"), false);
});

test("hypothetical questions are never treated as inspections", () => {
  // Each trips both a measurement word and a concrete noun, and none of them is
  // about this machine.
  for (const prompt of [
    "how many tests should I write for a new payment module",
    "how much should I charge for this project",
    "how big should a component file be",
    "how many commits should I squash before opening a PR, in general",
    "how much memory does a typical node process use in general",
  ]) {
    assert.equal(DiligenceEngine.needsEvidence(prompt), false, prompt);
  }
});

test("paraphrases of the same question are recognised, not just the canonical wording", () => {
  // Generality that only holds for the phrasings in the unit tests is not
  // generality; users paraphrase.
  for (const prompt of [
    "which dependency bloats the bundle",
    "which tests fail",
    "what's eating my disk space",
    "show me the biggest files in this repo",
    "find the largest folders on my machine",
    "what process has port 3000",
    "who is holding port 3000",
    "why is the build taking so long",
    "is my node_modules out of date",
  ]) {
    assert.equal(DiligenceEngine.needsEvidence(prompt), true, prompt);
  }
});
