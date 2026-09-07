/* ═══════════════════════════════════════════════════════════════════
   The right rail of the panel: what goes into the take.

   Two rules this rail is built around.

   **Show the camera, do not describe it.** A dropdown reading
   "FaceTime HD Camera" does not tell you the lid is half closed, that
   the lamp behind you is blowing the frame out, or that the wrong
   camera is selected on a machine with three. A live preview does, and
   it costs one low-resolution stream.

   **Show the microphone too.** The single most common way a screen
   recording is ruined is a muted or wrong input, discovered after
   twenty minutes of talking. The meter is not decoration: it is the
   only thing on this rail that can prove the take will have sound.

   The preview streams are deliberately SMALL — 640x360 and whatever the
   default sample rate is. They are thrown away when recording starts
   and the real streams are opened at full resolution, so previewing
   costs nothing in the file.

   ── Four groups, not eight ───────────────────────────────────────────
   Three describe the CAPTURE and the fourth describes the EDIT the
   build makes of it. What is still missing from the Cut's rail is the
   tutorial skill and Go live: the first reads a transcript this app
   cannot produce, the second has no streaming surface here. A control
   that writes to nothing is worse than a missing one, so they come
   back with the code that honours them.
   ═══════════════════════════════════════════════════════════════════ */

import React from 'react';
import { SliderRow, ToggleRow, SegmentedControl } from '../ui/Controls';
import { previewCamera, previewMicrophone } from '../../engine/screenCapture';
import type { DeviceOption } from '../../engine/screenCapture';
import { useRecorderStore, type StickySettings } from '../../store/recorderStore';
import type { RecorderPermissions, LiveStreamService } from '../../../types/recorder';
import {
  Camera, Mic, MicOff, VideoOff, Monitor, Film, AlertTriangle,
  Broadcast, Eye, EyeOff, CheckCircle2, Loader2,
} from '../ui/icons';
import { cursorHint } from '../../engine/platformCopy';

interface Props {
  settings: StickySettings;
  cameras: DeviceOption[];
  microphones: DeviceOption[];
  permissions: RecorderPermissions | null;
  onChange: <K extends keyof StickySettings>(key: K, value: StickySettings[K]) => void;
  onRequestPermission: (kind: 'camera' | 'microphone' | 'screen' | 'accessibility') => void;
}

