/**
 * Saying a project's name should point the shell at it before she finishes the
 * sentence, and should never point it somewhere else.
 *
 * "Open my DukaBot folder" already reaches the assistant: `machineAction`
 * classifies it as `workspace` and the router delegates. That is a delegate, a
 * prompt, a tool call and a report, seconds of it, for a decision that is a
 * name lookup against four sibling directories. `workspaceActions` is the local
 * answer to that, and it is a fast path so it is the dangerous kind of code:
 * the slow path can be wrong and apologise, this one just does it.
 *
 * What it would do wrong, if it were written to be helpful rather than to
 * refuse, is switch the operator's workspace root on a name that merely sounded
 * close. That is not a small mistake. `setWorkspacePath` in `studioStore.ts`
 * also collapses every open folder in the tree, clears the reveal target and
 * restamps the active chat session onto the new root, so a wrong switch costs
 * far more than the second it saved. Every case below that ends in `null` is
 * therefore a feature, and the ones that matter most are the four at the
 * bottom: a UI surface that is not a directory, a question that only mentions
 * one, a path climbing out of the projects folder, and two projects whose names
 * begin with the same word.
 *
 * The transcriptions are real shapes, not invented ones: `m-digital` arrives as
 * "m digital" and as "em digital", `DukaBot` as "duka bot" and, on a bad
 * microphone, as "duke about".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  parseWorkspaceCommand,
  resolveFolder,
  scoreFolderName,
  isPathAllowed,
  createDirectoryLister,
  candidatesFromEntries,
  PROJECTS_ROOT,
  MINIMUM_CONFIDENCE,
} from "../src/services/voice/workspaceActions.ts";

/** The operator's real siblings, as the disk spells them. */
const SIBLINGS = ["teminali", "m-digital", "dukabot", "gs_project"];
const candidates = SIBLINGS.map((name) => ({ name, path: `${PROJECTS_ROOT}/${name}` }));
const at = (name) => `${PROJECTS_ROOT}/${name}`;

/** The root this repository sits in, which is where a turn is spoken from. */
const CURRENT = `${PROJECTS_ROOT}/teminali/teminaliCode`;

const parse = (text, extra = {}) => parseWorkspaceCommand(text, { candidates, ...extra });

/* ── the names he actually says ──────────────────────────────────────────── */

test("every way the microphone hears DukaBot lands on the one real folder", () => {
  // The left column is what the transcript says. All three are the same folder,
  // and "duke about" is the worst one measured: two wrong letters in nine.
  for (const spoken of ["open my duka bot folder", "open my DukaBot folder", "open my duke about folder"]) {
    const action = parse(spoken, { workspacePath: CURRENT });
    assert.equal(action?.kind, "switch-workspace", `"${spoken}" did not resolve`);
    assert.equal(action.path, at("dukabot"));
    assert.equal(action.label, "dukabot", "the line she says back uses the real folder name");
  }
});

test("a hyphen the operator cannot pronounce does not hide m-digital", () => {
  for (const spoken of ["switch to the m digital project", "switch to the em digital project"]) {
    const action = parse(spoken);
    assert.equal(action?.kind, "switch-workspace", `"${spoken}" did not resolve`);
    assert.equal(action.path, at("m-digital"));
  }
});

test("an underscore is heard as a space, and gs_project still resolves", () => {
  assert.equal(parse("switch to the gs project repo")?.path, at("gs_project"));
});

test("the word orders he uses are both understood", () => {
  // The name before the noun, and the noun before the name.
  assert.equal(parse("take me back to my dukabot project")?.path, at("dukabot"));
  assert.equal(parse("change workspace to m-digital")?.path, at("m-digital"));
});

/* ── a switch, or a look inside the root already open ────────────────────── */

test("opening a folder of the current project reveals it instead of rebinding", () => {
  /*
    An `open` verb is ambiguous and the resolved path settles it. Revealing a
    folder that the tree does not contain opens nothing at all, which the
    operator reads as the command having been ignored, so a folder outside the
    current root is a switch. Inside it, the reveal is the right and much
    cheaper action, and it wants the workspace relative path: `revealPath` keys
    the open set by relative path, so an absolute one matches no row.
  */
  const inside = [...candidates, { name: "studio", path: `${CURRENT}/studio` }];
  const action = parseWorkspaceCommand("open the studio folder", {
    candidates: inside,
    workspacePath: CURRENT,
  });
  assert.equal(action?.kind, "reveal-folder");
  assert.equal(action.path, `${CURRENT}/studio`);
  assert.equal(action.relativePath, "studio");
});

