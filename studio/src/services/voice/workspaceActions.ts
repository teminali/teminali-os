/**
 * A spoken folder name, resolved into one concrete workspace action, locally.
 *
 * "Open my DukaBot folder" already works: `machineAction.ts` classifies it as
 * `workspace`, the router delegates, and the assistant opens it. What the
 * operator actually said, though, was that it should happen NOW. That path is a
 * full agent round trip: a delegate, a prompt, a tool call, a report. Seconds,
 * for a decision that is a name lookup against four sibling directories.
 *
 * So this module is the fast path for the one case that does not need an agent:
 * the operator named a project he already has, and wants the shell pointed at
 * it. Everything else must fall through, because the two slow paths are still
 * correct and a fast path that guesses is worse than no fast path at all.
 * Switching the workspace root is not a cheap mistake: `setWorkspacePath` in
 * `studioStore.ts` also drops every open folder in the tree, clears the reveal
 * target and restamps the active chat session onto the new root. Recovering
 * from a switch to the wrong directory costs the operator more than the second
 * this saves him, so every rule below is written to under-match.
 *
 * PURE, and deliberately importless, for two reasons that both bite:
 *
 *   - This is called from `TemiVoiceStage.tsx`, which is renderer code that
 *     Vite bundles for the browser. A top level `node:fs` or `node:path` here
 *     would break that build, so the directory listing arrives through an
 *     injected lister and path normalising is done by hand below.
 *   - `machineAction.ts` learned the same lesson: a gate that cannot be asked a
 *     question inside a plain `node --test` file does not get tested, and an
 *     untested gate on this lane fabricates. See its top of file comment.
 *
 * It resolves, it does not act. The store call belongs to the stage, because
 * the gateway and not this store owns which root the routes read: the caller
 * runs `WorkspaceService.openProject` first and passes the path it confirms.
 * See the comment on `setWorkspacePath` in `studioStore.ts`.
 */

/** Where the operator's projects live. Every resolved path must sit under it. */
export const PROJECTS_ROOT = "/Users/teminali/Documents/my_projects";

/**
 * The operator's home, read off `PROJECTS_ROOT` rather than imported.
 *
 * `os.homedir()` would be the obvious way and is not available: this module is
 * bundled for the browser and imports nothing. See the header.
 */
const HOME = PROJECTS_ROOT.slice(0, PROJECTS_ROOT.indexOf("/Documents/"));

/**
 * The only roots a spoken name may ever resolve inside.
 *
 * It began as one entry, and the second and third were added the way the note
 * here always said they would have to be — by naming another root, never by
 * loosening `isPathAllowed`, which still refuses `/etc`, a relative path, a
 * `..` escape and a sibling directory whose name merely starts the same way.
 *
 * They were added because the single root made the feature resolve almost
 * nothing. Measured against the live gateway on 2026-09-12, the operator's
 * `recent` list held nine projects and exactly one of them — `teminaliCode` —
 * sat under `my_projects`. The rest were `~/Downloads/4K Video Downloader+`,
 * `~/Downloads/MyProject` and four recordings under `~/Movies`, so every spoken
 * name but one resolved to null. That is not a cautious fast path, it is a
 * feature that only ever agrees you are already where you are — and the
 * operator's own call transcript from that day has him asking three times to be
 * switched to the 4K Video Downloader project, which is in `~/Downloads`.
 *
 * `~/Movies` is where the app writes its own recordings, so a video project
 * living there is the app's doing rather than the operator's choice. Candidates
 * still arrive from the gateway's list of projects he actually opened, which is
 * the narrower guard of the two and the one doing most of the work.
 */
export const ALLOWED_ROOTS: readonly string[] = [
  PROJECTS_ROOT,
  `${HOME}/Downloads`,
  `${HOME}/Movies`,
];

/**
 * How close a heard name must be to a real directory name before it counts.
 *
 * Calibrated against the mis-transcriptions this lane actually produces, not
 * picked round: "duke about" for `dukabot` scores 0.78 and is the worst real
 * case measured, so the floor sits below it and above the 0.5 range where
 * unrelated names land. Raising it drops "duke about"; lowering it starts
 * accepting names that merely share a few letters.
 */
export const MINIMUM_CONFIDENCE = 0.7;

/**
 * How far ahead of the runner up the winner must be.
 *
 * Without this, two similarly named projects both clear the floor and the
 * better score wins by a rounding error, which is guessing with extra steps.
 * An exact name match is exempt: see `resolveFolder`.
 */
export const REQUIRED_MARGIN = 0.08;