export const CaptureOptions: React.FC<Props> = ({
  settings, cameras, microphones, permissions, onChange, onRequestPermission,
}) => (
  /* Width and the dividing edge belong to whoever seats this rail — a
     column in a wide panel, a sheet in a narrow one. See `RecorderPanel`. */
  <div className="h-full overflow-y-auto">
    <Group title="Camera" icon={Camera}>
      <DeviceSelect
        value={settings.cameraDeviceId}
        options={cameras}
        emptyLabel="No camera"
        onChange={(id) => onChange('cameraDeviceId', id)}
      />
      {cameras.length === 0 && (
        <button
          type="button"
          onClick={() => onRequestPermission('camera')}
          className="w-full h-7 px-2 text-ui-xs rounded bg-spectrum-accent/15 text-spectrum-accent hover:bg-spectrum-accent/25 transition-colors font-medium flex items-center justify-center gap-1.5"
        >
          <Camera className="w-3.5 h-3.5" />
          Enable Camera
        </button>
      )}
      <CameraPreview
        deviceId={settings.cameraDeviceId}
        mirror={settings.mirrorCamera}
        onEnable={() => onRequestPermission('camera')}
      />

      {settings.cameraDeviceId && (
        <>
          <ToggleRow
            label="Mirror camera"
            checked={settings.mirrorCamera}
            onChange={(v) => onChange('mirrorCamera', v)}
            hint="Flip horizontally like a mirror"
          />
          <SegmentedControl
            value={String(settings.cameraHeight) as '720' | '1080'}
            options={[{ value: '720', label: '720p' }, { value: '1080', label: '1080p' }]}
            onChange={(v) => onChange('cameraHeight', Number(v) as 720 | 1080)}
          />
          <SegmentedControl
            value={settings.cameraCorner}
            options={[
              { value: 'bottom-right', label: 'BR', title: 'Bottom right' },
              { value: 'bottom-left', label: 'BL', title: 'Bottom left' },
              { value: 'top-right', label: 'TR', title: 'Top right' },
              { value: 'top-left', label: 'TL', title: 'Top left' },
            ]}
            onChange={(v) => onChange('cameraCorner', v)}
          />
          <SliderRow
            label="Inset size"
            value={settings.cameraSizePct}
            onChange={(v) => onChange('cameraSizePct', Math.round(v))}
            min={10}
            max={45}
            unit="%"
          />
        </>
      )}

      {permissions?.camera === 'denied' && (
        <PermissionNote
          text="Camera access is off for Teminali OS."
          action="Open settings"
          onAction={() => onRequestPermission('camera')}
        />
      )}
    </Group>

    <Group title="Sound" icon={Mic}>
      <DeviceSelect
        value={settings.micDeviceId}
        options={microphones}
        emptyLabel="No microphone"
        onChange={(id) => onChange('micDeviceId', id)}
      />
      {microphones.length === 0 && (
        <button
          type="button"
          onClick={() => onRequestPermission('microphone')}
          className="w-full h-7 px-2 text-ui-xs rounded bg-spectrum-accent/15 text-spectrum-accent hover:bg-spectrum-accent/25 transition-colors font-medium flex items-center justify-center gap-1.5"
        >
          <Mic className="w-3.5 h-3.5" />
          Enable Microphone
        </button>
      )}
      <MicMeter deviceId={settings.micDeviceId} />

      <ToggleRow
        label={permissions?.platform === 'win32' ? 'System audio' : 'System audio (Windows)'}
        checked={settings.systemAudio}
        onChange={(v) => onChange('systemAudio', v)}
        hint={permissions?.platform === 'win32' ? 'What the machine is playing' : 'Natively supported on Windows'}
      />

      {/* Not a device: the assistant's replies are made in this window and
          never reach any input, so without this a take has only your half of
          the conversation. Redundant where system audio is on, which already
          carries the speakers — the capture drops it there by itself. */}
      <ToggleRow
        label="Assistant's voice"
        checked={settings.assistantVoice}
        onChange={(v) => onChange('assistantVoice', v)}
        hint={settings.systemAudio && permissions?.platform === 'win32'
          ? 'Already inside system audio'
          : 'What the assistant says back'}
      />


      {/* Narration sits under Sound rather than under the camera it is
          recorded with, because what this decides is where the voice
          LANDS — its own audio track, or welded to the camera clip. */}
      <ToggleRow
        label="Narration on its own track"
        checked={settings.detachNarration}
        onChange={(v) => onChange('detachNarration', v)}
        hint="So cutting the camera does not cut your voice"
      />

      {permissions?.microphone === 'denied' && (
        <PermissionNote
          text="Microphone access is off for Teminali OS."
          action="Open settings"
          onAction={() => onRequestPermission('microphone')}
        />
      )}
    </Group>

    <Group title="Capture" icon={Monitor}>
      <Row label="Frame rate">
        <SegmentedControl
          value={String(settings.fps) as '30' | '60'}
          options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]}
          onChange={(v) => onChange('fps', Number(v) as 30 | 60)}
        />
      </Row>

      <Row label="Resolution">
        <SegmentedControl
          value={String(settings.maxWidth) as '0' | '2560' | '1920'}
          options={[
            { value: '0', label: 'Native', title: 'The display’s own resolution' },
            { value: '2560', label: '1440p' },
            { value: '1920', label: '1080p' },
          ]}
          onChange={(v) => onChange('maxWidth', Number(v))}
        />
      </Row>

      <Row label="Countdown">
        <SegmentedControl
          value={String(settings.countdownSec) as '0' | '3' | '5'}
          options={[
            { value: '0', label: 'None' },
            { value: '3', label: '3s' },
            { value: '5', label: '5s' },
          ]}
          onChange={(v) => onChange('countdownSec', Number(v) as 0 | 3 | 5)}
        />
      </Row>

      <ToggleRow
        label="Hide Teminali OS while recording"
        checked={settings.hideWindow}
        onChange={(v) => onChange('hideWindow', v)}
        hint="A floating bar stays, and it is kept out of the capture"
      />
    </Group>

    <Group title="Live stream" icon={Broadcast}>
      <ToggleRow
        label="Go live (YouTube, Twitch, RTMP)"
        checked={settings.liveEnabled}
        onChange={(v) => onChange('liveEnabled', v)}
        hint="Stream directly to a third-party platform"
      />

      {settings.liveEnabled && (
        <div className="space-y-3 pt-1">
          <Row label="Destination">
            <SegmentedControl
              value={settings.liveService}
              options={[
                { value: 'youtube', label: 'YouTube' },
                { value: 'twitch', label: 'Twitch' },
                { value: 'facebook', label: 'FB Live' },
                { value: 'custom', label: 'Custom' },
              ]}
              onChange={(v) => {
                const s = v as LiveStreamService;
                onChange('liveService', s);
                if (s === 'youtube') onChange('liveCustomUrl', 'rtmp://a.rtmp.youtube.com/live2');
                else if (s === 'twitch') onChange('liveCustomUrl', 'rtmp://live.twitch.tv/app');
                else if (s === 'facebook') onChange('liveCustomUrl', 'rtmps://live-api-s.facebook.com:443/rtmp/');
              }}
            />
          </Row>

          <Row label="Stream URL">
            <input
              type="text"
              value={settings.liveCustomUrl}
              onChange={(e) => onChange('liveCustomUrl', e.target.value)}
              placeholder="rtmp://a.rtmp.youtube.com/live2"
              className="pro-input w-full h-7 px-2 text-ui-xs font-mono outline-none"
            />
          </Row>

          <Row label="Stream key">
            <StreamKeyInput
              value={settings.liveStreamKey}
              onChange={(k) => onChange('liveStreamKey', k)}
              placeholder={
                settings.liveService === 'youtube'
                  ? 'Paste key from YouTube Studio'
                  : 'Paste stream key'
              }
            />
          </Row>

          <Row label="Target bitrate">
            <SegmentedControl
              value={String(settings.liveBitrateKbps) as '2500' | '4500' | '8000'}
              options={[
                { value: '2500', label: '720p · 2.5M' },
                { value: '4500', label: '1080p · 4.5M' },
                { value: '8000', label: '1440p · 8M' },
              ]}
              onChange={(v) => onChange('liveBitrateKbps', Number(v))}
            />
          </Row>

          <ToggleRow
            label="Record locally while streaming"
            checked={settings.liveSaveLocal}
            onChange={(v) => onChange('liveSaveLocal', v)}
            hint="Saves clips to disk so you can edit the take after broadcasting"
          />

          <LiveTestButton />
        </div>
      )}
    </Group>

    {/*
      The fifth group is the only one that does not describe the file
      being written. Everything above changes what is RECORDED and is
      therefore final the moment the take stops; everything here changes
      what the build makes of it, and can be turned off and the take
      rebuilt. Worth keeping visibly separate for that reason alone.
    */}
    <Group title="Auto edit" icon={Film}>
      <ToggleRow
        label="Push in on what you click"
        checked={settings.autoZoom}
        onChange={(v) => onChange('autoZoom', v)}
        hint="Reads the clicks, scrolls and keystrokes, not just the pointer"
      />
      <ToggleRow
        label="Draw the pointer"
        checked={settings.drawCursor}
        onChange={(v) => onChange('drawCursor', v)}
        hint={cursorHint(permissions?.platform)}
      />
      <ToggleRow
        label="Blur the zoom moves"
        checked={settings.motionBlur}
        onChange={(v) => onChange('motionBlur', v)}
        hint="Smoother, and slower to scrub. Off when there are no zooms"
      />
      <ToggleRow
        label="Cinematic frame"
        checked={settings.cinematic}
        onChange={(v) => onChange('cinematic', v)}
        hint="Sets the picture on a backdrop, inset and rounded, and fades it up"
      />
      <ToggleRow
        label="Click ticks and whooshes"
        checked={settings.sound}
        onChange={(v) => onChange('sound', v)}
        hint="Rendered into the take folder, on their own audio track"
      />
      <ToggleRow
        label="Mark every moment"
        checked={settings.markMoments}
        onChange={(v) => onChange('markMoments', v)}
        hint="A timeline marker wherever a zoom was placed"
      />
    </Group>
  </div>
);

