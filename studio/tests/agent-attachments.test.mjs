import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATTACHMENT_DIR,
  IMAGE_LIMITS,
  parseImageDataUrl,
  removeAgentImages,
  validateAgentImages,
  writeAgentImages,
} from "../server/agent-attachments.js";
import { runAgentTurn } from "../server/agent-cli.js";

/**
 * An attachment reaches Claude Code and Codex as a file, because the prompt
 * these CLIs are given is argv and bytes cannot ride in it. What is asserted
 * here is the whole of that journey: a data URL is decoded and checked, written
 * under the agent's own working directory, named to the agent in the one way
 * that agent can act on, and then removed when the turn ends.
 *
 * The argv assertions run the real `runAgentTurn` against a fake agent that
 * prints its own arguments, so what is checked is the argument vector the
 * production path actually built — not a re-derivation of it.
 */

const root = mkdtempSync(join(tmpdir(), "agent-attachments-test-"));

/** A real 1x1 PNG, not a plausible-looking buffer. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAX+d9DwAAAABJRU5ErkJggg==";

function dataUrl(mediaType, bytes) {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

const JPEG = dataUrl("image/jpeg", [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = dataUrl("image/webp", [
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

/**
 * A fake agent that prints its own argv and exits.
 *
 * The line is deliberately not JSON: `runAgentTurn` reports an unparseable line
 * as a `notice` event, which is the one channel that carries a payload through
 * without engine-specific normalisation touching it.
 */
