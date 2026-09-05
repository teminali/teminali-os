import React from "react";
import { X, ShieldCheck, UserCheck } from "lucide-react";
import { VoiceEnrolment } from "./VoiceEnrolment";
import type { UseVoiceResult } from "../../hooks/useVoice";

export interface EnrolVoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  voice: UseVoiceResult;
}

/**
 * Personalized Voice Enrollment Modal.
 *
 * Lets the operator record 3 short phrases so the on-device MFCC speaker
 * matcher learns their voice and ignores other people talking in the room.
 */
export const EnrolVoiceModal: React.FC<EnrolVoiceModalProps> = ({
  isOpen,
  onClose,
  voice,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="enrol-voice-title"
        className="w-full max-w-md rounded-2xl bg-surface border border-edge-subtle shadow-2xl overflow-hidden animate-scale-in"
      >
        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between border-b border-edge-subtle">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-success/15 text-success flex items-center justify-center">
              <UserCheck size={16} />
            </div>
            <div>
              <h3 id="enrol-voice-title" className="text-sm font-semibold text-ink-high">
                Recognize Only Me
              </h3>
              <p className="text-2xs text-ink-muted">
                Teach Temy your voice so it ignores room chatter
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="w-7 h-7 flex items-center justify-center rounded-full text-ink-muted hover:bg-surface-hover hover:text-ink-high transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5">
          <VoiceEnrolment
            hasProfile={voice.hasProfile}
            strongMatching={false}
            captureClip={voice.captureEnrolmentClip}
            finish={(clips) => {
              const success = voice.finishEnrolment(clips);
              if (success) {
                voice.update({ requireSpeakerMatch: true });
              }
              return success;
            }}
            clear={() => {
              voice.clearEnrolment();
              voice.update({ requireSpeakerMatch: false });
            }}
            onDone={onClose}
          />
        </div>
      </div>
    </div>
  );
};
