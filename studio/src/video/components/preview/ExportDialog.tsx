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
import {
  Activity,
  Check,
  Download,
  Film,
  FolderOpen,
  Loader2,
  Minimize2,
  Zap,
} from 'lucide-react';
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

const PIPELINE_STAGES = [
  { id: 'preflight', name: 'Preflight' },
  { id: 'composite', name: 'Composite' },
  { id: 'stream', name: 'Frame Stream' },
  { id: 'audio', name: 'Audio Mix' },
  { id: 'package', name: 'Package' },
];

function getActiveStage(phase: string, progress: number): number {
  if (phase === 'preparing') return 0;
  if (phase === 'rendering') {
    return progress < 45 ? 1 : 2;
  }
  if (phase === 'muxing') return 3;
  if (phase === 'encoding' || phase === 'done') return 4;
  return 1;
}

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
  const [superSpeed, setSuperSpeed] = useState(true);
  const [backgroundRender, setBackgroundRender] = useState(true);
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
    const outcome = await runExport({
      resolution,
      codec,
      hardware,
      outputPath: destination ?? undefined,
      range,
      superSpeed,
      background: backgroundRender,
    });
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
  const activeStage = getActiveStage(phase, progress);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
      {/* The scrim stops at the pane's edge. Clicking it hides the dialog and
          never cancels: an export running behind it keeps running. */}
      <button
        type="button"
        aria-label="Close export"
        onClick={close}
        className="absolute inset-0 bg-black/65 backdrop-blur-[4px] transition-opacity"
      />

      <div
        role="dialog"
        aria-modal="false"
        aria-label="Export video"
        className="relative w-[min(520px,100%)] max-h-full overflow-hidden rounded-2xl border border-white/[0.12] bg-[#0c0d0e]/95 backdrop-blur-2xl shadow-2xl flex flex-col text-white select-none animate-in fade-in zoom-in-95 duration-150"
      >
        {/* ── Apple Window Header ─────────────────────────────────────── */}
        <div className="h-11 px-3.5 flex items-center justify-between border-b border-white/[0.08] bg-white/[0.02]">
          <div className="flex items-center gap-3">
            {/* Apple window close and green minimize buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={isExporting ? cancelActiveExport : close}
                title={isExporting ? 'Cancel export' : 'Close dialog'}
                aria-label={isExporting ? 'Cancel export' : 'Close dialog'}
                className="group relative w-3 h-3 rounded-full flex items-center justify-center transition-all duration-150 hover:brightness-110 active:brightness-90 cursor-pointer shadow-sm"
                style={{
                  background: 'linear-gradient(180deg, #ff5f57 0%, #eb4d4b 100%)',
                  border: '0.5px solid rgba(0, 0, 0, 0.35)',
                }}
              >
                <svg
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity duration-100 text-[#4c0002]"
                >
                  <path
                    d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>

              <button
                type="button"
                onClick={close}
                title="Minimize to background (rendering continues at full speed)"
                aria-label="Minimize to background (rendering continues at full speed)"
                className="group relative w-3 h-3 rounded-full flex items-center justify-center transition-all duration-150 hover:brightness-110 active:brightness-90 cursor-pointer shadow-sm"
                style={{
                  background: 'linear-gradient(180deg, #28c840 0%, #20a033 100%)',
                  border: '0.5px solid rgba(0, 0, 0, 0.35)',
                }}
              >
                <svg
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity duration-100 text-[#024a0d]"
                >
                  <path
                    d="M2 5 L5 2 M5 2 L2.5 2 M5 2 L5 4.5 M10 7 L7 10 M7 10 L9.5 10 M7 10 L7 7.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <Film size={13} className="text-zinc-400" />
              <span className="panel-title font-sans text-xs font-medium text-zinc-200 tracking-wide">
                {isExporting ? 'Exporting' : finished ? 'Export finished' : 'Export video'}
              </span>
            </div>
          </div>

          {/* Right badges */}
          <div className="flex items-center gap-1.5">
            {isExporting && superSpeed && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold tracking-wider bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 uppercase">
                <Activity size={11} className="animate-pulse text-cyan-400" />
                TURBO
              </span>
            )}
            {isExporting && backgroundRender && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 uppercase">
                BG ACTIVE
              </span>
            )}
          </div>
        </div>

        {/* ── Content ─────────────────────────────────────────────────── */}
        {isExporting ? (
          <div className="p-4 flex flex-col gap-4">
            {/* 1. Complete Process Pipeline Visualizer */}
            <div className="grid grid-cols-5 gap-1.5 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06]">
              {PIPELINE_STAGES.map((st, idx) => {
                const isPast = idx < activeStage;
                const isCurrent = idx === activeStage;
                return (
                  <div
                    key={st.id}
                    className={`flex flex-col items-center py-2 px-1 rounded-lg text-center transition-all ${
                      isCurrent
                        ? 'bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 shadow-sm'
                        : isPast
                          ? 'text-zinc-400 opacity-90'
                          : 'text-zinc-600 opacity-50'
                    }`}
                  >
                    <span className="text-[9px] font-mono font-bold tracking-wider uppercase">
                      {idx + 1}. {st.name}
                    </span>
                    {isCurrent && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1 animate-pulse" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* 2. Hero Progress Section */}
            <div className="space-y-2 rounded-xl bg-white/[0.02] border border-white/[0.06] p-3.5">
              <div className="flex items-baseline justify-between">
                <div className="flex items-center gap-2 truncate text-xs text-zinc-300">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400 flex-shrink-0" />
                  <span className="truncate font-medium">{statusText || 'Rendering…'}</span>
                </div>
                <span className="font-mono text-2xl font-bold tracking-tight text-white tabular-nums">
                  {Math.round(progress)}%
                </span>
              </div>

              {/* Glowing cinematic progress track */}
              <div className="h-2 rounded-full bg-black/60 border border-white/10 overflow-hidden relative p-[1px]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 transition-all duration-150 shadow-[0_0_12px_rgba(52,211,153,0.35)]"
                  style={{ width: `${Math.max(2, Math.min(100, progress))}%` }}
                />
              </div>
            </div>

            {/* 3. Complete Telemetry Dashboard Grid */}
            <div className="grid grid-cols-3 gap-2 text-xs font-mono tabular-nums">
              <Stat label="Speed" value={telemetry ? `${telemetry.fps.toFixed(1)} fps` : '—'} highlight />
              <Stat label="Time Left" value={formatEta(telemetry?.etaMs ?? null)} />
              <Stat
                label="Frames"
                value={
                  telemetry
                    ? `${telemetry.frame.toLocaleString()} / ${telemetry.totalFrames.toLocaleString()}`
                    : `${Math.round((progress / 100) * bounds.totalFrames).toLocaleString()} / ${bounds.totalFrames.toLocaleString()}`
                }
              />
              <Stat label="Output" value={`${width}×${height}`} />
              <Stat label="Codec" value={`${codec.toUpperCase()} · ${project.fps}fps`} />
              <Stat
                label="Engine"
                value={superSpeed ? (telemetry?.lanes ? `Turbo Chk ${telemetry.lanes[0]?.chunk ?? 1}` : 'Turbo Stream') : 'Standard'}
              />
            </div>

            {/* 4. Background Rendering Notice & Footer Actions */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-3">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span className="text-[11px] leading-relaxed">
                  Export continues at full speed in the background without timer throttling.
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/[0.06]">
                <button
                  type="button"
                  onClick={close}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 transition-all cursor-pointer"
                  title="Minimize dialog and keep rendering in background"
                >
                  <Minimize2 size={12} className="text-emerald-400" />
                  Minimize to Background
                </button>

                <Button variant="danger" onClick={cancelActiveExport}>
                  Cancel export
                </Button>
              </div>
            </div>
          </div>
        ) : finished ? (
          <div className="p-4 flex flex-col gap-4">
            <div className="flex items-center gap-2.5 text-sm text-emerald-300 font-medium">
              <Check className="w-4 h-4 flex-shrink-0 text-emerald-400" />
              <span>Export finished</span>
            </div>

            {/* The whole path, wrapped rather than truncated. Somebody who
                has to find this file by hand needs the directory, and an
                ellipsis eats exactly that half. */}
            <div
              className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-3 text-xs font-mono tabular-nums text-zinc-300 break-all leading-relaxed"
              title={finished}
            >
              {finished}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/[0.06]">
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
          <div className="p-4 flex flex-col gap-3.5">
            {!canExport() && (
              <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
                Export needs the desktop app. A browser cannot write video files.
              </p>
            )}

            {/* Presets */}
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

            {/* Turbo Render & Background Rendering Controls */}
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono font-semibold tracking-wider ${
                      superSpeed
                        ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                        : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                    }`}
                  >
                    <Zap size={10} className={superSpeed ? 'text-cyan-400 fill-current' : 'text-zinc-500'} />
                    TURBO
                  </span>
                  <span className="text-xs font-medium text-zinc-200 truncate">
                    Turbo Rendering
                  </span>
                </div>
                <label className="flex items-center gap-1.5 text-xs font-medium cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={superSpeed}
                    onChange={(e) => setSuperSpeed(e.target.checked)}
                    className="accent-cyan-500 cursor-pointer"
                  />
                  <span className={superSpeed ? 'text-cyan-400' : 'text-zinc-500'}>
                    {superSpeed ? 'On' : 'Off'}
                  </span>
                </label>
              </div>

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/[0.06]">
                <span className="text-xs text-zinc-400">
                  Keep rendering in background
                </span>
                <label className="flex items-center gap-1.5 text-xs font-medium cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={backgroundRender}
                    onChange={(e) => setBackgroundRender(e.target.checked)}
                    className="accent-emerald-500 cursor-pointer"
                  />
                  <span className={backgroundRender ? 'text-emerald-400' : 'text-zinc-500'}>
                    {backgroundRender ? 'On' : 'Off'}
                  </span>
                </label>
              </div>
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
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hardware}
                    onChange={(e) => setHardware(e.target.checked)}
                    className="accent-emerald-500"
                  />
                  Use GPU hardware acceleration
                </label>
              </Field>
            )}

            {hasRange && (
              <Field label="Range">
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useRange}
                    onChange={(e) => setUseRange(e.target.checked)}
                    className="accent-emerald-500"
                  />
                  In to out only
                </label>
              </Field>
            )}

            <Field label="Save to">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-zinc-400 truncate flex-1" title={destination ?? undefined}>
                  {destination ?? 'Your Videos folder'}
                </span>
                <Button variant="ghost" icon={FolderOpen} onClick={() => void chooseDestination()}>
                  Choose…
                </Button>
              </div>
            </Field>

            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-2.5 text-xs font-mono tabular-nums text-zinc-400">
              {width}×{height} · {project.fps} fps · {bounds.totalFrames} frames ·{' '}
              {formatTimecode(bounds.renderMs, project.fps)}
            </div>

            {lastExportPath && (
              <button
                onClick={() => revealExport(lastExportPath)}
                className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 min-w-0 cursor-pointer"
                title={lastExportPath}
              >
                <Check className="w-3.5 h-3.5 flex-shrink-0 text-emerald-400" />
                <span className="truncate">Last export · reveal</span>
              </button>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.06]">
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
          <p className="px-4 pb-4 text-xs text-rose-400 font-medium">{statusText}</p>
        )}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-xs text-zinc-400 flex-shrink-0">{label}</span>
    {children}
  </div>
);

const Stat: React.FC<{ label: string; value: string; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-2.5 py-2">
    <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">{label}</div>
    <div className={`mt-0.5 text-xs font-medium ${highlight ? 'text-emerald-400' : 'text-zinc-200'}`}>{value}</div>
  </div>
);
