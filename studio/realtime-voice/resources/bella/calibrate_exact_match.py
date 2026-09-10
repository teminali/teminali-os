import os
import sys
import certifi
import soundfile as sf
import numpy as np
import librosa

os.environ["SSL_CERT_FILE"] = certifi.where()

from RealtimeTTS import KokoroEngine

SAMPLES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "audio_samples"))
STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "code", "static", "bella_preview"))

TEST_CASES = [
    {
        "id": "hard_to_get",
        "orig_file": os.path.join(SAMPLES_DIR, "bella_orig_s02e04_hard_to_get.wav"),
        "text": "I'm not playing hard to get. All you have to do is ask, Eddie.",
        "description": "The Falcon Scene (S02E04) — Intimate, sultry, teasing"
    },
    {
        "id": "door_is_closed",
        "orig_file": os.path.join(SAMPLES_DIR, "bella_orig_s02e02_door_is_closed.wav"),
        "text": "How and why my boyfriend was killed is no longer relevant. That door is closed.",
        "description": "The Arrival & Negotiation (S02E02) — Cool, aristocratic, calm authority"
    },
    {
        "id": "drive_carefully",
        "orig_file": os.path.join(SAMPLES_DIR, "bella_orig_s02e06_drive_carefully.wav"),
        "text": "Please drive carefully. If you hurt yourself, I'll kill you. But if you hurt the car, I'll kill your family.",
        "description": "The Ferrari Bet (S02E06) — Playful banter, dangerous charm"
    }
]

def analyze_audio(path):
    y, sr = librosa.load(path, sr=24000)
    dur = len(y) / sr
    
    # Trim leading/trailing silence (>20dB below max)
    yt, _ = librosa.effects.trim(y, top_db=25)
    speech_dur = len(yt) / sr
    
    # F0 analysis
    f0, voiced_flag, voiced_probs = librosa.pyin(y, fmin=librosa.note_to_hz('C3'), fmax=librosa.note_to_hz('C6'), sr=sr)
    valid_f0 = f0[~np.isnan(f0)] if f0 is not None else []
    mean_f0 = float(np.mean(valid_f0)) if len(valid_f0) > 0 else 0.0
    median_f0 = float(np.median(valid_f0)) if len(valid_f0) > 0 else 0.0
    
    # Spectral centroid (brightness / vocal tract resonance)
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    
    return {
        "dur": round(dur, 2),
        "speech_dur": round(speech_dur, 2),
        "mean_f0": round(mean_f0, 1),
        "median_f0": round(median_f0, 1),
        "centroid": round(centroid, 1)
    }

def main():
    print("="*60, flush=True)
    print("🎯 ANALYZING BENEDETTA PORCAROLI'S ORIGINAL VOCAL PROFILE", flush=True)
    print("="*60, flush=True)
    
    orig_profiles = {}
    for case in TEST_CASES:
        p = analyze_audio(case["orig_file"])
        orig_profiles[case["id"]] = p
        print(f"[{case['id']}] Total: {p['dur']}s | Speech: {p['speech_dur']}s | F0: {p['mean_f0']}Hz (median {p['median_f0']}Hz) | Centroid: {p['centroid']}Hz", flush=True)
    
    # Candidate voice formulas to evaluate
    candidates = [
        ("Velvet Aristocrat", "0.50*bf_emma + 0.35*bf_isabella + 0.15*af_sarah"),
        ("Deep Contessa", "0.55*bf_emma + 0.30*af_sarah + 0.15*bf_isabella"),
        ("Sultry Poise", "0.45*bf_isabella + 0.40*bf_emma + 0.15*af_nicole"),
        ("Aristocrat Touch", "0.45*bf_emma + 0.35*bf_isabella + 0.10*af_sarah + 0.10*if_sara")
    ]
    
    print("\n" + "="*60, flush=True)
    print("🔍 CALIBRATING DURATION & ACOUSTIC MATCH", flush=True)
    print("="*60, flush=True)
    
    speeds = [1.16, 1.20, 1.24]
    
    best_match = None
    best_score = 999999
    
    for cand_name, formula in candidates:
        print(f"\n--- Testing Candidate: {cand_name} ({formula}) ---", flush=True)
        for spd in speeds:
            engine = KokoroEngine(voice=formula, default_speed=spd)
            pipeline = engine._get_pipeline(engine.current_lang)
            voice_arg = engine._parse_mixed_voice_formula(engine.current_voice, pipeline)
            
            dur_diffs = []
            f0_diffs = []
            
            for case in TEST_CASES:
                chunks = []
                for res in pipeline(case["text"], voice=voice_arg, speed=spd):
                    if hasattr(res, 'audio') and res.audio is not None:
                        chunks.append(res.audio.cpu().numpy() if hasattr(res.audio, 'cpu') else np.array(res.audio))
                if chunks:
                    audio = np.concatenate(chunks)
                    dur = len(audio) / 24000
                    # trim silence
                    yt, _ = librosa.effects.trim(audio, top_db=25)
                    speech_dur = len(yt) / 24000
                    
                    # F0
                    f0, _, _ = librosa.pyin(audio, fmin=librosa.note_to_hz('C3'), fmax=librosa.note_to_hz('C6'), sr=24000)
                    valid_f0 = f0[~np.isnan(f0)] if f0 is not None else []
                    mean_f0 = float(np.mean(valid_f0)) if len(valid_f0) > 0 else 0.0
                    
                    target_dur = orig_profiles[case["id"]]["speech_dur"]
                    target_f0 = orig_profiles[case["id"]]["mean_f0"]
                    
                    dur_diff = abs(speech_dur - target_dur)
                    f0_diff = abs(mean_f0 - target_f0)
                    dur_diffs.append(dur_diff)
                    f0_diffs.append(f0_diff)
            
            avg_dur_diff = np.mean(dur_diffs)
            avg_f0_diff = np.mean(f0_diffs)
            score = (avg_dur_diff * 10) + (avg_f0_diff * 0.1)
            print(f"Speed {spd:.2f} -> Avg Speech Duration Error: {avg_dur_diff:.2f}s | Avg F0 Error: {avg_f0_diff:.1f}Hz | Score: {score:.2f}", flush=True)
            
            if score < best_score:
                best_score = score
                best_match = {
                    "name": cand_name,
                    "formula": formula,
                    "speed": spd,
                    "avg_dur_diff": avg_dur_diff,
                    "avg_f0_diff": avg_f0_diff
                }

    print("\n" + "="*60, flush=True)
    print(f"🏆 BEST EXACT MATCH: {best_match['name']}", flush=True)
    print(f"Formula: {best_match['formula']}", flush=True)
    print(f"Speed: {best_match['speed']}", flush=True)
    print(f"Average Duration Delta: ±{best_match['avg_dur_diff']:.2f}s", flush=True)
    print(f"Average F0 Pitch Delta: ±{best_match['avg_f0_diff']:.1f}Hz", flush=True)
    print("="*60, flush=True)

if __name__ == "__main__":
    main()
