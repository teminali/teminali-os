/**
 * File ingestion — turning any dropped file into something a model can read.
 *
 * A language model reads text and, with a vision model, images. Everything else
 * has to be converted first, and the conversion is what determines whether an
 * attachment is useful or noise. So each kind gets a purpose-built path rather
 * than a generic "read the bytes and hope":
 *
 *   audio, video  → whisper.cpp transcription (the same engine voice uses)
 *   pdf           → embedded text, and OCR when the pages turn out to be scans
 *   office docs   → textutil, which macOS already ships
 *   images        → downscaled for a vision model, plus OCR when they hold text
 *   archives      → a listing, because the contents are the question
 *   data          → structure and a sample, not 40MB of rows
 *
 * Every processor is bounded, every one reports which tool produced its output,
 * and a missing tool degrades to a description of the file rather than to a
 * silent empty string. What the model is given is always something the operator
 * can inspect and verify.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withBinPaths } from "./bin-paths.js";
import { lookupCommand } from "./command-resolver.js";
import { transcribeLocal } from "./speech-local.js";

const run = promisify(execFile);

/** Text handed to a model, per file. Beyond this the tail is dropped. */
export const MAX_EXTRACTED_CHARS = 120_000;
/** Longest edge of an image sent to a vision model. */
export const MAX_IMAGE_EDGE = 1536;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Frames sampled from a video for the vision model. */
const VIDEO_FRAMES = 3;

const EXTENSIONS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "heic", "avif", "svg"],
  audio: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aiff", "caf", "wma"],
  video: ["mp4", "mov", "avi", "mkv", "webm", "m4v", "mpg", "mpeg", "wmv"],
  pdf: ["pdf"],
  document: ["docx", "doc", "rtf", "odt", "pages", "html", "htm", "epub"],
  data: ["csv", "tsv", "json", "ndjson", "yaml", "yml", "xml", "parquet", "sqlite", "db"],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg"],
  code: [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift",
    "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "css", "scss", "less",
    "vue", "svelte", "astro", "toml", "ini", "cfg", "conf", "env", "dockerfile", "makefile",
    "gradle", "lock", "patch", "diff",
  ],
  text: ["txt", "md", "markdown", "log", "rst", "adoc", "csv"],
};

/** Magic-byte signatures, for when the extension lies or is absent. */
const SIGNATURES = [
  { kind: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },                 // %PDF
  { kind: "image", bytes: [0x89, 0x50, 0x4e, 0x47] },               // PNG
  { kind: "image", bytes: [0xff, 0xd8, 0xff] },                     // JPEG
  { kind: "image", bytes: [0x47, 0x49, 0x46, 0x38] },               // GIF8
  { kind: "archive", bytes: [0x50, 0x4b, 0x03, 0x04] },             // ZIP (also docx/xlsx)
  { kind: "archive", bytes: [0x1f, 0x8b] },                         // gzip
];

export function detectKind(name, buffer) {
  const extension = String(name).split(".").pop()?.toLowerCase() ?? "";
  for (const [kind, list] of Object.entries(EXTENSIONS)) {
    if (list.includes(extension)) {
      // A .docx is a zip by signature but a document by intent; extension wins
      // when it is one we recognise.
      return kind;
    }
  }
  if (buffer?.length) {
    for (const signature of SIGNATURES) {
      if (signature.bytes.every((byte, index) => buffer[index] === byte)) return signature.kind;
    }
    // No signature and mostly printable: treat it as text.
    if (looksLikeText(buffer)) return "text";
  }
  return "unknown";
}

/** Printable-ratio heuristic. A binary blob has control bytes and NULs. */
function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length === 0) return false;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128) printable += 1;
  }
  return printable / sample.length > 0.9;
}

/* ── Capability probe ─────────────────────────────────────────────────────── */

let capabilityCache = null;