function argvEcho() {
  const file = join(root, `argv-${randomUUID()}.mjs`);
  writeFileSync(
    file,
    `#!${process.execPath}\nprocess.stdout.write("ARGV " + JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    { mode: 0o755 },
  );
  return file;
}

async function argvFor(engine, options) {
  const events = [];
  await runAgentTurn({
    engine,
    root,
    bin: argvEcho(),
    onEvent: (event) => events.push(event),
    ...options,
  });
  const notice = events.find((event) => event.type === "notice" && event.text.startsWith("ARGV "));
  assert.ok(notice, "the fake agent did not report its arguments");
  return JSON.parse(notice.text.slice(5));
}

/* ── Decoding ────────────────────────────────────────────────────────────── */

test("a data URL is decoded only when it is one", () => {
  const png = parseImageDataUrl(PNG);
  assert.equal(png.mediaType, "image/png");
  assert.equal(png.extension, "png");
  assert.ok(png.bytes.length > 0);

  assert.equal(parseImageDataUrl(JPEG).extension, "jpg");
  assert.equal(parseImageDataUrl(WEBP).extension, "webp");

  assert.throws(() => parseImageDataUrl("https://example.com/cat.png"), /INVALID_AGENT_IMAGE/);
  assert.throws(() => parseImageDataUrl("data:image/png;base64,"), /INVALID_AGENT_IMAGE/);
  assert.throws(() => parseImageDataUrl(42), /INVALID_AGENT_IMAGE/);
  assert.throws(() => parseImageDataUrl(dataUrl("image/gif", [0x47, 0x49, 0x46])), /UNSUPPORTED_AGENT_IMAGE/);
});

test("bytes that are not the type they claim are refused", () => {
  // A shell script wearing a .png media type. The filename would be ours, but
  // the contents would be whatever was sent.
  assert.throws(() => parseImageDataUrl(dataUrl("image/png", [...Buffer.from("#!/bin/sh\nrm -rf /")])), /INVALID_AGENT_IMAGE/);
  // RIFF is a container; only the fourCC at offset 8 makes it a WebP.
  assert.throws(() => parseImageDataUrl(dataUrl("image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])), /INVALID_AGENT_IMAGE/);
});

test("the renderer's limits are re-checked on the server", () => {
  assert.deepEqual(validateAgentImages(undefined), []);
  assert.deepEqual(validateAgentImages([]), []);
  assert.equal(validateAgentImages([PNG, JPEG]).length, 2);

  assert.throws(() => validateAgentImages("one image"), /INVALID_AGENT_IMAGES/);
  assert.throws(() => validateAgentImages(new Array(IMAGE_LIMITS.maxCount + 1).fill(PNG)), /TOO_MANY_AGENT_IMAGES/);

  const huge = dataUrl("image/png", [0x89, 0x50, 0x4e, 0x47, ...new Uint8Array(3 * 1024 * 1024)]);
  assert.throws(() => validateAgentImages([huge, huge]), /AGENT_IMAGES_TOO_LARGE/);
});

/* ── On disk ─────────────────────────────────────────────────────────────── */

test("images land inside the agent's own working directory", () => {
  const cwd = mkdtempSync(join(root, "cwd-"));
  const { dir, paths } = writeAgentImages({ cwd, runId: "run-1", images: [PNG, JPEG, WEBP] });

  assert.equal(dir, join(cwd, ATTACHMENT_DIR, "run-1"));
  assert.deepEqual(
    paths.map((path) => path.slice(dir.length + 1)),
    ["image-1.png", "image-2.jpg", "image-3.webp"],
  );
  for (const path of paths) assert.ok(existsSync(path), `${path} was not written`);
  // Claude Code anchors its read permission at cwd; an image outside it is one
  // the operator attached and the agent may not open.
  assert.ok(paths.every((path) => path.startsWith(`${cwd}/`)));

  // The directory ignores itself, so a turn that runs `git status` does not see
  // the operator's repository grow files it did not add.
  assert.equal(readFileSync(join(cwd, ATTACHMENT_DIR, ".gitignore"), "utf8"), "*\n");
});

test("a run id cannot name a directory outside the attachment root", () => {
  const cwd = mkdtempSync(join(root, "cwd-"));
  const { dir } = writeAgentImages({ cwd, runId: "../../escape", images: [PNG] });
  assert.ok(dir.startsWith(join(cwd, ATTACHMENT_DIR)), `${dir} escaped`);
});

test("no images means no directory at all", () => {
  const cwd = mkdtempSync(join(root, "cwd-"));
  assert.deepEqual(writeAgentImages({ cwd, runId: "empty", images: [] }), { dir: null, paths: [] });
  assert.equal(existsSync(join(cwd, ATTACHMENT_DIR)), false);
});

test("cleanup takes the run away, and the root only once nothing is left", () => {
  const cwd = mkdtempSync(join(root, "cwd-"));
  const first = writeAgentImages({ cwd, runId: "run-a", images: [PNG] });
  const second = writeAgentImages({ cwd, runId: "run-b", images: [JPEG] });

  removeAgentImages(first.dir);
  assert.equal(existsSync(first.dir), false);
  // The second turn is still running: its files, and the .gitignore that hides
  // them, must both survive the first turn ending.
  assert.equal(existsSync(second.paths[0]), true);
  assert.equal(existsSync(join(cwd, ATTACHMENT_DIR, ".gitignore")), true);

  removeAgentImages(second.dir);
  assert.equal(existsSync(join(cwd, ATTACHMENT_DIR)), false);

  // Idempotent: `finish()` is the only caller, but it is reached by four paths.
  removeAgentImages(second.dir);
  removeAgentImages(null);
});

/* ── What the agent is actually told ─────────────────────────────────────── */

test("codex is handed the files, and the prompt still comes last", async () => {
  const argv = await argvFor("codex", { prompt: "what is in this", images: [PNG, JPEG] });

  const attached = argv.filter((argument) => argument.startsWith("--image="));
  assert.equal(attached.length, 2);
  assert.ok(attached[0].endsWith("image-1.png"));
  assert.ok(attached[1].endsWith("image-2.jpg"));
  // `--image <FILE>...` is variadic: given its value positionally it goes on
  // eating arguments, and the one it would eat is the prompt.
  assert.equal(argv.at(-1), "what is in this");
});

test("claude is told where the files are, because it has no flag for them", async () => {
  const argv = await argvFor("claude", { prompt: "what is in this", images: [PNG] });

  const prompt = argv[argv.indexOf("-p") + 1];
  assert.match(prompt, /attached 1 image to this message/);
  assert.match(prompt, /Read it with your Read tool/);
  assert.match(prompt, /image-1\.png/);
  // The operator's own words survive, and arrive after the instruction rather
  // than before it.
  assert.ok(prompt.endsWith("what is in this"));
  assert.equal(argv.includes("--image"), false);
});

test("a turn with no attachments is the turn it always was", async () => {
  const argv = await argvFor("claude", { prompt: "just a question" });
  assert.equal(argv[argv.indexOf("-p") + 1], "just a question");
  assert.equal(argv.some((argument) => argument.startsWith("--image=")), false);
});

test("the files do not outlive the turn", async () => {
  const cwd = mkdtempSync(join(root, "cwd-"));
  await argvFor("codex", { prompt: "look", cwd: cwd.slice(root.length + 1), images: [PNG] });
  assert.equal(existsSync(join(cwd, ATTACHMENT_DIR)), false, `${readdirSync(cwd).join(", ")} was left behind`);
});
