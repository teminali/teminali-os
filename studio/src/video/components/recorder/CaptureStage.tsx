/* ═══════════════════════════════════════════════════════════════════
   The stage: what the take will look like, before it exists.

   The setup screen used to be a grid of thumbnails and a rail of
   twenty switches, and on a one-display machine two thirds of it was
   empty black. That emptiness was not just ugly — it was where the
   answer to every camera question should have been. "BR" and "24%" are
   not answers a person can picture; a bubble sitting in the corner it
   will actually sit in, at the size it will actually be, is.

   So the source is shown ONCE, large, with the camera composited over
   it exactly where the build will put it, and the corner is chosen by
   clicking the corner rather than by decoding an abbreviation.

   ── Two clocks, and only one of them is live ────────────────────────
   The camera is a real stream. The screen behind it is the last frame
   `desktopCapturer` handed us, which is a still and may be seconds
   old. That is not a defect to hide: this surface answers "what will
   the frame look like", not "what is on my screen right now", and the
   refresh control in the picker below is what re-asks the second
   question. The caption says which is which rather than letting the
   operator assume both are live.

   ── Why the box is measured rather than laid out ────────────────────
   A replaced element that must fit a box on BOTH axes while keeping
   its ratio, and whose overlay has to land on the picture and not on
   the letterbox, is the one case where CSS gives you a size you cannot
   read back. The bubble's position is a percentage of the PICTURE, so
   the picture's rectangle is computed here and everything hangs off it.
   ═══════════════════════════════════════════════════════════════════ */

import React from 'react';
import type { RecorderSource } from '../../../types/recorder';
import type { StickySettings } from '../../store/recorderStore';
import { useMeasure } from '../../hooks/useMeasure';
import { previewCamera } from '../../engine/screenCapture';
import { Monitor, AppWindow, VideoOff, CursorClick, Broadcast, Timer } from '../ui/icons';

type Corner = StickySettings['cameraCorner'];

const CORNERS: { value: Corner; label: string; box: string }[] = [
  { value: 'top-left', label: 'Top left', box: 'top-0 left-0' },
  { value: 'top-right', label: 'Top right', box: 'top-0 right-0' },
  { value: 'bottom-left', label: 'Bottom left', box: 'bottom-0 left-0' },
  { value: 'bottom-right', label: 'Bottom right', box: 'bottom-0 right-0' },
];

/** The bubble's gap from the frame edge, as a fraction of picture width. */
const MARGIN_PCT = 0.025;

interface Props {
  source: RecorderSource | null;
  settings: StickySettings;
  onChange: <K extends keyof StickySettings>(key: K, value: StickySettings[K]) => void;
  /** Jump the rail to the group that owns a thing named on this stage. */
  onReveal?: (tab: 'capture' | 'live' | 'edit') => void;
}