test("with no confirmed root, an open verb still switches rather than guessing a reveal", () => {
  // `workspaceRootConfirmed` can still be false when the turn arrives, and a
  // reveal decided against the boot guess would be decided against the wrong
  // tree. Without a root there is nothing to be inside of.
  const action = parse("open my dukabot folder");
  assert.equal(action?.kind, "switch-workspace");
  assert.equal(action.path, at("dukabot"));
});

/* ── the refusals ────────────────────────────────────────────────────────── */

test("a tab, an editor and a mode are not directories", () => {
  // All three are good commands about the UI. None of them may reach a store
  // setter that repoints the gateway.
  for (const spoken of [
    "switch to the other tab",
    "open the video editor",
    "switch to dark mode",
    "go to the settings panel",
    "take me back to the chat",
  ]) {
    assert.equal(parse(spoken, { workspacePath: CURRENT }), null, `"${spoken}" must not switch anything`);
  }
});

test("a question about a folder is work for the hands, not a switch", () => {
  // These mention a project by name and must still travel the slow path, where
  // something can actually look. Answering them here would be the fabrication
  // the whole lane is built to avoid.
  for (const spoken of [
    "how big is my dukabot folder",
    "what is in the m-digital project",
    "which project am i in",
    "did you open the dukabot folder",
  ]) {
    assert.equal(parse(spoken), null, `"${spoken}" is a question, not a command`);
  }
});

test("a negated or hypothetical switch is not a switch", () => {
  for (const spoken of [
    "don't switch to the m-digital project",
    "what if i switched to the dukabot project",
    "i was in the gs project repo earlier",
  ]) {
    assert.equal(parse(spoken), null, `"${spoken}" must not act`);
  }
});

test("politeness is not a refusal, because it was once", () => {
  // The old voice gate rejected anything ending in a question mark and sent
  // "can you open my downloads?" to a persona with no hands, which answered in
  // character and said it had done it. A polite imperative is an imperative.
  const action = parse("can you open my dukabot folder please?");
  assert.equal(action?.kind, "switch-workspace");
  assert.equal(action.path, at("dukabot"));
});

test("a switch with no name in it resolves to nothing", () => {
  assert.equal(parse("switch to the project"), null);
  assert.equal(parse("open my folder"), null);
});

test("without the noun, only an exactly spelled name is trusted", () => {
  /*
    "Switch to m-digital" carries nothing saying its object is a directory, so
    the fuzzy scoring is not allowed to run on it: that is the form that would
    turn "switch to dark" into a workspace switch. The exact name still works,
    and the fuzzy one comes back the moment the operator says which kind of
    thing he means.
  */
  assert.equal(parse("switch to m-digital")?.path, at("m-digital"));
  assert.equal(parse("switch to em digital"), null);
  assert.equal(parse("switch to the em digital project")?.path, at("m-digital"));
});

/* ── the guard ───────────────────────────────────────────────────────────── */

test("the guard allows a project and refuses everything above it", () => {
  assert.equal(isPathAllowed(at("dukabot")), true);
  assert.equal(isPathAllowed(`${CURRENT}/studio/src`), true);

  // Each of these is a directory the operator has, and none of them is a place
  // to bind a workspace. The home root is the one that hurts: the file tree
  // becomes a list of Library folders and every relative path resolves wrong.
  for (const escape of [
    "/",
    "/Users",
    "/Users/teminali",
    "/Users/teminali/Documents",
    "/etc/passwd",
    PROJECTS_ROOT,
  ]) {
    assert.equal(isPathAllowed(escape), false, `${escape} must be refused`);
  }
});

test("a climbing path is refused after it is resolved, not before", () => {
  // The string starts with the allowed root, which is exactly why a prefix
  // check on its own is not a guard.
  assert.equal(isPathAllowed(`${PROJECTS_ROOT}/../../../etc`), false);
  assert.equal(isPathAllowed(`${PROJECTS_ROOT}/dukabot/../teminali`), true, "one level up is still a sibling project");
  assert.equal(isPathAllowed(`${PROJECTS_ROOT}/dukabot/../..`), false);
  assert.equal(isPathAllowed("../.."), false, "a relative path is not a workspace root");
  assert.equal(isPathAllowed("~/Documents/my_projects/dukabot"), false);
});

