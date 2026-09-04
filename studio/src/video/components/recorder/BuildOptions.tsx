/* ═══════════════════════════════════════════════════════════════════
   What the build should make of the take.

   Everything in `CaptureOptions` is asked BEFORE recording and is final
   the moment the take stops — fps, devices, whether the microphone was
   even on. Everything here is asked after, on the review screen, and
   none of it touches the files: it is all arguments to
   `assembleRecording`, so a wrong answer costs a rebuild rather than a
   reshoot. That is the whole reason it is a separate surface at a
   separate moment instead of six more switches in the setup rail.

   ── Two rules this file follows ────────────────────────────────────

   **Nothing here invents a list.** The backdrops, the camera shapes and
   the zoom styles are all exported by the engine modules that honour
   them, with their own labels. A menu that keeps its own copy of the
   options is a menu that goes stale the first time a preset is added.

   **A control the take cannot honour is not drawn.** A take recorded
   without a webcam does not get four greyed-out camera switches; it
   gets no camera group at all. Greying a control says "you could have
   this", and after the recording has stopped that is not true.
   ═══════════════════════════════════════════════════════════════════ */

import React from 'react';
import { useRecorderStore } from '../../store/recorderStore';
import type { Take } from '../../engine/screenCapture';
import { BACKDROPS } from '../../engine/cinematicLook';
import { CAMERA_SHAPES } from '../../engine/cameraChoreography';
import { ZOOM_STYLES } from '../../engine/cursorZoom';
import { ToggleRow, SegmentedControl } from '../ui/Controls';
import { Camera, Film } from '../ui/icons';