/** A directory that a spoken name is allowed to resolve to. */
export interface FolderCandidate {
  /** Absolute path on disk. */
  path: string;
  /** The directory's own name, spelled the way the disk spells it. */
  name: string;
}

/** Names the directories directly inside one root. Injected, never imported. */
export type DirectoryLister = (root: string) => readonly string[];

/** The shape of `fs.readdirSync(root, { withFileTypes: true })`. */
export interface DirentLike {
  name: string;
  isDirectory: () => boolean;
}

export type ReadDirSync = (root: string, options: { withFileTypes: true }) => readonly DirentLike[];

export interface ResolveOptions {
  /** Candidates to score against. Preferred: the gateway already knows these. */
  candidates?: readonly FolderCandidate[];
  /** Or a lister, used against `roots` when no candidates are supplied. */
  list?: DirectoryLister;
  roots?: readonly string[];
  minimumConfidence?: number;
  requiredMargin?: number;
}

export interface ParseOptions extends ResolveOptions {
  /**
   * The root the shell is currently bound to, if it is known.
   *
   * Only used to tell a reveal from a switch. Left optional because
   * `workspaceRootConfirmed` may still be false at the moment of the turn, and
   * an unconfirmed root must not be used to decide that a folder is local.
   */
  workspacePath?: string;
}

export interface FolderMatch {
  /** Absolute, normalised, and inside an allowed root. */
  path: string;
  /** The directory's real name, for the line Temi says back. */
  label: string;
  score: number;
  /** The best score among the others, so a refusal can be explained. */
  runnerUp: number;
}

export type WorkspaceAction =
  | { kind: "switch-workspace"; path: string; label: string }
  /**
   * A folder inside the root already open. `relativePath` is what the store
   * wants: `revealPath` keys the open set by workspace relative path, so an
   * absolute one opens nothing.
   */
  | { kind: "reveal-folder"; path: string; relativePath: string };

/* ── the heard name ──────────────────────────────────────────────────────── */

/**
 * Both sides of a comparison, reduced to what the operator actually pronounced.
 *
 * Case, spaces, hyphens and underscores all survive transcription as noise:
 * `m-digital` is heard as "m digital", `DukaBot` as "duka bot", `gs_project` as
 * "gs project". None of that is a difference worth scoring, so it is removed
 * from both sides before anything is measured. The camel case split runs first,
 * otherwise "DukaBot" and "dukabot" reduce identically but "DukaBot" against a
 * hyphenated sibling would not.
 */
function skeleton(spoken: string): string {
  return spoken
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Levenshtein distance, two rows, because the strings are folder names. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length];
}

/**
 * How much a heard name looks like a real directory name, from 0 to 1.
 *
 * Edit distance over the reduced skeletons, normalised by the longer of the
 * two, which is the defensible part: it charges for every inserted, dropped or
 * mis-heard letter and it cannot be gamed by length. "em digital" against
 * `m-digital` is one insertion in nine characters, 0.89. "duke about" against
 * `dukabot` is two, 0.78. An unrelated sibling lands near 0.2.
 *
 * On top of that, a heard name that is a whole prefix of a directory name
 * scores as a prefix rather than as four missing letters, because "open my
 * duka folder" is a person naming a project by its first word, not a person
 * mis-pronouncing it. The bonus is intentionally not enough to win on its own:
 * when two directories start with the same word, both are lifted equally and
 * `REQUIRED_MARGIN` then refuses to pick one. Four characters is the floor for
 * the bonus, measured against the failure it caused: at three, "open the bot
 * folder" resolved to `dukabot`.
 */
export function scoreFolderName(spoken: string, folderName: string): number {
  const heard = skeleton(spoken);
  const actual = skeleton(folderName);
  if (!heard || !actual) return 0;
  if (heard === actual) return 1;

  const longest = Math.max(heard.length, actual.length);
  let score = 1 - editDistance(heard, actual) / longest;

  if (heard.length >= 4) {
    const coverage = heard.length / actual.length;
    if (actual.startsWith(heard)) score = Math.max(score, 0.75 + 0.2 * coverage);
    else if (actual.includes(heard)) score = Math.max(score, 0.65 + 0.2 * coverage);
  }

  return score;
}

/* ── the guard ───────────────────────────────────────────────────────────── */

/**
 * Resolves `.` and `..` without `node:path`, and refuses to climb out.
 *
 * A `..` that would pop past the first segment returns null rather than
 * clamping at `/`, because clamping is how "../../.." becomes the root
 * directory and the guard below then has to catch it. Better to refuse the
 * path at the point the escape is visible.
 */
