/**
 * What an agent CLI wrote, turned into a reviewable change.
 *
 * The built-in chat pane has had accept/reject since `liveEditService` shipped,
 * because it authors the edit itself and therefore holds both sides of it. An
 * agent CLI does not: it writes to the working tree in its own process and
 * tells us about it afterwards. So the "before" has to be recovered rather than
 * remembered, and this module is the recovery.
 *
 * It runs on the server, next to the CLI's stdout, for one reason: timing. The
 * tool-use line arrives before the CLI has performed the write, but only just —
 * a snapshot taken after a round trip to the renderer would routinely read the
 * file the agent had already changed. Reading here, synchronously, in the same
 * tick the line is parsed, is the earliest moment available to anyone.
 *
 * Even that is a race, so it is not trusted blindly. `Edit` is a literal string
 * substitution, which means it can be *undone* on the text it produced: when
 * the snapshot turns out to be stale the original is reconstructed from the
 * result instead. That makes an edit exact whether or not the snapshot won.
 * `Write` has no such inverse — it replaces the whole file — so a lost race
 * there yields `before === after` and the change is dropped rather than
 * reported as an empty diff. Losing silently beats reviewing a lie.
 *
 * Nothing here parses prose. See tests/agent-edits.test.mjs.
 */

import { readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isWritableWorkspaceFile } from "./workspace.js";

/**
 * Per side of one change. Both sides travel the run's NDJSON stream to the
 * renderer, so this is a stream budget rather than a filesystem one — the
 * workspace API's own 8 MB cap is for a single body the operator asked for.
 */
export const AGENT_EDIT_MAX_BYTES = 1024 * 1024;

/** Replace one literal occurrence. `String.replace` would read `$&` in `put`. */
function replaceOnce(text, find, put) {
  const at = text.indexOf(find);
  if (at === -1) return null;
  return text.slice(0, at) + put + text.slice(at + find.length);
}

function editList(input) {
  if (Array.isArray(input.edits)) {
    const edits = [];
    for (const entry of input.edits) {
      if (typeof entry?.old_string !== "string" || typeof entry?.new_string !== "string") return null;
      edits.push({ oldText: entry.old_string, newText: entry.new_string, replaceAll: entry.replace_all === true });
    }
    return edits.length > 0 ? edits : null;
  }
  if (typeof input.old_string === "string" && typeof input.new_string === "string") {
    return [{ oldText: input.old_string, newText: input.new_string, replaceAll: input.replace_all === true }];
  }
  return null;
}

/**
 * Codex reports a file change as an opaque payload rather than as before/after
 * text, and the shape has moved between releases. Every form seen is read, and
 * an unrecognised one yields no paths rather than a guess.
 */
function codexPaths(changes) {
  if (typeof changes === "string") return [changes];
  if (Array.isArray(changes)) {
    return changes
      .map((entry) => (typeof entry === "string" ? entry : typeof entry?.path === "string" ? entry.path : null))
      .filter((entry) => typeof entry === "string" && entry.length > 0);
  }
  if (changes && typeof changes === "object") return Object.keys(changes);
  return [];
}

/**
 * The files one tool call touches, and what is known about undoing each.
 *
 * `edits` is null when the call carries no inverse — a `Write`, or any of
 * Codex's file changes — which is what makes the snapshot the only source of
 * `before` for those.
 */
export function editTargets(name, input = {}) {
  const payload = input && typeof input === "object" ? input : {};
  if (name === "Write") {
    return typeof payload.file_path === "string" && payload.file_path ? [{ path: payload.file_path, edits: null }] : [];
  }
  if (name === "Edit" || name === "MultiEdit") {
    if (typeof payload.file_path === "string" && payload.file_path) {
      return [{ path: payload.file_path, edits: editList(payload) }];
    }
    return codexPaths(payload.changes).map((path) => ({ path, edits: null }));
  }
  return [];
}

/** True when `edits` still describes `before` — i.e. the snapshot is pre-edit. */
export function editsApplyTo(before, edits) {
  let text = before;
  for (const { oldText, newText, replaceAll } of edits) {
    if (oldText === "") return false;
    if (!text.includes(oldText)) return false;
    text = replaceAll ? text.split(oldText).join(newText) : replaceOnce(text, oldText, newText);
  }
  return true;
}

