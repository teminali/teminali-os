import os
import sys
import certifi
import soundfile as sf
import numpy as np
import librosa
import torch

os.environ["SSL_CERT_FILE"] = certifi.where()

from kokoro import KPipeline

SAMPLES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "audio_samples"))
STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "code", "static", "bella_preview"))

pipeline = KPipeline(lang_code='b')

# 1. Build and refine Decoupled Bella Style Tensor
emma = pipeline.load_voice('bf_emma')
isabella = pipeline.load_voice('bf_isabella')
sarah = pipeline.load_voice('af_sarah')
nicole = pipeline.load_voice('af_nicole')

# Acoustic Timbre (first 128 dims): 55% Emma + 30% Isabella + 15% Sarah (Chest resonance & smoky low register)
timbre_part = (0.55 * emma[:, :, :128] + 0.30 * isabella[:, :, :128] + 0.15 * sarah[:, :, :128])
# Prosodic Inflection (second 128 dims): 45% Isabella + 40% Nicole + 15% Emma (Aristocratic diction & breathy fry)
prosody_part = (0.45 * isabella[:, :, 128:] + 0.40 * nicole[:, :, 128:] + 0.15 * emma[:, :, 128:])

custom_bella = torch.cat([timbre_part, prosody_part], dim=-1)
tensor_path = os.path.join(SAMPLES_DIR, "bella_exact_custom.pt")
torch.save(custom_bella, tensor_path)
print(f"Saved custom Bella style tensor to {tensor_path}")

BENCHMARKS = [
    {
        "id": "scene1",
        "title": "Scene 1: S02E04 — The Falcon & Seduction",
        # Dynamic prosody with hesitation breath beat
        "dynamic_text": "I'm not playing hard to get... All you have to do is ask, Eddie.",
        "orig_file": os.path.join(STATIC_DIR, "bella_exact_scene1_original.wav"),
        "output_file": os.path.join(STATIC_DIR, "bella_exact_scene1_generated.wav"),
        "speed": 1.08
    },
    {
        "id": "scene2",
        "title": "Scene 2: S02E02 — Cold Aristocratic Authority",
        # Dynamic prosody with grave aristocratic pause
        "dynamic_text": "How and why my boyfriend was killed... is no longer relevant. That door is closed.",
        "orig_file": os.path.join(STATIC_DIR, "bella_exact_scene2_original.wav"),
        "output_file": os.path.join(STATIC_DIR, "bella_exact_scene2_generated.wav"),
        "speed": 1.10
    },
    {
        "id": "scene3",
        "title": "Scene 3: S02E06 — The Ferrari Bet & Danger Banter",
        # Dynamic prosody with deliberate menace pauses
        "dynamic_text": "Please drive carefully... If you hurt yourself, I'll kill you... But if you hurt the car... I'll kill your family.",
        "orig_file": os.path.join(STATIC_DIR, "bella_exact_scene3_original.wav"),
        "output_file": os.path.join(STATIC_DIR, "bella_exact_scene3_generated.wav"),
        "speed": 1.08
    }
]

def analyze(wav_path):
    y, sr = librosa.load(wav_path, sr=24000)
    dur = len(y) / sr
    f0, _, _ = librosa.pyin(y, fmin=librosa.note_to_hz('C3'), fmax=librosa.note_to_hz('C6'), sr=sr)
    vf0 = f0[~np.isnan(f0)] if f0 is not None else []
    mean_f0 = float(np.mean(vf0)) if len(vf0) > 0 else 0.0
    return dur, mean_f0

print("="*60)
print("🚀 SYNTHESIZING DYNAMIC DECOUPLED BELLA BENCHMARKS")
print("="*60)

for b in BENCHMARKS:
    results = list(pipeline(b["dynamic_text"], voice=custom_bella, speed=b["speed"]))
    audio = np.concatenate([r.audio.cpu().numpy() for r in results if r.audio is not None])
    # trim silence
    audio_trimmed, _ = librosa.effects.trim(audio, top_db=25)
    sf.write(b["output_file"], audio_trimmed, 24000)
    
    orig_dur, orig_f0 = analyze(b["orig_file"])
    gen_dur, gen_f0 = analyze(b["output_file"])
    
    diff = abs(gen_dur - orig_dur)
    match_pct = max(0, 100 - (diff / orig_dur * 100))
    print(f"[{b['id']}] {b['title']}")
    print(f"  Original:  {orig_dur:.2f}s | F0: {orig_f0:.1f}Hz")
    print(f"  Generated: {gen_dur:.2f}s | F0: {gen_f0:.1f}Hz")
    print(f"  Timing Delta: {diff:.2f}s ({match_pct:.1f}% Match)")
