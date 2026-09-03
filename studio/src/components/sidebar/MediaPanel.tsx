import React, { useMemo, useRef, useState } from "react";
import { Film, Image as ImageIcon, Music, Plus, Search as SearchIcon, Trash2, Type } from "lucide-react";
import { EmptyState, IconButton, Input } from "../ui";
import { useMediaPool, useTimelineStore } from "../../video/store/timelineStore";
import { importMediaFromPath } from "../../video/mcp/toolRegistry";
import { mediaConsentGate } from "../../services/mediaConsent";
import type { MediaAsset } from "../../video/types/edl";

/**
 * The media pool, as a sidebar tab.
 *
 * This is the shell's own surface, not a port of the Cut's `MediaPanel` — the
 * Cut's version is a rail panel with grid/list modes, a drop target and a file
 * input, and it reaches for `File.path`, which no longer exists in either
 * Electron. What is shared is the store underneath: `mediaPool` lives in
 * `src/video/store/timelineStore.ts` and is complete, so this reads real
 * project state rather than a fixture of its own.
 *
 * It lives in `components/sidebar/` rather than in `src/video/` on purpose.
 * Everything under `src/video/` is a byte-for-byte lift from the Cut so the two
 * apps can be diffed for months; a file that only Code has would quietly end
 * that property. See `src/video/README.md`.
 *
 * **Import from disk is the gate's source of consent, not just a convenience.**
 * A file the operator picked or dropped is a real human gesture, so it grants
 * that file *and its containing folder* for the session — the folder you took
 * one clip out of is the folder the rest of the shoot is in. That is why the
 * import gesture and the approval gate had to arrive together, and why this
 * tab is always mounted: `VideoPane` is not, and a consent surface that
 * depends on which workspace panel is open is not a consent surface. See
 * `src/video/P3-import-gate.md` and `services/mediaConsent.ts`.
 */

/** `m:ss`, which is how the timeline and the inspector both say it. */
function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const AssetGlyph: React.FC<{ type: MediaAsset["type"] }> = ({ type }) => {
  const props = { size: 13, strokeWidth: 1.7, className: "text-ink-muted flex-shrink-0" } as const;
  if (type === "audio") return <Music {...props} />;
  if (type === "image") return <ImageIcon {...props} />;
  if (type === "text") return <Type {...props} />;
  return <Film {...props} />;
};

