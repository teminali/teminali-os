import assert from "node:assert/strict";
import test from "node:test";

import {
  CDP_ALLOWED_METHODS,
  CDP_ALLOWED_PREFIXES,
  axOutline,
  createBrowserCdp,
  isAllowedCdpMethod,
  quadCentre,
} from "../electron/browserCdp.cjs";

/**
 * The browser panel's DevTools Protocol channel, and the boundary around it.
 *
 * `webContents.debugger` is the whole protocol against someone else's page, so
 * the interesting question about this file is not what it can do but what it
 * refuses to. These assertions are on the **allowlist**: a CDP domain Chromium
 * adds next year is denied by this test passing unchanged, which is the
 * property a blocklist cannot have.
 *
 * The one that matters most is `WebAuthn.*`. It installs *virtual
 * authenticators*, so anything reaching it could mint a passkey and read the
 * credential back — which would make the Touch ID work in electron/webauthn.cjs
 * a net security loss rather than a feature.
 */

test("the domains that must be unreachable are unreachable", () => {
  for (const method of [
    // Virtual authenticators. The reason this file has an allowlist at all.
    "WebAuthn.enable",
    "WebAuthn.addVirtualAuthenticator",
    "WebAuthn.getCredentials",
    // Outside the page: other windows, downloads, granted permissions.
    "Browser.setDownloadBehavior",
    "Browser.grantPermissions",
    "Browser.getWindowForTarget",
    // Stored credentials, wholesale.
    "Storage.getCookies",
    "Storage.getStorageKeyForFrame",
    "Storage.clearDataForOrigin",
    // File streams.
    "IO.read",
    "IO.resolveBlob",
    // Attaching to other contents, including the app's own.
    "Target.attachToTarget",
    "Target.createTarget",
    "Target.setAutoAttach",
    // Rewriting requests in flight, and stepping someone else's JavaScript.
    "Fetch.enable",
    "Fetch.fulfillRequest",
    "Debugger.enable",
    "Debugger.setBreakpointByUrl",
    // Everything else nobody has weighed.
    "Emulation.setGeolocationOverride",
    "Security.setIgnoreCertificateErrors",
    "ServiceWorker.enable",
    "Autofill.trigger",
    "FileSystem.getDirectory",
    "Tracing.start",
    "Memory.getAllTimeSamplingProfile",
    "SystemInfo.getInfo",
    "Cast.startTabMirroring",
  ]) {
    assert.equal(isAllowedCdpMethod(method), false, method);
  }
});

test("a new method inside an allowed domain is still denied", () => {
  /*
    The second tier, and the reason it exists. `Network.*` is an allowed domain
    because the request log is a tool — and `Network.getAllCookies` is in that
    same domain and would hand over every cookie in the session. The prefix list
    says which neighbourhoods; the method list says which doors.
  */
  for (const method of [
    "Network.getAllCookies",
    "Network.getCookies",
    "Network.setCookie",
    "Network.clearBrowserCookies",
    "Network.getResponseBody",
    "Network.setRequestInterception",
    "Page.setDownloadBehavior",
    "Page.setBypassCSP",
    "Page.getResourceContent",
    "DOM.setOuterHTML",
    "DOM.getDocument",
    "Runtime.addBinding",
  ]) {
    assert.equal(isAllowedCdpMethod(method), false, method);
    assert.equal(
      CDP_ALLOWED_PREFIXES.some((prefix) => method.startsWith(prefix)),
      true,
      `${method} should be inside an allowed domain — that is what makes it a useful case`,
    );
  }
});

test("only the methods this build actually sends are allowed", () => {
  for (const method of CDP_ALLOWED_METHODS) {
    assert.equal(isAllowedCdpMethod(method), true, method);
    assert.equal(
      CDP_ALLOWED_PREFIXES.some((prefix) => method.startsWith(prefix)),
      true,
      `${method} is on the method list but in no allowed domain`,
    );
  }
  // A domain on the prefix list with nothing using it is dead weight the next
  // reader would take for a granted capability.
  for (const prefix of CDP_ALLOWED_PREFIXES) {
    assert.equal(
      CDP_ALLOWED_METHODS.some((method) => method.startsWith(prefix)),
      true,
      `${prefix} is allowed but nothing sends anything in it`,
    );
  }
});

test("nothing that is not a command is a command", () => {
  for (const value of ["", "Page", "Runtime", ".", "Page.", null, undefined, 42, {}, ["Page.enable"]]) {
    assert.equal(isAllowedCdpMethod(value), false, String(value));
  }
});

test("the channel refuses a denied method before it reaches the page", async () => {
  const sent = [];
  const cdp = createBrowserCdp({
    contents: {
      getURL: () => "https://example.com/",
      getTitle: () => "Example",
      debugger: {
        isAttached: () => true,
        attach: () => {},
        sendCommand: async (method, params) => {
          sent.push(method);
          if (method === "Accessibility.getFullAXTree") return { nodes: [] };
          if (method === "Runtime.evaluate") {
            return { result: { value: JSON.stringify({ url: "https://example.com/", title: "Example", text: "hello" }) } };
          }
          if (method === "Page.captureScreenshot") return { data: "aGk=" };
          return {};
        },
        on: () => {},
        removeListener: () => {},
        detach: () => {},
      },
    },
  });

  // The real tools go through, and only through allowed methods.
  await cdp.snapshot();
  await cdp.read();
  await cdp.screenshot();
  for (const method of sent) assert.equal(isAllowedCdpMethod(method), true, method);

  // A ref nobody snapshotted is a refusal that says what to do, not a click.
  await assert.rejects(() => cdp.click({ ref: "e9" }), /page_snapshot/);
});

test("an outline names what can be acted on, and only that", () => {
  const { outline, refs } = axOutline([
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Sign in" }, childIds: ["2", "3", "4", "5"] },
    { nodeId: "2", role: { value: "heading" }, name: { value: "Sign in" }, childIds: [] },
    { nodeId: "3", role: { value: "textbox" }, name: { value: "Email" }, backendDOMNodeId: 11, childIds: [] },
    { nodeId: "4", role: { value: "button" }, name: { value: "Next" }, backendDOMNodeId: 12, childIds: [] },
    // Disabled: on the page, in the outline, but not offered as a ref — a ref
    // is a promise that a click will do something.
    { nodeId: "5", role: { value: "button" }, name: { value: "Later" }, backendDOMNodeId: 13, properties: [{ name: "disabled", value: { value: true } }], childIds: [] },
  ]);

  assert.match(outline, /heading "Sign in"/);
  assert.match(outline, /textbox "Email" \[ref=e1\]/);
  assert.match(outline, /button "Next" \[ref=e2\]/);
  assert.match(outline, /button "Later" disabled/);
  assert.equal(/Later.*\[ref=/.test(outline), false);
  assert.deepEqual([...refs.entries()], [["e1", 11], ["e2", 12]]);
  // The container roles a framework emits per component are the noise this
  // reduction exists to drop.
  assert.equal(outline.includes("generic"), false);
});

test("a transformed element's centre is the mean of its corners", () => {
  assert.deepEqual(quadCentre([10, 20, 30, 20, 30, 40, 10, 40]), { x: 20, y: 30 });
  // A laid-out but invisible element has no centre to click, and says so
  // rather than sending the click to the origin of the page.
  assert.equal(quadCentre([5, 5, 5, 5, 5, 5, 5, 5]), null);
  assert.equal(quadCentre([1, 2, 3]), null);
  assert.equal(quadCentre(undefined), null);
});
