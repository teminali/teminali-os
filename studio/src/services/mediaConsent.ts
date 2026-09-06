/* ────────────────────────────────────────────────────────────────
   The media approval gate.

   Designed in `src/video/P3-import-gate.md`, which holds the reasoning;
   this is that design in code. What it guards is not writing — nothing
   P3 exposes can destroy the operator's data. It guards **reading** a
   path they did not name and **spawning** a subprocess on their machine,
   which is what `import_media_from_path` and `ffmpeg_process` hand to a
   caller that may be running unattended in another application.

   Three properties this file exists to hold, each of them a reason it is
   shaped the way it is:

   1. **React-free**, like `createApprovalGate` in `agentCommands.ts` and
      for the same reason: "the promise always settles" is only testable
      if no component has to mount for it to settle. The difference is
      ownership — the shell's gate is created per-hook, this one is a
      module singleton (below) because `registerVideoToolBridge()` runs
      outside React at module load, and a gate drawn inside the video
      panel would be absent exactly when it is needed most.
   2. **Policy and enforcement in one file.** The deny list, the
      extension rule and the grant set live beside the code that
      consults them, so a rule cannot drift from its check.
   3. **No I/O of its own.** Path resolution is injected, because
      collapsing `..` and following symlinks needs a real filesystem and
      the renderer has none — main does it over IPC. Injecting it is
      also what lets the tests drive the real policy under plain Node.
   ──────────────────────────────────────────────────────────────── */

/**
 * What a tool owes before it runs.
 *
 * The design document writes this as one optional field; it is a list
 * because `ffmpeg_process` needs both, and the two answer different
 * questions at different scopes — "may you read this file" is per path,
 * "may you spend fifteen minutes of this machine" is per session.
 */
export type ConsentCapability = "read-path" | "spawn";

/** A path the call would touch, and what may legitimately live at it. */
export interface RequestedPath {
  path: string;
  /**
   * Extensions this argument accepts, lowercase and without the dot.
   *
   * Not one global list: a media argument accepts media, and
   * `ffmpeg_process`'s `lutPath` accepts a `.cube` — which is a real
   * read of a real sidecar file and would be refused outright by a
   * media-only rule, making the `lut` operation permanently unusable.
   */
  accepts: readonly string[];
}

export interface MediaConsentRequest {
  tool: string;
  /** Threaded from `executeTool`: the chat's own name, or the agent CLI. */
  agentName: string;
  capabilities: readonly ConsentCapability[];
  paths: readonly RequestedPath[];
  /** One extra line of weight for the prompt — the ffmpeg operation, say. */
  detail?: string;
}

/** The request as the prompt sees it: every path already resolved. */
export interface PendingConsent extends MediaConsentRequest {
  /** Resolved absolute paths, in the order they were requested. */
  resolved: readonly string[];
  /** The directories "allow this folder" would grant. */
  folders: readonly string[];
}

export type ConsentAnswer = "file" | "folder" | "deny";

/** What the prompt settled to, and what settled it. */
interface SettledConsent {
  answer: ConsentAnswer;
  cause: ConsentOutcome;
}

/**
 * Why a call was allowed or refused — one word, logged on every decision.
 *
 * Without it, "the agent imported something odd" has no answer: an
 * allowed call tells you nothing unless you know *which* grant satisfied
 * it. `superseded` and `declined` are not in the design document's list;
 * they are the two operator-driven outcomes it did not enumerate.
 */
export type ConsentOutcome =
  | "picker" | "project-root" | "session-folder" | "session-spawn" | "prompt"
  | "deny-list" | "not-media" | "no-ui" | "deadline" | "declined" | "superseded";

export interface ConsentVerdict {
  allowed: boolean;
  reason: ConsentOutcome;
  /** What the verdict was about: the deciding path, or the capability. */
  subject: string;
  /** The sentence the caller reads when refused. */
  message?: string;
}

/** The two absolute paths the deny list is written against. */
export interface ConsentPolicy {
  /** The operator's home directory. */
  home: string;
  /** Electron's `app.getPath("userData")` — the app's own state. */
  userData: string;
}