/* ── Pieces ─────────────────────────────────────────────────────── */

const Group: React.FC<{ title: string; icon: React.ElementType; children: React.ReactNode }> = ({
  title, icon: Icon, children,
}) => (
  <div className="border-b border-line last:border-b-0 px-3 py-3 space-y-2">
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

const DeviceSelect: React.FC<{
  value: string | null;
  options: DeviceOption[];
  emptyLabel: string;
  onChange: (id: string | null) => void;
}> = ({ value, options, emptyLabel, onChange }) => (
  <select
    value={value ?? ''}
    onChange={(e) => onChange(e.target.value || null)}
    className="pro-input w-full h-7 px-2 text-ui-sm outline-none"
    aria-label={emptyLabel}
  >
    <option value="">{emptyLabel}</option>
    {options.map((option) => (
      <option key={option.deviceId} value={option.deviceId}>{option.label}</option>
    ))}
  </select>
);

const CameraPreview: React.FC<{
  deviceId: string | null;
  mirror?: boolean;
  onEnable?: () => void;
}> = ({
  deviceId, mirror = true, onEnable,
}) => {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!deviceId) return;
    let stream: MediaStream | null = null;
    let cancelled = false;

    void previewCamera(deviceId)
      .then((result) => {
        // The pick can change while `getUserMedia` is still resolving; a
        // stream that arrives after that has to be closed, not shown.
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

  if (!deviceId) {
    return (
      <div
        onClick={onEnable}
        role="button"
        tabIndex={0}
        className="aspect-video rounded-squircle-sm bg-spectrum-sunken border border-line
                   flex flex-col items-center justify-center gap-1 cursor-pointer
                   hover:bg-spectrum-hover transition-colors p-2 text-center"
        title="Click to enable camera"
      >
        <VideoOff className="w-5 h-5 text-spectrum-textFaint" />
        <span className="text-micro text-spectrum-textDim">Click to enable camera</span>
      </div>
    );
  }

  return (
    <div className="aspect-video rounded-squircle-sm bg-black border border-line overflow-hidden relative">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-cover transition-transform duration-200"
        style={{ transform: mirror ? 'scaleX(-1)' : 'none' }}
      />
      {error && (
        <span className="absolute inset-0 flex items-center justify-center px-3 text-center
                         text-micro text-spectrum-red bg-black/70">
          {error}
        </span>
      )}
    </div>
  );
};

/**
 * A live level, not a fake one.
 *
 * Reads the analyser's time-domain buffer and shows peak, because RMS
 * on a quiet room barely moves and the question this answers is "is
 * anything reaching the input at all".
 */
const MicMeter: React.FC<{ deviceId: string | null }> = ({ deviceId }) => {
  const [level, setLevel] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setLevel(0);
    if (!deviceId) return;

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    let cancelled = false;

    void previewMicrophone(deviceId)
      .then((result) => {
        if (cancelled) { result.getTracks().forEach((t) => t.stop()); return; }
        stream = result;
        setError(null);

        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(result).connect(analyser);

        const buffer = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buffer);
          let peak = 0;
          for (const sample of buffer) peak = Math.max(peak, Math.abs(sample - 128) / 128);
          // Decay, so the bar reads as a level rather than as a strobe.
          setLevel((previous) => Math.max(peak, previous * 0.86));
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
  }, [deviceId]);

  if (!deviceId) {
    return (
      <div className="flex items-center gap-2 h-6">
        <MicOff className="w-3.5 h-3.5 text-spectrum-textFaint flex-shrink-0" />
        <span className="text-micro text-spectrum-textFaint">The take will be silent</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 h-6">
      <Mic className="w-3.5 h-3.5 text-spectrum-textDim flex-shrink-0" />
      <div className="flex-1 h-1.5 rounded-full bg-spectrum-sunken overflow-hidden border border-line">
        <div
          className="h-full rounded-full transition-[width] duration-75"
          style={{
            width: `${Math.min(100, level * 140)}%`,
            background: level > 0.85 ? 'var(--danger)' : 'var(--accent)',
          }}
        />
      </div>
      {error && <span className="text-micro text-spectrum-red truncate max-w-[110px]">{error}</span>}
    </div>
  );
};

const PermissionNote: React.FC<{ text: string; action: string; onAction: () => void }> = ({
  text, action, onAction,
}) => (
  <div className="flex items-start gap-1.5 rounded-squircle-xs bg-spectrum-amber/10 border border-spectrum-amber/25 px-2 py-1.5">
    <AlertTriangle className="w-3 h-3 text-spectrum-amber flex-shrink-0 mt-px" />
    <div className="min-w-0 space-y-1">
      <p className="text-micro text-spectrum-textMuted leading-snug">{text}</p>
      <button onClick={onAction} className="text-micro text-spectrum-accent hover:underline">{action}</button>
    </div>
  </div>
);

const StreamKeyInput: React.FC<{
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}> = ({ value, placeholder, onChange }) => {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative flex items-center">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pro-input w-full h-7 pl-2 pr-7 text-ui-xs font-mono outline-none"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-1.5 text-spectrum-textMuted hover:text-spectrum-text transition-colors p-0.5"
        title={show ? 'Hide key' : 'Reveal key'}
        aria-label={show ? 'Hide key' : 'Reveal key'}
      >
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
};

const LiveTestButton: React.FC = () => {
  const store = useRecorderStore();
  const hasKey = Boolean(store.settings.liveStreamKey.trim());

  return (
    <div className="space-y-1 pt-1">
      <button
        type="button"
        disabled={!hasKey || store.testingConnection}
        onClick={() => void store.testLiveConnection()}
        className="pro-btn-filled w-full h-7 px-2 text-ui-xs gap-1.5 flex items-center justify-center font-medium disabled:opacity-40"
      >
        {store.testingConnection ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin text-spectrum-accent" />
            Testing RTMP handshake...
          </>
        ) : store.testConnectionResult?.ok ? (
          <>
            <CheckCircle2 className="w-3 h-3 text-spectrum-green" />
            Connection verified ✓
          </>
        ) : (
          <>
            <Broadcast className="w-3 h-3" />
            Test stream connection
          </>
        )}
      </button>
      {store.testConnectionResult && !store.testConnectionResult.ok && (
        <p className="text-micro text-spectrum-red px-1 truncate" title={store.testConnectionResult.error}>
          {store.testConnectionResult.error}
        </p>
      )}
    </div>
  );
};
