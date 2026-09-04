/* ═══════════════════════════════════════════════════════════════════
   The recorder, as a panel.

   The Cut puts this on a full-screen home surface behind a scrim; here
   it is one workspace panel among thirteen, and the difference is not
   cosmetic. **A panel opens at 452px.** The Cut's shape — a source grid
   beside a fixed 288px rail of options — needs 568px before either half
   is usable, so the rail is SEATED when the width is there and SUMMONED
   when it is not, exactly as `VideoPane` seats and summons its
   inspector. Everything stays reachable at every width; only the number
   of clicks changes.

   The phases are the store's, and each one owns the whole panel body:
   choosing a source is not a step you do while a take is running, and
   showing the grid greyed out behind a timer would only invite it.

   ── The review is a second decision, not a confirmation ─────────────
   The review does not just show the take and offer a button. It opens
   it as an INTERPRETED assemble — zooms on the real clicks, the drawn
   pointer, the cinematic frame, the camera's choreography — and the
   rail carries the arguments to that build (`BuildOptions`). They are
   asked here rather than in setup because none of them change the
   files: a wrong backdrop or a circular webcam you did not want costs
   one rebuild, where a wrong fps costs the take.
   ═══════════════════════════════════════════════════════════════════ */

import React from 'react';
import { useRecorderStore } from '../../store/recorderStore';
import { SourceGrid } from './SourceGrid';
import { CaptureOptions } from './CaptureOptions';
import { BuildOptions } from './BuildOptions';
import { formatDuration, formatFileSize } from '../../utils/time';
import {
  Record, Pause, Play, Square, Loader2, AlertTriangle, CheckCircle2, X,
  FolderOpen, CursorClick, Camera, Monitor, Mic, Trash2, Sliders, Film,
} from '../ui/icons';

/** The options rail's own width, matching the Cut's. */
const OPTIONS_W = 288;
/** Below this the grid stops being a grid and starts being a list of slivers. */
const GRID_MIN_W = 280;
/** The width at which the rail can be a column rather than a visit. */
const OPTIONS_COLUMN_MIN_W = OPTIONS_W + GRID_MIN_W;
/** The review's summary rail, which is wider — it carries prose. */
const REVIEW_RAIL_W = 320;
/** Below this the review stacks instead of splitting. */
const REVIEW_COLUMN_MIN_W = REVIEW_RAIL_W + GRID_MIN_W;

interface Props {
  /** The measured width of the surface. `RecorderModal` supplies it. */
  width?: number;
  /**
   * Show the take that was just laid down.
   *
   * A callback rather than a `panelStore` import, because everything
   * under `src/video/` is workspace-agnostic and reaching for the
   * workspace's panel list from in here would be the first exception.
   * `RecorderModal` — which is app-side already — supplies it.
   */
  onOpenedOnTimeline?: () => void;
}

