import assert from "node:assert/strict";
import test from "node:test";
import { findTabByFileIdentity, shouldPersistEditorChange } from "../src/store/tabIdentity.ts";

test("open-file identity uses the exact workspace path when filenames repeat", () => {
  const tabs = [
    { id: "root", name: "package.json", path: "package.json" },
    { id: "studio", name: "package.json", path: "studio/package.json" },
  ];
  assert.equal(findTabByFileIdentity(tabs, "studio/package.json", "package.json")?.id, "studio");
  assert.equal(findTabByFileIdentity(tabs, "packages/ui/package.json", "package.json"), undefined);
});

test("legacy name fallback applies only to a truly pathless persisted tab", () => {
  const tabs = [
    { id: "pathful", name: "README.md", path: "docs/README.md" },
    { id: "legacy", name: "README.md" },
  ];
  assert.equal(findTabByFileIdentity(tabs, "README.md", "README.md")?.id, "legacy");
});

test("controlled Monaco playback never becomes a user-dirty edit", () => {
  assert.equal(shouldPersistEditorChange(true), false);
  assert.equal(shouldPersistEditorChange(false), true);
});