function normaliseAbsolutePath(candidate: string): string | null {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.includes("\0")) return null;

  const resolved: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!resolved.length) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return `/${resolved.join("/")}`;
}

/**
 * Is this a path a spoken command is allowed to point the shell at?
 *
 * Strictly inside an allowed root, never the root itself. Both halves matter.
 * Outside, the operator's whole disk is reachable by a mis-heard name, and the
 * first casualty is his home directory: binding the gateway there makes the
 * file tree a list of Library folders. The root itself is refused for the same
 * reason at smaller scale. `/Users/teminali/Documents/my_projects` is not a
 * project, and every workspace relative path inside it would resolve one level
 * too high, so every file the agent then opened would be the wrong one.
 */
export function isPathAllowed(candidate: string, roots: readonly string[] = ALLOWED_ROOTS): boolean {
  const path = normaliseAbsolutePath(candidate);
  if (!path) return false;

  return roots.some((root) => {
    const base = normaliseAbsolutePath(root);
    if (!base || base === "/") return false;
    return path !== base && path.startsWith(`${base}/`);
  });
}

/** The same check, but it hands back the normalised path it approved. */
function allowedPath(candidate: string, roots: readonly string[]): string | null {
  if (!isPathAllowed(candidate, roots)) return null;
  return normaliseAbsolutePath(candidate);
}

