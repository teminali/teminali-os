/**
 * What the room sounded like.
 *
 * Recognition answers "what was said". This answers "what was that?" — the
 * question the operator actually asked for: *"if there was a car noise i can
 * ask did you hear that"*. Until now `ambientMemory.ts` only ever recorded
 * speech, and said so honestly when asked about a noise; this is the model
 * that lets it record the noise instead.
 *
 * AudioSet AST (`MIT/ast-finetuned-audioset-10-10-0.4593`, ONNX-converted) over
 * 527 labels, on the same 16 kHz mono float32 the recogniser already has. One
 * fixed-size forward pass, measured at 220-290 ms on this machine whatever the
 * clip length, because the model pads or truncates to 10.24 s internally. That
 * cost does not overlap recognition — ONNX inference blocks the loop — which is
 * why `asr.js` spends it only on clips that produced no words.
 *
 * Three things it deliberately does not do:
 *
 *   1. **It does not name speech.** "Speech", "Male speech", "Narration" and
 *      the rest are suppressed: the transcript path already owns those, and an
 *      ambient log that recorded both would answer "what did she say?" with
 *      "a person speaking".
 *   2. **It does not name the room.** "Silence", "Static", "Inside, small
 *      room", mains hum — these are the noise floor, not events. Measured on
 *      this machine: silence scores `Silence` 0.45 and brown noise scores
 *      `Pink noise` 0.33, so both would clear any useful threshold. They are
 *      dropped by name, not by score.
 *   3. **It does not guess.** Below `SOUND_THRESHOLD` the honest answer is an
 *      empty list, which `ambientMemory` reports as having heard nothing.
 */
import { pipeline } from "@huggingface/transformers";

export const SOUND_MODEL =
  process.env.TEMINALI_SOUND_MODEL || "Xenova/ast-finetuned-audioset-10-10-0.4593";
const SOUND_DTYPE = process.env.TEMINALI_SOUND_DTYPE || "q8";

/**
 * How sure the model must be before a label is worth telling anyone about.
 * Calibrated on this machine: a 1 kHz tone reads `Beep, bleep` at 0.77 and
 * synthesised speech reads `Speech` at 0.85, while the loudest thing in a
 * featureless clip tops out around 0.33.
 */
export const SOUND_THRESHOLD = Number(process.env.TEMINALI_SOUND_THRESHOLD || 0.35);

/** Speech belongs to the transcript, not to the sound log. */
const SPEECH_LABELS = new Set([
  "speech",
  "male speech, man speaking",
  "female speech, woman speaking",
  "child speech, kid speaking",
  "conversation",
  "narration, monologue",
  "speech synthesizer",
  "babbling",
  "whispering",
  "chatter",
  "hubbub, speech noise, speech babble",
  "children shouting",
  "shout",
  "bellow",
  "yell",
]);

/**
 * The noise floor and the shape of the room. Real labels, but not events: an
 * assistant that volunteers "I heard a small room" is worse than one silent.
 */
const NON_EVENT_LABELS = new Set([
  "silence",
  "static",
  "white noise",
  "pink noise",
  "noise",
  "environmental noise",
  "background noise",
  "hum",
  "mains hum",
  "sine wave",
  "chirp tone",
  "sound effect",
  "inside, small room",
  "inside, large room or hall",
  "inside, public space",
  "outside, urban or manmade",
  "outside, rural or natural",
  "echo",
  "reverberation",
  "sidetone",
  "throbbing",
  "vibration",
  "distortion",
  "tender music",
  "field recording",
]);

/**
 * How a person would say it. AudioSet labels are catalogue entries — "Vehicle
 * horn, car horn, honking", "Water tap, faucet" — and reading one aloud is the
 * difference between an assistant and a database. Anything not listed falls
 * back to `articled()`, which is plain but never wrong.
 */
