/*
  Which sound of a take belongs on which clip.

  Split out of `screenCapture` and free of imports so the rules below can be
  tested without a media stack. They are worth testing: both of them fail
  silently — one by putting a voice in the file twice, the other by letting a
  voice drift out of sync with the face saying it — and neither shows up until
  someone plays the recording back.
*/

/** The sounds a take can carry, whatever hardware happens to provide them. */
export type SoundSource = 'mic' | 'assistant' | 'systemAudio';

export interface SoundPlan {
  /** Take the voice engine's output tap for this take. */
  tapAssistant: boolean;
  /** What rides the screen clip's audio track, summed if more than one. */
  screen: SoundSource[];
  /** What rides the camera clip's, which must not drift from the face. */
  camera: SoundSource[];
}

/**
 * Where each sound of a take belongs — pure, so the two rules that are easy
 * to get wrong can be tested without a media stack:
 *
 * 1. The assistant's tap is NOT taken when the system's own output is in the
 *    take. That loopback (Windows only) already carries the speakers, so
 *    taking the tap as well would put every reply in twice.
 * 2. The microphone and the assistant are one narration. They stay together,
 *    which is why the assistant follows the microphone onto the camera clip
 *    when there is a face to stay in sync with, and onto the screen clip —
 *    the one clip a take always has — when there is not.
 */
export function planSound(input: {
  assistantVoice: boolean;
  systemAudio: boolean;
  mic: boolean;
  cameraVideo: boolean;
}): SoundPlan {
  const tapAssistant = input.assistantVoice && !input.systemAudio;
  const narration: SoundSource[] = [
    ...(input.mic ? ['mic' as const] : []),
    ...(tapAssistant ? ['assistant' as const] : []),
  ];
  const system: SoundSource[] = input.systemAudio ? ['systemAudio'] : [];

  if (input.cameraVideo && input.mic) {
    return { tapAssistant, screen: system, camera: narration };
  }
  return { tapAssistant, screen: [...system, ...narration], camera: [] };
}
