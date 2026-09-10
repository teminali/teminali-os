/*
  The browser panel, as a control plane rather than a picture.

  The panel's page is a `WebContentsView` — a real Chromium web contents in its
  own process (see browserView.cjs). That means `webContents.debugger` is a
  full Chrome DevTools Protocol channel against it: no remote-debugging port, no
  second process, no engine change, nothing listening on a socket. This file is
  the only thing in the app that speaks it.

  Why it exists: the assistant could already be *told* to look at a page, and
  what it did was screenshot the whole desktop and run the macOS accessibility
  tree through a vision model (server/assistant.js). For a page that renders on
  the client, `services/readablePage.ts` fetches HTML and reads the `<head>`.
  Both are guesses about a document that is sitting right there with an
  accessibility tree, a DOM and an input pipeline of its own.

  ## What this file is not

  It is not a general CDP proxy, and the agent never names a CDP method. The
  tools are semantic — snapshot, read, screenshot, click, type, network, eval —
  and each is a fixed sequence of commands composed here. The allowlist below
  therefore guards *this file's own future*, not the agent's input: a tool added
  in six months that reaches for a domain nobody weighed is refused by default,
  and the refusal is a test failure long before it is a shipped capability.

  ## The two tiers, and why a blocklist was not an option

  `CDP_ALLOWED_PREFIXES` is the domain boundary. `WebAuthn.*` is the one that
  makes this non-negotiable: it installs *virtual authenticators*, so anything
  reaching it could mint a passkey and read the credential back out — which
  would make the Touch ID work of electron/webauthn.cjs a net security loss
  rather than a feature. `Browser.*` reaches outside the page (windows,
  downloads, permissions), `Storage.*` and `IO.*` hand over stored credentials
  and file streams wholesale, `Target.*` attaches to other contents, `Fetch.*`
  rewrites requests in flight and `Debugger.*` pauses and steps someone else's
  JavaScript. None of them are here, and a domain invented after this comment
  was written is not here either, which is the entire point of an allowlist.

  `CDP_ALLOWED_METHODS` narrows that to the exact calls this build makes. It is
  not a second guess at the same question: `Network.*` is on the domain list
  because the request log is a tool, and `Network.getAllCookies` is in that same
  domain and would hand over every cookie in the session. The prefix list says
  which neighbourhoods; the method list says which doors. Both must agree.
*/

/**
 * The CDP domains this app may speak, and no others.
 *
 * Deliberately an allowlist of prefixes rather than a list of domains to
 * refuse. A blocklist is a claim to know every dangerous domain in a protocol
 * that Chromium adds to on its own schedule; this is a claim to know the six we
 * use, which is a claim we can actually keep.
 */
const CDP_ALLOWED_PREFIXES = Object.freeze([
  "Accessibility.",
  "DOM.",
  "Input.",
  "Network.",
  "Page.",
  "Runtime.",
]);

/**
 * The exact commands this build sends, which is a much shorter list than the
 * domains above allow.
 *
 * Adding a tool means adding its methods here, in the same edit, with the same
 * question asked out loud: does this reach past the page the operator is
 * looking at? `Network.getAllCookies` is in an allowed domain and is absent for
 * that reason.
 */
const CDP_ALLOWED_METHODS = Object.freeze([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.enable",
  "DOM.focus",
  "DOM.getBoxModel",
  "DOM.scrollIntoViewIfNeeded",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Network.enable",
  "Page.captureScreenshot",
  "Page.enable",
  "Runtime.enable",
  "Runtime.evaluate",
]);

const ALLOWED_METHOD_SET = new Set(CDP_ALLOWED_METHODS);

/**
 * May this CDP method be sent at all?
 *
 * Both tiers, in order, so a caller that widened one and forgot the other is
 * refused rather than half-allowed. Anything that is not a string, or is a
 * bare domain with no method, is not a command.
 */
function isAllowedCdpMethod(method) {
  if (typeof method !== "string" || !method.includes(".")) return false;
  if (!CDP_ALLOWED_PREFIXES.some((prefix) => method.startsWith(prefix))) return false;
  return ALLOWED_METHOD_SET.has(method);
}