test("a root that is a prefix of another directory's name is not that directory", () => {
  assert.equal(isPathAllowed("/Users/teminali/Documents/my_projects_backup/dukabot"), false);
});

test("a candidate list pointing outside the roots resolves to nothing", () => {
  // The names are perfect. The paths are not this operator's, and the guard
  // runs on the candidates as well as on the winner, so a stale gateway entry
  // cannot smuggle one through.
  const smuggled = [
    { name: "dukabot", path: "/etc/dukabot" },
    { name: "m-digital", path: `${PROJECTS_ROOT}/../m-digital` },
  ];
  assert.equal(parseWorkspaceCommand("open my dukabot folder", { candidates: smuggled }), null);
  assert.equal(parseWorkspaceCommand("switch to the m-digital project", { candidates: smuggled }), null);
});

/* ── ambiguity ───────────────────────────────────────────────────────────── */

test("two projects starting with the same word return nothing rather than a coin toss", () => {
  /*
    "Duka" is a person naming a project by its first word, and with one such
    project that is enough to act on. With two it is not, and the margin rule is
    what says so: both score well above the floor and within a few points of
    each other, which is the shape of a guess. The operator hears the slow path
    ask him which one, which is the correct outcome.
  */
  const twins = [
    { name: "dukabot", path: at("dukabot") },
    { name: "dukabot-web", path: at("dukabot-web") },
  ];
  assert.ok(scoreFolderName("duka", "dukabot") > MINIMUM_CONFIDENCE, "the prefix itself is confident");
  assert.equal(parseWorkspaceCommand("open my duka folder", { candidates: twins }), null);

  // And the same phrase with only one of them present does resolve, which is
  // what proves the refusal above was ambiguity and not incapacity.
  assert.equal(parseWorkspaceCommand("open my duka folder", { candidates: [twins[0]] })?.path, at("dukabot"));
});

test("an exactly spelled name beats a near twin, but two exact names do not", () => {
  // The margin is waived for an exact name, because a directory spelled what he
  // said is not a guess. Waived only while it is the only one: two directories
  // that reduce to the same name are real ambiguity, and it is the one shape a
  // score cannot break, so it is refused outright.
  const near = [
    { name: "gs_project", path: at("gs_project") },
    { name: "gs-project2", path: at("gs-project2") },
  ];
  assert.equal(resolveFolder("gs project", { candidates: near })?.path, at("gs_project"));

  const identical = [
    { name: "m-digital", path: at("m-digital") },
    { name: "m_digital", path: at("m_digital") },
  ];
  assert.equal(resolveFolder("m digital", { candidates: identical }), null);
});

test("a name that is no project at all scores below the floor", () => {
  for (const spoken of ["landing", "recorder", "random_project", "the thing i was doing"]) {
    assert.equal(resolveFolder(spoken, { candidates }), null, `"${spoken}" is not one of these four`);
  }
});

test("the prefix bonus needs four characters, because three resolved bot to dukabot", () => {
  assert.ok(scoreFolderName("bot", "dukabot") < MINIMUM_CONFIDENCE);
  assert.equal(parse("open the bot folder"), null);
});

/* ── the injected disk ───────────────────────────────────────────────────── */

test("the lister reads directories through an injected readdir, never this disk", () => {
  const entries = [
    { name: "teminali", isDirectory: () => true },
    { name: "dukabot", isDirectory: () => true },
    { name: ".DS_Store", isDirectory: () => false },
    { name: ".git", isDirectory: () => true },
    { name: "notes.md", isDirectory: () => false },
  ];
  const list = createDirectoryLister((root, options) => {
    assert.equal(root, PROJECTS_ROOT);
    assert.equal(options.withFileTypes, true);
    return entries;
  });
  assert.deepEqual(list(PROJECTS_ROOT), ["teminali", "dukabot"]);

  const action = parseWorkspaceCommand("open my duka bot folder", { list });
  assert.equal(action?.path, at("dukabot"));
});

test("a root that is not there costs one place to look, not the voice turn", () => {
  const list = createDirectoryLister(() => {
    throw new Error("ENOENT");
  });
  assert.deepEqual(list(PROJECTS_ROOT), []);
  assert.equal(parseWorkspaceCommand("open my dukabot folder", { list }), null);
});

