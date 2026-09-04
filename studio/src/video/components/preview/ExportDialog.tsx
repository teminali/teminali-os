/* ═══════════════════════════════════════════════════════════════════
   The export dialog.

   It lives INSIDE the video pane rather than over the window, and that
   is the panel-shaped answer to a window-shaped control: a full-screen
   scrim would black out the terminal and the agent to ask a question
   about a video, and the export deliberately does not stop the rest of
   the app from being used. The scrim covers the pane it belongs to.

   Nothing here drives the render. `runExport` reports into
   `useProjectStore`, so this dialog shows an export an AGENT started
   exactly as it shows one a person started, and the Cancel button works
   on both.
   ═══════════════════════════════════════════════════════════════════ */

import React, { useEffect, useState } from 'react';

import { useProjectStore } from '../../store/projectStore';
import { useTimelineStore } from '../../store/timelineStore';
import { toast } from '../../store/uiStore';
import { canExport, runExport } from '../../engine/exportPipeline';
import {
  formatEta,
  outputDimensions,
  renderWindow,
  suggestedFileName,
  type ExportCodec,
  type ExportResolution,
} from '../../engine/exportPlan';
import { Button, Select } from '../ui/Primitives';
import { Check, Download, FolderOpen, Loader2, X } from '../ui/icons';
import { formatTimecode } from '../../utils/time';

const RESOLUTIONS: { value: ExportResolution; label: string }[] = [
  { value: '720p', label: '720p · Fast' },
  { value: '1080p', label: '1080p · Standard' },
  /* 1440p is labelled 2K because that is what every platform that accepts
     it calls it, and an operator looking for "2K" does not find "1440p". */
  { value: '1440p', label: '2K · Sharper' },
  { value: '4k', label: '4K · Maximum' },
];

const CODECS: { value: ExportCodec; label: string }[] = [
  { value: 'h264', label: 'H.264 · Universal' },
  { value: 'hevc', label: 'HEVC · Smaller' },
  { value: 'prores', label: 'ProRes · Editing' },
];

const PRESETS: { id: string; label: string; resolution: ExportResolution; codec: ExportCodec }[] = [
  { id: 'youtube', label: 'YouTube', resolution: '1080p', codec: 'h264' },
  { id: 'tiktok', label: 'TikTok / Reels', resolution: '1080p', codec: 'h264' },
  { id: 'master', label: 'Master', resolution: '4k', codec: 'prores' },
];

/* Each platform names its own file manager, and an operator looking for
   "Finder" does not recognise "folder". Read once at module load: the
   preload has run long before this bundle does. */
const REVEAL_LABEL =
  typeof window === 'undefined'
    ? 'Show in folder'
    : window.teminali?.platform === 'darwin'
      ? 'Show in Finder'
      : window.teminali?.platform === 'win32'
        ? 'Show in Explorer'
        : 'Show in folder';

/* The video project transport already owns `showItemInFolder`; an export
   is one more file on disk and does not need a channel of its own. */
const revealExport = (path: string): void => {
  void window.teminali?.videoProjects?.reveal(path);
};

