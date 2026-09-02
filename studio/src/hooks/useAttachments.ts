import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileService, MAX_ATTACHMENTS, MAX_FILE_BYTES, type Attachment,
} from "../services/fileService";

/**
 * Attachment intake: picking, dropping and pasting files.
 *
 * Three entry points converge here because they are the same operation. Paste
 * is the one worth calling out — copying a file in Finder and hitting ⌘V in the
 * chat should attach it, and so should pasting a screenshot straight from the
 * clipboard, with no trip through a file dialog.
 *
 * Files are read one request at a time rather than in parallel: a PDF OCR pass
 * and a video transcription both saturate the machine, and four at once turns a
 * slow attachment into an unresponsive app.
 */

let sequence = 0;

export interface UseAttachmentsResult {
  attachments: Attachment[];
  add: (files: FileList | File[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** True while any file is still being read. */
  busy: boolean;
  /** Bind to a container to accept drops. */
  dropProps: {
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
  };
  isDragging: boolean;
  error: string | null;
}

export function useAttachments(): UseAttachmentsResult {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const previews = useRef<string[]>([]);

  useEffect(
    () => () => {
      // Object URLs outlive the component unless revoked.
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const add = useCallback((incoming: FileList | File[]) => {
    const files = Array.from(incoming);
    if (files.length === 0) return;
    setError(null);

    setAttachments((current) => {
      const room = MAX_ATTACHMENTS - current.length;
      if (room <= 0) {
        setError(`Up to ${MAX_ATTACHMENTS} files at a time.`);
        return current;
      }

      const accepted: Attachment[] = [];
      for (const file of files.slice(0, room)) {
        if (file.size > MAX_FILE_BYTES) {
          setError(`${file.name} is larger than 100 MB.`);
          continue;
        }
        sequence += 1;
        const id = `attachment-${Date.now()}-${sequence}`;
        let previewUrl: string | undefined;
        if (file.type.startsWith("image/")) {
          previewUrl = URL.createObjectURL(file);
          previews.current.push(previewUrl);
        }
        accepted.push({ id, name: file.name, bytes: file.size, status: "reading", previewUrl });

        // Serialise the reads; see the note above on saturation.
        queue.current = queue.current.then(async () => {
          try {
            const result = await FileService.ingest(file);
            setAttachments((list) =>
              list.map((entry) => (entry.id === id ? { ...entry, ...result, status: "ready" } : entry)),
            );
          } catch (failure) {
            setAttachments((list) =>
              list.map((entry) =>
                entry.id === id
                  ? { ...entry, status: "failed", error: (failure as Error).message }
                  : entry,
              ),
            );
          }
        });
      }
      return [...current, ...accepted];
    });
  }, []);

  const remove = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((entry) => entry.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((entry) => entry.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((current) => {
      for (const entry of current) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      return [];
    });
  }, []);

  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      // Only claim the drop when it actually carries files, or dragging text
      // around the page would light up the whole composer.
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node)) return;
      setDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      setDragging(false);
      if (event.dataTransfer.files.length) add(event.dataTransfer.files);
    },
  };

  return { attachments, add, remove, clear, busy: attachments.some((a) => a.status === "reading"), dropProps, isDragging, error };
}

/**
 * Pull files out of a paste. Handles both a copied file from Finder and a raw
 * screenshot on the clipboard, which arrives as an unnamed image blob.
 */
export function filesFromClipboard(event: React.ClipboardEvent | ClipboardEvent): File[] {
  const data = event.clipboardData;
  if (!data) return [];

  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;

  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    // A pasted screenshot has no name; give it one so the chip is readable.
    fromItems.push(
      file.name && file.name !== "image.png"
        ? file
        : new File([file], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`, { type: file.type }),
    );
  }
  return fromItems;
}
