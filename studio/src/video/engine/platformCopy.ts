/**
 * What the recorder is allowed to SAY about the machine it is running on.
 *
 * The recorder's capabilities differ per platform, and until now its copy
 * did not: a Linux operator asking for system audio was told what macOS
 * does, and every platform was told that a screen capture contains no
 * cursor — a fact measured on macOS and asserted everywhere.
 *
 * Wrong copy is not cosmetic here. These two strings are the only thing
 * standing between an operator and a silent take or a doubled pointer, so
 * each one has to name the platform it is actually talking about. The
 * functions are pure and take the platform explicitly so they can be
 * tested without a renderer.
 */

/** `process.platform` as an operator would name it. */
export function platformName(platform: string | undefined): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return 'this platform';
}

/**
 * The warning shown when a take was asked for system audio on a machine
 * that cannot serve it — null on Windows, which can.
 *
 * `micOn` decides whether the take has any sound at all, so the sentence
 * does not promise narration to someone recording with no microphone.
 * The old copy promised it unconditionally.
 */
export function systemAudioWarning(
  platform: string | undefined,
  micOn: boolean,
): string | null {
  if (platform === 'win32') return null;
  const name = platformName(platform);
  return micOn
    ? `System audio loopback is a Windows capability, so this ${name} take carries no sound of its own. The microphone is still recorded.`
    : `System audio loopback is a Windows capability, so this ${name} take has no sound at all: no system audio, and no microphone selected.`;
}

/**
 * The hint under "Draw the pointer".
 *
 * Only macOS is measured: its screen capture genuinely omits the cursor,
 * which is why the option exists. On Windows and Linux nobody here has
 * observed whether the captured frames already contain one, so the hint
 * warns about the doubling instead of asserting a fact that has not been
 * checked on hardware.
 */
export function cursorHint(platform: string | undefined): string {
  if (platform === 'darwin') return 'A macOS screen capture does not contain the cursor';
  return 'Draws a pointer. If the capture already shows one, the take has two';
}
