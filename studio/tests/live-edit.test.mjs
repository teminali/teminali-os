import assert from "node:assert/strict";
import test from "node:test";
import { isTruncatingRewrite, parseWorkspaceEdits } from "../src/services/liveEditProtocol.ts";

test("live edit parses explicit streamed and complete workspace file blocks", () => {
  const streamed = parseWorkspaceEdits('Working…\n```frontier-file path="src/App.tsx"\nexport const ready = tr');
  assert.deepEqual(streamed, [{ path: "src/App.tsx", content: "export const ready = tr", complete: false }]);

  const complete = parseWorkspaceEdits('```tsx path="src/App.tsx"\nexport const ready = true;\n```');
  assert.deepEqual(complete, [{ path: "src/App.tsx", content: "export const ready = true;\n", complete: true }]);
});

test("live edit supports a conventional file header and strips it from committed content", () => {
  const edits = parseWorkspaceEdits("```css\n/* no path */\n```\n```ts\n// file: src/state.ts\nexport const value = 1;\n```");
  assert.deepEqual(edits, [{ path: "src/state.ts", content: "export const value = 1;\n", complete: true }]);
});

test("live edit recognizes conventional markdown filename headings", () => {
  assert.deepEqual(
    parseWorkspaceEdits("### `src/components/Card.tsx`\n\n```tsx\nexport const Card = () => <article />;\n```"),
    [{ path: "src/components/Card.tsx", content: "export const Card = () => <article />;\n", complete: true }],
  );
});

test("a single code block may target the active file only for a real edit request", () => {
  assert.deepEqual(
    parseWorkspaceEdits("```tsx\nexport default function App() { return null; }\n```", { activePath: "src/App.tsx", userPrompt: "Fix and update the current component" }),
    [{ path: "src/App.tsx", content: "export default function App() { return null; }\n", complete: true }],
  );
  assert.deepEqual(
    parseWorkspaceEdits("```tsx\nexport default function App() { return null; }\n```", { activePath: "src/App.tsx", userPrompt: "Explain this code" }),
    [],
  );
});

test("live edit rejects unsafe and ambiguous inferred paths", () => {
  assert.deepEqual(parseWorkspaceEdits("```ts path=../outside.ts\nunsafe\n```"), []);
  assert.deepEqual(
    parseWorkspaceEdits("```ts\none\n```\n```ts\ntwo\n```", { activePath: "src/App.tsx", userPrompt: "update it" }),
    [],
  );
});

test("a multi-file scaffold answer with no path headers still reaches disk", () => {
  // The exact shape a local model produced in the landing-page benchmark:
  // three unlabelled fences, previously parsed to zero edits.
  const answer = [
    "Here is the page.",
    "```html\n<!DOCTYPE html>\n<html></html>\n```",
    "```css\nbody { margin: 0; }\n```",
    "```js\nconsole.log('ready');\n```",
  ].join("\n");

  assert.deepEqual(
    parseWorkspaceEdits(answer, { userPrompt: "Build a production-grade landing page for Teminali Nexus" }),
    [
      { path: "index.html", content: "<!DOCTYPE html>\n<html></html>\n", complete: true },
      { path: "styles.css", content: "body { margin: 0; }\n", complete: true },
      { path: "script.js", content: "console.log('ready');\n", complete: true },
    ],
  );
});

test("scaffold inference never guesses for repeated or unconventional languages", () => {
  // Two css blocks: which one is styles.css is unknowable, so commit nothing.
  assert.deepEqual(
    parseWorkspaceEdits("```css\na{}\n```\n```css\nb{}\n```", { userPrompt: "build the page" }),
    [],
  );
  // Python has no single conventional filename here.
  assert.deepEqual(
    parseWorkspaceEdits("```py\nprint(1)\n```", { userPrompt: "build a script" }),
    [],
  );
  // No edit intent means an explanatory answer is never written to disk.
  assert.deepEqual(
    parseWorkspaceEdits("```html\n<p>demo</p>\n```", { userPrompt: "Explain how this markup works" }),
    [],
  );
});

test("an explicit path always wins over scaffold inference", () => {
  assert.deepEqual(
    parseWorkspaceEdits('```html path="public/landing.html"\n<main></main>\n```', { userPrompt: "build the landing page" }),
    [{ path: "public/landing.html", content: "<main></main>\n", complete: true }],
  );
});