export const RecorderPanel: React.FC<Props> = ({
  width = OPTIONS_COLUMN_MIN_W,
  onOpenedOnTimeline,
}) => {
  const store = useRecorderStore();
  const phase = store.phase;

  /*
    Opening is this component MOUNTING, not a menu item, so it happens
    here — and it is guarded. `open()` resets the phase to setup and
    clears the take, which is right when the recorder is being opened to
    record and catastrophic when a take is already running: a recording
    started from the File menu and then dismissed with Escape would be
    forgotten by the one surface that can stop it. So a mount that
    arrives mid-take only announces itself.

    The dialog makes that path ordinary rather than exotic: closing it
    unmounts this component, and the floating `RecorderBar` is what the
    operator stops the take from meanwhile.
  */
  React.useEffect(() => {
    const state = useRecorderStore.getState();
    if (state.phase === 'setup' && !state.take) state.open();
    else useRecorderStore.setState({ isOpen: true });
    return () => { useRecorderStore.getState().close(); };
  }, []);

  const canSeatOptions = width >= OPTIONS_COLUMN_MIN_W;
  const [optionsOpen, setOptionsOpen] = React.useState(false);

  /* Wide enough to seat the rail does not need it summoned as well. */
  React.useEffect(() => {
    if (canSeatOptions) setOptionsOpen(false);
  }, [canSeatOptions]);

  const options = (
    <CaptureOptions
      settings={store.settings}
      cameras={store.cameras}
      microphones={store.microphones}
      permissions={store.permissions}
      onChange={store.set}
      onRequestPermission={(kind) => void store.requestPermission(kind)}
    />
  );

  const overlayWidth = Math.min(OPTIONS_W, Math.max(200, width - 48));

  return (
    <>
      {phase === 'setup' && (
        <>
          <div className="flex-1 flex min-h-0 relative">
            <div className="flex-1 min-w-0">
              <SourceGrid
                sources={store.sources}
                loading={store.sourcesLoading}
                selectedId={store.selectedSourceId}
                onSelect={store.selectSource}
                onRefresh={() => void store.refreshSources()}
              />
            </div>

            {canSeatOptions ? (
              <div
                className="flex-shrink-0 min-h-0 border-l border-line"
                style={{ width: OPTIONS_W }}
              >
                {options}
              </div>
            ) : (
              optionsOpen && (
                <>
                  <div
                    className="editor-overlay-scrim"
                    onClick={() => setOptionsOpen(false)}
                    aria-hidden="true"
                  />
                  <div
                    className="editor-side-overlay is-right"
                    style={{ width: overlayWidth }}
                  >
                    {options}
                  </div>
                </>
              )
            )}
          </div>

          <SetupFooter
            canSummonOptions={!canSeatOptions}
            optionsOpen={optionsOpen}
            onToggleOptions={() => setOptionsOpen((o) => !o)}
          />
        </>
      )}

      {phase === 'countdown' && <Countdown seconds={store.countdown} />}

      {(phase === 'recording' || phase === 'paused') && <Running />}

      {phase === 'processing' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
          <Loader2 className="w-6 h-6 text-spectrum-accent animate-spin" />
          <p className="text-ui-xl text-spectrum-text">Converting the take</p>
          <p className="text-ui-sm text-spectrum-textDim max-w-[380px] text-center leading-relaxed">
            A raw capture carries no duration and no seek index, so it is remuxed before it
            can be scrubbed. Long takes take a moment.
          </p>
        </div>
      )}

      {phase === 'review' && store.take && (
        <Review stacked={width < REVIEW_COLUMN_MIN_W} onOpened={onOpenedOnTimeline} />
      )}

      {phase === 'error' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-10 text-center">
          <AlertTriangle className="w-7 h-7 text-spectrum-red" />
          <p className="text-ui-xl text-spectrum-text">The recording did not start</p>
          <p className="text-ui-sm text-spectrum-textMuted leading-relaxed max-w-[440px]">{store.error}</p>
          <button
            onClick={() => useRecorderStore.setState({ phase: 'setup', error: null })}
            className="btn-primary h-8 px-4 text-ui mt-2"
          >
            Back to setup
          </button>
        </div>
      )}
    </>
  );
};

/* ── Setup footer ───────────────────────────────────────────────── */

