/* ═══════════════════════════════════════════════════════════════════
   The right rail: what goes into the take, and what the build makes of it.

   ── Three tabs, not one scroll of five groups ───────────────────────
   This rail used to be five stacked groups in a 288px column. Camera
   came first and carried a preview, a mirror switch, two segmented
   controls and a slider; by the time Live stream arrived it was the
   fourth heading below the fold, and Auto edit — six switches nobody
   had ever seen — was the fifth. The footer would announce "Live:
   YouTube" in red while the controls that said so were three scrolls
   away, which is how the report put it: *the live settings are too far*.

   Depth is the wrong axis for a rail this narrow. The three groups
   answer three different questions, asked at different moments:

     Capture   what the FILE will contain          settled at the take
     Live      where it is going while it happens  settled at the take
     Auto edit what the BUILD makes of the file    changeable forever

   So they are tabs. Everything is one click from everywhere, the tab
   strip carries the state that used to be invisible (a live dot, a
   count of edit steps), and the footer's chips are doors into the tab
   that owns them rather than labels for something you must go hunting
   for.

   ── Two rules the rail is still built around ────────────────────────
   **Show the microphone, do not describe it.** The single most common
   way a screen recording is ruined is a muted or wrong input,
   discovered after twenty minutes of talking. The meter is not
   decoration: it is the only thing here that can prove the take will
   have sound.

   **Show the camera where it will BE.** The preview moved out of this
   rail and onto the stage (`CaptureStage`), because a 288px thumbnail
   proves the lens works and says nothing about the thing you actually
   get wrong — which corner it lands in and how much of the frame it
   eats. One stream, one place, at the size and position of the real
   thing. What stays here is the choosing: device, mirror, resolution,
   corner and size.

   The preview streams are deliberately SMALL — 640x360 and whatever the
   default sample rate is. They are thrown away when recording starts
   and the real streams are opened at full resolution, so previewing
   costs nothing in the file.
   ═══════════════════════════════════════════════════════════════════ */

import React from 'react';
import { SliderRow, ToggleRow, SegmentedControl } from '../ui/Controls';
import { previewMicrophone } from '../../engine/screenCapture';
import type { DeviceOption } from '../../engine/screenCapture';
import { useRecorderStore, type StickySettings } from '../../store/recorderStore';
import type { RecorderPermissions, LiveStreamService } from '../../../types/recorder';
import {
  Camera, Mic, MicOff, Film, AlertTriangle,
  Broadcast, Eye, EyeOff, CheckCircle2, Loader2, Gauge, KeyRound, Globe, Info,
} from '../ui/icons';
import { cursorHint } from '../../engine/platformCopy';

export type RailTab = 'capture' | 'live' | 'edit';

/**
 * Whether a live take can start, and why not.
 *
 * Read by the rail and by the footer's start button, from here, so the
 * two can never disagree about it. It exists because the store's
 * `begin()` does not check: an armed stream with no key used to get all
 * the way to ffmpeg before failing, which spends a take to learn
 * something the dialog already knew.
 */
export function liveReadiness(settings: StickySettings): { ok: boolean; reason: string | null } {
  if (!settings.liveEnabled) return { ok: true, reason: null };
  if (!settings.liveCustomUrl.trim()) return { ok: false, reason: 'The stream needs a server URL' };
  /* A custom endpoint may carry its key in the path — the presets never
     do, and every one of them fails silently without it. */
  if (settings.liveService !== 'custom' && !settings.liveStreamKey.trim()) {
    return { ok: false, reason: 'Paste the stream key from your broadcaster' };
  }
  return { ok: true, reason: null };
}

/** How many of the build's interpretations are switched on. */
export function autoEditCount(settings: StickySettings): number {
  return [
    settings.autoZoom, settings.drawCursor, settings.motionBlur,
    settings.cinematic, settings.sound, settings.markMoments,
  ].filter(Boolean).length;
}