export const ExportDialog: React.FC = () => {
  const isOpen = useProjectStore((s) => s.isExportModalOpen);
  const setOpen = useProjectStore((s) => s.setExportModalOpen);
  const isExporting = useProjectStore((s) => s.isExporting);
  const progress = useProjectStore((s) => s.exportProgress);
  const statusText = useProjectStore((s) => s.exportStatusText);
  const phase = useProjectStore((s) => s.exportPhase);
  const telemetry = useProjectStore((s) => s.exportTelemetry);
  const lastExportPath = useProjectStore((s) => s.lastExportPath);
  const cancelActiveExport = useProjectStore((s) => s.cancelActiveExport);
  const project = useProjectStore((s) => s.project);

  const inPointMs = useTimelineStore((s) => s.inPointMs);
  const outPointMs = useTimelineStore((s) => s.outPointMs);
  const hasRange = inPointMs != null || outPointMs != null;

  const [resolution, setResolution] = useState<ExportResolution>('1080p');
  const [codec, setCodec] = useState<ExportCodec>('h264');
  const [hardware, setHardware] = useState(true);
  const [useRange, setUseRange] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);

  /* A range that no longer exists cannot stay selected: clearing the in
     point while the toggle was on would export a window with one end. */
  useEffect(() => {
    if (!hasRange) setUseRange(false);
  }, [hasRange]);

  /*
    A finished export reports into the store, so it is shown here rather
    than dropping the operator back into the settings it was started
    from — the file's whereabouts is the one thing they now want, and
    hunting for it in a file manager is the failure this avoids.

    Driven from the store, not from `start`, so an export an AGENT ran
    lands here too, and so does one that finished while this dialog was
    hidden. Closing it dismisses the result; reopening shows settings.
  */
  const [finished, setFinished] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen) setFinished(null);
  }, [isOpen]);
  useEffect(() => {
    if (!isExporting && phase === 'done' && lastExportPath) setFinished(lastExportPath);
  }, [isExporting, phase, lastExportPath]);

  if (!isOpen) return null;

  const range = useRange
    ? {
        startMs: inPointMs ?? 0,
        durationMs: Math.max(0, (outPointMs ?? project.durationMs) - (inPointMs ?? 0)),
      }
    : undefined;
  const bounds = renderWindow(project, range);
  const { width, height } = outputDimensions(project, resolution);

  const start = async (): Promise<void> => {
    const outcome = await runExport({ resolution, codec, hardware, outputPath: destination ?? undefined, range });
    if (outcome.ok) {
      const written = outcome.outputPath;
      /* Longer than the usual 3.2s: this one is offering a button, and a
         notice that expires before it can be pressed is a taunt. */
      toast.success(
        'Export finished',
        written,
        written
          ? { ttl: 9000, action: { label: REVEAL_LABEL, onSelect: () => revealExport(written) } }
          : undefined
      );
      if (outcome.droppedAudio && outcome.droppedAudio.length > 0) {
        toast.info(
          `${outcome.droppedAudio.length} source${outcome.droppedAudio.length === 1 ? '' : 's'} left out of the mix`,
          outcome.droppedAudio.slice(0, 3).join(', ')
        );
      }
    } else if (!outcome.canceled) {
      toast.error('Export failed', outcome.error);
    }
  };

  const chooseDestination = async (): Promise<void> => {
    const chosen = await window.teminali?.exporter?.choose(suggestedFileName(project.name, codec), codec);
    if (chosen?.path) setDestination(chosen.path);
  };

  const close = (): void => setOpen(false);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
      {/* The scrim stops at the pane's edge. Clicking it hides the dialog and
          never cancels: an export running behind it keeps running. */}
      <button
        type="button"
        aria-label="Close export"
        onClick={close}
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="false"
        aria-label="Export video"
        className="relative w-[min(420px,100%)] max-h-full overflow-auto rounded-squircle-md border border-line bg-spectrum-panel shadow-pop"
      >
        <div className="h-9 px-3 flex items-center justify-between border-b border-line bg-spectrum-panelHeader">
          <span className="panel-title">
            {isExporting ? 'Exporting' : finished ? 'Export finished' : 'Export video'}
          </span>
          <button onClick={close} className="pro-btn editor-tool-btn" title="Hide" aria-label="Hide">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {isExporting ? (
          <div className="p-3 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-ui-sm">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-spectrum-accent" />
              <span className="truncate">{statusText || 'Rendering…'}</span>
            </div>

            <div className="h-1.5 rounded-full bg-spectrum-sunken overflow-hidden">
              <div
                className="h-full bg-spectrum-accent transition-[width] duration-150"
                style={{ width: `${Math.max(1, Math.min(100, progress))}%` }}
              />
            </div>

            <div className="grid grid-cols-3 gap-2 text-ui-xs font-mono tabular text-spectrum-textDim">
              <Stat label="Progress" value={`${Math.round(progress)}%`} />
              <Stat label="Speed" value={telemetry ? `${telemetry.fps.toFixed(1)} fps` : '—'} />
              <Stat label="Left" value={formatEta(telemetry?.etaMs ?? null)} />
            </div>

            {/* Hiding is not cancelling, and the two are one click apart, so
                the destructive one says what it destroys. */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-ui-xs text-spectrum-textDim">
                Hiding this leaves the export running.
              </span>
              <Button variant="danger" onClick={cancelActiveExport}>
                Cancel export
              </Button>
            </div>
          </div>
        ) : finished ? (
          <div className="p-3 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-ui-sm">
              <Check className="w-3.5 h-3.5 flex-shrink-0 text-spectrum-green" />
              <span>Export finished</span>
            </div>

            {/* The whole path, wrapped rather than truncated. Somebody who
                has to find this file by hand needs the directory, and an
                ellipsis eats exactly that half. */}
            <div
              className="rounded-squircle-sm bg-spectrum-sunken px-2.5 py-2 text-ui-xs font-mono tabular text-spectrum-textDim break-all"
              title={finished}
            >
              {finished}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button variant="ghost" onClick={() => setFinished(null)}>
                Export again
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={close}>
                  Done
                </Button>
                <Button variant="primary" icon={FolderOpen} onClick={() => revealExport(finished)}>
                  {REVEAL_LABEL}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-3 flex flex-col gap-3">
            {!canExport() && (
              <p className="text-ui-xs text-spectrum-amber">
                Export needs the desktop app. A browser cannot write video files.
              </p>
            )}

            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  variant="ghost"
                  on={resolution === preset.resolution && codec === preset.codec}
                  onClick={() => {
                    setResolution(preset.resolution);
                    setCodec(preset.codec);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <Field label="Resolution">
              <Select
                value={resolution}
                options={RESOLUTIONS}
                onChange={(v) => setResolution(v)}
                title="Resolution"
                className="w-[190px]"
              />
            </Field>

            <Field label="Codec">
              <Select
                value={codec}
                options={CODECS}
                onChange={(v) => setCodec(v)}
                title="Codec"
                className="w-[190px]"
              />
            </Field>

            {/* ProRes has no rate control to hand a hardware encoder, and no
                platform ships one ffmpeg can reach — so the switch is not
                merely ignored there, it is not offered. */}
            {codec !== 'prores' && (
              <Field label="Hardware">
                <label className="flex items-center gap-2 text-ui-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hardware}
                    onChange={(e) => setHardware(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  Use the GPU encoder when there is one
                </label>
              </Field>
            )}

            {hasRange && (
              <Field label="Range">
                <label className="flex items-center gap-2 text-ui-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useRange}
                    onChange={(e) => setUseRange(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  In to out only
                </label>
              </Field>
            )}

            <Field label="Save to">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-ui-xs text-spectrum-textDim truncate flex-1" title={destination ?? undefined}>
                  {destination ?? 'Your Videos folder'}
                </span>
                <Button variant="ghost" icon={FolderOpen} onClick={() => void chooseDestination()}>
                  Choose…
                </Button>
              </div>
            </Field>

            <div className="rounded-squircle-sm bg-spectrum-sunken px-2.5 py-2 text-ui-xs font-mono tabular text-spectrum-textDim">
              {width}×{height} · {project.fps} fps · {bounds.totalFrames} frames ·{' '}
              {formatTimecode(bounds.renderMs, project.fps)}
            </div>

            {lastExportPath && (
              <button
                onClick={() => revealExport(lastExportPath)}
                className="flex items-center gap-1.5 text-ui-xs text-spectrum-textDim hover:text-spectrum-text min-w-0"
                title={lastExportPath}
              >
                <Check className="w-3 h-3 flex-shrink-0 text-spectrum-green" />
                <span className="truncate">Last export · reveal</span>
              </button>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" icon={Download} disabled={!canExport()} onClick={() => void start()}>
                Export
              </Button>
            </div>
          </div>
        )}

        {phase === 'error' && !isExporting && statusText && (
          <p className="px-3 pb-3 text-ui-xs text-spectrum-red">{statusText}</p>
        )}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-ui-sm text-spectrum-textDim flex-shrink-0">{label}</span>
    {children}
  </div>
);

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-squircle-sm bg-spectrum-sunken px-2 py-1.5">
    <div className="text-micro uppercase tracking-[0.08em]">{label}</div>
    <div className="text-spectrum-text">{value}</div>
  </div>
);