const SetupFooter: React.FC<{
  canSummonOptions: boolean;
  optionsOpen: boolean;
  onToggleOptions: () => void;
}> = ({ canSummonOptions, optionsOpen, onToggleOptions }) => {
  const store = useRecorderStore();
  const selected = store.sources.find((s) => s.id === store.selectedSourceId);
  const screenBlocked = store.permissions?.screen === 'denied'
    || store.permissions?.screen === 'not-determined'
    || store.permissions?.screen === 'restricted';

  return (
    <div className="flex-shrink-0 border-t border-line px-3 py-2 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {/*
          The stale grant comes FIRST, before the ordinary denied case,
          because the two need opposite advice and only one of them is
          ever true at a time. Sending somebody to System Settings when
          the switch there is already on is sending them to look at the
          thing that is not the problem.
        */}
        {store.screenGrantStale ? (
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-spectrum-amber flex-shrink-0" />
            <span
              className="text-ui-sm text-spectrum-textMuted truncate"
              title="Teminali Code's permissions need refreshing on macOS update."
            >
              Screen recording looks enabled but macOS is refusing it. Updating Teminali Code does this.
            </span>
            <button
              onClick={() => void store.repairScreenPermission()}
              className="btn-primary h-6 px-2 text-ui-xs flex-shrink-0"
            >
              Fix and restart
            </button>
          </div>
        ) : screenBlocked ? (
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-spectrum-amber flex-shrink-0" />
            <span className="text-ui-sm text-spectrum-textMuted truncate">
              macOS has not allowed Teminali Code to record the screen yet.
            </span>
            <button
              onClick={() => void store.repairScreenPermission()}
              className="pro-btn-filled h-6 px-2 text-ui-xs flex-shrink-0"
              title="Reset the macOS permission cache so macOS will ask again"
            >
              Reset permissions
            </button>
            <button
              onClick={() => void store.requestPermission('screen')}
              className="pro-btn-filled h-6 px-2 text-ui-xs flex-shrink-0"
            >
              Open settings
            </button>
          </div>
        ) : (
          <span className="flex items-center gap-3 text-ui-sm text-spectrum-textDim min-w-0">
            <span className="flex items-center gap-1.5 min-w-0">
              <Monitor className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">{selected ? selected.name : 'Nothing selected'}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Camera className="w-3.5 h-3.5" />
              {store.settings.cameraDeviceId ? 'Camera on' : 'No camera'}
            </span>
            <span className="flex items-center gap-1.5">
              <Mic className="w-3.5 h-3.5" />
              {store.settings.micDeviceId ? 'Mic on' : 'Silent'}
            </span>
          </span>
        )}
      </div>

      {/* The summon control lives here rather than in the grid's header,
          because the footer is the one strip of this phase that never
          holds anything but status and the start button. */}
      {canSummonOptions && (
        <button
          onClick={onToggleOptions}
          className={`pro-btn h-8 px-2 gap-1.5 flex-shrink-0 ${optionsOpen ? 'pro-btn-active' : ''}`}
          title={optionsOpen ? 'Hide the capture options' : 'Show the capture options'}
          aria-label={optionsOpen ? 'Hide the capture options' : 'Show the capture options'}
          aria-pressed={optionsOpen}
        >
          {optionsOpen ? <X className="w-3.5 h-3.5" /> : <Sliders className="w-3.5 h-3.5" />}
          <span className="text-ui-xs">Options</span>
        </button>
      )}

      <button
        data-recorder="start"
        onClick={() => void store.begin()}
        disabled={!selected}
        className="btn-primary h-8 px-4 text-ui gap-2 flex-shrink-0"
      >
        <Record className="w-3.5 h-3.5" weight="fill" />
        Start recording
      </button>
    </div>
  );
};

/* ── Countdown ──────────────────────────────────────────────────── */

/*
  The way out of the countdown.

  The countdown exists precisely so you can get a window in front, so
  finding the wrong window there is the normal reason to stop. Without
  this the only options are to let it record and discard afterwards, or
  to record your desktop while hunting for a way to cancel. `discard`
  from `countdown` starts nothing and writes nothing — there is no take
  yet to throw away.
*/
const Countdown: React.FC<{ seconds: number }> = ({ seconds }) => {
  const discard = useRecorderStore((s) => s.discard);
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4">
      <span
        key={seconds}
        className="text-spectrum-text font-semibold tabular animate-scale-in"
        style={{ fontSize: 128, lineHeight: 1 }}
      >
        {seconds}
      </span>
      <p className="text-ui-lg text-spectrum-textDim">Get your window in front</p>
      <button
        type="button"
        onClick={() => void discard()}
        className="pro-btn-filled h-7 px-3 text-ui-sm"
      >
        Cancel
      </button>
    </div>
  );
};

/* ── Recording ──────────────────────────────────────────────────── */

/** Registered in `electron/screenRecorder.cjs`; kept in step by hand. */
const SHORTCUT_MEANING: Record<string, string> = {
  'Alt+Shift+R': 'stop',
  'Alt+Shift+P': 'pause',
  'Alt+Shift+Z': 'mark',
};