export interface MediaConsentGateOptions {
  policy: ConsentPolicy;
  /**
   * Absolute → real absolute: `..` collapsed, symlinks followed.
   *
   * Every check below runs on the answer, and the prompt shows the
   * answer, because a gate that validates one path and opens another is
   * worse than no gate.
   */
  resolve: (path: string) => Promise<string>;
  /** How long the operator has before the prompt settles as a denial. */
  deadlineMs?: number;
  /** One line per decision. See `ConsentOutcome`. */
  audit?: (entry: ConsentAuditEntry) => void;
}

export interface ConsentAuditEntry {
  tool: string;
  agentName: string;
  path: string;
  allowed: boolean;
  reason: ConsentOutcome;
}

/* ── Policy ─────────────────────────────────────────────────────────
   Two questions with exactly one defensible answer each, so the
   operator is never asked them. A prompt is for a real question; a
   prompt whose only correct answer is "no" teaches the operator to
   click through prompts, which is a worse property than having none.
   ──────────────────────────────────────────────────────────────────── */

/**
 * The import surface's own extension list.
 *
 * Taken from the picker the Cut shows a human (`teminaliCut/electron/
 * main.ts:236`). The agent path is the *same import*, so it is held to
 * the same list: the honest answer to
 * `import_media_from_path('/etc/passwd')` is "that is not media".
 */
export const MEDIA_EXTENSIONS: readonly string[] = Object.freeze([
  "mp4", "mov", "mkv", "webm", "mp3", "wav", "aac", "png", "jpg", "jpeg", "webp",
]);

/** `ffmpeg_process`'s `lutPath`, and nothing else. */
export const LUT_EXTENSIONS: readonly string[] = Object.freeze(["cube"]);

/**
 * Directories no grant reaches, named rather than derived.
 *
 * The dotfile rule below already covers `.ssh`, `.aws` and `.gnupg`;
 * they are listed anyway so the refusal can say which one it was.
 * `Keychains` and the app's own `userData` are not dotted and would
 * otherwise sit inside an ordinary grant.
 *
 * Deliberately not extendable by a setting: an allowlist an operator can
 * be talked into widening mid-session is not an allowlist.
 */
function deniedRoots(policy: ConsentPolicy): Array<{ path: string; label: string }> {
  const home = trimSlash(policy.home);
  return [
    { path: `${home}/.ssh`, label: "SSH keys" },
    { path: `${home}/.aws`, label: "AWS credentials" },
    { path: `${home}/.gnupg`, label: "GnuPG keys" },
    { path: `${home}/Library/Keychains`, label: "the macOS keychain" },
    { path: trimSlash(policy.userData), label: "Teminali OS's own state" },
  ];
}