/* ── Bounds on what comes back ──────────────────────────────────────────────
   Every one of these is a window budget, not a safety limit. A full
   accessibility tree of a search results page runs to thousands of nodes and a
   page's `innerText` to hundreds of kilobytes; handed to a model whole, the
   page is the turn. Clamped here rather than in the shim so the truncation is
   measured against the real document and can say so.
*/

/** How many AX nodes reach the outline. Past this the page is summarised. */
const MAX_SNAPSHOT_NODES = 800;
/** How long any single name, value or label may be. */
const MAX_TEXT = 200;
/** How much page text `page_read` returns. */
const MAX_READ_CHARS = 40_000;
/** How many network entries are kept per view, newest last. */
const MAX_NETWORK_ENTRIES = 200;
/** How long a single CDP command may take before the tool reports a stall. */
const COMMAND_TIMEOUT_MS = 15_000;

/**
 * The roles that get a `ref` — the ones `page_click` and `page_type` can act
 * on.
 *
 * A ref is a promise that the element can be interacted with, so a role that
 * cannot be is deliberately absent: it appears in the outline as text, and an
 * agent that tries to click it gets a refusal naming the role rather than a
 * click that lands on nothing.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

/**
 * The roles worth a line even though nothing can be done to them: the ones
 * that tell an agent *where it is*.
 *
 * Everything else — generic, none, presentation, the dozen container roles a
 * framework emits per component — is dropped. A tree of `generic > generic >
 * generic` is the noise that made the desktop screenshot look competitive.
 */
const INFORMATIVE_ROLES = new Set([
  "alert",
  "article",
  "banner",
  "caption",
  "cell",
  "columnheader",
  "complementary",
  "contentinfo",
  "dialog",
  "form",
  "heading",
  "image",
  "img",
  "list",
  "listitem",
  "main",
  "navigation",
  "paragraph",
  "region",
  "row",
  "rowheader",
  "search",
  "status",
  "StaticText",
  "table",
  "tablist",
]);