export const BuildOptions: React.FC<{ take: Take }> = ({ take }) => {
  const settings = useRecorderStore((s) => s.settings);
  /* The store's own one-key setter, which is also what persists. */
  const setSetting = useRecorderStore((s) => s.set);

  /* The take's own camera, not the setting. `includeCamera` is a choice
     about a file that exists; this is whether one does. */
  const hasCamera = Boolean(take.camera);
  const cameraHasAudio = Boolean(take.camera?.hasAudio);
  const showCameraDetail = hasCamera && settings.includeCamera;

  return (
    <div className="rounded-squircle-sm border border-line overflow-hidden">
      <Group title="Look" icon={Film}>
        <Row label="Backdrop">
          {/*
            Swatches rather than a dropdown, because the thing being
            chosen is a colour and a list of nine names does not show it.
            Each chip paints the preset's own gradient at the preset's
            own angle, so what is in the picker is what lands behind the
            picture.
          */}
          <div className="grid grid-cols-3 gap-1.5">
            {BACKDROPS.map((backdrop) => (
              <button
                key={backdrop.id}
                onClick={() => setSetting('backdrop', backdrop.id)}
                title={backdrop.label}
                aria-label={backdrop.label}
                aria-pressed={settings.backdrop === backdrop.id}
                className={`h-8 rounded-squircle-xs border transition-all ${
                  settings.backdrop === backdrop.id
                    ? 'border-spectrum-blue ring-1 ring-spectrum-blue/40'
                    : 'border-line hover:border-line-strong'
                }`}
                style={{
                  backgroundImage:
                    `linear-gradient(${backdrop.angle}deg, ${backdrop.from}, ${backdrop.to})`,
                }}
              />
            ))}
            {/*
              `none` is a real `BackdropId` and deliberately not in
              `BACKDROPS` — `addBackdrop` finds no preset for it and lays
              no clip down. So it is drawn as a chip here rather than as
              a swatch, because there is no colour to show.
            */}
            <button
              onClick={() => setSetting('backdrop', 'none')}
              title="No backdrop. The picture fills the frame."
              aria-pressed={settings.backdrop === 'none'}
              className={`h-8 rounded-squircle-xs border text-micro text-spectrum-textDim
                          transition-all ${
                settings.backdrop === 'none'
                  ? 'border-spectrum-blue ring-1 ring-spectrum-blue/40 text-spectrum-text'
                  : 'border-line hover:border-line-strong'
              }`}
            >
              None
            </button>
          </div>
          <p className="text-micro text-spectrum-textFaint leading-snug">
            {settings.cinematic
              ? BACKDROPS.find((b) => b.id === settings.backdrop)?.label
                ?? 'No backdrop behind the picture'
              : 'Turn on the cinematic frame in setup to see it'}
          </p>
        </Row>

        <Row label="How the zoom moves">
          <SegmentedControl
            value={settings.zoomStyle}
            columns={2}
            options={ZOOM_STYLES.map((style) => ({
              value: style.id,
              label: style.label,
              title: style.hint,
            }))}
            onChange={(v) => setSetting('zoomStyle', v)}
          />
          <p className="text-micro text-spectrum-textFaint leading-snug">
            {ZOOM_STYLES.find((s) => s.id === settings.zoomStyle)?.hint}
          </p>
        </Row>
      </Group>

      {hasCamera && (
        <Group title="Camera" icon={Camera}>
          <ToggleRow
            label="Include the camera"
            checked={settings.includeCamera}
            onChange={(v) => setSetting('includeCamera', v)}
            hint={
              take.camera?.hasAudio && settings.detachNarration
                ? 'Off leaves the narration, which is split onto its own track'
                : 'Off drops the camera clip and the sound on it'
            }
          />

          {showCameraDetail && (
            <>
              <Row label="Shape">
                <SegmentedControl
                  value={settings.cameraShape}
                  columns={2}
                  options={CAMERA_SHAPES.map((shape) => ({
                    value: shape.id,
                    label: shape.label,
                    title: shape.hint,
                  }))}
                  onChange={(v) => setSetting('cameraShape', v)}
                />
                <p className="text-micro text-spectrum-textFaint leading-snug">
                  {CAMERA_SHAPES.find((s) => s.id === settings.cameraShape)?.hint}
                </p>
              </Row>

              <ToggleRow
                label="Move out of the pointer's way"
                checked={settings.cameraDodge}
                onChange={(v) => setSetting('cameraDodge', v)}
                hint="Crosses to the other side when you work under it"
              />

              {/*
                The takeover is gated on the camera clip carrying sound,
                because that is what tells explaining apart from having
                walked away — see `cameraChoreography.ts`. A silent
                camera finds zero stretches, so the switch is drawn
                disabled and says why rather than doing nothing quietly.
              */}
              <ToggleRow
                label="Full frame while you explain"
                checked={cameraHasAudio && settings.cameraOnExplaining}
                onChange={(v) => { if (cameraHasAudio) setSetting('cameraOnExplaining', v); }}
                hint={
                  cameraHasAudio
                    ? 'When your hands come off the machine and you keep talking'
                    : 'Needs sound on the camera clip; this take has none'
                }
              />
            </>
          )}
        </Group>
      )}

      {!hasCamera && (
        <Group title="Camera" icon={Camera}>
          <p className="text-micro text-spectrum-textFaint leading-snug">
            No camera was recorded, so there is nothing to shape, move or hand the
            frame to. The screen, the pointer and the backdrop are unaffected.
          </p>
        </Group>
      )}
    </div>
  );
};

/* ── Pieces ─────────────────────────────────────────────────────── */

const Group: React.FC<{ title: string; icon: React.ElementType; children: React.ReactNode }> = ({
  title, icon: Icon, children,
}) => (
  <div className="border-b border-line last:border-b-0 px-2.5 py-2.5 space-y-2">
    <div className="flex items-center gap-1.5">
      <Icon className="w-3 h-3 text-spectrum-textDim flex-shrink-0" />
      <span className="section-label">{title}</span>
    </div>
    {children}
  </div>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="space-y-1.5">
    <span className="prop-label">{label}</span>
    {children}
  </div>
);
