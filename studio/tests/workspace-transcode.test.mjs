import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The `?transcode=1` half of the media protocol, at the door.
 *
 * The path guard it stands on — `resolveMediaPath` in server/workspace-media.js
 * — is async, and for a while this handler did not await it. An unawaited
 * promise has no `ok`, so every transcode fell into the refusal branch and
 * answered `{ status: undefined }`, which the Response constructor reads as a
 * **200 with an empty body**. Nothing logged, nothing spawned, and the pane
 * blamed ffmpeg for a stream that had never started.
 *
 * So these cases assert the two refusals by their status. A refusal that
 * arrives as 200 is the bug; a 404 and a 415 mean the guard's answer was
 * waited for.
 */

const require_ = createRequire(import.meta.url);
const Module = require_("node:module");
const MEDIA = "../electron/workspaceMedia.cjs";

/** The module loaded against a stub `electron`, with its protocol handler and nonce in hand. */
function loadHandler(root) {
  let handler = null;
  let nonce = null;
  const electron = {
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: (_scheme, fn) => { handler = fn; },
    },
    ipcMain: {
      on: (channel, fn) => {
        if (channel !== "workspace-media:origin-sync") return;
        const event = {};
        fn(event);
        nonce = event.returnValue.nonce;
      },
    },
  };

  const realLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    delete require_.cache[require_.resolve(MEDIA)];
    const media = require_(MEDIA);
    media.registerWorkspaceMediaScheme();
    media.initWorkspaceMedia({ getGatewayRoot: () => root, isMainWindow: () => true, log: () => {} });
  } finally {
    Module._load = realLoad;
  }

  return (name) => handler(new Request(
    `teminali-media://${nonce}/${encodeURIComponent(name)}?transcode=1&start=0`,
    { method: "GET" },
  ));
}

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), "workspace-transcode-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a transcode of a file that is not there is refused, not answered with an empty 200", async () => {
  const ask = loadHandler(workspace({}));
  const response = await ask("missing.mkv");
  assert.equal(response.status, 404);
});

test("a transcode of a file the media route does not serve is refused", async () => {
  const ask = loadHandler(workspace({ "notes.txt": "not media" }));
  const response = await ask("notes.txt");
  assert.equal(response.status, 415);
});