test("live edit refuses a path block that holds a fragment of a long file", () => {
  // The shape the local lane actually produces: asked to change one default in
  // an 812-line file it has seen one line of, it answers with a two-line path
  // block. Committing that deletes 810 lines, so the applier must not.
  const long = Array.from({ length: 812 }, (_, i) => `const line${i} = ${i};`).join("\n");
  assert.equal(isTruncatingRewrite(long, "  port: Number(process.env.PORT ?? 4310),\n"), true);

  // The same file rewritten in full is an edit, not a truncation.
  assert.equal(isTruncatingRewrite(long, long.replace("line3 = 3", "line3 = 4310")), false);
});

test("live edit lets a short file be rewritten, and a long one be halved", () => {
  // Below the floor "rewrite the whole thing" is an ordinary request, and the
  // model can hold the file in its window, so nothing is refused.
  const short = Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(isTruncatingRewrite(short, "line 0"), false);

  // At the cut itself: keeping half of a long file is allowed, one line less is not.
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(isTruncatingRewrite(long, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")), false);
  assert.equal(isTruncatingRewrite(long, Array.from({ length: 49 }, (_, i) => `line ${i}`).join("\n")), true);
});

/*
  The applier's second refusal: a file nobody read.

  `isTruncatingRewrite` catches a block that keeps too little of a file. It
  does not catch a block that is the right *size* and the wrong *file* — an
  invented six-line script over a real twenty-line one — which is what the
  local lane produced 3/3 in the `read-before-edit` eval case. Prose did not
  move that number, so the guard lives here, in the code that writes bytes.

  These drive the real service with the workspace transport stubbed, because
  the guard is a property of committing, not of parsing.
*/

globalThis.window ??= {
  location: { protocol: "http:" },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

const { LiveEditService } = await import("../src/services/liveEditService.ts");
const { WorkspaceService } = await import("../src/services/workspaceService.ts");
const { GatewayError } = await import("../src/services/gatewayClient.ts");

const DEPLOY = ["#!/bin/sh", "set -e", "rsync -a dist/ prod:/srv/app", "echo deployed"].join("\n");

/** A workspace holding `files`; anything else is a 404, the way the gateway reports one. */
function stubWorkspace(files) {
  const written = [];
  WorkspaceService.readFile = async (path) => {
    if (!(path in files)) throw new GatewayError("not found", "WORKSPACE_FILE_NOT_FOUND", 404);
    return { path, content: files[path], modified: "2026-09-07T00:00:00Z", size: files[path].length, mimeType: "text/plain" };
  };
  WorkspaceService.writeFile = async (path, content) => {
    written.push(path);
    files[path] = content;
    return { path, content, modified: "2026-09-07T00:00:01Z", size: content.length, mimeType: "text/plain" };
  };
  return written;
}

/**
 * Wait for the service to go quiet.
 *
 * It is a singleton with playback on a timer, so a commit from the previous
 * test is still publishing while the next one starts. Without this the tests
 * read each other's snapshots.
 */
async function idle() {
  let revision = -1;
  while (revision !== LiveEditService.getSnapshot().revision) {
    revision = LiveEditService.getSnapshot().revision;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/** Wait for the commit to land or be refused; it is fired off, not awaited. */
async function settle(predicate, budgetMs = 2_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

const block = (path, ...lines) => ["```path=" + path, ...lines, "```"].join("\n");

test("live edit refuses to overwrite a file this conversation has never read", async () => {
  await idle();
  const written = stubWorkspace({ "scripts/deploy.sh": DEPLOY });
  LiveEditService.observe({
    requestId: "unseen-1",
    text: block("scripts/deploy.sh", "#!/bin/sh", 'echo "deploying"', "npm run deploy -- --verbose"),
    isStreaming: false,
    userPrompt: "add a --verbose flag to scripts/deploy.sh",
    dirtyPaths: [],
    seenPaths: [],
    conversationId: "session-unseen",
  });

  assert.ok(await settle(() => LiveEditService.getSnapshot().phase === "error"), "the write should have been refused");
  assert.deepEqual(written, [], "nothing may reach disk");
  // The refusal has to name the way out, or the model spends the next turn
  // guessing again rather than reading.
  assert.match(LiveEditService.getSnapshot().detail, /nothing in this conversation has read it/);
  assert.match(LiveEditService.getSnapshot().detail, /cat scripts\/deploy\.sh/);
});

test("live edit writes a file the conversation read, and one it created", async () => {
  await idle();
  const files = { "scripts/deploy.sh": DEPLOY };
  const written = stubWorkspace(files);

  // Read out loud on the shell: the model holds the real contents.
  LiveEditService.observe({
    requestId: "seen-1",
    text: block("scripts/deploy.sh", "#!/bin/sh", "npm run deploy -- --verbose"),
    isStreaming: false,
    userPrompt: "add a --verbose flag to scripts/deploy.sh",
    dirtyPaths: [],
    seenPaths: ["./scripts/deploy.sh"],
    conversationId: "session-seen",
  });
  assert.ok(await settle(() => written.includes("scripts/deploy.sh")), "a file that was read may be rewritten");

  // A file that does not exist yet is created, not refused: there is nothing
  // to destroy, and every scaffold answer is this shape.
  LiveEditService.observe({
    requestId: "seen-2",
    text: block("scripts/rollback.sh", "#!/bin/sh", "echo rolling back"),
    isStreaming: false,
    userPrompt: "add a rollback script",
    dirtyPaths: [],
    seenPaths: [],
    conversationId: "session-seen",
  });
  assert.ok(await settle(() => written.includes("scripts/rollback.sh")), "a new file is not an overwrite");

  // And having written it, the assistant knows its contents — a second edit to
  // the same file in the same conversation is not an invention.
  LiveEditService.observe({
    requestId: "seen-3",
    text: block("scripts/rollback.sh", "#!/bin/sh", "echo rolling back", "npm run rollback"),
    isStreaming: false,
    userPrompt: "make the rollback script call npm",
    dirtyPaths: [],
    seenPaths: [],
    conversationId: "session-seen",
  });
  assert.ok(
    await settle(() => written.filter((path) => path === "scripts/rollback.sh").length === 2),
    "a file the assistant wrote this conversation stays writable",
  );
});

test("a new chat forgets what the last one read", async () => {
  await idle();
  const written = stubWorkspace({ "scripts/release.sh": DEPLOY });
  const observe = (requestId, conversationId, seenPaths) =>
    LiveEditService.observe({
      requestId,
      text: block("scripts/release.sh", "#!/bin/sh", "npm run release"),
      isStreaming: false,
      userPrompt: "update the release script",
      dirtyPaths: [],
      seenPaths,
      conversationId,
    });

  observe("forget-1", "session-a", ["scripts/release.sh"]);
  // Settled, not merely written: playback publishes after the bytes land, and
  // a half-finished first commit would overwrite the second one's verdict.
  await idle();
  assert.deepEqual(written, ["scripts/release.sh"]);

  // Same file, same service, different conversation: the evidence did not
  // carry over, so the guard is back on.
  observe("forget-2", "session-b", []);
  await idle();
  assert.equal(LiveEditService.getSnapshot().phase, "error");
  assert.deepEqual(written, ["scripts/release.sh"], "the new conversation may not overwrite on the old one's evidence");
});

test("live edit parses inline filename mentions and colon notation", () => {
  const prompt = "Temi, create an app.js file that implements an interactive shopping cart with an item counter, a subtotal calculator with 10% tax, and link it in index.html.";

  // 1. Inline preceding mention
  const t1 = "I will create `app.js`:\n```javascript\nconsole.log('cart');\n```\nAnd update `index.html`:\n```html\n<script src=\"app.js\"></script>\n```";
  assert.deepEqual(parseWorkspaceEdits(t1, { userPrompt: prompt }), [
    { path: "app.js", content: "console.log('cart');\n", complete: true },
    { path: "index.html", content: '<script src="app.js"></script>\n', complete: true },
  ]);

  // 2. Colon fence notation
  const t2 = "```javascript:app.js\nconsole.log('cart');\n```";
  assert.deepEqual(parseWorkspaceEdits(t2, { userPrompt: prompt }), [
    { path: "app.js", content: "console.log('cart');\n", complete: true },
  ]);

  // 3. Unlabelled fence matched to user prompt
  const t3 = "```javascript\nconsole.log('cart');\n```";
  assert.deepEqual(parseWorkspaceEdits(t3, { userPrompt: prompt }), [
    { path: "app.js", content: "console.log('cart');\n", complete: true },
  ]);
});

test("live edit rejects shell commands as filenames and ignores execution fences", () => {
  // Shell execution fences should never be treated as file edits
  const toolText = "I'm running inspect:\n```frontier-run\nhead -n 50 index.html\n```\n```bash\ncat index.html\n```";
  assert.deepEqual(parseWorkspaceEdits(toolText), []);

  // Preceding shell command lines should not be extracted as filenames
  const commandMention = "I ran this command:\nhead -n 50 index.html\n```html\n<div>sample</div>\n```";
  // The command line is not a filename, so unlabelled block doesn't bind to "head -n 50 index.html"
  const edits = parseWorkspaceEdits(commandMention);
  assert.ok(!edits.some((e) => e.path.includes("head") || e.path.includes("index.html")));
});

