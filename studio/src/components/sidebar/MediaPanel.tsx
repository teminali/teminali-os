import React, { useMemo, useState } from "react";
import { Film, Image as ImageIcon, Music, Search as SearchIcon, Trash2, Type } from "lucide-react";
import { EmptyState, IconButton, Input } from "../ui";
import { useMediaPool, useTimelineStore } from "../../video/store/timelineStore";
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
 * **Import from disk is deliberately absent.** It is the first gesture that
 * touches the operator's own filesystem, and it does not ship until the
 * approval gate designed in `src/video/P3-import-gate.md` exists to take
 * consent from it. A tab that is always mounted is exactly what that gate
 * needs, which is why this landed first.
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
      <header className="h-8 flex-shrink-0 flex items-center justify-between gap-2 pl-3.5 pr-2">
        <span className="text-sm text-ink-faint truncate">Media</span>
        <span className="font-mono text-3xs text-ink-disabled flex-shrink-0">
          {pool.length} {pool.length === 1 ? "asset" : "assets"}
        </span>
      </header>

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

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1" aria-label="Media pool">
        {visible.length === 0 && (
          <EmptyState
            title={pool.length === 0 ? "The pool is empty" : "Nothing matches"}
            detail={
              pool.length === 0
                ? "Assets the project already knows about appear here."
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
        Click an asset to place it at the playhead. Importing from disk arrives with the media
        approval gate.
      </p>
    </div>
  );
};
