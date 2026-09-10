/*
  What the About surface is allowed to say.

  This is a licence surface before it is a pane: §6 of the LGPL is met only
  when the shipped components are named with their versions and the source is
  offered, so the failures worth pinning are the ones where the app claims
  something untrue about what it carries. A checkout must not claim a bundle it
  does not have; a build that ships one must name every component in it exactly
  once; and a licence text must be reachable by name without that name being a
  path somebody can steer.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { aboutPayload, readLicence, readMediaStack, PRODUCT_NAME } from "../server/about.js";

const MANIFEST = {
  builtAt: "2026-09-10T21:41:30Z",
  platform: "macos",
  components: [
    { name: "FFmpeg", version: "7.1.1", licence: "LGPL-2.1-or-later" },
    { name: "openh264", version: "2.4.1", licence: "BSD-2-Clause" },
    { name: "kvazaar", version: "2.3.1", licence: "LGPL-2.1-or-later" },
  ],
  sourceOffer: "https://github.com/teminali/releases/releases/tag/media-stack-7.1.1",
  buildScript: "studio/scripts/build-media-stack.sh",
};

/** A fake `<Resources>`: manifests by bundle, licence file names by bundle. */
function bundleAt(root, { manifests = {}, licences = {} } = {}) {
  const read = async (path) => {
    for (const [bundle, manifest] of Object.entries(manifests)) {
      if (path === join(root, bundle, "manifest.json")) return JSON.stringify(manifest);
    }
    for (const [bundle, files] of Object.entries(licences)) {
      for (const file of files) {
        if (path === join(root, bundle, "licences", file)) return `text of ${file}`;
      }
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const list = async (path) => {
    for (const [bundle, files] of Object.entries(licences)) {
      if (path === join(root, bundle, "licences")) return [...files];
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  return { resourcesPath: root, read, list };
}

test("a build with no bundle claims none", async () => {
  const stack = await readMediaStack({ resourcesPath: undefined });
  assert.equal(stack.bundled, false);
  assert.deepEqual(stack.components, []);
  assert.equal(stack.sourceOffer, null);
});

test("a checkout is not a bundle even when media-stack/ is full", async () => {
  /* `resourcesPath` is Electron's and undefined under Node. A development run
     resolves ffmpeg off the PATH, so naming the staged build would name a
     binary this process is not using. */
  const stack = await readMediaStack({ ...bundleAt("/R", { manifests: { ffmpeg: MANIFEST } }), resourcesPath: undefined });
  assert.equal(stack.bundled, false);
});

test("a shipped bundle names every component with its version and licence", async () => {
  const stack = await readMediaStack(bundleAt("/R", { manifests: { ffmpeg: MANIFEST } }));
  assert.equal(stack.bundled, true);
  assert.deepEqual(
    stack.components.map((c) => `${c.name} ${c.version} ${c.licence}`),
    ["FFmpeg 7.1.1 LGPL-2.1-or-later", "openh264 2.4.1 BSD-2-Clause", "kvazaar 2.3.1 LGPL-2.1-or-later"],
  );
  assert.equal(stack.sourceOffer, MANIFEST.sourceOffer);
  assert.equal(stack.buildScript, MANIFEST.buildScript);
  assert.equal(stack.platform, "macos");
});

test("both bundles carry the same manifest, and a component is listed once", async () => {
  const stack = await readMediaStack(bundleAt("/R", { manifests: { ffmpeg: MANIFEST, mpv: MANIFEST } }));
  assert.equal(stack.components.length, 3);
});

test("the same library at two versions is two disclosures", async () => {
  const other = { ...MANIFEST, components: [{ name: "FFmpeg", version: "6.1.1", licence: "LGPL-2.1-or-later" }] };
  const stack = await readMediaStack(bundleAt("/R", { manifests: { ffmpeg: MANIFEST, mpv: other } }));
  assert.deepEqual(
    stack.components.filter((c) => c.name === "FFmpeg").map((c) => c.version),
    ["7.1.1", "6.1.1"],
  );
});

test("a nameless component is dropped rather than rendered as an empty row", async () => {
  const broken = { ...MANIFEST, components: [{ version: "1.0" }, { name: "  ", version: "2" }, { name: "x264", version: "164" }] };
  const stack = await readMediaStack(bundleAt("/R", { manifests: { ffmpeg: broken } }));
  assert.deepEqual(stack.components, [{ name: "x264", version: "164", licence: null }]);
});

test("a manifest that will not parse discloses nothing rather than throwing", async () => {
  const options = bundleAt("/R");
  const stack = await readMediaStack({ ...options, read: async () => "{ not json" });
  assert.equal(stack.bundled, false);
});

test("the shipped licence texts are listed, sorted, without dotfiles", async () => {
  const stack = await readMediaStack(
    bundleAt("/R", {
      manifests: { ffmpeg: MANIFEST },
      licences: { ffmpeg: ["openh264-LICENSE", ".DS_Store", "ffmpeg-COPYING.LGPLv2.1", "kvazaar-LICENSE"] },
    }),
  );
  assert.deepEqual(stack.licences.map((l) => l.file), [
    "ffmpeg-COPYING.LGPLv2.1",
    "kvazaar-LICENSE",
    "openh264-LICENSE",
  ]);
});

test("a licence text is readable by the name the bundle lists", async () => {
  const options = bundleAt("/R", { manifests: { ffmpeg: MANIFEST }, licences: { ffmpeg: ["kvazaar-LICENSE"] } });
  assert.equal(await readLicence("ffmpeg", "kvazaar-LICENSE", options), "text of kvazaar-LICENSE");
});

test("a name the bundle does not list reads nothing, traversal included", async () => {
  const options = bundleAt("/R", { manifests: { ffmpeg: MANIFEST }, licences: { ffmpeg: ["kvazaar-LICENSE"] } });
  assert.equal(await readLicence("ffmpeg", "../../../etc/passwd", options), null);
  assert.equal(await readLicence("ffmpeg", "COPYING", options), null);
  assert.equal(await readLicence("mpv", "kvazaar-LICENSE", options), null);
});

test("the payload names the product and the build it is", async () => {
  const payload = await aboutPayload({ appRoot: new URL("..", import.meta.url).pathname, resourcesPath: undefined });
  assert.equal(payload.app.name, PRODUCT_NAME);
  assert.match(payload.app.version, /^\d+\.\d+\.\d+/);
  assert.equal(payload.app.platform, process.platform);
  assert.equal(payload.mediaStack.bundled, false);
});
