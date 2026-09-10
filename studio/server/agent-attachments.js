/**
 * The operator's attached images, on their way to a CLI that only reads files.
 *
 * Claude Code and Codex are processes, not providers: `server/agent-cli.js`
 * hands them a prompt as argv, so a base64 data URL cannot ride inline — a 5 MB
 * string is not an argument, and neither CLI would know what to do with one if
 * it were. Both read images off disk instead, by two different routes:
 *
 *   codex exec --image=<file>   attaches the file to the initial prompt
 *   claude -p <prompt>          has no image flag; it reads paths with its own
 *                               Read tool, so the paths go in the prose
 *
 * Which is why the bytes must land somewhere both can reach. They are written
 * under the agent's own resolved working directory rather than in a system temp
 * dir, because Claude Code anchors its read permission at cwd: an image in
 * /tmp is outside the workspace and gets a permission prompt or a refusal for a
 * file the operator already chose to attach.
 *
 * The directory carries its own `.gitignore` containing `*`, so a turn that
 * runs `git status` mid-flight does not see the operator's repository suddenly
 * grow four untracked files. `removeAgentImages` deletes the run's directory
 * from `runAgentTurn`'s single `finish()` funnel, so nothing survives the turn.
 * A resumed session keeps the *content* — Codex embedded it in its request,
 * Claude read it into its transcript — but not the files.
 *
 * The limits mirror `src/services/attachmentPolicy.ts`, which is where the
 * renderer enforces them; they are re-checked here because a limit only the
 * client enforces is not a limit. The 1536px cap is not among them: that is a
 * client-side resize, and the server can only honestly police bytes and type.
 */

import { mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const IMAGE_LIMITS = Object.freeze({
  maxCount: 4,
  maxTotalBytes: 5 * 1024 * 1024,
});

/** Where a run's images live, relative to the agent's working directory. */
export const ATTACHMENT_DIR = ".teminali-attachments";

const EXTENSIONS = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});

/**
 * The first bytes each declared type must actually start with.
 *
 * A data URL is operator input claiming its own type, and the answer to that
 * claim is written into the workspace. Checking the signature costs four bytes
 * and means the file we create is the kind of file we said it was.
 */
const MAGIC = Object.freeze({
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
});

/** Operator-facing wording for each code these functions throw. */
export const AGENT_IMAGE_ERRORS = Object.freeze({
  INVALID_AGENT_IMAGES: "Attached images must be an array of data URLs.",
  TOO_MANY_AGENT_IMAGES: `At most ${IMAGE_LIMITS.maxCount} images can be attached to one turn.`,
  AGENT_IMAGES_TOO_LARGE: `The attached images exceed ${Math.round(IMAGE_LIMITS.maxTotalBytes / (1024 * 1024))} MB in total.`,
  INVALID_AGENT_IMAGE: "An attachment is not a readable base64 image data URL.",
  UNSUPPORTED_AGENT_IMAGE: "Attached images must be PNG, JPEG, or WebP.",
});

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

function looksLike(mediaType, bytes) {
  const signature = MAGIC[mediaType];
  if (!signature) return false;
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }
  // RIFF is a container, not a format: only the WEBP fourCC at offset 8 says
  // which one this is.
  if (mediaType === "image/webp") return bytes.length >= 12 && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  return true;
}

/** One data URL, decoded and checked. Throws a bare code; see AGENT_IMAGE_ERRORS. */
export function parseImageDataUrl(value) {
  if (typeof value !== "string") throw new Error("INVALID_AGENT_IMAGE");
  const match = DATA_URL.exec(value.trim());
  if (!match) throw new Error("INVALID_AGENT_IMAGE");
  const mediaType = match[1].toLowerCase();
  const extension = EXTENSIONS[mediaType];
  if (!extension) throw new Error("UNSUPPORTED_AGENT_IMAGE");
  // Buffer.from is lenient with base64 and never throws, so the bytes it
  // returns are the only evidence of whether the payload was real.
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) throw new Error("INVALID_AGENT_IMAGE");
  if (!looksLike(mediaType, bytes)) throw new Error("INVALID_AGENT_IMAGE");
  return { mediaType, extension, bytes };
}

/**
 * The whole attachment set, decoded and within the limits.
 *
 * Called twice per turn on purpose: once by the gateway so a bad payload is a
 * 400 before a stream is opened, and once by `runAgentTurn`, which is exported
 * and callable without going through the route at all.
 */
export function validateAgentImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error("INVALID_AGENT_IMAGES");
  if (images.length === 0) return [];
  if (images.length > IMAGE_LIMITS.maxCount) throw new Error("TOO_MANY_AGENT_IMAGES");
  const parsed = images.map(parseImageDataUrl);
  const total = parsed.reduce((sum, image) => sum + image.bytes.length, 0);
  if (total > IMAGE_LIMITS.maxTotalBytes) throw new Error("AGENT_IMAGES_TOO_LARGE");
  return parsed;
}

/**
 * Put the images on disk under `cwd` and return the paths to name to the agent.
 *
 * `runId` only names the directory; it is reduced to the characters that can
 * safely be one path segment rather than trusted, because a run id that could
 * contain a separator would be a way out of the directory it is meant to make.
 */
export function writeAgentImages({ cwd, runId = null, images }) {
  const parsed = validateAgentImages(images);
  if (parsed.length === 0) return { dir: null, paths: [] };

  const slug = String(runId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || randomUUID();
  const dir = join(cwd, ATTACHMENT_DIR, slug);
  mkdirSync(dir, { recursive: true });
  // A directory that ignores itself. Written every run rather than once, so a
  // turn cannot inherit a half-made directory from a run that was killed.
  writeFileSync(join(cwd, ATTACHMENT_DIR, ".gitignore"), "*\n");

  const paths = parsed.map((image, index) => {
    const file = join(dir, `image-${index + 1}.${image.extension}`);
    writeFileSync(file, image.bytes, { mode: 0o600 });
    return file;
  });

  return { dir, paths };
}

/**
 * Take the run's images away again.
 *
 * The parent is removed too, but only with a non-recursive `rmdir`: it fails
 * harmlessly while another turn still has a directory in there, which is the
 * behaviour concurrent agent tabs need.
 */
export function removeAgentImages(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* A turn must not fail because its scratch files outlived it. */
  }
  const parent = dirname(dir);
  try {
    // The `.gitignore` is shared by every concurrent run, so it goes only once
    // nothing else is left to ignore. Removing it while another agent tab still
    // has images in there would make that turn's files visible to git.
    const remaining = readdirSync(parent);
    if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === ".gitignore")) {
      rmSync(join(parent, ".gitignore"), { force: true });
      rmdirSync(parent);
    }
  } catch {
    /* Another run is still using it, or it was never ours. Either is fine. */
  }
}