interface Props {
  settings: StickySettings;
  cameras: DeviceOption[];
  microphones: DeviceOption[];
  permissions: RecorderPermissions | null;
  onChange: <K extends keyof StickySettings>(key: K, value: StickySettings[K]) => void;
  onRequestPermission: (kind: 'camera' | 'microphone' | 'screen' | 'accessibility') => void;
  /** The chosen source is Teminali OS's own window. See `hideWindow` below. */
  recordingSelf: boolean;
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
}

export const CaptureOptions: React.FC<Props> = ({
  settings, cameras, microphones, permissions, onChange, onRequestPermission,
  recordingSelf, tab, onTabChange,
}) => {
  const edits = autoEditCount(settings);

  return (
    /* Width and the dividing edge belong to whoever seats this rail — a
       column in a wide panel, a sheet in a narrow one. See `RecorderPanel`. */
    <div className="h-full flex flex-col min-h-0">
      <div className="tab-strip flex-shrink-0 flex" role="tablist">
        <RailTabButton id="capture" label="Capture" tab={tab} onSelect={onTabChange} />
        <RailTabButton
          id="live"
          label="Live"
          tab={tab}
          onSelect={onTabChange}
          badge={settings.liveEnabled
            ? <span className="w-1.5 h-1.5 rounded-full bg-spectrum-red animate-pulse" aria-label="armed" />
            : null}
        />
        <RailTabButton
          id="edit"
          label="Auto edit"
          tab={tab}
          onSelect={onTabChange}
          badge={edits > 0
            ? <span className="text-micro tabular text-spectrum-textFaint">{edits}</span>
            : null}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" role="tabpanel">
        {tab === 'capture' && (
          <CaptureTab
            settings={settings}
            cameras={cameras}
            microphones={microphones}
            permissions={permissions}
            onChange={onChange}
            onRequestPermission={onRequestPermission}
            recordingSelf={recordingSelf}
          />
        )}
        {tab === 'live' && <LiveTab settings={settings} onChange={onChange} />}
        {tab === 'edit' && <AutoEditTab settings={settings} permissions={permissions} onChange={onChange} />}
      </div>
    </div>
  );
};

/* ── Capture ────────────────────────────────────────────────────── */