const SPOKEN_PHRASE = new Map([
  // Traffic. The label the operator asked for by name.
  ["vehicle", "a vehicle"],
  ["car", "a car"],
  ["car passing by", "a car going past"],
  ["motor vehicle (road)", "a car"],
  ["truck", "a truck"],
  ["bus", "a bus"],
  ["motorcycle", "a motorbike"],
  ["engine", "an engine"],
  ["engine starting", "an engine starting"],
  ["idling", "an engine idling"],
  ["accelerating, revving, vroom", "an engine revving"],
  ["vehicle horn, car horn, honking", "a car horn"],
  ["air horn, truck horn", "a horn"],
  ["skidding", "tyres skidding"],
  ["tire squeal", "tyres squealing"],
  ["train", "a train"],
  ["aircraft", "a plane"],
  ["helicopter", "a helicopter"],
  ["bicycle", "a bicycle"],
  ["traffic noise, roadway noise", "traffic"],

  // The door and the room.
  ["door", "a door"],
  ["knock", "a knock at the door"],
  ["doorbell", "the doorbell"],
  ["ding-dong", "the doorbell"],
  ["slam", "a door slamming"],
  ["sliding door", "a sliding door"],
  ["cupboard open or close", "a cupboard"],
  ["drawer open or close", "a drawer"],
  ["walk, footsteps", "footsteps"],
  ["chair", "a chair moving"],

  // Phones and alarms.
  ["telephone", "a phone"],
  ["telephone bell ringing", "a phone ringing"],
  ["ringtone", "a phone ringing"],
  ["cellphone buzz, vibrating alert", "a phone buzzing"],
  ["telephone dialing, dtmf", "a phone dialling"],
  ["busy signal", "an engaged tone"],
  ["alarm", "an alarm"],
  ["alarm clock", "an alarm clock"],
  ["siren", "a siren"],
  ["civil defense siren", "a siren"],
  ["ambulance (siren)", "an ambulance"],
  ["police car (siren)", "a police siren"],
  ["fire engine, fire truck (siren)", "a fire engine"],
  ["smoke detector, smoke alarm", "a smoke alarm"],
  ["fire alarm", "a fire alarm"],
  ["buzzer", "a buzzer"],
  ["beep, bleep", "a beep"],
  ["bell", "a bell"],
  ["church bell", "a church bell"],
  ["chime", "a chime"],
  ["notification", "a notification"],

  // People, without words.
  ["laughter", "laughter"],
  ["giggle", "laughter"],
  ["chuckle, chortle", "laughter"],
  ["crying, sobbing", "crying"],
  ["baby cry, infant cry", "a baby crying"],
  ["cough", "a cough"],
  ["sneeze", "a sneeze"],
  ["sniff", "a sniff"],
  ["throat clearing", "someone clearing their throat"],
  ["breathing", "breathing"],
  ["snoring", "snoring"],
  ["whistling", "whistling"],
  ["clapping", "clapping"],
  ["applause", "applause"],
  ["cheering", "cheering"],
  ["singing", "singing"],
  ["humming", "humming"],
  ["finger snapping", "a finger snap"],

  // Animals.
  ["dog", "a dog"],
  ["bark", "a dog barking"],
  ["howl", "a dog howling"],
  ["whimper (dog)", "a dog whimpering"],
  ["cat", "a cat"],
  ["meow", "a cat"],
  ["purr", "a cat purring"],
  ["bird", "a bird"],
  ["bird vocalization, bird call, bird song", "birdsong"],
  ["chicken, rooster", "a chicken"],
  ["insect", "an insect"],
  ["cricket", "crickets"],
  ["fly, housefly", "a fly"],

  // Work, and the machines around it.
  ["computer keyboard", "typing"],
  ["typing", "typing"],
  ["typewriter", "typing"],
  ["mouse", "a mouse click"],
  ["printer", "a printer"],
  ["camera", "a camera"],
  ["mechanical fan", "a fan"],
  ["air conditioning", "air conditioning"],
  ["vacuum cleaner", "a vacuum cleaner"],
  ["blender", "a blender"],
  ["microwave oven", "a microwave"],
  ["hair dryer", "a hairdryer"],
  ["electric shaver, electric razor", "an electric shaver"],
  ["power tool", "a power tool"],
  ["drill", "a drill"],
  ["sawing", "sawing"],
  ["hammer", "hammering"],
  ["sanding", "sanding"],

  // Water and weather.
  ["water", "running water"],
  ["water tap, faucet", "a tap running"],
  ["sink (filling or washing)", "a sink"],
  ["toilet flush", "a toilet flushing"],
  ["bathtub (filling or washing)", "a bath running"],
  ["pour", "something being poured"],
  ["boiling", "something boiling"],
  ["rain", "rain"],
  ["rain on surface", "rain"],
  ["raindrop", "rain"],
  ["thunder", "thunder"],
  ["thunderstorm", "a thunderstorm"],
  ["wind", "wind"],
  ["wind noise (microphone)", "wind on the microphone"],
  ["ocean", "the sea"],
  ["stream", "running water"],
  ["waterfall", "running water"],

  // Impacts and breakages.
  ["glass", "glass"],
  ["shatter", "breaking glass"],
  ["chink, clink", "glass clinking"],
  ["thump, thud", "a thud"],
  ["bang", "a bang"],
  ["crack", "a crack"],
  ["crushing", "something being crushed"],
  ["tearing", "tearing"],
  ["crumpling, crinkling", "paper crinkling"],
  ["rustle", "rustling"],
  ["squeak", "a squeak"],
  ["clatter", "a clatter"],
  ["explosion", "an explosion"],
  ["gunshot, gunfire", "a gunshot"],
  ["fireworks", "fireworks"],

  // Media in the room.
  ["music", "music"],
  ["musical instrument", "an instrument"],
  ["guitar", "a guitar"],
  ["piano", "a piano"],
  ["drum", "a drum"],
  ["drum kit", "drums"],
  ["radio", "a radio"],
  ["television", "a television"],
]);