function clamp(value, limit = MAX_TEXT) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** An AX node's `{ value }` wrapper, unwrapped to a clamped string. */
function axText(field) {
  const value = field?.value;
  if (typeof value === "string") return clamp(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function axProperty(node, name) {
  const found = Array.isArray(node?.properties) ? node.properties.find((property) => property?.name === name) : null;
  return found?.value?.value;
}

/**
 * A full AX tree, reduced to an outline an agent can read and act on.
 *
 * Pure, and exported for that reason: this is the part that decides what the
 * model gets to see, and it is worth being able to assert on without an
 * Electron window.
 *
 * The shape is one line per node — indent, role, name, and `[ref]` when the
 * node can be acted on — because that is what a model reads cheaply and what a
 * following `page_click` can name unambiguously. The refs are handed back
 * separately so the caller can resolve one to a `backendDOMNodeId` later; the
 * agent never sees a node id, which is what stops a ref surviving a navigation
 * into a click on whatever now occupies that slot.
 */
function axOutline(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map();
  for (const node of list) {
    if (node && typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }

  /** The roots: every node nobody claims as a child. */
  const claimed = new Set();
  for (const node of list) {
    for (const childId of Array.isArray(node?.childIds) ? node.childIds : []) claimed.add(childId);
  }
  const roots = list.filter((node) => typeof node?.nodeId === "string" && !claimed.has(node.nodeId));

  const lines = [];
  /** ref -> backendDOMNodeId, the half the agent never sees. */
  const refs = new Map();
  let truncated = false;
  let refSeq = 0;

  const visit = (node, depth) => {
    if (!node || lines.length >= MAX_SNAPSHOT_NODES) {
      if (node) truncated = true;
      return;
    }
    const role = axText(node.role);
    const name = axText(node.name);
    const ignored = node.ignored === true || axProperty(node, "hidden") === true;
    const interactive = INTERACTIVE_ROLES.has(role);
    const informative = INFORMATIVE_ROLES.has(role);
    /*
      A node earns a line by being actionable, or by being one of the roles
      that says where you are *and* having something to say. An unnamed
      paragraph is not a landmark; an unnamed button still has to be clickable,
      because "the unlabelled button beside the search box" is a real thing to
      be asked to press.
    */
    const keep = !ignored && (interactive || (informative && name));
    let childDepth = depth;

    if (keep) {
      const bits = [role || "node"];
      if (name) bits.push(JSON.stringify(name));
      const value = axText(node.value);
      if (value && value !== name) bits.push(`value=${JSON.stringify(value)}`);
      if (axProperty(node, "disabled") === true) bits.push("disabled");
      const checked = axProperty(node, "checked");
      if (checked !== undefined) bits.push(`checked=${checked}`);
      const expanded = axProperty(node, "expanded");
      if (expanded !== undefined) bits.push(`expanded=${expanded}`);

      let ref = "";
      if (interactive && Number.isFinite(node.backendDOMNodeId) && axProperty(node, "disabled") !== true) {
        ref = `e${++refSeq}`;
        refs.set(ref, node.backendDOMNodeId);
        bits.push(`[ref=${ref}]`);
      }
      lines.push(`${"  ".repeat(Math.min(depth, 12))}${bits.join(" ")}`);
      childDepth = depth + 1;
    }

    for (const childId of Array.isArray(node.childIds) ? node.childIds : []) {
      visit(byId.get(childId), childDepth);
    }
  };

  for (const root of roots) visit(root, 0);

  return { outline: lines.join("\n"), refs, truncated, nodes: lines.length };
}

/**
 * The centre of a box model's content quad, in CSS pixels.
 *
 * A quad is eight numbers — four corners, clockwise from the top left — and a
 * transformed element's quad is not a rectangle, so the centre is the mean of
 * the corners rather than `x + width / 2`. A zero-area quad is an element that
 * is laid out but not visible, and returns null: clicking the origin of the
 * page because an element had no box is the kind of miss that looks like the
 * agent lying about what it did.
 */
function quadCentre(quad) {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  if (![...xs, ...ys].every((value) => Number.isFinite(value))) return null;
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.round(xs.reduce((sum, value) => sum + value, 0) / 4),
    y: Math.round(ys.reduce((sum, value) => sum + value, 0) / 4),
  };
}

/** The text-extracting expression `page_read` evaluates, kept out of the flow. */
const READ_EXPRESSION = `(() => {
  const pick = document.querySelector("main, article, [role=main]") || document.body;
  const text = pick ? pick.innerText : "";
  return JSON.stringify({
    url: location.href,
    title: document.title || "",
    text: typeof text === "string" ? text.slice(0, ${MAX_READ_CHARS + 1}) : "",
  });
})()`;

/**
 * One view's CDP channel.
 *
 * `contents` is a `WebContents`; nothing else about Electron is touched, which
 * is what lets the whole of this file be exercised against a fake.
 *
 * Attachment is lazy on purpose. `debugger.attach` on every browser tab the
 * operator opens would put a protocol channel and a message listener on pages
 * nobody ever asks the assistant about, and — the part that is not just
 * tidiness — Chromium shows "DevTools is debugging this page"-class behaviour
 * and disables some optimisations for an attached target. A tab the agent never
 * touches should be exactly as fast as it was before this file existed.
 */
function createBrowserCdp({ contents, log = () => {} }) {
  /** Which domains have had `.enable` sent. Enabling twice is legal and wasteful. */
  const enabled = new Set();
  /** The last snapshot's refs. Replaced wholesale by the next snapshot. */
  let refs = new Map();
  /** The snapshot the current refs came from, so a stale ref can say so. */
  let refsFrom = { url: "", at: 0 };
  /** Newest last. See MAX_NETWORK_ENTRIES. */
  const network = [];
  let networkListening = false;
  let detached = false;

  const dbg = () => {
    const target = contents?.debugger;
    if (!target) throw new Error("This build has no debugger channel for the browser panel.");
    return target;
  };

  function attach() {
    if (detached) throw new Error("This browser panel has been closed.");
    const target = dbg();
    if (target.isAttached?.()) return;
    try {
      target.attach("1.3");
    } catch (error) {
      /*
        The one failure worth translating. This panel deliberately offers
        Inspect Element (browserView.cjs, `allowInspect: true`), and an open
        devtools window already holds the only debugger channel this page has.
        Left as Electron's message it reads as an internal fault; named, it is
        something the operator can act on in two seconds.
      */
      const message = String(error?.message ?? error);
      if (/already attached/i.test(message)) {
        throw new Error(
          "This page's devtools are open, and they hold the only debugger channel it has. Close the Inspect Element window and try again.",
        );
      }
      throw new Error(`The browser panel's debugger could not be attached: ${message}`);
    }
  }

  /**
   * Send one command, having proved it is one we are allowed to send.
   *
   * The timeout is not belt and braces. `sendCommand` against a page that is
   * showing a modal `alert()`, or a renderer that has hung, returns a promise
   * that simply never settles — and an agent turn stalled behind it looks to
   * the operator like the assistant ignoring them.
   */
  async function send(method, params = {}) {
    if (!isAllowedCdpMethod(method)) {
      /*
        Not a message for the model — the model cannot reach this — but for
        whoever added the tool that tried. See CDP_ALLOWED_METHODS.
      */
      throw new Error(`"${method}" is not an allowed CDP method. See electron/browserCdp.cjs.`);
    }
    attach();
    let timer = null;
    try {
      return await Promise.race([
        dbg().sendCommand(method, params),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`The page did not answer ${method} in time. It may be showing a dialog.`)), COMMAND_TIMEOUT_MS);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function enable(...domains) {
    for (const domain of domains) {
      if (enabled.has(domain)) continue;
      await send(`${domain}.enable`, {});
      enabled.add(domain);
    }
  }

  /* ── The tools ────────────────────────────────────────────────────────── */

  async function snapshot() {
    await enable("Accessibility", "DOM");
    const { nodes } = await send("Accessibility.getFullAXTree", {});
    const reduced = axOutline(nodes);
    refs = reduced.refs;
    refsFrom = { url: contents.getURL?.() ?? "", at: Date.now() };
    return {
      url: refsFrom.url,
      title: contents.getTitle?.() ?? "",
      outline: reduced.outline,
      elements: reduced.refs.size,
      nodes: reduced.nodes,
      truncated: reduced.truncated,
      ...(reduced.truncated
        ? { note: `Only the first ${MAX_SNAPSHOT_NODES} lines of this page are here. Read it with page_read, or narrow what you are looking for.` }
        : {}),
    };
  }

  async function read() {
    await enable("Runtime");
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression: READ_EXPRESSION,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(`The page's text could not be read: ${clamp(exceptionDetails.text, 200)}`);
    let payload = {};
    try {
      payload = JSON.parse(String(result?.value ?? "{}"));
    } catch {
      throw new Error("The page's text came back in a shape this build could not read.");
    }
    const text = typeof payload.text === "string" ? payload.text : "";
    const truncated = text.length > MAX_READ_CHARS;
    return {
      url: payload.url || (contents.getURL?.() ?? ""),
      title: clamp(payload.title, 300),
      text: truncated ? text.slice(0, MAX_READ_CHARS) : text,
      characters: Math.min(text.length, MAX_READ_CHARS),
      truncated,
      ...(truncated ? { note: `This page is longer than ${MAX_READ_CHARS} characters and was cut there.` } : {}),
    };
  }

  async function screenshot({ fullPage = false, format = "jpeg" } = {}) {
    await enable("Page");
    /*
      JPEG by default, not PNG. The agent's picture goes to a vision model,
      which does not care, and a full-page PNG of a long article is several
      megabytes of base64 through two IPC hops and an HTTP POST. Same trade the
      camera already makes; see src/services/cameraFrame.ts.

      `format: "png"` is for the operator's own Take Screenshot, which ends as a
      file they keep rather than as tokens in a turn: there the loss is theirs
      to look at afterwards, and lossless text is the whole point of the file.
      Nothing on the agent's path can ask for it — `browser-agent.js` has no
      field it could travel in.
    */
    const png = format === "png";
    const { data } = await send("Page.captureScreenshot", {
      format: png ? "png" : "jpeg",
      ...(png ? {} : { quality: 70 }),
      captureBeyondViewport: fullPage === true,
      ...(fullPage === true ? {} : { fromSurface: true }),
    });
    if (typeof data !== "string" || !data) throw new Error("The page produced no picture.");
    return {
      url: contents.getURL?.() ?? "",
      title: contents.getTitle?.() ?? "",
      image: `data:image/${png ? "png" : "jpeg"};base64,${data}`,
      fullPage: fullPage === true,
    };
  }

  /** A ref, resolved to the node it named — or a refusal that says why. */
  function backendNodeFor(ref) {
    const name = typeof ref === "string" ? ref.trim() : "";
    if (!name) throw new Error("Give a ref from the last page_snapshot, such as \"e4\".");
    const backendNodeId = refs.get(name);
    if (backendNodeId === undefined) {
      if (refs.size === 0) throw new Error("There is no snapshot of this page yet. Call page_snapshot first, then act on a ref from it.");
      const current = contents.getURL?.() ?? "";
      if (current && refsFrom.url && current !== refsFrom.url) {
        throw new Error(`The page has navigated since that snapshot (it is now ${current}). Call page_snapshot again and use a ref from it.`);
      }
      throw new Error(`"${name}" is not a ref in the last snapshot of this page. Call page_snapshot again if the page has changed.`);
    }
    return backendNodeId;
  }

  /** Where on screen a ref is, having scrolled it into view first. */
  async function pointFor(ref) {
    const backendNodeId = backendNodeFor(ref);
    await enable("DOM");
    /*
      Scroll first. A ref below the fold has a box model with real coordinates
      that are outside the viewport, and `Input.dispatchMouseEvent` is a
      viewport-space event — so without this the click lands on whatever is at
      those coordinates now, which is the worst possible outcome: a click that
      reports success on the wrong element.
    */
    try {
      await send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch {
      // Not every node can be scrolled to, and a box model may still be usable.
    }
    let model;
    try {
      ({ model } = await send("DOM.getBoxModel", { backendNodeId }));
    } catch (error) {
      throw new Error(`"${ref}" is no longer on the page. Call page_snapshot again. (${clamp(error?.message, 120)})`);
    }
    const point = quadCentre(model?.content);
    if (!point) throw new Error(`"${ref}" is on the page but has no visible box, so there is nothing to click.`);
    return point;
  }

  async function click({ ref, button = "left" } = {}) {
    const point = await pointFor(ref);
    const which = button === "right" || button === "middle" ? button : "left";
    const base = { x: point.x, y: point.y, button: which, clickCount: 1, buttons: which === "left" ? 1 : which === "right" ? 2 : 4 };
    // Move first: a page that only shows its menu on hover needs the pointer
    // to have arrived before the press, and a bare press on such a page is a
    // click on the thing that was there before the menu opened.
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
    await send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
    return { clicked: ref, at: point, button: which, url: contents.getURL?.() ?? "" };
  }

  async function type({ ref, text, submit = false } = {}) {
    const value = typeof text === "string" ? text : "";
    const backendNodeId = backendNodeFor(ref);
    await enable("DOM");
    try {
      await send("DOM.focus", { backendNodeId });
    } catch (error) {
      throw new Error(`"${ref}" could not be focused, so nothing was typed. (${clamp(error?.message, 120)})`);
    }
    if (value) {
      /*
        `Input.insertText` rather than a key event per character. It is what
        Chromium's own automation uses for filling a field: it goes through the
        input method, so a React-controlled input sees one `input` event with
        the whole value instead of thirty, and it does not lie about physical
        keys that were never pressed. What it deliberately does not do is fire
        `keydown` — a field that only reacts to keystrokes needs `submit`, or a
        click and a real key event.
      */
      await send("Input.insertText", { text: value });
    }
    if (submit === true) {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          ...(type === "keyDown" ? { text: "\r" } : {}),
        });
      }
    }
    return { typed: ref, characters: value.length, submitted: submit === true, url: contents.getURL?.() ?? "" };
  }

  /**
   * What the page asked the network for.
   *
   * Enabling `Network` starts the log; it does not fill it retroactively, so
   * the first call on a page that has already loaded comes back empty and says
   * so. That is honest rather than convenient: the alternative is enabling the
   * domain on every view at creation, which is the always-attached cost this
   * file exists to avoid.
   */
  async function networkLog({ limit = 50, filter = "" } = {}) {
    const started = !enabled.has("Network");
    await enable("Network");
    if (!networkListening) {
      dbg().on("message", onProtocolMessage);
      networkListening = true;
    }
    const needle = typeof filter === "string" ? filter.trim().toLowerCase() : "";
    const rows = network
      .filter((entry) => !needle || entry.url.toLowerCase().includes(needle) || String(entry.status ?? "").includes(needle))
      .slice(-Math.max(1, Math.min(Number(limit) || 50, MAX_NETWORK_ENTRIES)));
    return {
      requests: rows,
      kept: network.length,
      ...(started
        ? { note: "The network log has only just been switched on for this page, so it holds nothing yet. Reload the page, or act on it, and ask again." }
        : {}),
    };
  }

  function onProtocolMessage(_event, method, params) {
    try {
      if (method === "Network.requestWillBeSent") {
        network.push({
          requestId: params?.requestId,
          method: params?.request?.method ?? "",
          url: clamp(params?.request?.url, 500),
          type: params?.type ?? "",
          status: null,
          mimeType: "",
        });
        while (network.length > MAX_NETWORK_ENTRIES) network.shift();
        return;
      }
      if (method === "Network.responseReceived") {
        const entry = network.find((row) => row.requestId === params?.requestId);
        if (entry) {
          entry.status = params?.response?.status ?? null;
          entry.mimeType = params?.response?.mimeType ?? "";
        }
        return;
      }
      if (method === "Network.loadingFailed") {
        const entry = network.find((row) => row.requestId === params?.requestId);
        if (entry) entry.status = `failed: ${clamp(params?.errorText, 80) || "unknown"}`;
      }
    } catch (error) {
      log("A CDP network event could not be recorded:", error?.message ?? error);
    }
  }

  async function evaluate({ expression } = {}) {
    const source = typeof expression === "string" ? expression.trim() : "";
    if (!source) throw new Error("Give a JavaScript expression to evaluate.");
    await enable("Runtime");
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression: source,
      returnByValue: true,
      awaitPromise: true,
      /*
        The page's own world, not an isolated one. `page_eval` exists to do
        what the page's own console would do — read a framework's state, call a
        function the page defines — and an isolated world sees the DOM but none
        of that. It is the one tool here that runs the agent's own code in
        someone else's document, which is why it is the one tool that is never
        pre-approved. See server/browser-mcp.js.
      */
      userGesture: false,
    });
    if (exceptionDetails) {
      return {
        threw: true,
        error: clamp(exceptionDetails.exception?.description || exceptionDetails.text, 1000),
        url: contents.getURL?.() ?? "",
      };
    }
    let value = result?.value;
    if (value === undefined && result?.type !== "undefined") value = clamp(result?.description, 1000);
    let rendered;
    try {
      rendered = JSON.stringify(value) ?? "undefined";
    } catch {
      rendered = String(value);
    }
    return {
      threw: false,
      type: result?.type ?? "undefined",
      value: rendered.length > 4000 ? `${rendered.slice(0, 4000)}…` : rendered,
      url: contents.getURL?.() ?? "",
    };
  }

  /** The page navigated: the refs describe a document that is no longer here. */
  function invalidateRefs() {
    refs = new Map();
    refsFrom = { url: "", at: 0 };
    network.length = 0;
  }

  function dispose() {
    if (detached) return;
    detached = true;
    try {
      if (networkListening) dbg().removeListener?.("message", onProtocolMessage);
    } catch {}
    try {
      if (dbg().isAttached?.()) dbg().detach();
    } catch (error) {
      // A contents that is already gone has no debugger to detach, which is
      // the ordinary case on window close rather than a failure.
      log("The browser panel's debugger could not be detached:", error?.message ?? error);
    }
  }

  return { snapshot, read, screenshot, click, type, networkLog, evaluate, invalidateRefs, dispose };
}

module.exports = {
  createBrowserCdp,
  isAllowedCdpMethod,
  axOutline,
  quadCentre,
  CDP_ALLOWED_PREFIXES,
  CDP_ALLOWED_METHODS,
  MAX_SNAPSHOT_NODES,
  MAX_READ_CHARS,
  MAX_NETWORK_ENTRIES,
};