const CaptureTab: React.FC<Omit<Props, 'tab' | 'onTabChange'>> = ({
  settings, cameras, microphones, permissions, onChange, onRequestPermission, recordingSelf,
}) => (
  <>
    <Group title="Camera" icon={Camera} summary={settings.cameraDeviceId ? `${settings.cameraHeight}p` : 'Off'}>
      <DeviceSelect
        value={settings.cameraDeviceId}
        options={cameras}
        emptyLabel="No camera"
        onChange={(id) => onChange('cameraDeviceId', id)}
      />
      {cameras.length === 0 && (
        <EnableButton icon={Camera} label="Enable Camera" onClick={() => onRequestPermission('camera')} />
      )}

      {settings.cameraDeviceId && (
        <>
          <ToggleRow
            label="Mirror camera"
            checked={settings.mirrorCamera}
            onChange={(v) => onChange('mirrorCamera', v)}
            hint="Flip horizontally like a mirror"
          />
          <Row label="Camera resolution">
            <SegmentedControl
              value={String(settings.cameraHeight) as '720' | '1080'}
              options={[{ value: '720', label: '720p' }, { value: '1080', label: '1080p' }]}
              onChange={(v) => onChange('cameraHeight', Number(v) as 720 | 1080)}
            />
          </Row>

          {/* Four letters — BR, BL, TR, TL — asked the operator to hold a
              coordinate system in their head. A picture of the frame with
              the corner filled in does not. The same choice is on the
              stage, on the picture itself; this one is here for the
              keyboard and because a control that only exists on hover is
              a control some people never find. */}
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <span className="prop-label block">Corner</span>
              <span className="text-micro text-spectrum-textFaint leading-tight block">
                Or click a corner on the preview
              </span>
            </div>
            <CornerPicker
              value={settings.cameraCorner}
              onChange={(corner) => onChange('cameraCorner', corner)}
            />
          </div>

          <SliderRow
            label="Camera size"
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

    <Group
      title="Sound"
      icon={Mic}
      summary={settings.micDeviceId ? 'Mic on' : 'Silent'}
      summaryTone={settings.micDeviceId ? 'normal' : 'warn'}
    >
      <DeviceSelect
        value={settings.micDeviceId}
        options={microphones}
        emptyLabel="No microphone"
        onChange={(id) => onChange('micDeviceId', id)}
      />
      {microphones.length === 0 && (
        <EnableButton icon={Mic} label="Enable Microphone" onClick={() => onRequestPermission('microphone')} />
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

    <Group title="Quality" icon={Gauge} summary={`${settings.fps} fps`}>
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

      <Row label="Countdown before it starts">
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

      {/*
        Off, and unreachable, when Teminali OS IS the subject.

        Hiding the window keeps the app out of a capture of the DISPLAY.
        Point the recorder at Teminali OS's own window and the same
        switch hides what is being filmed — macOS delivers no frames for
        an ordered-out window, so the take records nothing and the file
        it wrote will not remux. Main refuses it too (`screenRecorder.cjs`),
        because a stale source list must not be able to lose a take; this
        is the half that tells the operator why.
      */}
      <ToggleRow
        label="Hide Teminali OS while recording"
        checked={settings.hideWindow && !recordingSelf}
        onChange={(v) => onChange('hideWindow', v)}
        disabled={recordingSelf}
        hint={recordingSelf
          ? 'Not while Teminali OS is what you are recording'
          : 'A floating bar stays, and it is kept out of the capture'}
      />
    </Group>
  </>
);

/* ── Live ───────────────────────────────────────────────────────── */

const SERVICES: { value: LiveStreamService; label: string; url: string; keyFrom: string }[] = [
  { value: 'youtube', label: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2', keyFrom: 'YouTube Studio → Go live' },
  { value: 'twitch', label: 'Twitch', url: 'rtmp://live.twitch.tv/app', keyFrom: 'Twitch Dashboard → Stream key' },
  { value: 'facebook', label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', keyFrom: 'Facebook Live Producer' },
  { value: 'custom', label: 'Custom RTMP', url: '', keyFrom: 'Your own server' },
];

const LiveTab: React.FC<{
  settings: StickySettings;
  onChange: Props['onChange'];
}> = ({ settings, onChange }) => {
  const service = SERVICES.find((s) => s.value === settings.liveService) ?? SERVICES[0];
  const ready = liveReadiness(settings);

  return (
    <>
      {/*
        The arm switch is a card and not a row, and it is the first thing
        on this tab, because arming it is the one decision here that
        changes what the primary button does. Everything below is
        addressing; this is the switch.
      */}
      <div className="px-3 py-3 border-b border-line">
        <label
          className={`flex items-start gap-2.5 p-2.5 rounded-squircle-sm border cursor-pointer transition-colors ${
            settings.liveEnabled
              ? 'border-spectrum-red/45 bg-spectrum-red/10'
              : 'border-line bg-spectrum-sunken/60 hover:border-line-strong'
          }`}
        >
          <Broadcast
            className={`w-4 h-4 mt-px flex-shrink-0 ${settings.liveEnabled ? 'text-spectrum-red' : 'text-spectrum-textDim'}`}
            weight={settings.liveEnabled ? 'fill' : 'regular'}
          />
          <span className="flex-1 min-w-0 space-y-0.5">
            <span className="block text-ui-sm text-spectrum-text font-medium">Broadcast this take</span>
            <span className="block text-micro text-spectrum-textFaint leading-snug">
              {settings.liveEnabled
                ? `Streaming to ${service.label} while it records`
                : 'Off. The take is recorded to disk only.'}
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.liveEnabled}
            onChange={(e) => onChange('liveEnabled', e.target.checked)}
            className="flex-shrink-0 mt-0.5"
          />
        </label>
      </div>

      {!settings.liveEnabled ? (
        <div className="px-3 py-3 space-y-2">
          <p className="text-ui-sm text-spectrum-textDim leading-relaxed">
            Teminali OS pushes the same frames it is recording to an RTMP endpoint, so the
            broadcast and the file you edit afterwards are one take rather than two.
          </p>
          <ul className="space-y-1.5 pt-1">
            {['A server URL — filled in for you on the three presets',
              'A stream key from your broadcaster',
              'Upload headroom for the bitrate you pick'].map((line) => (
              <li key={line} className="flex items-start gap-1.5 text-micro text-spectrum-textFaint leading-snug">
                <Info className="w-3 h-3 flex-shrink-0 mt-px" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <Group title="Destination" icon={Globe}>
            <div className="grid grid-cols-2 gap-1.5">
              {SERVICES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange('liveService', option.value);
                    if (option.url) onChange('liveCustomUrl', option.url);
                  }}
                  aria-pressed={settings.liveService === option.value}
                  className={`h-8 px-2 rounded-squircle-xs border text-ui-xs transition-colors truncate ${
                    settings.liveService === option.value
                      ? 'border-spectrum-accent bg-spectrum-accent/12 text-spectrum-text'
                      : 'border-line bg-spectrum-sunken/60 text-spectrum-textMuted hover:border-line-strong hover:text-spectrum-text'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Group>

          <Group title="Connection" icon={KeyRound}>
            <Row label="Server URL">
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
                placeholder="Paste stream key"
              />
              <span className="block text-micro text-spectrum-textFaint pt-1">From {service.keyFrom}</span>
            </Row>

            {/* Readiness said once, in the place the key was typed, and
                again on the start button. The button is the one that
                stops the take; this is the one that explains it. */}
            <div className={`flex items-start gap-1.5 rounded-squircle-xs px-2 py-1.5 border ${
              ready.ok
                ? 'border-spectrum-green/25 bg-spectrum-green/10'
                : 'border-spectrum-amber/25 bg-spectrum-amber/10'
            }`}>
              {ready.ok
                ? <CheckCircle2 className="w-3 h-3 text-spectrum-green flex-shrink-0 mt-px" />
                : <AlertTriangle className="w-3 h-3 text-spectrum-amber flex-shrink-0 mt-px" />}
              <span className="text-micro text-spectrum-textMuted leading-snug">
                {ready.ok ? 'Ready to broadcast.' : ready.reason}
              </span>
            </div>

            <LiveTestButton />
          </Group>

          <Group title="Bandwidth" icon={Gauge} summary={`${(settings.liveBitrateKbps / 1000).toFixed(1)} Mbps`}>
            <SegmentedControl
              value={String(settings.liveBitrateKbps) as '2500' | '4500' | '8000'}
              options={[
                { value: '2500', label: '720p · 2.5M' },
                { value: '4500', label: '1080p · 4.5M' },
                { value: '8000', label: '1440p · 8M' },
              ]}
              onChange={(v) => onChange('liveBitrateKbps', Number(v))}
              columns={1}
            />

            <ToggleRow
              label="Record locally while streaming"
              checked={settings.liveSaveLocal}
              onChange={(v) => onChange('liveSaveLocal', v)}
              hint="Saves clips to disk so you can edit the take after broadcasting"
            />
          </Group>
        </>
      )}
    </>
  );
};

/* ── Auto edit ──────────────────────────────────────────────────── */

/*
  The only tab that does not describe the file being written. Everything
  under Capture and Live is final the moment the take stops; everything
  here changes what the BUILD makes of that file, and can be turned off
  and the take rebuilt. Worth keeping visibly separate for that reason
  alone — and worth saying out loud at the top, because a switch you
  believe is destructive is a switch you leave alone.
*/
const AutoEditTab: React.FC<{
  settings: StickySettings;
  permissions: RecorderPermissions | null;
  onChange: Props['onChange'];
}> = ({ settings, permissions, onChange }) => (
  <>
    <div className="px-3 py-2.5 border-b border-line flex items-start gap-1.5">
      <Film className="w-3 h-3 text-spectrum-textDim flex-shrink-0 mt-0.5" />
      <p className="text-micro text-spectrum-textFaint leading-snug">
        Applied when the take is opened on the timeline — never to the recording itself.
        Change any of it and rebuild; the files do not move.
      </p>
    </div>

    <Group title="Interpretation" icon={Film}>
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
  </>
);

/* ── Pieces ─────────────────────────────────────────────────────── */

const RailTabButton: React.FC<{
  id: RailTab;
  label: string;
  tab: RailTab;
  onSelect: (tab: RailTab) => void;
  badge?: React.ReactNode;
}> = ({ id, label, tab, onSelect, badge }) => (
  <button
    role="tab"
    aria-selected={tab === id}
    onClick={() => onSelect(id)}
    className={`tab-item flex-1 justify-center gap-1.5 ${tab === id ? 'tab-item-active' : ''}`}
  >
    {label}
    {badge}
  </button>
);

const Group: React.FC<{
  title: string;
  icon: React.ElementType;
  summary?: string;
  summaryTone?: 'normal' | 'warn';
  children: React.ReactNode;
}> = ({ title, icon: Icon, summary, summaryTone = 'normal', children }) => (
  <div className="border-b border-line last:border-b-0 px-3 py-3 space-y-2">
    <div className="flex items-center gap-1.5">
      <Icon className="w-3 h-3 text-spectrum-textDim flex-shrink-0" />
      <span className="section-label">{title}</span>
      {summary && (
        <span
          className={`ml-auto text-micro tabular truncate ${
            summaryTone === 'warn' ? 'text-spectrum-amber' : 'text-spectrum-textFaint'
          }`}
        >
          {summary}
        </span>
      )}
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

const EnableButton: React.FC<{ icon: React.ElementType; label: string; onClick: () => void }> = ({
  icon: Icon, label, onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full h-7 px-2 text-ui-xs rounded bg-spectrum-accent/15 text-spectrum-accent hover:bg-spectrum-accent/25 transition-colors font-medium flex items-center justify-center gap-1.5"
  >
    <Icon className="w-3.5 h-3.5" />
    {label}
  </button>
);

/** The frame, with the corner filled in. See the note at its call site. */
const CornerPicker: React.FC<{
  value: StickySettings['cameraCorner'];
  onChange: (corner: StickySettings['cameraCorner']) => void;
}> = ({ value, onChange }) => {
  const corners: { value: StickySettings['cameraCorner']; label: string; box: string }[] = [
    { value: 'top-left', label: 'Top left', box: 'top-[5px] left-[5px]' },
    { value: 'top-right', label: 'Top right', box: 'top-[5px] right-[5px]' },
    { value: 'bottom-left', label: 'Bottom left', box: 'bottom-[5px] left-[5px]' },
    { value: 'bottom-right', label: 'Bottom right', box: 'bottom-[5px] right-[5px]' },
  ];

  /* 80×50 outer, 30×17 blocks on a 5px inset: an 8px channel across and a
     6px channel down. Measured rather than guessed, because at the first
     attempt (72×42) the two rows met in the middle and the widget read as
     two tall bars rather than as four corners of a frame. */
  return (
    <div
      className="relative w-[80px] h-[50px] flex-shrink-0 rounded-squircle-xs border border-line bg-spectrum-sunken"
      role="radiogroup"
      aria-label="Camera corner"
    >
      {corners.map((corner) => (
        <button
          key={corner.value}
          type="button"
          role="radio"
          aria-checked={value === corner.value}
          aria-label={corner.label}
          title={corner.label}
          onClick={() => onChange(corner.value)}
          className={`absolute w-[30px] h-[17px] rounded-[3px] transition-colors ${corner.box} ${
            value === corner.value
              ? 'bg-spectrum-accent'
              : 'bg-spectrum-control hover:bg-spectrum-hover'
          }`}
        />
      ))}
    </div>
  );
};

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
          /*
            Decay, so the bar reads as a level rather than as a strobe —
            and only committed when the bar would actually MOVE. A room is
            never silent enough for `peak` to be exactly zero, so this
            re-rendered sixty times a second for the whole time the dialog
            was open, to redraw a bar at the same width. The threshold is
            below one pixel of a 288px rail.
          */
          setLevel((previous) => {
            const next = Math.max(peak, previous * 0.86);
            return Math.abs(next - previous) < 0.004 ? previous : next;
          });
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
            Testing RTMP handshake…
          </>
        ) : store.testConnectionResult?.ok ? (
          <>
            <CheckCircle2 className="w-3 h-3 text-spectrum-green" />
            Connection verified
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