/** "a car" from "Car"; "an engine" from "Engine". Plain, but never wrong. */
function articled(label) {
  const head = label.split(",")[0].trim().toLowerCase();
  if (!head) return label.toLowerCase();
  return `${/^[aeiou]/.test(head) ? "an" : "a"} ${head}`;
}

/** How to say one AudioSet label out loud. */
export function describeSound(label) {
  return SPOKEN_PHRASE.get(label.trim().toLowerCase()) ?? articled(label);
}

/** Is this label an event in the room, rather than speech or the room itself? */
export function isReportableSound(label) {
  const key = label.trim().toLowerCase();
  return !SPEECH_LABELS.has(key) && !NON_EVENT_LABELS.has(key);
}

let loading = null;

/**
 * Load the classifier once; concurrent callers share the promise. Cold this
 * fetches ~90 MB (measured 123 s on a first run); warm it is 87 ms, which is
 * why `server.js` warms it in the background and advertises it only after.
 */
export function loadSounds() {
  if (!loading) {
    loading = pipeline("audio-classification", SOUND_MODEL, { dtype: SOUND_DTYPE, device: "cpu" });
  }
  return loading;
}

/**
 * Turn one ranked classifier output into the sounds worth telling someone
 * about. Separate from the model so the judgement can be tested without one:
 * every rule about what is worth reporting lives here.
 *
 * Returns `[]` — never a guess — when nothing clears the threshold and when
 * every candidate was speech or room tone. An empty list is a real answer: it
 * is what lets "did you hear that?" say no.
 */
export function selectSounds(candidates, { limit = 2, threshold = SOUND_THRESHOLD } = {}) {
  const sounds = [];
  for (const candidate of candidates ?? []) {
    if (sounds.length >= limit) break;
    const label = candidate?.label;
    const confidence = Number(candidate?.score ?? 0);
    if (!label || !Number.isFinite(confidence) || confidence < threshold) continue;
    if (!isReportableSound(label)) continue;
    const sound = describeSound(label);
    // Several AudioSet labels collapse to the same phrase ("Siren" and
    // "Civil defense siren" are both "a siren"); saying it twice is a tell
    // that a catalogue is talking, not a person.
    if (sounds.some((existing) => existing.sound === sound)) continue;
    sounds.push({ label, sound, confidence: Number(confidence.toFixed(3)) });
  }
  return sounds;
}

/** Name what is audible in one clip, loudest first. */
export async function classifySounds(samples, options = {}) {
  if (!samples?.length) return [];
  const classifier = await loadSounds();
  // Ask for more than we will keep: the top label is often "Speech" or the
  // room, and the event we want is the one underneath it.
  const ranked = await classifier(samples, { top_k: 8 });
  return selectSounds(Array.isArray(ranked) ? ranked : [ranked], options);
}