const Running: React.FC = () => {
  const store = useRecorderStore();
  const paused = store.phase === 'paused';

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 px-4">
      <div className="flex items-center gap-3">
        <span
          className={`w-3 h-3 rounded-full bg-spectrum-red ${paused ? 'opacity-40' : 'animate-pulse'}`}
          aria-hidden="true"
        />
        <span className="font-mono tabular text-spectrum-text" style={{ fontSize: 48, lineHeight: 1 }}>
          {formatDuration(store.elapsedMs)}
        </span>
      </div>

      <p className="text-ui-sm text-spectrum-textDim">
        {paused ? 'Paused' : 'Recording'}
        {store.markCount > 0 ? ` · ${store.markCount} marked` : ''}
      </p>

      <div className="flex items-center gap-2 flex-wrap justify-center">
        <button onClick={() => void store.togglePause()} className="pro-btn-filled h-8 px-3 text-ui gap-1.5">
          {paused ? <Play className="w-3.5 h-3.5" weight="fill" /> : <Pause className="w-3.5 h-3.5" weight="fill" />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button onClick={() => store.mark()} className="pro-btn-filled h-8 px-3 text-ui gap-1.5">
          <CursorClick className="w-3.5 h-3.5" />
          Mark a moment
        </button>
        <button onClick={() => void store.stop()} className="btn-primary h-8 px-4 text-ui gap-1.5">
          <Square className="w-3 h-3" weight="fill" />
          Stop
        </button>
      </div>

      {/* The only way to throw a take away, and it is deliberately not a
          button on the floating bar: a destructive action one press from
          Stop, on a pill you cannot see the label of at a glance, would
          be a way to lose a recording. */}
      <button
        onClick={() => void store.discard()}
        className="btn-ghost-danger h-7 px-3 text-ui-sm gap-1.5"
        title="Stop, and delete what has been recorded so far"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Stop and discard
      </button>

      {store.shortcuts.length > 0 && (
        /* Named, not listed. `globalShortcut` takes these keys away from
           every other app for as long as a take runs, so it is worth
           saying which one does what and which ones registered at all. */
        <p className="text-micro text-spectrum-textFaint text-center">
          {store.shortcuts
            .map((accelerator) => `${accelerator} ${SHORTCUT_MEANING[accelerator] ?? ''}`.trim())
            .join(' · ')}
        </p>
      )}
    </div>
  );
};

/* ── Review ─────────────────────────────────────────────────────── */

