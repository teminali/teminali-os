/* ═══════════════════════════════════════════════════════════════════
   The narration, as timed cues.

   Subtitles need two things a transcript alone does not give you: WHEN
   each phrase was said, and phrases short enough to read. This asks the
   gateway for both and hands back `SpeechCue[]`, which is what
   `Take.transcript` already holds.

   ── Why the language is never `auto` ───────────────────────────────

   `/api/voice/transcribe` defaults to `auto` and whisper will happily
   guess. On a long, clean, English take that guess is right. On a short
   one, on a noisy one, and above all on Kiswahili — which shares a
   great deal of its phonology with languages whisper has far more of —
   the guess is how a take comes back confidently transcribed as the
   wrong language, with timings that fit and words that are nonsense.

   So the operator picks, and this module has no way to express `auto`.
   That is a deliberate hole in the type: the caller cannot ask for the
   behaviour that produces the failure.

   ── What this module does NOT hide ─────────────────────────────────

   Recognition quality is a property of the installed model, and the
   small models are materially worse outside English. `transcribeNarration`
   reports the model that ran in `model`, so the caller can say which
   one produced the words rather than presenting every transcript as
   equally trustworthy.
   ═══════════════════════════════════════════════════════════════════ */

import { GatewayClient } from '../../services/gatewayClient';
import type { SpeechCue } from '../../types/recorder';

/**
 * The languages the subtitle picker offers.
 *
 * Short by design. whisper.cpp recognises around a hundred, and a
 * hundred-item menu is a worse way to find Kiswahili than a list of the
 * ones this product is actually used in, plus a text field nobody has
 * asked for yet. Codes are ISO-639-1, which is what whisper takes;
 * `speech-local.js` splits a BCP-47 tag down to this anyway.
 */
export const SUBTITLE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'sw', label: 'Kiswahili' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'ar', label: 'العربية' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
];

/**
 * Characters per cue.
 *
 * 42 is the EBU/BBC line length, and it is also what `reflowCues`
 * defaults to. Passing it to whisper rather than reflowing afterwards
 * matters: whisper re-aligns the timings to the split it makes, where a
 * post-hoc reflow has to divide one cue's duration by character count
 * and pretend that is when the words were said.
 */
export const CAPTION_LINE_CHARS = 42;

export interface NarrationTranscript {
  cues: SpeechCue[];
  /** What the engine reports it heard, which may not be what was asked for. */
  language: string;
  /** The whisper model that ran, e.g. `base`, or null from a sidecar. */
  model: string | null;
}

interface TranscribeResponse {
  text?: string;
  language?: string;
  model?: string | null;
  segments?: { startMs: number; endMs: number; text: string }[];
}

/**
 * Transcribe one audio blob into caption-shaped, timed cues.
 *
 * @throws when the gateway has no recogniser, or when it answers
 *   without timings — see below.
 */
export async function transcribeNarration(
  audio: Blob,
  language: string,
  signal?: AbortSignal,
): Promise<NarrationTranscript> {
  const form = new FormData();
  form.append('audio', audio, 'narration.webm');
  form.append('language', language);
  form.append('maxSegmentChars', String(CAPTION_LINE_CHARS));

  const response = await GatewayClient.request('/api/voice/transcribe', {
    method: 'POST',
    signal,
    body: form,
  });
  await GatewayClient.expectOk(response);
  const data = (await response.json()) as TranscribeResponse;

  /*
    A transcript with no segments is refused rather than salvaged.

    The salvage would be to take `text`, split it, and spread it evenly
    across the take — and that produces a caption track that looks
    finished and is wrong everywhere, which is worse than no captions
    and a sentence saying why. The remote sidecar is the path that can
    answer this way; the local whisper engine always segments.
  */
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (segments.length === 0) {
    throw new Error(
      'The recogniser returned words but no timings, so there is nothing to place the captions on.',
    );
  }

  return {
    cues: segments
      .map((segment) => ({
        startMs: Math.max(0, Math.round(segment.startMs)),
        endMs: Math.max(0, Math.round(segment.endMs)),
        text: String(segment.text ?? '').trim(),
      }))
      .filter((cue) => cue.text.length > 0 && cue.endMs > cue.startMs),
    language: data.language ?? language,
    model: data.model ?? null,
  };
}
