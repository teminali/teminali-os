import React, { useState } from "react";
import { Mic, Check, Loader2, Trash2, ShieldCheck, AlertTriangle } from "lucide-react";

/**
 * Voice enrolment — teaching the studio which voice is yours.
 *
 * Three short clips, deliberately different sentences, so the resulting print
 * describes the speaker rather than whatever phrase happened to be said. The
 * copy is honest about the limits of the on-device matcher, because a security
 * control that oversells itself is worse than one that states its range.
 */

const PHRASES = [
  "Open the project and show me what changed today.",
  "Teminali, run the tests and summarise the failures.",
  "I want a new component with a table and three columns.",
];

export interface VoiceEnrolmentProps {
  hasProfile: boolean;
  /** Strong verification available (sidecar embedding), rather than the local heuristic. */
  strongMatching: boolean;
  captureClip: (seconds?: number) => Promise<{ samples: Float32Array; sampleRate: number }>;
  finish: (clips: Array<{ samples: Float32Array; sampleRate: number }>) => boolean;
  clear: () => void;
  onDone?: () => void;
}

export const VoiceEnrolment: React.FC<VoiceEnrolmentProps> = ({
  hasProfile,
  strongMatching,
  captureClip,
  finish,
  clear,
  onDone,
}) => {
  const [clips, setClips] = useState<Array<{ samples: Float32Array; sampleRate: number }>>([]);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const record = async () => {
    setError(null);
    setRecording(true);
    try {
      const clip = await captureClip(4);
      setClips((previous) => [...previous, clip]);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setRecording(false);
    }
  };

  const save = () => {
    if (finish(clips)) {
      setSaved(true);
      onDone?.();
    } else {
      setError("Those clips did not contain enough speech to build a profile. Try again, speaking normally.");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 text-2xs text-ink-faint">
        <ShieldCheck size={13} className="text-success flex-shrink-0 mt-px" />
        <p>
          Record three short clips. Afterwards the studio can ignore speech that is not yours, which is what makes an
          always-open microphone usable in a room with other people. Your voice never leaves this machine.
        </p>
      </div>

      {!strongMatching && (
        <div className="flex items-start gap-2 text-2xs text-warning bg-warning/10 border border-warning/25 rounded-lg px-2.5 py-2">
          <AlertTriangle size={13} className="flex-shrink-0 mt-px" />
          <p>
            Running the on-device matcher. It reliably tells you apart from a clearly different voice, but not from a
            similar one. Install the VibeVoice sidecar for proper speaker verification.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {PHRASES.map((phrase, index) => {
          const done = index < clips.length;
          const current = index === clips.length;
          return (
            <div
              key={phrase}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 border transition-colors duration-ds ease-ds ${
                done
                  ? "border-success/25 bg-success/5"
                  : current
                    ? "border-accent/40 bg-accent/5"
                    : "border-edge-subtle bg-surface-sunken opacity-50"
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-3xs ${
                  done ? "bg-success/20 text-success" : "bg-surface-chip text-ink-muted"
                }`}
              >
                {done ? <Check size={11} /> : index + 1}
              </span>
              <span className={`text-xs flex-1 ${done ? "text-ink-muted line-through" : "text-ink-prose"}`}>
                {phrase}
              </span>
              {current && (
                <button
                  type="button"
                  onClick={record}
                  disabled={recording}
                  className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md bg-accent text-frame-top text-2xs font-medium hover:bg-accent-hover disabled:opacity-60 transition-colors duration-ds ease-ds"
                >
                  {recording ? <Loader2 size={12} className="animate-spin" /> : <Mic size={12} />}
                  {recording ? "Listening…" : "Record"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="text-2xs text-danger">{error}</p>}
      {saved && <p className="text-2xs text-success">Profile saved. You can now switch on “Only respond to my voice”.</p>}

      <div className="flex items-center gap-2">
        {hasProfile && (
          <button
            type="button"
            onClick={() => {
              clear();
              setClips([]);
              setSaved(false);
            }}
            className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-2xs text-ink-muted hover:bg-danger/15 hover:text-danger transition-colors duration-ds ease-ds"
          >
            <Trash2 size={12} />
            Delete profile
          </button>
        )}
        <div className="flex-1" />
        {clips.length > 0 && (
          <button
            type="button"
            onClick={() => setClips([])}
            className="h-7 px-2.5 rounded-md text-2xs text-ink-muted hover:text-ink-high transition-colors duration-ds ease-ds"
          >
            Start over
          </button>
        )}
        <button
          type="button"
          onClick={save}
          disabled={clips.length < 2}
          className="h-7 px-3 inline-flex items-center gap-1.5 rounded-md bg-ink-high text-frame-top text-2xs font-medium hover:bg-white disabled:opacity-35 transition-colors duration-ds ease-ds"
        >
          <Check size={12} />
          Save profile
        </button>
      </div>
    </div>
  );
};
