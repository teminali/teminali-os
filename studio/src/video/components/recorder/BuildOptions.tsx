/* ═══════════════════════════════════════════════════════════════════
   What the build should make of the take.

   Everything in `CaptureOptions` is asked BEFORE recording and is final
   the moment the take stops — fps, devices, whether the microphone was
   even on. Everything here is asked after, on the review screen, and
   none of it touches the files: it is all arguments to
   `assembleRecording`, so a wrong answer costs a rebuild rather than a
   reshoot. That is the whole reason it is a separate surface at a
   separate moment instead of six more switches in the setup rail.
   ═══════════════════════════════════════════════════════════════════ */

import React, { useRef } from 'react';
import { useRecorderStore } from '../../store/recorderStore';
import type { Take } from '../../engine/screenCapture';
import { BACKDROPS, WALLPAPER_PRESETS } from '../../engine/cinematicLook';
import { CAMERA_SHAPES } from '../../engine/cameraChoreography';
import { ZOOM_STYLES } from '../../engine/cursorZoom';
import { CURSOR_STYLES, CursorStyleId } from '../../engine/cursorLayer';
import { ToggleRow, SegmentedControl } from '../ui/Controls';
import { Camera, Film, Image as ImageIcon, MousePointer2, Sliders, X } from '../ui/icons';

