import { GatewayClient } from "./gatewayClient";

/**
 * Client for file ingestion.
 *
 * A file becomes useful to a model only after something converts it — audio to
 * a transcript, a PDF to text, a screenshot to both an image and its OCR. That
 * conversion happens on the gateway, where the tools live; this is the seam.
 */

export type AttachmentKind =
  | "image" | "audio" | "video" | "pdf" | "document"
  | "data" | "archive" | "code" | "text" | "unknown";

export interface IngestedFile {
  name: string;
  bytes: number;
  kind: AttachmentKind;
  mimeType: string | null;
  /** Which tool produced the output, so the operator can judge it. */
  tool: string | null;
  text: string;
  truncated?: boolean;
  /** Present for images: a downscaled data URL for the vision model. */
  dataUrl?: string;
  /** Present for video: sampled frames. */
  frames?: string[];
  needsVisionModel?: boolean;
  meta?: Record<string, unknown>;
  /** Why there is no text, when there is none. */
  detail?: string | null;
}

/** An attachment as the composer tracks it, through its whole lifecycle. */
export interface Attachment extends Partial<IngestedFile> {
  id: string;
  name: string;
  bytes: number;
  status: "reading" | "ready" | "failed";
  error?: string;
  /** Local preview, available before the server has finished. */
  previewUrl?: string;
}

export interface FileCapabilities {
  audio: boolean; video: boolean; pdf: boolean; pdfOcr: boolean;
  document: boolean; image: boolean; ocr: boolean; archive: boolean;
}

export const MAX_ATTACHMENTS = 10;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export const FileService = {
  capabilities: async (signal?: AbortSignal): Promise<FileCapabilities> => {
    const response = await GatewayClient.request("/api/files/capabilities", { method: "GET", signal });
    await GatewayClient.expectOk(response);
    return (await response.json()) as FileCapabilities;
  },

  ingest: async (file: File, signal?: AbortSignal): Promise<IngestedFile> => {
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await GatewayClient.request("/api/files/ingest", { method: "POST", body: form, signal });
    await GatewayClient.expectOk(response);
    return (await response.json()) as IngestedFile;
  },
};

/**
 * Fold ready attachments into the prompt.
 *
 * Their content is framed explicitly rather than concatenated: a model that
 * cannot tell where an attachment ends and the question begins will answer the
 * attachment. Images are passed separately, as images.
 */
export function composePrompt(text: string, attachments: Attachment[]): { prompt: string; images: string[] } {
  const ready = attachments.filter((entry) => entry.status === "ready");
  if (ready.length === 0) return { prompt: text, images: [] };

  const images: string[] = [];
  const blocks: string[] = [];

  for (const attachment of ready) {
    if (attachment.dataUrl) images.push(attachment.dataUrl);
    for (const frame of attachment.frames ?? []) images.push(frame);

    const body = (attachment.text ?? "").trim();
    const header = `${attachment.name} · ${attachment.kind}${attachment.tool ? ` · read with ${attachment.tool}` : ""}`;
    if (body) {
      blocks.push(`<<< attachment: ${header} >>>\n${body}\n<<< end attachment >>>`);
    } else if (attachment.detail) {
      blocks.push(`<<< attachment: ${header} >>>\n${attachment.detail}\n<<< end attachment >>>`);
    }
  }

  const prompt = blocks.length
    ? `${blocks.join("\n\n")}\n\n${text || "Look at the attached file(s)."}`
    : text || "Look at the attached image(s).";

  return { prompt, images };
}

export function describeKind(kind: AttachmentKind): string {
  const copy: Record<AttachmentKind, string> = {
    image: "Image", audio: "Audio", video: "Video", pdf: "PDF",
    document: "Document", data: "Data", archive: "Archive",
    code: "Code", text: "Text", unknown: "File",
  };
  return copy[kind] ?? "File";
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
