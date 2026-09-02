import React from "react";
import {
  AlertTriangle, Archive, FileCode, FileText, FileType, Image as ImageIcon,
  Loader2, Music, Sheet, Video, X,
} from "lucide-react";
import { describeKind, formatFileSize, type Attachment, type AttachmentKind } from "../../services/fileService";

/**
 * Attachments, as chips above the composer.
 *
 * Each chip says three things while the file is being read and after: what it
 * is, whether it worked, and *which tool read it*. That last part matters more
 * than it looks — "read with whisper.cpp" tells you the model is seeing a
 * transcript, and "no text found" tells you it is seeing nothing, which is the
 * difference between trusting an answer and being misled by one.
 */

const GLYPHS: Record<AttachmentKind, React.ReactNode> = {
  image: <ImageIcon size={12} />,
  audio: <Music size={12} />,
  video: <Video size={12} />,
  pdf: <FileType size={12} />,
  document: <FileText size={12} />,
  data: <Sheet size={12} />,
  archive: <Archive size={12} />,
  code: <FileCode size={12} />,
  text: <FileText size={12} />,
  unknown: <FileText size={12} />,
};

export const AttachmentStrip: React.FC<{
  attachments: Attachment[];
  onRemove?: (id: string) => void;
  compact?: boolean;
}> = ({ attachments, onRemove, compact = false }) => {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((attachment) => {
        const failed = attachment.status === "failed";
        const reading = attachment.status === "reading";
        // Say what was actually extracted, not just that a file is attached.
        const summary = failed
          ? attachment.error
          : reading
            ? "reading…"
            : attachment.text?.trim()
              ? `${attachment.tool ?? "read"} · ${attachment.text.trim().length.toLocaleString()} chars`
              : (attachment.detail ?? attachment.tool ?? describeKind(attachment.kind ?? "unknown"));

        return (
          <span
            key={attachment.id}
            title={`${attachment.name} — ${summary}`}
            className={`lit lit-inner group inline-flex items-center gap-2 rounded-lg bg-surface-chip ${
              compact ? "pl-2 pr-1 py-1" : "pl-2.5 pr-1.5 py-1.5"
            } max-w-[260px]`}
          >
            {attachment.previewUrl && attachment.kind === "image" ? (
              <img
                src={attachment.previewUrl}
                alt=""
                className="w-5 h-5 rounded object-cover flex-shrink-0"
              />
            ) : (
              <span className={`flex-shrink-0 ${failed ? "text-danger" : "text-ink-muted"}`}>
                {reading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : failed ? (
                  <AlertTriangle size={12} />
                ) : (
                  GLYPHS[attachment.kind ?? "unknown"]
                )}
              </span>
            )}

            <span className="min-w-0 flex flex-col leading-tight">
              <span className="text-2xs text-ink-high truncate max-w-[150px]">{attachment.name}</span>
              <span className={`text-3xs truncate max-w-[150px] font-mono ${failed ? "text-danger" : "text-ink-faint"}`}>
                {formatFileSize(attachment.bytes)} · {summary}
              </span>
            </span>

            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
                className="w-4 h-4 flex items-center justify-center rounded text-ink-disabled hover:text-danger transition-colors duration-ds ease-ds flex-shrink-0"
              >
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
};