export const BuildOptions: React.FC<{ take: Take }> = ({ take }) => {
  const settings = useRecorderStore((s) => s.settings);
  /* The store's own one-key setter, which is also what persists. */
  const setSetting = useRecorderStore((s) => s.set);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* The take's own camera, not the setting. `includeCamera` is a choice
     about a file that exists; this is whether one does. */
  const hasCamera = Boolean(take.camera);
  const cameraHasAudio = Boolean(take.camera?.hasAudio);
  const showCameraDetail = hasCamera && settings.includeCamera;

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      if (dataUrl) {
        setSetting('backdropImage', dataUrl);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="rounded-squircle-sm border border-line overflow-hidden space-y-px bg-line/20">
      {/* ── Look & Backdrop ────────────────────────────────────────── */}
      <Group title="Look & Backdrop" icon={Film}>
        <Row label="Backdrop style">
          {settings.backdropImage ? (
            <div className="rounded-squircle-xs border border-spectrum-blue/50 overflow-hidden p-1.5 flex items-center gap-2 bg-spectrum-blue/5">
              <img
                src={settings.backdropImage}
                alt="Custom wallpaper"
                className="w-12 h-7 object-cover rounded border border-line flex-shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="text-micro font-medium text-spectrum-text truncate">Custom Wallpaper</p>
                <p className="text-micro text-spectrum-textMuted">Active background image</p>
              </div>
              <button
                type="button"
                onClick={() => setSetting('backdropImage', null)}
                className="p-1 text-spectrum-textMuted hover:text-spectrum-text rounded hover:bg-spectrum-bgMuted transition-colors"
                title="Remove image and return to presets"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Clean Wallpapers */}
              <div>
                <span className="text-micro text-spectrum-textDim font-medium block mb-1">Clean Wallpapers</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {WALLPAPER_PRESETS.map((wp) => (
                    <button
                      key={wp.id}
                      onClick={() => setSetting('backdropImage', wp.url)}
                      title={wp.label}
                      className="h-8 rounded-squircle-xs border border-line hover:border-spectrum-blue transition-all flex items-end justify-center relative overflow-hidden group shadow-sm"
                      style={{ background: wp.previewGradient }}
                    >
                      <span className="w-full py-0.5 bg-black/60 text-[9px] text-white text-center truncate px-0.5 opacity-90 group-hover:opacity-100 font-medium">
                        {wp.label.split(' ')[0]}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Studio Gradients */}
              <div>
                <span className="text-micro text-spectrum-textDim font-medium block mb-1">Gradients</span>
                <div className="grid grid-cols-5 gap-1">
                  {BACKDROPS.map((backdrop) => (
                    <button
                      key={backdrop.id}
                      onClick={() => {
                        setSetting('backdropImage', null);
                        setSetting('backdrop', backdrop.id);
                      }}
                      title={backdrop.label}
                      aria-label={backdrop.label}
                      aria-pressed={!settings.backdropImage && settings.backdrop === backdrop.id}
                      className={`h-6 rounded-squircle-xs border transition-all ${
                        !settings.backdropImage && settings.backdrop === backdrop.id
                          ? 'border-spectrum-blue ring-1 ring-spectrum-blue/40'
                          : 'border-line hover:border-line-strong'
                      }`}
                      style={{
                        backgroundImage: `linear-gradient(${backdrop.angle}deg, ${backdrop.from}, ${backdrop.to})`,
                      }}
                    />
                  ))}
                  <button
                    onClick={() => {
                      setSetting('backdropImage', null);
                      setSetting('backdrop', 'none');
                    }}
                    title="No backdrop. The picture fills the frame."
                    aria-pressed={!settings.backdropImage && settings.backdrop === 'none'}
                    className={`h-6 rounded-squircle-xs border text-[10px] text-spectrum-textDim transition-all ${
                      !settings.backdropImage && settings.backdrop === 'none'
                        ? 'border-spectrum-blue ring-1 ring-spectrum-blue/40 text-spectrum-text'
                        : 'border-line hover:border-line-strong'
                    }`}
                  >
                    None
                  </button>
                </div>
              </div>

              {/* Custom Image Upload */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={handleImageUpload}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-7 px-2 text-micro rounded border border-dashed border-line hover:border-spectrum-blue text-spectrum-textDim hover:text-spectrum-text transition-colors flex items-center justify-center gap-1.5"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                <span>Upload custom image...</span>
              </button>
            </div>
          )}
        </Row>

        <Row label="Pointer style">
          <SegmentedControl
            value={settings.cursorStyle ?? 'plane'}
            columns={4}
            options={CURSOR_STYLES.map((style) => ({
              value: style.id,
              label: style.label,
              title: style.hint,
            }))}
            onChange={(v) => setSetting('cursorStyle', v as CursorStyleId)}
          />
          <p className="text-micro text-spectrum-textFaint leading-snug">
            {CURSOR_STYLES.find((s) => s.id === (settings.cursorStyle ?? 'plane'))?.hint}
          </p>
        </Row>

        <Row label="Zoom motion">
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

      {/* ── Frame & Smart Options ──────────────────────────────────── */}
      <Group title="Framing & Motion" icon={Sliders}>
        <Row label="Screen margin / padding">
          <SegmentedControl
            value={String(settings.insetPct ?? 88)}
            columns={4}
            options={[
              { value: '80', label: 'Spacious', title: '80% width: relaxed margin for backdrop' },
              { value: '88', label: 'Studio', title: '88% width: standard cinematic framing' },
              { value: '94', label: 'Tight', title: '94% width: minimal margin' },
              { value: '100', label: 'Full', title: '100% width: edge to edge' },
            ]}
            onChange={(v) => setSetting('insetPct', Number(v))}
          />
        </Row>

        <Row label="Corner roundness">
          <SegmentedControl
            value={String(settings.cornerPct ?? 1.8)}
            columns={4}
            options={[
              { value: '0', label: 'Sharp', title: 'Square edges' },
              { value: '1.2', label: '12px', title: 'Subtle rounding' },
              { value: '1.8', label: '18px', title: 'Smooth modern curvature' },
              { value: '2.6', label: '26px', title: 'Deep card curvature' },
            ]}
            onChange={(v) => setSetting('cornerPct', Number(v))}
          />
        </Row>


        <ToggleRow
          label="Auto-zoom into actions"
          checked={settings.autoZoom}
          onChange={(v) => setSetting('autoZoom', v)}
          hint="Pushes the picture in smoothly when you click, scroll or type"
        />

        <ToggleRow
          label="Click & zoom sounds"
          checked={settings.sound}
          onChange={(v) => setSetting('sound', v)}
          hint="Subtle acoustic clicks on clicks and whooshes on zoom moves"
        />
      </Group>

      {/* ── Camera (Webcam) ────────────────────────────────────────── */}
      {hasCamera && (
        <Group title="Webcam" icon={Camera}>
          <ToggleRow
            label="Include webcam on timeline"
            checked={settings.includeCamera}
            onChange={(v) => setSetting('includeCamera', v)}
            hint={
              cameraHasAudio
                ? (settings.includeCamera ? 'Webcam video PiP placed on V4 · Camera' : 'Off: webcam omitted, voice narration preserved on A1')
                : (settings.includeCamera ? 'Include silent webcam video' : 'Off drops silent webcam clip')
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
        <Group title="Webcam" icon={Camera}>
          <p className="text-micro text-spectrum-textFaint leading-snug">
            No camera was recorded, so there is nothing to shape or move. The screen,
            the pointer and the backdrop are unaffected.
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
  <div className="bg-spectrum-bg border-b border-line last:border-b-0 px-2.5 py-2.5 space-y-2">
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