/**
 * Where a tool is, or null.
 *
 * `withBinPaths()` rather than the bare environment: a Finder-launched app
 * inherits launchd's PATH, so without it every capability below reported
 * missing on a packaged macOS build with Homebrew's ffmpeg installed. And
 * `lookupCommand` rather than spawning `which`, which does not exist on
 * Windows — where this therefore answered "nothing installed" for all of them.
 */
function which(binary) {
  return lookupCommand(binary, withBinPaths());
}

async function hasPython(module) {
  try {
    await run("python3", ["-c", `import ${module}`], { timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

/** What this machine can actually do with a file. Never throws. */
export async function fileCapabilities({ force = false } = {}) {
  if (capabilityCache && !force) return capabilityCache;

  const [ffmpeg, ffprobe, textutil, sips, tesseract, unzip, fileCmd, pymupdf] = await Promise.all([
    which("ffmpeg"), which("ffprobe"), which("textutil"), which("sips"),
    which("tesseract"), which("unzip"), which("file"), hasPython("fitz"),
  ]);

  capabilityCache = {
    audio: Boolean(ffmpeg),
    video: Boolean(ffmpeg && ffprobe),
    pdf: pymupdf,
    pdfOcr: pymupdf && Boolean(tesseract),
    document: Boolean(textutil),
    image: true,
    imageResize: Boolean(sips),
    ocr: Boolean(tesseract),
    archive: Boolean(unzip),
    identify: Boolean(fileCmd),
    tools: { ffmpeg, ffprobe, textutil, sips, tesseract, unzip, file: fileCmd, pymupdf },
  };
  return capabilityCache;
}

/* ── Ingestion ────────────────────────────────────────────────────────────── */

function clamp(text) {
  const value = String(text ?? "");
  if (value.length <= MAX_EXTRACTED_CHARS) return { text: value, truncated: false };
  return { text: `${value.slice(0, MAX_EXTRACTED_CHARS)}\n\n… truncated`, truncated: true };
}

/**
 * Process one file. Always resolves: an unprocessable file returns a
 * description of itself, which is more useful to a model than an error.
 */
export async function ingestFile(buffer, name, { mimeType = null } = {}) {
  const kind = detectKind(name, buffer);
  const capabilities = await fileCapabilities();
  const base = { name, bytes: buffer.length, kind, mimeType };

  const directory = await mkdtemp(path.join(os.tmpdir(), "teminali-file-"));
  const filePath = path.join(directory, sanitise(name));

  try {
    await writeFile(filePath, buffer);

    switch (kind) {
      case "text":
      case "code":
        return { ...base, tool: "utf8", ...clamp(buffer.toString("utf8")) };

      case "data":
        return { ...base, ...(await ingestData(buffer, name)) };

      case "image":
        return { ...base, ...(await ingestImage(filePath, buffer, capabilities)) };

      case "audio":
        return { ...base, ...(await ingestAudio(filePath, capabilities)) };

      case "video":
        return { ...base, ...(await ingestVideo(filePath, directory, capabilities)) };

      case "pdf":
        return { ...base, ...(await ingestPdf(filePath, directory, capabilities)) };

      case "document":
        return { ...base, ...(await ingestDocument(filePath, capabilities)) };

      case "archive":
        return { ...base, ...(await ingestArchive(filePath, capabilities)) };

      default:
        return { ...base, ...(await describeUnknown(filePath, buffer, capabilities)) };
    }
  } catch (error) {
    return {
      ...base,
      tool: null,
      text: "",
      detail: `Could not process this file: ${String(error?.message ?? error).split("\n")[0]}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sanitise(name) {
  return String(name).replace(/[/\\]/g, "_").slice(-120) || "file";
}

/* ── Per-kind processors ──────────────────────────────────────────────────── */

async function ingestData(buffer, name) {
  const extension = String(name).split(".").pop()?.toLowerCase();
  const raw = buffer.toString("utf8");

  if (extension === "json" || extension === "ndjson") {
    try {
      const parsed = JSON.parse(raw);
      // Shape first: a model reasons better about "an array of 5,000 objects
      // with these keys" than about the first 200 of them.
      const shape = describeShape(parsed);
      const sample = JSON.stringify(Array.isArray(parsed) ? parsed.slice(0, 5) : parsed, null, 2);
      return { tool: "json", ...clamp(`Structure: ${shape}\n\nSample:\n${sample}`) };
    } catch {
      return { tool: "utf8", ...clamp(raw) };
    }
  }

  if (extension === "csv" || extension === "tsv") {
    const delimiter = extension === "tsv" ? "\t" : ",";
    const lines = raw.split("\n").filter((line) => line.trim());
    const header = lines[0]?.split(delimiter).map((column) => column.trim()) ?? [];
    const preview = lines.slice(0, 25).join("\n");
    return {
      tool: "csv",
      meta: { rows: Math.max(0, lines.length - 1), columns: header.length, header },
      ...clamp(`${header.length} columns, ${Math.max(0, lines.length - 1)} rows.\nColumns: ${header.join(", ")}\n\nFirst rows:\n${preview}`),
    };
  }

  return { tool: "utf8", ...clamp(raw) };
}

function describeShape(value, depth = 0) {
  if (depth > 3) return "…";
  if (Array.isArray(value)) {
    return `array of ${value.length}${value.length ? ` × ${describeShape(value[0], depth + 1)}` : ""}`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return `object { ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""} }`;
  }
  return typeof value;
}

async function ingestImage(filePath, buffer, capabilities) {
  let outputBuffer = buffer;
  let resized = false;

  if (capabilities.imageResize) {
    try {
      const resizedPath = `${filePath}.resized.png`;
      await run("sips", ["-Z", String(MAX_IMAGE_EDGE), "-s", "format", "png", filePath, "--out", resizedPath], {
        timeout: 20_000,
      });
      outputBuffer = await readFile(resizedPath);
      resized = true;
      await rm(resizedPath, { force: true }).catch(() => undefined);
    } catch {
      // Keep the original; a vision model can usually still read it.
    }
  }

  // Pull any text out too. A screenshot of an error message is far more useful
  // as text than as pixels, and the model gets both.
  let ocr = "";
  if (capabilities.ocr) {
    try {
      const { stdout } = await run("tesseract", [filePath, "stdout", "--psm", "3"], {
        timeout: 30_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
      });
      ocr = stdout.trim();
    } catch {
      /* OCR is a bonus, never a requirement. */
    }
  }

  return {
    tool: resized ? "sips + tesseract" : "tesseract",
    dataUrl: `data:image/png;base64,${outputBuffer.toString("base64")}`,
    needsVisionModel: true,
    ...clamp(ocr ? `Text found in the image:\n${ocr}` : ""),
    detail: ocr ? null : "No text was found in this image; it will be read by the vision model.",
  };
}

async function ingestAudio(filePath, capabilities) {
  if (!capabilities.audio) {
    return { tool: null, text: "", detail: "ffmpeg is required to read audio. `brew install ffmpeg`." };
  }
  // transcribeLocal handles the resample and the whisper invocation, so audio
  // attachments and voice dictation cannot drift apart.
  const buffer = await readFile(filePath);
  const result = await transcribeLocal(buffer, { language: "auto" });
  return {
    tool: "whisper.cpp",
    meta: { language: result.language, model: result.model },
    ...clamp(result.text ? `Transcript:\n${result.text}` : ""),
    detail: result.text ? null : "No speech was detected in this audio.",
  };
}

async function ingestVideo(filePath, directory, capabilities) {
  if (!capabilities.video) {
    return { tool: null, text: "", detail: "ffmpeg is required to read video." };
  }

  let meta = null;
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: 20_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    meta = {
      durationSeconds: Number(probe.format?.duration) || null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      codec: video?.codec_name ?? null,
      hasAudio: Boolean(probe.streams?.some((stream) => stream.codec_type === "audio")),
    };
  } catch {
    /* Metadata is useful but not required. */
  }

  // The soundtrack usually carries the meaning; the frames carry the context.
  let transcript = "";
  if (meta?.hasAudio !== false) {
    try {
      const audioPath = path.join(directory, "audio.wav");
      await run("ffmpeg", ["-y", "-i", filePath, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", audioPath], {
        timeout: 120_000,
      });
      const result = await transcribeLocal(await readFile(audioPath), { language: "auto" });
      transcript = result.text ?? "";
    } catch {
      /* Silent or undecodable audio. */
    }
  }

  const frames = [];
  try {
    const duration = meta?.durationSeconds ?? 0;
    for (let index = 0; index < VIDEO_FRAMES; index += 1) {
      // Sample across the middle of the clip, avoiding black lead-in frames.
      const at = duration > 2 ? (duration * (index + 1)) / (VIDEO_FRAMES + 1) : 0;
      const framePath = path.join(directory, `frame-${index}.png`);
      await run("ffmpeg", ["-y", "-ss", String(at.toFixed(2)), "-i", filePath, "-frames:v", "1",
        "-vf", `scale='min(${MAX_IMAGE_EDGE},iw)':-1`, framePath], { timeout: 30_000 });
      frames.push(`data:image/png;base64,${(await readFile(framePath)).toString("base64")}`);
    }
  } catch {
    /* Frames are a bonus. */
  }

  const summary = [
    meta?.durationSeconds ? `Duration ${meta.durationSeconds.toFixed(1)}s` : null,
    meta?.width ? `${meta.width}×${meta.height}` : null,
    meta?.codec,
  ].filter(Boolean).join(" · ");

  return {
    tool: "ffmpeg + whisper.cpp",
    meta,
    frames,
    needsVisionModel: frames.length > 0,
    ...clamp([summary, transcript ? `Transcript:\n${transcript}` : "No speech detected."].filter(Boolean).join("\n\n")),
  };
}

async function ingestPdf(filePath, directory, capabilities) {
  if (!capabilities.pdf) {
    return { tool: null, text: "", detail: "PyMuPDF is required to read PDFs. `pip install pymupdf`." };
  }

  // Extract embedded text first. It is exact, instant, and preserves reading
  // order — everything OCR is not.
  const script = `
import sys, json, fitz
doc = fitz.open(sys.argv[1])
pages = [page.get_text() for page in doc]
print(json.dumps({
  "pageCount": doc.page_count,
  "text": "\\n\\n".join(f"--- page {i+1} ---\\n{t}" for i, t in enumerate(pages) if t.strip()),
  "chars": sum(len(t.strip()) for t in pages),
  "title": (doc.metadata or {}).get("title") or None,
}))
`;
  let extracted;
  try {
    const { stdout } = await run("python3", ["-c", script, filePath], {
      timeout: 60_000, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    extracted = JSON.parse(stdout);
  } catch (error) {
    return { tool: "pymupdf", text: "", detail: `The PDF could not be read: ${String(error?.message ?? error).split("\n")[0]}` };
  }

  // Almost no text across many pages means a scan, not an empty document.
  const scanned = extracted.chars < Math.max(80, extracted.pageCount * 40);
  if (!scanned) {
    return {
      tool: "pymupdf",
      meta: { pageCount: extracted.pageCount, title: extracted.title },
      ...clamp(extracted.text),
    };
  }

  if (!capabilities.pdfOcr) {
    return {
      tool: "pymupdf",
      meta: { pageCount: extracted.pageCount },
      text: "",
      detail: "This PDF holds no selectable text — it is a scan. Install tesseract to read it.",
    };
  }

  const renderScript = `
import sys, fitz
doc = fitz.open(sys.argv[1])
for i, page in enumerate(doc[:20]):
    page.get_pixmap(dpi=200).save(f"{sys.argv[2]}/page-{i:03d}.png")
`;
  try {
    await run("python3", ["-c", renderScript, filePath, directory], { timeout: 120_000 });
    const pages = (await readdir(directory)).filter((entry) => entry.startsWith("page-")).sort();
    const texts = [];
    for (const page of pages) {
      const { stdout } = await run("tesseract", [path.join(directory, page), "stdout", "--psm", "3"], {
        timeout: 40_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
      });
      texts.push(`--- page ${texts.length + 1} ---\n${stdout.trim()}`);
    }
    return {
      tool: "pymupdf + tesseract (OCR)",
      meta: { pageCount: extracted.pageCount, ocr: true, pagesRead: texts.length },
      ...clamp(texts.join("\n\n")),
      detail: extracted.pageCount > 20 ? "Only the first 20 pages were read." : null,
    };
  } catch (error) {
    return { tool: "pymupdf", text: "", detail: `OCR failed: ${String(error?.message ?? error).split("\n")[0]}` };
  }
}

async function ingestDocument(filePath, capabilities) {
  if (!capabilities.document) {
    return { tool: null, text: "", detail: "textutil is required to read documents." };
  }
  try {
    const { stdout } = await run("textutil", ["-convert", "txt", "-stdout", filePath], {
      timeout: 30_000, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    return { tool: "textutil", ...clamp(stdout) };
  } catch (error) {
    return { tool: "textutil", text: "", detail: `Could not convert: ${String(error?.message ?? error).split("\n")[0]}` };
  }
}

async function ingestArchive(filePath, capabilities) {
  if (!capabilities.archive || !filePath.endsWith(".zip")) {
    return { tool: null, text: "", detail: "Only .zip archives can be listed." };
  }
  try {
    const { stdout } = await run("unzip", ["-l", filePath], {
      timeout: 20_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    });
    // The listing *is* the content: what a model needs from an archive is what
    // is inside it, not the bytes.
    return { tool: "unzip", ...clamp(`Archive contents:\n${stdout}`) };
  } catch (error) {
    return { tool: "unzip", text: "", detail: String(error?.message ?? error).split("\n")[0] };
  }
}

async function describeUnknown(filePath, buffer, capabilities) {
  let described = null;
  if (capabilities.identify) {
    try {
      const { stdout } = await run("file", ["-b", filePath], { timeout: 8000, encoding: "utf8" });
      described = stdout.trim();
    } catch {
      /* Nothing more to say. */
    }
  }
  if (looksLikeText(buffer)) {
    return { tool: "utf8", ...clamp(buffer.toString("utf8")), detail: described };
  }
  return {
    tool: capabilities.identify ? "file" : null,
    text: "",
    detail: described
      ? `Binary file: ${described}. Its contents cannot be read as text.`
      : "This file type cannot be read.",
  };
}

/* ── Multipart ────────────────────────────────────────────────────────────── */

/**
 * Pull the single file part out of a multipart body.
 *
 * The client uploads one file per request — that keeps per-file progress and
 * per-file failure honest, and means this only ever has to find one part rather
 * than pulling in a full parser for a job that is a boundary search.
 */
export function extractFilePart(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  if (!boundaryMatch) return { buffer: body, filename: "file" };
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);

  let cursor = body.indexOf(boundary);
  while (cursor !== -1) {
    const headerStart = cursor + boundary.length;
    const headerEnd = body.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1) break;

    const headers = body.subarray(headerStart, headerEnd).toString("latin1");
    const next = body.indexOf(boundary, headerEnd);
    if (next === -1) break;

    if (/name="file"/i.test(headers)) {
      const nameMatch = /filename\*?=(?:UTF-8'')?"?([^";\r\n]+)"?/i.exec(headers);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
      return {
        // The trailing CRLF belongs to the delimiter, not the file.
        buffer: body.subarray(headerEnd + 4, next - 2),
        filename: nameMatch ? decodeURIComponent(nameMatch[1]) : "file",
        mimeType: typeMatch ? typeMatch[1].trim() : null,
      };
    }
    cursor = next;
  }
  return { buffer: body, filename: "file", mimeType: null };
}
