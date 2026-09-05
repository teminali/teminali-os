import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectPhrase } from "../server/project-phrase.js";

const NOW = new Date("2026-09-06T10:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const RECENT = [
  { path: "/p/landing", name: "landing", openedAt: daysAgo(0), kind: "code" },
  { path: "/p/reel", name: "reel", openedAt: daysAgo(1), kind: "video" },
  { path: "/p/teminaliCode", name: "teminaliCode", openedAt: daysAgo(1), kind: "code" },
  { path: "/p/trailer", name: "trailer", openedAt: daysAgo(9), kind: "video" },
];

test("\"the last project\" is the newest one that is not already open", () => {
  const { project } = resolveProjectPhrase("open the last project", RECENT, { now: NOW, currentPath: "/p/landing" });
  assert.equal(project.path, "/p/reel");
});

test("\"the last video project\" filters by kind before taking the newest", () => {
  const { project } = resolveProjectPhrase("the last video project", RECENT, { now: NOW, currentPath: "/p/landing" });
  assert.equal(project.path, "/p/reel");
});

test("\"the one from yesterday\" filters by calendar day", () => {
  const { project } = resolveProjectPhrase("open the one from yesterday", RECENT, { now: NOW, currentPath: "/p/landing" });
  assert.equal(project.path, "/p/reel");
});

test("a name wins over recency", () => {
  const { project } = resolveProjectPhrase("open teminaliCode", RECENT, { now: NOW, currentPath: "/p/landing" });
  assert.equal(project.path, "/p/teminaliCode");
});

test("the project already open is not what \"the last project\" means", () => {
  const { project } = resolveProjectPhrase("last project", [RECENT[0]], { now: NOW, currentPath: "/p/landing" });
  assert.equal(project, null);
});

test("a name nobody has is a refusal, not the nearest project", () => {
  const { project, reason } = resolveProjectPhrase("open dukabot", RECENT, { now: NOW, currentPath: "" });
  assert.equal(project, null);
  assert.match(reason, /dukabot/);
});

test("a kind with nothing to match says so, and says how short the list is", () => {
  const codeOnly = RECENT.filter((entry) => entry.kind === "code");
  const { project, reason } = resolveProjectPhrase("the last video project", codeOnly, { now: NOW, currentPath: "" });
  assert.equal(project, null);
  assert.match(reason, /video/);
  assert.match(reason, /last 2/);
});

test("a miss on yesterday admits the twelve-entry list may simply have dropped it", () => {
  const stale = [{ path: "/p/old", name: "old", openedAt: daysAgo(30), kind: "code" }];
  const { project, reason } = resolveProjectPhrase("the one from yesterday", stale, { now: NOW, currentPath: "" });
  assert.equal(project, null);
  assert.match(reason, /no longer be recorded/);
});

test("\"the second to last\" steps one further back", () => {
  const { project } = resolveProjectPhrase("the second to last project", RECENT, { now: NOW, currentPath: "/p/landing" });
  assert.equal(project.path, "/p/teminaliCode");
});

test("an empty recents list is answered, not thrown", () => {
  const { project, reason } = resolveProjectPhrase("the last project", [], { now: NOW });
  assert.equal(project, null);
  assert.match(reason, /no recent projects/i);
});