const Review: React.FC<{ stacked: boolean; onOpened?: () => void }> = ({ stacked, onOpened }) => {
  const store = useRecorderStore();
  /* The phase gate above this only renders `Review` when a take exists. */
  const take = store.take!;

  const marks = take.marks.length;
  const clicks = take.events.filter((e) => e.kind === 'click' || e.kind === 'rightclick').length;

  return (
    <>
      <div className={`flex-1 min-h-0 flex ${stacked ? 'flex-col overflow-y-auto' : ''}`}>
        <div className={`flex-1 min-w-0 p-3 flex flex-col gap-3 ${stacked ? 'min-h-[220px]' : ''}`}>
          <div className="flex-1 min-h-0 rounded-squircle-sm overflow-hidden bg-black border border-line relative">
            {take.screen ? (
              <video
                src={take.screen.url}
                controls
                className="w-full h-full object-contain"
                aria-label="The screen take"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-ui-sm text-spectrum-textDim">
                No screen file was written.
              </div>
            )}

            {take.camera && (
              <video
                src={take.camera.url}
                muted
                loop
                autoPlay
                playsInline
                className="absolute bottom-3 right-3 w-[22%] rounded-squircle-xs border border-line-strong
                           shadow-modal pointer-events-none"
                aria-hidden="true"
              />
            )}
          </div>

          <div className="flex items-center gap-4 flex-shrink-0 flex-wrap">
            <Fact label="Length" value={formatDuration(take.durationMs)} />
            {take.screen && <Fact label="Screen" value={`${take.screen.width}x${take.screen.height}`} />}
            {take.camera && <Fact label="Camera" value={`${take.camera.width}x${take.camera.height}`} />}
            <Fact
              label="Size"
              value={formatFileSize((take.screen?.bytes ?? 0) + (take.camera?.bytes ?? 0))}
            />
          </div>
        </div>

        <div
          className={`flex-shrink-0 overflow-y-auto p-3 space-y-3 flex flex-col ${
            stacked ? 'border-t border-line' : 'border-l border-line'
          }`}
          style={stacked ? undefined : { width: REVIEW_RAIL_W }}
        >
          <div className="flex items-center gap-2">
            {take.screen ? (
              <CheckCircle2 className="w-4 h-4 text-spectrum-green flex-shrink-0" weight="fill" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-spectrum-red flex-shrink-0" weight="fill" />
            )}
            <span className="text-ui font-medium text-spectrum-text">
              {take.screen ? 'Take saved' : 'The screen was not recorded'}
            </span>
          </div>

          {!take.screen && (
            <p className="text-ui-sm text-spectrum-textMuted leading-relaxed">
              Nothing was written for the display, so there is no take to open.
              {take.camera ? ' The camera file is on disk and can be imported by hand.' : ''}
              {' '}Record again, and if it happens twice the notes below are the place to look.
            </p>
          )}

          {take.screen && (
            <ul className="space-y-1.5">
              <Bullet
                icon={Monitor}
                text={`The display, ${take.fps} fps${take.screen.hasAudio ? ', with its own sound' : ', silent'}`}
              />
              {take.camera && (
                <Bullet
                  icon={Camera}
                  text={
                    take.camera.hasAudio
                      ? 'The camera, with your narration on it'
                      : 'The camera, without sound'
                  }
                />
              )}
              <Bullet
                icon={CursorClick}
                text={
                  marks === 0 && clicks === 0
                    ? 'No moments were marked and no clicks were seen'
                    : `${marks} marked moment${marks === 1 ? '' : 's'}`
                      + (clicks > 0 ? ` and ${clicks} click${clicks === 1 ? '' : 's'}` : '')
                      + ', kept beside the take'
                }
              />
            </ul>
          )}

          {take.input && !take.input.ok && (
            <div className="flex items-start gap-1.5 rounded-squircle-xs bg-spectrum-blue/10
                            border border-spectrum-blue/25 px-2 py-1.5">
              <AlertTriangle className="w-3 h-3 text-spectrum-blue flex-shrink-0 mt-px" />
              <span className="text-micro text-spectrum-textMuted leading-snug">{take.input.message}</span>
            </div>
          )}

          {store.warnings.length > 0 && (
            <div className="space-y-1.5 pt-1">
              {store.warnings.map((warning) => (
                <div
                  key={warning}
                  className="flex items-start gap-1.5 rounded-squircle-xs bg-spectrum-amber/10
                             border border-spectrum-amber/25 px-2 py-1.5"
                >
                  <AlertTriangle className="w-3 h-3 text-spectrum-amber flex-shrink-0 mt-px" />
                  <span className="text-micro text-spectrum-textMuted leading-snug">{warning}</span>
                </div>
              ))}
            </div>
          )}

          {/* Only when there is a screen to build from. Without one there
              is no build, and a rail of build options above a disabled
              button is an offer that cannot be taken. */}
          {take.screen && <BuildOptions take={take} />}

          {/* The take is on disk whatever happens next, and a build can be
              thrown away and rebuilt, so both facts are worth stating
              beside the button rather than only after it is pressed. */}
          <p className="text-micro text-spectrum-textFaint leading-relaxed pt-1">
            Opening the take lays the screen, the camera and the narration down as separate
            clips you can move, resize and cut. It replaces whatever is on the timeline now;
            the files stay on disk, so you can build it again.
          </p>

          <button
            onClick={() => void window.teminali?.recorder?.reveal(take.screen?.path ?? take.dir)}
            className="flex items-center gap-1.5 text-micro text-spectrum-textDim hover:text-spectrum-text
                       transition-colors mt-auto pt-2"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Show the files
          </button>
        </div>
      </div>

      <div className="flex-shrink-0 border-t border-line px-3 py-2 flex items-center gap-2">
        <button
          onClick={() => { void store.openOnTimeline().then((r) => { if (r) onOpened?.(); }); }}
          className="btn-primary h-8 px-3 text-ui gap-1.5"
          title="Lay the take down as clips and show the timeline"
        >
          <Film className="w-3.5 h-3.5" />
          Open on the timeline
        </button>
        {/* Secondary now, because the take in hand is the thing to act on
            and recording over it is the step back, not the step on. */}
        <button
          onClick={() => void store.discard()}
          className="pro-btn h-8 px-3 text-ui gap-1.5"
          title="Go back to setup. The take stays on disk."
        >
          <Record className="w-3.5 h-3.5" weight="fill" />
          Record again
        </button>
      </div>
    </>
  );
};

/* ── Pieces ─────────────────────────────────────────────────────── */

const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="min-w-0">
    <p className="text-micro text-spectrum-textFaint uppercase tracking-wide">{label}</p>
    <p className="text-ui-sm font-mono tabular text-spectrum-textMuted truncate">{value}</p>
  </div>
);

const Bullet: React.FC<{ icon: React.ElementType; text: string }> = ({ icon: Icon, text }) => (
  <li className="flex items-start gap-2 text-ui-sm text-spectrum-textMuted leading-snug">
    <Icon className="w-3.5 h-3.5 flex-shrink-0 text-spectrum-textFaint mt-px" />
    <span>{text}</span>
  </li>
);

/* Re-exported for the layout test, which asserts that this panel's own
   thresholds cannot drift away from the rail widths they are built on. */
export { OPTIONS_COLUMN_MIN_W, REVIEW_COLUMN_MIN_W, OPTIONS_W, REVIEW_RAIL_W };
