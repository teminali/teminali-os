import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteWorkspaceFile,
  isWritableWorkspaceFile,
  listWorkspaceTree,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../server/workspace.js";

/**
 * What the workspace will and will not show, and the promise that the two
 * halves of that answer agree.
 *
 * The gate used to be one extension table read in five places. Two kinds of
 * file fell through it: pictures, which the pane refused because the reader
 * refused first, and files whose whole name is the extension — `.gitignore`,
 * `Dockerfile` — which were absent from the tree entirely and therefore could
 * never be recorded as a reviewable change, because a reject that cannot be
 * honoured must not be offered.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), "workspace-files-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/* ── the writable gate ───────────────────────────────────────────────────── */

test("a file named only for its extension is writable, so a change to it can be rejected", () => {
  assert.equal(isWritableWorkspaceFile("app/.gitignore"), true);
  assert.equal(isWritableWorkspaceFile("Dockerfile"), true);
  assert.equal(isWritableWorkspaceFile("Makefile"), true);
  assert.equal(isWritableWorkspaceFile("src/index.ts"), true);
});

test("bytes are never writable, whatever the pane can display", () => {
  assert.equal(isWritableWorkspaceFile("logo.png"), false);
  assert.equal(isWritableWorkspaceFile("report.pdf"), false);
  assert.equal(isWritableWorkspaceFile("book.xlsx"), false);
});

test(".env stays out, because its contents are usually secrets", () => {
  assert.equal(isWritableWorkspaceFile(".env"), false);
});

/* ── reading ─────────────────────────────────────────────────────────────── */

test("an image comes back as base64 under its own mime type", async () => {
  const root = workspace({ "logo.png": PNG });
  const file = await readWorkspaceFile(root, "logo.png");
  assert.equal(file.encoding, "base64");
  assert.equal(file.mimeType, "image/png");
  assert.equal(Buffer.from(file.content, "base64").equals(PNG), true);
});

test("a PDF comes back as base64, which is what the viewer frame needs", async () => {
  const root = workspace({ "report.pdf": "%PDF-1.4\n%%EOF\n" });
  const file = await readWorkspaceFile(root, "report.pdf");
  assert.equal(file.encoding, "base64");
  assert.equal(file.mimeType, "application/pdf");
});

test("a Dockerfile comes back as text, not as bytes", async () => {
  const root = workspace({ Dockerfile: "FROM node:22\n" });
  const file = await readWorkspaceFile(root, "Dockerfile");
  assert.equal(file.encoding, "utf8");
  assert.equal(file.content, "FROM node:22\n");
});

test("an .xls that is really an HTML table is still text", async () => {
  const root = workspace({ "sheet.xls": "<table><tr><td>1</td></tr></table>" });
  const file = await readWorkspaceFile(root, "sheet.xls");
  assert.equal(file.encoding, "utf8");
});

test("a format with no viewer is still refused rather than guessed at", async () => {
  const root = workspace({ "clip.mp4": "\0\0\0 ftypmp42" });
  await assert.rejects(readWorkspaceFile(root, "clip.mp4"), /WORKSPACE_FILE_UNSUPPORTED/);
});

/* ── the tree ────────────────────────────────────────────────────────────── */

test("the tree lists everything a pane can open, and nothing it cannot", async () => {
  const root = workspace({ "logo.png": PNG, Dockerfile: "FROM node:22\n", "notes.md": "hi", "clip.mp4": "x" });
  const tree = await listWorkspaceTree(root);
  const names = tree.files.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["Dockerfile", "logo.png", "notes.md"]);
});

/* ── writing and deleting ────────────────────────────────────────────────── */

test("a Dockerfile round-trips through the write path", async () => {
  const root = workspace({ Dockerfile: "FROM node:22\n" });
  const written = await writeWorkspaceFile(root, "Dockerfile", "FROM node:24\n");
  assert.equal(written.content, "FROM node:24\n");
  assert.equal((await readWorkspaceFile(root, "Dockerfile")).content, "FROM node:24\n");
});

test("an image is readable but never writable, so utf8 cannot overwrite its bytes", async () => {
  const root = workspace({ "logo.png": PNG });
  await assert.rejects(writeWorkspaceFile(root, "logo.png", "not a picture"), /WORKSPACE_FILE_UNSUPPORTED/);
  assert.equal(Buffer.from((await readWorkspaceFile(root, "logo.png")).content, "base64").equals(PNG), true);
});

test("restoring a created .gitignore to nothing means deleting it", async () => {
  const root = workspace({ ".gitignore": "dist\n" });
  const result = await deleteWorkspaceFile(root, ".gitignore");
  assert.equal(result.deleted, true);
  await assert.rejects(readWorkspaceFile(root, ".gitignore"), /ENOENT/);
});
