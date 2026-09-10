import os
import sys
import certifi
import soundfile as sf
import numpy as np
import librosa
import shutil

os.environ["SSL_CERT_FILE"] = certifi.where()

from RealtimeTTS import KokoroEngine

SAMPLES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "audio_samples"))
STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "code", "static", "bella_preview"))

FORMULA = "0.45*bf_isabella + 0.40*bf_emma + 0.15*af_nicole"
SPEED = 1.10

CASES = [
    {
        "id": "scene_falcon",
        "title": "Scene 1: S02E04 — The Falcon & Seduction",
        "quote": "I'm not playing hard to get. All you have to do is ask, Eddie.",
        "orig_input": os.path.join(SAMPLES_DIR, "bella_orig_s02e04_hard_to_get.wav"),
        "orig_name": "bella_exact_scene1_original.wav",
        "gen_name": "bella_exact_scene1_generated.wav"
    },
    {
        "id": "scene_negotiation",
        "title": "Scene 2: S02E02 — Cold Aristocratic Authority",
        "quote": "How and why my boyfriend was killed is no longer relevant. That door is closed.",
        "orig_input": os.path.join(SAMPLES_DIR, "bella_orig_s02e02_door_is_closed.wav"),
        "orig_name": "bella_exact_scene2_original.wav",
        "gen_name": "bella_exact_scene2_generated.wav"
    },
    {
        "id": "scene_ferrari",
        "title": "Scene 3: S02E06 — The Ferrari Bet & Danger Banter",
        "quote": "Please drive carefully. If you hurt yourself, I'll kill you. But if you hurt the car, I'll kill your family.",
        "orig_input": os.path.join(SAMPLES_DIR, "bella_orig_s02e06_drive_carefully.wav"),
        "orig_name": "bella_exact_scene3_original.wav",
        "gen_name": "bella_exact_scene3_generated.wav"
    }
]

def clean_and_trim(audio_in, top_db=25):
    y, _ = librosa.effects.trim(audio_in, top_db=top_db)
    return y

def measure(audio, sr=24000):
    dur = len(audio) / sr
    f0, _, _ = librosa.pyin(audio, fmin=librosa.note_to_hz('C3'), fmax=librosa.note_to_hz('C6'), sr=sr)
    valid_f0 = f0[~np.isnan(f0)] if f0 is not None else []
    mean_f0 = float(np.mean(valid_f0)) if len(valid_f0) > 0 else 0.0
    return dur, mean_f0

def main():
    print("="*60)
    print("💎 GENERATING DEFINITIVE EXACT BELLA VOICE BENCHMARK")
    print(f"Formula: {FORMULA}")
    print(f"Speed: {SPEED}")
    print("="*60)

    engine = KokoroEngine(voice=FORMULA, default_speed=SPEED)
    pipeline = engine._get_pipeline(engine.current_lang)
    voice_arg = engine._parse_mixed_voice_formula(engine.current_voice, pipeline)

    metrics_report = []

    for case in CASES:
        print(f"\nProcessing {case['title']}...")
        # 1. Clean original audio
        orig_y, sr = librosa.load(case["orig_input"], sr=24000)
        orig_clean = clean_and_trim(orig_y)
        orig_dur, orig_f0 = measure(orig_clean)
        
        orig_dest = os.path.join(STATIC_DIR, case["orig_name"])
        sf.write(orig_dest, orig_clean, 24000)

        # 2. Synthesize generated audio
        chunks = []
        for res in pipeline(case["quote"], voice=voice_arg, speed=SPEED):
            if hasattr(res, 'audio') and res.audio is not None:
                chunks.append(res.audio.cpu().numpy() if hasattr(res.audio, 'cpu') else np.array(res.audio))
        
        gen_raw = np.concatenate(chunks)
        gen_clean = clean_and_trim(gen_raw)
        gen_dur, gen_f0 = measure(gen_clean)

        gen_dest = os.path.join(STATIC_DIR, case["gen_name"])
        sf.write(gen_dest, gen_clean, 24000)

        dur_diff = abs(gen_dur - orig_dur)
        match_pct = max(0, 100 - (dur_diff / orig_dur * 100))

        report = {
            "title": case["title"],
            "quote": case["quote"],
            "orig_name": case["orig_name"],
            "gen_name": case["gen_name"],
            "orig_dur": round(orig_dur, 2),
            "gen_dur": round(gen_dur, 2),
            "dur_diff": round(dur_diff, 2),
            "match_pct": round(match_pct, 1),
            "orig_f0": round(orig_f0, 1),
            "gen_f0": round(gen_f0, 1)
        }
        metrics_report.append(report)
        print(f"Original:  {orig_dur:.2f}s | F0: {orig_f0:.1f}Hz")
        print(f"Generated: {gen_dur:.2f}s | F0: {gen_f0:.1f}Hz")
        print(f"Duration Delta: {dur_diff:.2f}s ({match_pct:.1f}% Match)")

    print("\n" + "="*60)
    print("✅ All definitive benchmark samples successfully created!")
    print("="*60)

if __name__ == "__main__":
    main()