test("the gateway's own project entries are usable as candidates unchanged", () => {
  // This is where the renderer gets its list: `/api/workspace/projects` already
  // knows the recent roots, so nothing in this lane has to read a disk.
  const built = candidatesFromEntries([
    { path: at("dukabot"), name: "dukabot" },
    { path: at("m-digital") },
    { path: "" },
  ]);
  assert.deepEqual(built, [
    { path: at("dukabot"), name: "dukabot" },
    { path: at("m-digital"), name: "m-digital" },
  ]);
  assert.equal(parseWorkspaceCommand("switch to the duka bot project", { candidates: built })?.path, at("dukabot"));
});

test("the module imports nothing, so the renderer bundle still builds", async () => {
  // `TemiVoiceStage.tsx` is renderer code that Vite bundles for the browser. A
  // top level `node:fs` here would break that build, which is why the lister is
  // injected and the path normalising is done by hand.
  const source = await readFile(new URL("../src/services/voice/workspaceActions.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(source), false, "no imports, pure rules");
  assert.equal(/\brequire\s*\(/.test(source), false);
});

/* ── the roots, after the measurement that widened them ───────────────────── */

test("the operator's real projects resolve, which one root did not allow", () => {
  /* Measured against the live gateway on 2026-09-12: of the nine projects in
     his `recent` list, exactly one sat under `my_projects`. With a single root
     every spoken name but that one resolved to null, and his own call
     transcript from that day has him asking three times to be switched to a
     project in `~/Downloads`. */
  const candidates = [
    { name: "teminaliCode", path: `${PROJECTS_ROOT}/teminali/teminaliCode` },
    { name: "4K Video Downloader+", path: "/Users/teminali/Downloads/4K Video Downloader+" },
    { name: "MyProject", path: "/Users/teminali/Downloads/MyProject" },
    { name: "2026-09-10 20.37.26", path: "/Users/teminali/Movies/Teminali OS Recordings/2026-09-10 20.37.26" },
  ];
  assert.equal(resolveFolder("my project", { candidates })?.label, "MyProject");
  assert.equal(resolveFolder("4k video downloader", { candidates })?.label, "4K Video Downloader+");
});

test("widening the roots did not widen the guard", () => {
  // The mechanism is untouched; only the list it reads got longer.
  assert.equal(isPathAllowed("/etc/dukabot"), false);
  assert.equal(isPathAllowed("/Users/teminali/Downloads/../../../etc"), false);
  assert.equal(isPathAllowed("/Users/teminali/Downloads_backup/thing"), false);
  assert.equal(isPathAllowed("/Users/teminali"), false, "the home directory is not a project");
  assert.equal(isPathAllowed("/Users/teminali/Downloads/MyProject"), true);
});

/* ── 2026-09-12: the name window widened from three words to four ──────────
 *
 * `4K Video Downloader+` is the folder the operator asked for three times in
 * one call transcript and the fast path never gave him, because it is spoken
 * either "4K video downloader plus" or "four K video downloader" -- both FOUR
 * words. The name sits between the verb's lead-in and the place noun, so a
 * four-word name matched no pattern at all: the command died before the
 * scorer ever ran, which is why the failure did not show up as a wrong
 * answer, only as silence.
 *
 * Widening the window on its own would have traded one failure for a worse
 * one: a longer capture can cross a phrase boundary, and the old cleanName
 * deleted filler wherever it found it, so "move the video into the downloads
 * folder" -- a FILE MOVE -- would capture "video into the downloads", delete
 * "into" and "the", and weld what was left into "video downloads", which is a
 * confident match for `4K Video Downloader+`. cleanName now trims filler only
 * from the edges and refuses the whole reading if filler survives inside it.
 * Both changes are pinned together below, because shipping the first without
 * the second is the regression that would have mattered most.
 */

test("the four-word window: 4K Video Downloader+ resolves every way it is actually spoken", () => {
  const candidates = [
    { name: "teminaliCode", path: `${PROJECTS_ROOT}/teminali/teminaliCode` },
    { name: "4K Video Downloader+", path: "/Users/teminali/Downloads/4K Video Downloader+" },
    { name: "MyProject", path: "/Users/teminali/Downloads/MyProject" },
  ];
  const want = "/Users/teminali/Downloads/4K Video Downloader+";

  for (const spoken of [
    "open the 4K video downloader plus folder",
    "open the four k video downloader folder",
    "switch to the 4k video downloader plus folder",
  ]) {
    const action = parseWorkspaceCommand(spoken, { candidates });
    assert.equal(action?.kind, "switch-workspace", `"${spoken}" did not resolve`);
    assert.equal(action.path, want);
    assert.equal(action.label, "4K Video Downloader+");
  }
});

test("a four-word name resolves generally, not just the one folder that was measured", () => {
  // `Mocro.Maffia.S06.MULTi` is the other real directory the source comment
  // names: a long, dotted, four-word release name. It skeletonises to exactly
  // what the operator said, so this is a clean exact match, not a fuzzy one --
  // proof the window covers four words as a rule, not as a special case for
  // one downloader.
  const candidates = [
    ...SIBLINGS.map((name) => ({ name, path: at(name) })),
    { name: "Mocro.Maffia.S06.MULTi", path: "/Users/teminali/Downloads/Mocro.Maffia.S06.MULTi" },
  ];
  const action = parseWorkspaceCommand("open the mocro maffia s06 multi folder", { candidates });
  assert.equal(action?.kind, "switch-workspace");
  assert.equal(action.path, "/Users/teminali/Downloads/Mocro.Maffia.S06.MULTi");
});

test("the three-word form that already worked still works, and so do shorter names", () => {
  // The window widened, it did not shift. `4K Video Downloader+` without the
  // "plus" is the three-word form that resolved before this fix and must go
  // on resolving; a single word and a two-word name from the real siblings
  // pin the other end of the window the same way.
  const fourK = [{ name: "4K Video Downloader+", path: "/Users/teminali/Downloads/4K Video Downloader+" }];
  assert.equal(
    parseWorkspaceCommand("open the 4K video downloader folder", { candidates: fourK })?.path,
    "/Users/teminali/Downloads/4K Video Downloader+",
  );

  assert.equal(parse("open the teminali folder")?.path, at("teminali"));
  assert.equal(parse("open the gs project folder")?.path, at("gs_project"));
});

test("the interior-filler guard refuses a capture that crosses a phrase boundary", () => {
  /*
    The point of change 2. A four-word window can capture across a phrase
    boundary the old three-word window never reached, and a filler word
    surviving in the MIDDLE of that capture is the tell: it is not riding
    along with a name, it is the rest of the sentence carrying on.

    The first one is the case that was actually measured. "move the video
    into the downloads folder" is an instruction to move a FILE. It captures
    "video into the downloads", and the old cleanName deleted "into" and "the"
    and welded what was left into "video downloads" -- which scores 0.76
    against `4K Video Downloader+`, clears the 0.7 floor, and would have
    silently switched the operator's workspace root out from under a command
    that never named a project at all. That is the most expensive failure on
    this lane, arriving through the front door.

    The next two are the same shape against different targets, and neither
    weld happens to clear the floor this time (0.27 and 0.65 measured). That
    is exactly why the fix refuses the SHAPE of the capture instead of relying
    on the score: the guard must not depend on being lucky.
  */
  const downloads = [{ name: "4K Video Downloader+", path: "/Users/teminali/Downloads/4K Video Downloader+" }];
  assert.equal(
    parseWorkspaceCommand("move the video into the downloads folder", { candidates: downloads }),
    null,
    "a file move must never become a workspace switch",
  );

  const untitled = [{ name: "Untitled Project", path: "/Users/teminali/Downloads/Untitled Project" }];
  assert.equal(
    parseWorkspaceCommand("move that clip into my untitled project folder", { candidates: untitled }),
    null,
  );
  assert.equal(
    parseWorkspaceCommand("go back to the video in the downloads folder", { candidates: downloads }),
    null,
  );
});

test("cleanName's contract, exercised through the parser since it is not exported", () => {
  /*
    cleanName has no export, deliberately, so every caller including this test
    reaches it only through parseWorkspaceCommand -- the same door the fast
    path itself uses.

    Edge filler rides along with a name and is trimmed, even two words of it,
    and even a word LEAD_IN itself never looks for. LEAD_IN's own literal
    words are things like "back", "to", "into", "the", "my" -- not "up" -- so
    "up" survives into the raw capture as "up the dukabot", and it is
    cleanName, not LEAD_IN, doing the trim here.
  */
  assert.equal(parse("open up the dukabot folder")?.path, at("dukabot"));
  assert.equal(parse("switch to a dukabot folder")?.path, at("dukabot"));

  // Filler in the interior is refused outright rather than deleted. This uses
  // only the four real siblings, apart from the scenario-specific cases
  // above, so it pins the mechanism on its own: "move the file into the
  // dukabot folder" is a file move, it captures "file into the dukabot", and
  // "into" and "the" both survive inside it.
  assert.equal(parse("move the file into the dukabot folder"), null);
});