export const MediaPanel: React.FC = () => {
  const pool = useMediaPool();
  const insertClip = useTimelineStore((state) => state.insertClip);
  const removeMediaAsset = useTimelineStore((state) => state.removeMediaAsset);
  const [filter, setFilter] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Bring in files the operator chose themselves.
   *
   * `webUtils.getPathForFile` (exposed through preload) is the only way to an
   * absolute path now that `File.path` is gone from Electron — and an absolute
   * path is exactly what a grant is made of. The old fallback,
   * `URL.createObjectURL(file)`, previews and then dies on reload, and ffmpeg
   * and export cannot read a blob, so a file with no path is refused with the
   * reason rather than imported as something that half works.
   */
  const bring = async (files: FileList | null) => {
    const media = (window.teminali as unknown as {
      media?: { getPathForFile?: (file: File) => string | null };
    } | undefined)?.media;

    if (!files || files.length === 0) return;
    if (!media?.getPathForFile) {
      setImportError("Importing from disk needs the desktop app.");
      return;
    }

    const failed: string[] = [];
    for (const file of Array.from(files)) {
      const path = media.getPathForFile(file);
      if (!path) {
        failed.push(file.name);
        continue;
      }
      // The gesture, before the read: granting first is what makes this the
      // same code path as the agent's without prompting the operator about a
      // file they just handed us.
      mediaConsentGate().grantRoot(path, "picker");
      try {
        await importMediaFromPath(path);
      } catch (error) {
        failed.push(`${file.name} — ${(error as Error).message}`);
      }
    }
    setImportError(failed.length ? `Could not import: ${failed.join(", ")}` : null);
  };

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return pool;
    return pool.filter((asset) => asset.name.toLowerCase().includes(query));
  }, [pool, filter]);

  /**
   * The Cut's own placement rule, kept identical (`MediaPanel.tsx:112`): the
   * selected track wins, else the first track that can hold this kind of
   * media, else whatever is on top. Read through `getState` rather than
   * subscribed, so moving the playhead does not re-render the list.
   */
  const place = (asset: MediaAsset) => {
    const { tracks, selectedTrackId, playheadMs } = useTimelineStore.getState();
    if (tracks.length === 0) return;
    const fallback =
      asset.type === "audio"
        ? tracks.find((track) => track.type === "audio")?.id
        : tracks.find((track) => track.type === "video")?.id;
    insertClip(selectedTrackId ?? fallback ?? tracks[0].id, asset, playheadMs);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-8 flex-shrink-0 flex items-center justify-between gap-2 pl-3.5 pr-1.5">
        <span className="text-sm text-ink-faint truncate">Media</span>
        <span className="flex items-center gap-1 flex-shrink-0">
          <span className="font-mono text-3xs text-ink-disabled">
            {pool.length} {pool.length === 1 ? "asset" : "assets"}
          </span>
          <IconButton
            onClick={() => fileInput.current?.click()}
            title="Import media from disk"
            aria-label="Import media from disk"
            size={22}
          >
            <Plus size={13} />
          </IconButton>
        </span>
      </header>

      <input
        ref={fileInput}
        type="file"
        multiple
        // The same list the gate holds the agent to, so a human and an agent
        // reach the pool through one rule. See MEDIA_EXTENSIONS in the registry.
        accept=".mp4,.mov,.mkv,.webm,.mp3,.wav,.aac,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(event) => {
          void bring(event.target.files);
          // Reset, or picking the same file twice fires no second change.
          event.target.value = "";
        }}
      />

      <div className="px-2 pt-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter media"
          aria-label="Filter media pool"
          icon={<SearchIcon size={13} />}
          clearable
          onClear={() => setFilter("")}
        />
      </div>

      {importError && (
        <p role="alert" className="mx-2 mt-2 rounded-lg bg-danger/10 border border-danger/25 px-2.5 py-1.5 text-2xs text-danger leading-relaxed">
          {importError}
        </p>
      )}

      <div
        className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1"
        aria-label="Media pool"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void bring(event.dataTransfer.files);
        }}
      >
        {visible.length === 0 && (
          <EmptyState
            title={pool.length === 0 ? "The pool is empty" : "Nothing matches"}
            detail={
              pool.length === 0
                ? "Drop media here, or use + above. Files you bring in yourself are trusted for the session."
                : "No asset in the pool matches this filter."
            }
          />
        )}

        {visible.map((asset) => (
          <div
            key={asset.id}
            className="group relative rounded-lg bg-surface-sunken hover:bg-surface transition-colors duration-ds ease-ds"
          >
            <button
              type="button"
              onClick={() => place(asset)}
              title={`Place ${asset.name} at the playhead`}
              className="w-full text-left p-1.5 flex items-center gap-2.5"
            >
              {/* The thumbnail is the asset's own frame where it has one. The
                  glyph behind it is not a placeholder for a slow image — it is
                  what an audio asset shows, which has no frame to show. */}
              <span className="w-11 h-8 rounded-md bg-surface-skeleton flex items-center justify-center overflow-hidden flex-shrink-0">
                {asset.thumbnailUrl && asset.type !== "audio" ? (
                  <img src={asset.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <AssetGlyph type={asset.type} />
                )}
              </span>

              <span className="flex-1 min-w-0">
                <span className="block truncate text-xs text-ink-body">{asset.name}</span>
                <span className="flex items-center gap-1.5 font-mono text-3xs text-ink-disabled">
                  <AssetGlyph type={asset.type} />
                  {duration(asset.durationMs)}
                  {asset.fileSizeFormatted && asset.fileSizeFormatted !== "-" && (
                    <>· {asset.fileSizeFormatted}</>
                  )}
                </span>
              </span>
            </button>

            {/* Outside the placing button, or every removal would also drop a
                clip on the timeline on its way past. */}
            <IconButton
              onClick={() => removeMediaAsset(asset.id)}
              title={`Remove ${asset.name} from the pool`}
              aria-label={`Remove ${asset.name} from the pool`}
              size={24}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
      </div>

      <p className="flex-shrink-0 border-t border-edge-subtle px-3.5 py-2 text-2xs text-ink-disabled leading-relaxed">
        Click an asset to place it at the playhead. A file you import here is granted to the
        session, along with the folder it came from.
      </p>
    </div>
  );
};