export const CaptureStage: React.FC<Props> = ({ source, settings, onChange, onReveal }) => {
  const [areaRef, { width, height }] = useMeasure<HTMLDivElement>();

  const ratio = source?.width && source?.height ? source.width / source.height : 16 / 9;
  /* Fit inside the measured area on whichever axis binds first. The 1px
     floor keeps the first frame — measured at 0×0 — from producing a
     NaN transform on the bubble. */
  const boxW = Math.max(1, Math.min(width || 1, (height || 1) * ratio));
  const boxH = Math.max(1, boxW / ratio);

  const bubbleW = boxW * (settings.cameraSizePct / 100);
  const bubbleH = bubbleW * (9 / 16);
  const margin = boxW * MARGIN_PCT;

  const SourceIcon = source?.kind === 'window' ? AppWindow : Monitor;
  const isDisplay = source?.kind !== 'window';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div ref={areaRef} className="flex-1 min-h-0 relative flex items-center justify-center p-4">
        {!source ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <Monitor className="w-7 h-7 text-spectrum-textDisabled" />
            <p className="text-ui-sm text-spectrum-textDim">Pick a display or a window below</p>
          </div>
        ) : (
          <div
            className="relative rounded-squircle-md overflow-hidden border border-line bg-black/60 shadow-raised"
            style={{ width: boxW, height: boxH }}
          >
            {source.thumbnail ? (
              <img src={source.thumbnail} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <SourceIcon className="w-8 h-8 text-spectrum-textDisabled" />
              </div>
            )}

            {/* What the build will do to this frame, said on the frame
                rather than three scrolls down a rail. Each chip is the
                door to the group that owns it. */}
            <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5">
              <StageChip
                icon={CursorClick}
                label={
                  !isDisplay ? 'No auto zoom on a window'
                    : settings.autoZoom ? 'Auto zoom on clicks' : 'Auto zoom off'
                }
                muted={!isDisplay || !settings.autoZoom}
                onClick={isDisplay ? () => onReveal?.('edit') : undefined}
              />
              {settings.countdownSec > 0 && (
                <StageChip icon={Timer} label={`${settings.countdownSec}s countdown`} muted onClick={() => onReveal?.('capture')} />
              )}
              {settings.liveEnabled && (
                <StageChip icon={Broadcast} label="Going live" live onClick={() => onReveal?.('live')} />
              )}
            </div>

            {/* The four places the camera can sit. Invisible until the
                stage is hovered, because this is a preview first and a
                control second — a frame permanently quartered by dashed
                boxes reads as a broken image. */}
            {settings.cameraDeviceId && (
              <div className="absolute inset-0 opacity-0 hover:opacity-100 transition-opacity duration-ds"
                   style={{ padding: margin }}>
                {CORNERS.map((corner) => (
                  <button
                    key={corner.value}
                    type="button"
                    onClick={() => onChange('cameraCorner', corner.value)}
                    title={`Put the camera ${corner.label.toLowerCase()}`}
                    aria-label={`Put the camera ${corner.label.toLowerCase()}`}
                    aria-pressed={settings.cameraCorner === corner.value}
                    className={`absolute rounded-squircle-sm border border-dashed transition-colors ${
                      settings.cameraCorner === corner.value
                        ? 'border-spectrum-accent bg-spectrum-accent/10'
                        : 'border-white/35 bg-black/30 hover:border-white/70 hover:bg-black/50'
                    } ${corner.box}`}
                    style={{ width: bubbleW, height: bubbleH }}
                  />
                ))}
              </div>
            )}

            <CameraBubble
              deviceId={settings.cameraDeviceId}
              mirror={settings.mirrorCamera}
              corner={settings.cameraCorner}
              width={bubbleW}
              height={bubbleH}
              margin={margin}
            />
          </div>
        )}
      </div>

      {source && (
        <div className="flex-shrink-0 px-4 pb-1 flex items-center gap-2 min-w-0">
          <SourceIcon className="w-3.5 h-3.5 flex-shrink-0 text-spectrum-textFaint" />
          <span className="text-ui-sm text-spectrum-text truncate">{source.name}</span>
          {source.width !== null && source.height !== null && (
            <span className="text-micro font-mono text-spectrum-textFaint tabular flex-shrink-0">
              {source.width}×{source.height}{source.primary ? ' · main' : ''}
            </span>
          )}
          <span className="ml-auto text-micro text-spectrum-textFaint flex-shrink-0">
            {settings.cameraDeviceId
              ? 'Layout preview · the camera is live, the screen is a still'
              : 'Layout preview · the screen is a still'}
          </span>
        </div>
      )}
    </div>
  );
};

const StageChip: React.FC<{
  icon: React.ElementType;
  label: string;
  muted?: boolean;
  live?: boolean;
  onClick?: () => void;
}> = ({ icon: Icon, label, muted, live, onClick }) => {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`flex items-center gap-1 h-5 px-1.5 rounded-squircle-xs backdrop-blur-sm border text-micro
                  transition-colors ${onClick ? 'cursor-pointer' : ''} ${
        live
          ? 'bg-spectrum-red/85 border-spectrum-red text-white'
          : muted
            ? 'bg-black/55 border-white/10 text-white/60 hover:text-white/90'
            : 'bg-black/55 border-white/15 text-white/90'
      }`}
    >
      <Icon className="w-3 h-3 flex-shrink-0" weight={live ? 'fill' : 'regular'} />
      {label}
    </Tag>
  );
};

/**
 * The camera, where it will actually be.
 *
 * One stream, opened here and nowhere else. The rail used to run its
 * own copy of this preview; two `getUserMedia` calls on one device is a
 * second camera light and a second decode for the same picture, and
 * the rail is the wrong place to judge framing anyway — it is 288px
 * wide and says nothing about where the bubble lands.
 */
const CameraBubble: React.FC<{
  deviceId: string | null;
  mirror: boolean;
  corner: Corner;
  width: number;
  height: number;
  margin: number;
}> = ({ deviceId, mirror, corner, width, height, margin }) => {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!deviceId) return;
    let stream: MediaStream | null = null;
    let cancelled = false;

    void previewCamera(deviceId)
      .then((result) => {
        /* The pick can change while `getUserMedia` is still resolving;
           a stream that arrives after that is closed, not shown. */
        if (cancelled) { result.getTracks().forEach((t) => t.stop()); return; }
        stream = result;
        setError(null);
        if (videoRef.current) videoRef.current.srcObject = result;
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [deviceId]);

  if (!deviceId) return null;

  const position: React.CSSProperties = {
    width,
    height,
    ...(corner.startsWith('top') ? { top: margin } : { bottom: margin }),
    ...(corner.endsWith('left') ? { left: margin } : { right: margin }),
  };

  return (
    <div
      className="absolute rounded-squircle-sm overflow-hidden bg-black border border-white/20 shadow-raised
                 pointer-events-none transition-all duration-ds"
      style={position}
    >
      {error ? (
        <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-micro text-spectrum-red bg-black/80">
          <VideoOff className="w-3.5 h-3.5" />
        </span>
      ) : (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
          style={{ transform: mirror ? 'scaleX(-1)' : 'none' }}
        />
      )}
    </div>
  );
};