function trimSlash(value: string): string {
  return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

/** True when `child` is `root` itself or lives underneath it. */
export function isInside(child: string, root: string): boolean {
  const base = trimSlash(root);
  return child === base || child.startsWith(`${base}/`);
}

export function extensionOf(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function directoryOf(filePath: string): string {
  const cut = filePath.lastIndexOf("/");
  return cut > 0 ? filePath.slice(0, cut) : "/";
}

/**
 * The refusal that overrides every grant, or null.
 *
 * A granted root means "a folder of footage". A folder of footage that
 * happens to contain a `.env` did not make the `.env` footage — which is
 * why the dotfile rule is a rule about the path, not about the grant.
 */
export function denyListReason(filePath: string, policy: ConsentPolicy): string | null {
  for (const root of deniedRoots(policy)) {
    if (isInside(filePath, root.path)) return root.label;
  }
  const segments = filePath.split("/").filter(Boolean);
  const dotted = segments.find((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
  return dotted ? `a hidden file or folder (${dotted})` : null;
}

/* ── The gate ───────────────────────────────────────────────────── */

export interface MediaConsentGate {
  /** Asks. The returned promise always settles, with or without a human. */
  request: (request: MediaConsentRequest) => Promise<ConsentVerdict>;
  /** The prompt host subscribes; returns an unsubscribe function. */
  subscribe: (listener: (pending: PendingConsent | null) => void) => () => void;
  /** The operator's answer to the outstanding prompt. */
  answer: (answer: ConsentAnswer) => void;
  /** Denies the outstanding prompt — teardown, navigation, Escape. */
  cancel: () => void;
  pending: () => PendingConsent | null;
  /**
   * A human gesture grants a root without a prompt: the file they picked
   * or dropped, *and* its containing folder — because the folder you took
   * one clip out of is the folder the rest of the shoot is in.
   */
  grantRoot: (absolutePath: string, reason: "picker" | "project-root") => void;
  /** Session grants, for the tests and for anything that wants to show them. */
  granted: () => readonly string[];
  /** Drops every session grant. Tests, and a future "revoke" UI. */
  reset: () => void;
}

/**
 * 90 seconds.
 *
 * `electron/videoToolBridge.cjs` gives a tool 20s by default, a figure
 * chosen for writes to an in-memory store that finish in single-digit
 * milliseconds — it was never a claim about human latency. The gated
 * tools get their own `SLOW_TOOLS` entries so this deadline, not that
 * one, is what the operator is racing. It exists at all because a
 * blocked call must not become a wedged CLI: after it, the gate settles
 * as a denial that says nobody answered.
 */
export const CONSENT_DEADLINE_MS = 90_000;

export function createMediaConsentGate(options: MediaConsentGateOptions): MediaConsentGate {
  const { policy, resolve, deadlineMs = CONSENT_DEADLINE_MS, audit } = options;

  /** Session scope only. Nothing here is written to disk — see the design's § 2. */
  const roots = new Set<string>();
  let spawnGranted = false;

  const listeners = new Set<(pending: PendingConsent | null) => void>();
  let current: PendingConsent | null = null;
  let resolver: ((settled: SettledConsent) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (next: PendingConsent | null) => {
    current = next;
    for (const listener of listeners) listener(next);
  };

  /*
    Every denial carries WHY, because "denied" alone cannot tell an
    operator who said no from a prompt that timed out unseen, and those
    are the two failures with completely different fixes.
  */
  const settle = (answer: ConsentAnswer, cause: ConsentOutcome) => {
    const resolveWith = resolver;
    resolver = null;
    if (timer) { clearTimeout(timer); timer = null; }
    publish(null);
    resolveWith?.({ answer, cause });
  };

  const record = (
    request: MediaConsentRequest,
    path: string,
    allowed: boolean,
    reason: ConsentOutcome,
  ): ConsentVerdict => {
    audit?.({ tool: request.tool, agentName: request.agentName, path, allowed, reason });
    return { allowed, reason, subject: path };
  };

  const refuse = (
    request: MediaConsentRequest,
    path: string,
    reason: ConsentOutcome,
    message: string,
  ): ConsentVerdict => ({ ...record(request, path, false, reason), message });

  return {
    async request(request) {
      const resolved: string[] = [];

      for (const requested of request.paths) {
        /*
          Resolve first, then judge. Every check below is against the
          real path, and the prompt shows the same string, so there is
          no window in which one path is checked and another opened.
        */
        const real = await resolve(requested.path);
        resolved.push(real);

        const denied = denyListReason(real, policy);
        if (denied) {
          return refuse(
            request, real, "deny-list",
            `Refused: ${real} is ${denied}. This is not something a grant can cover.`,
          );
        }

        const extension = extensionOf(real);
        if (!requested.accepts.includes(extension)) {
          return refuse(
            request, real, "not-media",
            `Refused: ${real} is not ${requested.accepts === LUT_EXTENSIONS ? "a .cube LUT" : "a media file"}. ` +
            `Accepted here: ${requested.accepts.join(", ")}.`,
          );
        }
      }

      const needsSpawn = request.capabilities.includes("spawn");
      const ungranted = resolved.filter((real) => ![...roots].some((root) => isInside(real, root)));

      if (ungranted.length === 0 && (!needsSpawn || spawnGranted)) {
        const subject = resolved[0] ?? request.tool;
        return record(request, subject, true, needsSpawn ? "session-spawn" : "session-folder");
      }

      /*
        No subscriber means no way to ask, so the answer is no —
        immediately, not after the deadline. A dev browser build, the
        assistant overlay and a headless test all land here. A gate that
        cannot ask must not grant.
      */
      if (listeners.size === 0) {
        return refuse(
          request, ungranted[0] ?? request.tool, "no-ui",
          "Refused: nothing is available to ask the operator for permission.",
        );
      }

      // A second prompt while one is outstanding denies the first rather
      // than dropping its resolver, which would stall that agent's turn.
      if (resolver) settle("deny", "superseded");

      const { answer, cause } = await new Promise<SettledConsent>((settleWith) => {
        resolver = settleWith;
        timer = setTimeout(() => settle("deny", "deadline"), deadlineMs);
        publish({
          ...request,
          resolved,
          folders: [...new Set(resolved.map(directoryOf))],
        });
      });

      if (answer === "deny") {
        return refuse(
          request, resolved[0] ?? request.tool, cause,
          cause === "deadline"
            ? `Nobody answered the permission prompt within ${Math.round(deadlineMs / 1000)}s. ` +
              "The operator may not have been at the machine. Ask them directly."
            : "The operator did not allow this. Ask them directly, or use a file they have already imported.",
        );
      }

      for (const real of resolved) roots.add(answer === "folder" ? directoryOf(real) : real);
      if (needsSpawn) spawnGranted = true;

      return record(request, resolved[0] ?? request.tool, true, "prompt");
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
        // The last subscriber leaving with a prompt open would leave the
        // caller waiting on a question nobody can see any more.
        if (listeners.size === 0 && resolver) settle("deny", "no-ui");
      };
    },

    answer(value) {
      if (resolver) settle(value, "declined");
    },

    cancel() {
      if (resolver) settle("deny", "declined");
    },

    pending: () => current,

    grantRoot(absolutePath, reason) {
      if (!absolutePath.startsWith("/")) return;
      const real = trimSlash(absolutePath);
      // The file itself and the folder it came out of, per the design's § 2.
      roots.add(real);
      if (reason === "picker") roots.add(directoryOf(real));
      audit?.({ tool: "(gesture)", agentName: "operator", path: real, allowed: true, reason });
    },

    granted: () => [...roots],

    reset() {
      roots.clear();
      spawnGranted = false;
      if (resolver) settle("deny", "declined");
    },
  };
}

/* ── The singleton the bridge owns ──────────────────────────────────
   One gate per renderer, created lazily so importing this module under
   plain Node (which the tests do) touches no browser global. The bridge
   consults it, `MediaPanel` grants to it from a human gesture, and
   `MediaConsentModal` — mounted in `App.tsx`'s modal layer, not in the
   video panel — is what subscribes.
   ──────────────────────────────────────────────────────────────────── */

/** The slice of preload this file needs. See `electron/preload.cjs`. */
interface MediaBridgeApi {
  /** `{ home, userData }`, read once at preload time. */
  paths?: ConsentPolicy | null;
  resolvePath?: (path: string) => Promise<string>;
  audit?: (entry: ConsentAuditEntry) => void;
}

function mediaApi(): MediaBridgeApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window.teminali as unknown as { media?: MediaBridgeApi } | undefined)?.media;
}

let singleton: MediaConsentGate | null = null;

export function mediaConsentGate(): MediaConsentGate {
  if (singleton) return singleton;
  const api = mediaApi();

  singleton = createMediaConsentGate({
    /*
      With no bridge there is no home directory to write a deny list
      against, and `/` denies everything — which is the right way for
      this to fail. A browser dev build has no video bridge registered
      either, so nothing should reach here at all; if something does,
      it is refused rather than judged against a policy that is not
      there.
    */
    policy: api?.paths ?? { home: "/", userData: "/" },
    resolve: async (path) => (api?.resolvePath ? api.resolvePath(path) : path),
    audit: api?.audit,
  });
  return singleton;
}