/** Wraps a `readdirSync` the caller owns, so this module imports no IO. */
export function createDirectoryLister(readdirSync: ReadDirSync): DirectoryLister {
  return (root: string) => {
    let entries: readonly DirentLike[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      // A root that is not there is not an error here: it is one fewer place to
      // look. Throwing would take the voice turn down with it.
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  };
}

/** Builds candidates from the gateway's project entries, the renderer's source. */
export function candidatesFromEntries(
  entries: readonly { path: string; name?: string }[],
): FolderCandidate[] {
  return entries
    .filter((entry) => typeof entry?.path === "string" && entry.path.length > 0)
    .map((entry) => ({
      path: entry.path,
      name: entry.name || entry.path.split("/").filter(Boolean).pop() || "",
    }))
    .filter((candidate) => candidate.name.length > 0);
}

/* ── the resolver ────────────────────────────────────────────────────────── */

function gatherCandidates(options: ResolveOptions, roots: readonly string[]): FolderCandidate[] {
  const listed = options.candidates
    ? [...options.candidates]
    : options.list
      ? roots.flatMap((root) =>
          options.list!(root).map((name) => ({ name, path: `${root}/${name}` })),
        )
      : [];

  // The guard runs here as well as on the winner, so neither a stale gateway
  // entry nor a lister pointed somewhere odd can put an out of bounds path into
  // the scoring at all.
  const seen = new Set<string>();
  const approved: FolderCandidate[] = [];
  for (const candidate of listed) {
    const path = candidate && allowedPath(candidate.path, roots);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    approved.push({ path, name: candidate.name || path.split("/").filter(Boolean).pop() || "" });
  }
  return approved;
}

/**
 * The heard name against the directories that exist. Null unless it is clear.
 *
 * Two separate refusals, and they fail for different reasons worth keeping
 * apart in the logs: nothing was close enough, or two things were equally
 * close. The second is the one that protects the operator. An exact name is
 * exempt from the margin, because a directory that is spelled exactly what he
 * said is not a guess, but only while it is the ONLY exact match: two of them
 * is genuine ambiguity, not confidence.
 */
export function resolveFolder(spoken: string, options: ResolveOptions = {}): FolderMatch | null {
  const name = spoken?.trim();
  if (!name) return null;

  const roots = options.roots ?? ALLOWED_ROOTS;
  const floor = options.minimumConfidence ?? MINIMUM_CONFIDENCE;
  const margin = options.requiredMargin ?? REQUIRED_MARGIN;

  const scored = gatherCandidates(options, roots)
    .map((candidate) => ({ candidate, score: scoreFolderName(name, candidate.name) }))
    .sort((left, right) => right.score - left.score);

  if (!scored.length) return null;

  const best = scored[0];
  const runnerUp = scored[1]?.score ?? 0;
  if (best.score < floor) return null;

  const exactCount = scored.filter((entry) => entry.score === 1).length;
  if (exactCount > 1) return null;
  if (exactCount !== 1 && best.score - runnerUp < margin) return null;

  return { path: best.candidate.path, label: best.candidate.name, score: best.score, runnerUp };
}

/* ── the parser ──────────────────────────────────────────────────────────── */

/**
 * Things the operator switches to that are not directories.
 *
 * "Switch to the other tab" and "open the video editor" are both perfectly good
 * commands about the UI, and both name something this module must not resolve.
 * Checked before any pattern, because a panel name that happens to look like a
 * project name is exactly how an instant switch becomes an instant mistake.
 *
 * The cost is real and accepted: a project named `editor` cannot be reached by
 * voice through this path. It is still reachable through the assistant, which
 * is the whole point of leaving the slow path in place.
 */
const SURFACE_NOUNS =
  /\b(tab|tabs|window|windows|panel|panels|pane|sidebar|chat|chats|editor|terminal|console|settings|preferences|timeline|theme|mode|model|models|branch|view|screen|page|inbox|gallery|browser|preview|canvas|orb|composer|transcript|voice|camera|profile|account|session)\b/i;

/**
 * Frames that mention a folder without asking for it to be opened.
 *
 * A question about a folder is work for the hands, not a switch: "how big is my
 * dukabot folder" must reach the assistant, which can look, and must never
 * reach a store setter. Negations and hypotheticals are here for the reason
 * `machineAction.ts` grew the same list: "don't switch to m-digital" contains a
 * perfectly formed switch command.
 *
 * Politeness is deliberately absent from this list. "Can you open my DukaBot
 * folder" is an instruction wearing a question's punctuation, and rejecting it
 * is the documented mistake the old voice gate made.
 */
const NON_ACTION_FRAMES: readonly RegExp[] = [
  /\b(?:do\s*n[o']?t|don't|never|instead\s+of|rather\s+than|no\s+need\s+to)\b/i,
  /\b(?:what\s+if|if\s+i|if\s+you|suppose|imagine|in\s+case)\b/i,
  /\b(?:how\s+(?:big|large|much|many)|what(?:'s|\s+is)\s+in|which|where\s+is|why|did|does|was|were)\b/i,
  /\b(?:i\s+(?:was|were|had|would|might|used\s+to)|you\s+(?:were|had))\b/i,
];

/** The nouns that mark the object as a place on disk rather than a surface. */
const PLACE_NOUN = "(?:workspace|project|repo|repository|codebase|folder|directory|dir)";
/**
 * Up to three words of name, which is what a hyphenated project transcribes as.
 *
 * Read twice, once shortest first and once longest first, because a place noun
 * can sit INSIDE the name: `gs_project` is spoken "gs project", so "switch to
 * the gs project repo" has two honest readings and the short one resolves to
 * "gs", which is nothing. Both readings are scored and the better one wins.
 */
const NAME_SHORTEST = "([\\w.'\\-]+(?:[ \\t]+[\\w.'\\-]+){0,2}?)";
const NAME_LONGEST = "([\\w.'\\-]+(?:[ \\t]+[\\w.'\\-]+){0,2})";

const SWITCH_VERB = "(?:switch|change|move|jump|hop|flip|take\\s+me|bring\\s+me|go)";
const OPEN_VERB = "(?:open|show|reveal|bring\\s+up|pull\\s+up|go\\s+to|navigate\\s+to)";
const LEAD_IN = "(?:\\s+me)?(?:\\s+back)?(?:\\s+(?:to|into|over\\s+to|onto|in|inside))?\\s+(?:the|my|our|that|this)?\\s*";

/** "switch to the m-digital project", "take me back to my dukabot folder". */
const SWITCH_THEN_NAME = [
  new RegExp(`\\b${SWITCH_VERB}${LEAD_IN}${NAME_SHORTEST}\\s+${PLACE_NOUN}\\b`, "i"),
  new RegExp(`\\b${SWITCH_VERB}${LEAD_IN}${NAME_LONGEST}\\s+${PLACE_NOUN}\\b`, "i"),
];
/** "switch workspace to teminaliCut", the other word order the operator uses. */
const SWITCH_THEN_NOUN = new RegExp(
  `\\b${SWITCH_VERB}\\s+(?:the\\s+|my\\s+)?${PLACE_NOUN}\\s+(?:to|into|over\\s+to)\\s+(?:the|my|our)?\\s*${NAME_LONGEST}\\s*$`,
  "i",
);
/**
 * "switch to m-digital", with no noun at all.
 *
 * Held to a stricter standard in `parseWorkspaceCommand`: without the noun
 * there is nothing in the sentence saying the object is a directory, so only an
 * exactly spelled name is accepted. This is the pattern that would otherwise
 * turn "switch to dark" into a workspace switch.
 */
const SWITCH_BARE = new RegExp(`\\b${SWITCH_VERB}${LEAD_IN}${NAME_LONGEST}\\s*$`, "i");
/** "open my DukaBot folder". The noun is required here, always. */
const OPEN_THEN_NAME = [
  new RegExp(`\\b${OPEN_VERB}${LEAD_IN}${NAME_SHORTEST}\\s+${PLACE_NOUN}\\b`, "i"),
  new RegExp(`\\b${OPEN_VERB}${LEAD_IN}${NAME_LONGEST}\\s+${PLACE_NOUN}\\b`, "i"),
];

/** Words that ride along with the name and are not part of it. */
const FILLER = /^(?:to|into|the|my|our|that|this|a|an|me|back|over|up|please|now|again)$/i;

function cleanName(raw: string | undefined): string {
  if (!raw) return "";
  const words = raw
    .trim()
    .split(/[ \t]+/)
    .filter((word) => word && !FILLER.test(word));
  return words.join(" ");
}

/**
 * Every name the sentence could be naming, by each pattern's own reading.
 *
 * Order does not matter: `bestOf` scores them all and the highest wins, which
 * is what lets a short and a long reading of the same phrase coexist without
 * either of them having to be right on its own.
 */
function namesFrom(said: string, patterns: readonly RegExp[]): string[] {
  const names: string[] = [];
  for (const pattern of patterns) {
    const heard = cleanName(pattern.exec(said)?.[1]);
    if (heard && !names.includes(heard)) names.push(heard);
  }
  return names;
}

/** The most confident resolution among the readings, or none. */
function bestOf(readings: readonly string[], options: ResolveOptions): FolderMatch | null {
  let best: FolderMatch | null = null;
  for (const heard of readings) {
    const match = resolveFolder(heard, options);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}

/**
 * A spoken phrase, turned into the one action it unambiguously asks for.
 *
 * Null is the normal answer. It means only that this fast path will not act, so
 * the turn carries on to `machineAction` and the assistant exactly as it does
 * today. Nothing is lost by returning null, and a great deal is lost by
 * returning the wrong path, which is why every gate here is a refusal.
 *
 * An `open` verb produces a reveal only when the folder is inside the root that
 * is already open. Anywhere else it is a switch, because the file tree cannot
 * reveal a directory it does not contain: revealing `dukabot` while bound to
 * `teminaliCode` opens nothing and looks like the command was ignored.
 */
export function parseWorkspaceCommand(text: string, options: ParseOptions = {}): WorkspaceAction | null {
  const said = typeof text === "string" ? text.trim() : "";
  if (!said) return null;
  if (SURFACE_NOUNS.test(said)) return null;
  if (NON_ACTION_FRAMES.some((frame) => frame.test(said))) return null;

  // Three tiers, in order of how plainly the sentence says what it wants. A
  // switch verb outranks an open verb because "move me to the dukabot project"
  // contains neither ambiguity nor a reveal, and the bare form is last because
  // it is the only one with no noun vouching for the object being a directory.
  const tiers: { bare: boolean; readings: string[] }[] = [
    { bare: false, readings: namesFrom(said, [...SWITCH_THEN_NAME, SWITCH_THEN_NOUN]) },
    { bare: false, readings: namesFrom(said, OPEN_THEN_NAME) },
    { bare: true, readings: namesFrom(said, [SWITCH_BARE]) },
  ];

  let match: FolderMatch | null = null;
  let bare = false;
  let reveals = false;
  for (const [index, tier] of tiers.entries()) {
    if (!tier.readings.length) continue;
    match = bestOf(tier.readings, options);
    if (!match) continue;
    bare = tier.bare;
    reveals = index === 1;
    break;
  }
  if (!match) return null;

  // Third and last check on the path. The resolver already guarded its
  // candidates, and this is still here because it is the line between a voice
  // turn and a store setter, and it costs one string comparison.
  const path = allowedPath(match.path, options.roots ?? ALLOWED_ROOTS);
  if (!path) return null;

  // A bare switch is only trusted when the name was spelled exactly.
  if (bare && match.score !== 1) return null;

  if (reveals && options.workspacePath) {
    const root = normaliseAbsolutePath(options.workspacePath);
    if (root && root !== "/" && path.startsWith(`${root}/`)) {
      return { kind: "reveal-folder", path, relativePath: path.slice(root.length + 1) };
    }
  }

  return { kind: "switch-workspace", path, label: match.label };
}
