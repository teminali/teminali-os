import os
import sys
import time
import soundfile as sf
import numpy as np

# Ensure SSL certs
import certifi
os.environ["SSL_CERT_FILE"] = certifi.where()

from RealtimeTTS import KokoroEngine

OUTPUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "audio_samples"))
STATIC_PREVIEW_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "code", "static", "bella_preview"))

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(STATIC_PREVIEW_DIR, exist_ok=True)

TRUE_BELLA_CANDIDATES = [
    {
        "id": "true_bella_smoky_contessa",
        "name": "💎 True Bella 1: Smoky Contessa (Deep & Aristocratic)",
        "description": "50% Emma (bf_emma) + 35% Isabella (bf_isabella) + 15% Sarah (af_sarah) at 1.03x. Removes all American perkiness and robotic Italian phonemes. Low-register, smoky, poised European aristocracy.",
        "formula": "0.50*bf_emma + 0.35*bf_isabella + 0.15*af_sarah",
        "speed": 1.03,
    },
    {
        "id": "true_bella_seductive_poise",
        "name": "🌹 True Bella 2: Seductive Poise (Breathy & Sharp)",
        "description": "45% Isabella (bf_isabella) + 40% Emma (bf_emma) + 15% Nicole (af_nicole) at 1.04x. Razor-sharp upper-class British diction softened with breathy, intimate vocal fry.",
        "formula": "0.45*bf_isabella + 0.40*bf_emma + 0.15*af_nicole",
        "speed": 1.04,
    },
    {
        "id": "true_bella_velvet_noir",
        "name": "🌙 True Bella 3: Velvet Noir (Lowest Register & Sultry)",
        "description": "55% Emma (bf_emma) + 30% Sarah (af_sarah) + 15% Isabella (bf_isabella) at 1.00x. Lowest, smokiest chest resonance, deliberate unhurried cadence, effortless authority.",
        "formula": "0.55*bf_emma + 0.30*af_sarah + 0.15*bf_isabella",
        "speed": 1.00,
    },
    {
        "id": "true_bella_mediterranean_whisper",
        "name": "✨ True Bella 4: Mediterranean Whisper (90% British + 10% Italian)",
        "description": "45% Emma + 35% Isabella + 10% Sarah + 10% Sara (if_sara) at 1.04x. 90% British aristocratic body with a subtle 10% Mediterranean vocal warmth.",
        "formula": "0.45*bf_emma + 0.35*bf_isabella + 0.10*af_sarah + 0.10*if_sara",
        "speed": 1.04,
    }
]

TEST_SCRIPTS = [
    {
        "tag": "banter",
        "title": "Playful Banter / The Ferrari Bet (S02E06)",
        "text": "You take the car. I take the plane. And I race you. Please drive carefully. If you hurt yourself, I'll kill you. But if you hurt the car, I'll kill your family. Shut up and kiss me."
    },
    {
        "tag": "authority",
        "title": "Negotiation / Direct Authority (S02E02)",
        "text": "How and why my boyfriend was killed is no longer relevant. That door is closed. I will act as an intermediary between you and Marco to ensure there is no friction."
    },
    {
        "tag": "wit",
        "title": "Wicked Humorous Sarcasm (S02E02)",
        "text": "What a wonderful place for an office. Such a masculine atmosphere. You can just taste the testosterone. And yet here you sit, a beautiful rose in a tangle of thorns."
    }
]

def synthesize_to_wav(engine, text: str, output_path: str):
    """Feeds text into Kokoro pipeline and writes resulting 24kHz WAV file."""
    chunks = []
    pipeline = engine._get_pipeline(engine.current_lang)
    if "*" in engine.current_voice:
        voice_arg = engine._parse_mixed_voice_formula(engine.current_voice, pipeline)
    else:
        voice_arg = engine.current_voice

    generator = pipeline(text, voice=voice_arg, speed=engine.speed)
    for result in generator:
        if hasattr(result, 'audio') and result.audio is not None:
            audio = result.audio
            if hasattr(audio, 'cpu'):
                audio_np = audio.cpu().numpy()
            elif isinstance(audio, np.ndarray):
                audio_np = audio
            else:
                audio_np = np.array(audio, dtype=np.float32)
            chunks.append(audio_np)

    if chunks:
        full_audio = np.concatenate(chunks)
        sf.write(output_path, full_audio, 24000)
        print(f"Generated: {output_path} ({len(full_audio)/24000:.2f}s)")
        return True
    return False

def main():
    print("🚀 Generating Precision-Tuned 'True Bella' Samples...")
    
    results = []

    for cand in TRUE_BELLA_CANDIDATES:
        print(f"\n--- Initializing {cand['name']} ({cand['formula']}) ---")
        engine = KokoroEngine(voice=cand["formula"], default_speed=cand["speed"])
        
        cand_data = {**cand, "samples": []}
        for script in TEST_SCRIPTS:
            filename = f"{cand['id']}_{script['tag']}.wav"
            out_file = os.path.join(OUTPUT_DIR, filename)
            static_file = os.path.join(STATIC_PREVIEW_DIR, filename)
            
            print(f"Synthesizing [{script['tag']}]: \"{script['text'][:40]}...\"")
            t0 = time.time()
            if synthesize_to_wav(engine, script["text"], out_file):
                import shutil
                shutil.copyfile(out_file, static_file)
                cand_data["samples"].append({
                    "tag": script["tag"],
                    "title": script["title"],
                    "text": script["text"],
                    "filename": filename,
                    "elapsed": round(time.time() - t0, 2)
                })
        results.append(cand_data)

    print("\n✅ All True Bella samples generated successfully!")

if __name__ == "__main__":
    main()
