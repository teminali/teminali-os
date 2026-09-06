import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  BROWSER_VIEW_PARTITION,
  BROWSER_VIEW_PRIVATE_PARTITION,
  PASSKEY_PROBE,
  isPasskeyNotice,
} from "../electron/browserView.cjs";
import { downloadAction, visitOf } from "../src/utils/browserRecording.ts";
import { persistablePanels } from "../src/utils/privateBrowsing.ts";

/**
 * Private browsing is four promises, and each of them is one rule in one file.
 * They are pinned here because the alternative way of checking them is to
 * browse in a private tab, quit the app, start it again and go looking — which
 * is to say, they would never be checked at all.
 *
 * The passkey probe is in the same file because it lives on the same view and
 * is the same kind of claim: something the app says to the operator about a
 * limit it cannot remove, which must not fire when it is not true.
 */

/* ── The session ──────────────────────────────────────────────────────────── */

test("the private partition is in memory and the ordinary one is not", () => {
  // Electron's whole mechanism: an unprefixed partition is not written to disk.
  // A `persist:` slipping in front of this string is the bug that would make
  // every promise below false while every other test still passed.
  assert.equal(BROWSER_VIEW_PRIVATE_PARTITION.startsWith("persist:"), false);
  assert.equal(BROWSER_VIEW_PARTITION.startsWith("persist:"), true);
  assert.notEqual(BROWSER_VIEW_PRIVATE_PARTITION, BROWSER_VIEW_PARTITION);
});

/* ── What is written down ─────────────────────────────────────────────────── */

test("a page in a private tab is not a visit", () => {
  const page = { id: "a", url: "https://example.com", title: "Example" };
  assert.deepEqual(visitOf(page), { url: "https://example.com", title: "Example" });
  assert.equal(visitOf({ ...page, private: true }), null);
});

test("a private download is dropped rather than recorded", () => {
  const finished = {
    downloadId: "dl-1",
    panelId: "p1",
    url: "https://example.com/a.zip",
    filename: "a.zip",
    state: "completed",
    done: true,
    received: 10,
    total: 10,
    path: "/tmp/a.zip",
  };
  assert.equal(downloadAction(finished).kind, "record");
  assert.deepEqual(downloadAction({ ...finished, private: true }), { kind: "drop", id: "dl-1" });

  // Still shown while it arrives: the progress row is drawn from state the
  // renderer holds, and hiding it would leave a private download invisible.
  const arriving = { ...finished, done: false, state: "progressing", received: 4 };
  assert.equal(downloadAction({ ...arriving, private: true }).kind, "active");
});

/* ── What is reopened ─────────────────────────────────────────────────────── */

test("a private tab is not written to the persisted session", () => {
  const panels = [
    { id: "p1", kind: "terminal" },
    { id: "p2", kind: "browser", private: true },
    { id: "p3", kind: "browser" },
  ];
  const kept = persistablePanels(panels, "p3");
  assert.deepEqual(kept.panels.map((panel) => panel.id), ["p1", "p3"]);
  assert.equal(kept.activePanelId, "p3");
});

test("the active tab is recomputed when it was the private one", () => {
  const panels = [
    { id: "p1", kind: "terminal" },
    { id: "p2", kind: "browser", private: true },
  ];
  assert.equal(persistablePanels(panels, "p2").activePanelId, "p1");
  // Nothing left to be active, rather than an id pointing at no panel.
  assert.equal(persistablePanels([{ id: "p2", private: true }], "p2").activePanelId, null);
});

test("a session with no private tab is passed through untouched", () => {
  const panels = [{ id: "p1", kind: "browser" }];
  const kept = persistablePanels(panels, "p1");
  // Identity, not a copy: this runs on every store write.
  assert.equal(kept.panels, panels);
});

/* ── The passkey notice ───────────────────────────────────────────────────── */

test("only the probe's own line is read as a passkey notice", () => {
  assert.equal(isPasskeyNotice("teminali:passkey-unavailable:get"), true);
  for (const noise of [
    "Uncaught TypeError: passkey is not a function",
    " teminali:passkey-unavailable:get",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isPasskeyNotice(noise), false, String(noise));
  }
});

/**
 * The probe runs inside someone else's page, so what matters is not only that
 * it reports — it is that it reports *nothing* when a platform authenticator
 * exists, and that the page's own call goes through either way. A probe that
 * swallowed a credential request would break every sign-in in the panel.
 */
async function runProbe({ available, options }) {
  const said = [];
  const calls = [];
  const context = {
    console: { info: (line) => said.push(line) },
    navigator: {
      credentials: {
        get: (arg) => {
          calls.push(["get", arg]);
          return Promise.resolve("credential");
        },
        create: (arg) => {
          calls.push(["create", arg]);
          return Promise.resolve("credential");
        },
      },
    },
    window: {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(available),
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(PASSKEY_PROBE, context);
  const result = await context.navigator.credentials.get(options);
  // The report is a promise chained off the availability check.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { said, calls, result };
}

test("the probe speaks only when there is no platform authenticator", async () => {
  const absent = await runProbe({ available: false, options: { publicKey: {} } });
  assert.deepEqual(absent.said, ["teminali:passkey-unavailable:get"]);

  const present = await runProbe({ available: true, options: { publicKey: {} } });
  assert.deepEqual(present.said, []);
});

test("the probe never changes what the page asked for", async () => {
  const options = { publicKey: { challenge: "x" } };
  const { calls, result } = await runProbe({ available: false, options });
  // Called through once, with the very same object, and its answer returned.
  assert.deepEqual(calls, [["get", options]]);
  assert.equal(result, "credential");
});

test("a password request is not a passkey request", async () => {
  const { said, calls } = await runProbe({ available: false, options: { password: true } });
  assert.deepEqual(said, []);
  assert.equal(calls.length, 1);
});

test("the probe installs once, however many times it is injected", async () => {
  const said = [];
  const context = {
    console: { info: (line) => said.push(line) },
    navigator: { credentials: { get: () => Promise.resolve("credential") } },
    window: {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(false),
      },
    },
  };
  vm.createContext(context);
  // `dom-ready` fires again on every navigation within the same page's view.
  vm.runInContext(PASSKEY_PROBE, context);
  vm.runInContext(PASSKEY_PROBE, context);
  vm.runInContext(PASSKEY_PROBE, context);
  await context.navigator.credentials.get({ publicKey: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(said, ["teminali:passkey-unavailable:get"]);
});