/**
 * Undo a run of literal substitutions on the text they produced.
 *
 * Returns null wherever the original cannot be established rather than the
 * nearest plausible answer: a `before` recovered from the wrong occurrence
 * would look like a clean diff and, on reject, would write a file that never
 * existed. The refusals are a deletion (`new_string` empty, so the insertion
 * point is gone from the result) and an ambiguous one (`new_string` appears
 * more than once, so which copy the tool wrote is unknowable).
 */
export function reverseEdits(after, edits) {
  let text = after;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const { oldText, newText, replaceAll } = edits[index];
    if (oldText === newText) continue;
    if (newText === "") return null;
    if (replaceAll) {
      if (!text.includes(newText)) return null;
      text = text.split(newText).join(oldText);
      continue;
    }
    const at = text.indexOf(newText);
    if (at === -1) return null;
    if (text.indexOf(newText, at + newText.length) !== -1) return null;
    text = text.slice(0, at) + oldText + text.slice(at + newText.length);
  }
  return text;
}

/**
 * Read one side of a change.
 *
 * Three answers, and they are not the same: the file is there and reviewable,
 * the file is not there (a create, whose `before` is genuinely ""), or it is
 * there but unusable — too large for the stream, or not a regular file. Only
 * the last is null, and it takes the whole change out of review.
 */
function readSnapshot(absolutePath, maxBytes) {
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    return { existed: false, content: "" };
  }
  if (!stats.isFile() || stats.size > maxBytes) return null;
  try {
    // `size` and `modified` ride along because the renderer opens the edited
    // file in a tab, and a tab whose mtime is unknown cannot be saved over
    // safely afterwards — `writeWorkspaceFile` checks it to catch a file that
    // moved under the editor.
    return { existed: true, content: readFileSync(absolutePath, "utf8"), size: stats.size, modified: stats.mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * Watch one turn's tool stream and emit a change per file the agent wrote.
 *
 * `emit` is the run's own NDJSON emitter, the same channel `reveal` uses — the
 * renderer opened it by starting the turn and it dies with the turn, so no new
 * lifecycle is introduced here either.
 *
 * Only paths `writeWorkspaceFile` would accept are watched. A row in the review
 * dock promises that reject will restore the file; offering that for a path the
 * workspace API refuses to write would be a button that cannot keep its word.
 */
export function createEditWatcher({ root, emit, maxBytes = AGENT_EDIT_MAX_BYTES, read }) {
  const workspaceRoot = resolve(root);
  const snapshot = read || ((absolutePath) => readSnapshot(absolutePath, maxBytes));
  const pending = new Map();

  const locate = (candidate) => {
    if (typeof candidate !== "string" || candidate.includes("\0")) return null;
    const absolute = resolve(workspaceRoot, candidate);
    if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${sep}`)) return null;
    if (!isWritableWorkspaceFile(absolute)) return null;
    return { absolute, path: relative(workspaceRoot, absolute).split(sep).join("/") };
  };

  const settle = (entry) => {
    const after = snapshot(entry.absolute);
    // Gone, or grown past the stream budget. A change nobody can be shown the
    // whole of is not a change anybody can review.
    if (!after || !after.existed) return;

    let before = entry.before;
    if (entry.edits && (!before?.existed || !editsApplyTo(before.content, entry.edits))) {
      const reversed = reverseEdits(after.content, entry.edits);
      if (reversed === null) return;
      before = { existed: true, content: reversed };
    }
    if (!before) return;
    if (before.content === after.content) return;

    emit({
      type: "edit",
      path: entry.path,
      before: before.content,
      after: after.content,
      existedBefore: before.existed,
      size: after.size ?? null,
      modified: after.modified ?? null,
    });
  };

  return {
    onTool(event) {
      if (event.status === "running") {
        const watched = [];
        for (const target of editTargets(event.name, event.input)) {
          const located = locate(target.path);
          if (!located) continue;
          watched.push({ ...located, edits: target.edits, before: snapshot(located.absolute) });
        }
        if (watched.length > 0) pending.set(event.id, watched);
        return;
      }
      const watched = pending.get(event.id);
      if (!watched) return;
      pending.delete(event.id);
      // A refused or failed tool wrote nothing worth reviewing, and the
      // snapshot it left behind must not outlive it.
      if (event.status !== "completed") return;
      for (const entry of watched) settle(entry);
    },

    /** Drop anything the turn never finished. */
    close() {
      pending.clear();
    },
  };
}
