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

CANDIDATES = [
    {
        "id": "candidate_1_aristocrat",
        "name": "Bella 1: The Aristocrat",
        "description": "45% Italian (if_sara) + 35% British (bf_isabella) + 20% Bella (af_bella). Refined European aristocracy, melodic and poised.",
        "formula": "0.45*if_sara + 0.35*bf_isabella + 0.20*af_bella",
        "speed": 1.12,
    },
    {
        "id": "candidate_2_sultry_smoky",
        "name": "Bella 2: Sultry & Smoky",
        "description": "40% Italian (if_sara) + 35% Nicole (af_nicole) + 25% British Emma (bf_emma). Deeper, smokier vocal register with quiet authority.",
        "formula": "0.40*if_sara + 0.35*af_nicole + 0.25*bf_emma",
        "speed": 1.10,
    },
    {
        "id": "candidate_3_contessa_charme",
        "name": "Bella 3: Contessa Charme",
        "description": "55% Italian (if_sara) + 30% British (bf_isabella) + 15% Heart (af_heart). Rich Italian lilt, warm, disarming, and deeply charismatic.",
        "formula": "0.55*if_sara + 0.30*bf_isabella + 0.15*af_heart",
        "speed": 1.12,
    },
    {
        "id": "candidate_4_razor_wit",
        "name": "Bella 4: Razor Wit",
        "description": "30% Italian (if_sara) + 40% British (bf_isabella) + 30% Bella (af_bella). Faster tempo, razor-sharp dialogue delivery for banter and negotiations.",
        "formula": "0.30*if_sara + 0.40*bf_isabella + 0.30*af_bella",
        "speed": 1.15,
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
    import torch
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
    print("🚀 Starting Bella Voice Sample Generation...")
    
    # Check if raw reference clips exist, copy to static preview
    for ref_name in ["bella_raw_reference_s02e02.wav", "bella_raw_reference_s02e04.wav", "bella_raw_reference_s02e06.wav"]:
        src = os.path.join(OUTPUT_DIR, ref_name)
        if os.path.exists(src):
            dst = os.path.join(STATIC_PREVIEW_DIR, ref_name)
            import shutil
            shutil.copyfile(src, dst)
            print(f"Copied original TV reference: {ref_name}")

    results = []

    for cand in CANDIDATES:
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

    # Generate the HTML preview player
    generate_html_player(results)
    print("\n✅ All voice samples generated and preview player built!")

def generate_html_player(candidates):
    html = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bella Soranza Voice Audition Lab — The Gentlemen Season 2</title>
    <style>
        :root {
            --bg: #0d0f12;
            --surface: #161a22;
            --surface-card: #1c212d;
            --border: #283040;
            --accent: #d4af37;
            --accent-glow: rgba(212, 175, 55, 0.25);
            --text-main: #f0f3f8;
            --text-sub: #9ba3b4;
            --success: #10b981;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        body {
            background-color: var(--bg);
            color: var(--text-main);
            padding: 40px 20px;
            display: flex;
            justify-content: center;
        }
        .container {
            max-width: 1080px;
            width: 100%;
        }
        .header {
            text-align: center;
            margin-bottom: 40px;
            border-bottom: 1px solid var(--border);
            padding-bottom: 30px;
        }
        .header h1 {
            font-size: 2.4rem;
            color: var(--accent);
            letter-spacing: -0.5px;
            margin-bottom: 8px;
            text-shadow: 0 0 25px var(--accent-glow);
        }
        .header p {
            color: var(--text-sub);
            font-size: 1.1rem;
            max-width: 700px;
            margin: 0 auto 15px auto;
            line-height: 1.5;
        }
        .badge {
            display: inline-block;
            background: rgba(212, 175, 55, 0.15);
            color: var(--accent);
            border: 1px solid rgba(212, 175, 55, 0.3);
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 600;
        }
        .section-title {
            font-size: 1.4rem;
            margin: 35px 0 15px 0;
            display: flex;
            align-items: center;
            gap: 10px;
            color: #ffffff;
        }
        .reference-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 16px;
            margin-bottom: 40px;
        }
        .ref-card {
            background: var(--surface);
            border: 1px solid #3b3a2a;
            border-radius: 12px;
            padding: 18px;
        }
        .ref-card h4 {
            color: var(--accent);
            margin-bottom: 6px;
            font-size: 1rem;
        }
        .ref-card p {
            color: var(--text-sub);
            font-size: 0.85rem;
            margin-bottom: 12px;
            line-height: 1.4;
        }
        audio {
            width: 100%;
            height: 38px;
            filter: invert(0.9) hue-rotate(180deg);
        }
        .candidates-list {
            display: flex;
            flex-direction: column;
            gap: 30px;
        }
        .candidate-card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
            transition: transform 0.2s ease, border-color 0.2s ease;
        }
        .candidate-card:hover {
            border-color: var(--accent);
            box-shadow: 0 8px 30px rgba(0,0,0,0.5);
        }
        .cand-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 14px;
            border-bottom: 1px solid rgba(255,255,255,0.06);
            padding-bottom: 12px;
        }
        .cand-title {
            font-size: 1.3rem;
            font-weight: 700;
            color: #fff;
        }
        .cand-desc {
            color: var(--text-sub);
            font-size: 0.92rem;
            margin-top: 4px;
        }
        .cand-formula {
            background: #11141b;
            padding: 6px 12px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 0.82rem;
            color: #38bdf8;
            border: 1px solid #1e2638;
            white-space: nowrap;
        }
        .samples-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 16px;
            margin-top: 16px;
        }
        .sample-box {
            background: var(--surface-card);
            border: 1px solid rgba(255,255,255,0.05);
            border-radius: 10px;
            padding: 14px;
        }
        .sample-box .tag {
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 700;
            color: var(--accent);
            margin-bottom: 6px;
        }
        .sample-box .quote {
            font-size: 0.85rem;
            font-style: italic;
            color: #d1d5db;
            margin-bottom: 12px;
            line-height: 1.35;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <span class="badge">Character Acoustic Engineering</span>
            <h1>Countess Isabella "Bella" Soranza</h1>
            <p>Voice Audition & Acoustic Benchmark Lab — Compare authentic extracted episode dialogue of Benedetta Porcaroli against 4 custom-engineered Kokoro acoustic blends.</p>
        </div>

        <div class="section-title">
            <span>🎬</span> Original TV Show Vocal References (Center Channel Dialogue Track)
        </div>
        <div class="reference-grid">
            <div class="ref-card">
                <h4>S02E02 — Direct Negotiation & Arrival</h4>
                <p>"How and why my boyfriend was killed is no longer relevant. That door is closed... Marco asked me to take Cico's place."</p>
                <audio controls src="bella_raw_reference_s02e02.wav"></audio>
            </div>
            <div class="ref-card">
                <h4>S02E04 — The Falcon & Seduction</h4>
                <p>"My pleasure. I'm not playing hard to get. All you have to do is ask, Eddie."</p>
                <audio controls src="bella_raw_reference_s02e04.wav"></audio>
            </div>
            <div class="ref-card">
                <h4>S02E06 — The Ferrari Bet & Goodbye</h4>
                <p>"You take the car. I take the plane. If you hurt the car, I'll kill your family. Shut up and kiss me."</p>
                <audio controls src="bella_raw_reference_s02e06.wav"></audio>
            </div>
        </div>

        <div class="section-title">
            <span>✨</span> Engineered Bella Voice Candidates (Real-time Synthesis)
        </div>
        <div class="candidates-list">
"""

    for cand in candidates:
        html += f"""
            <div class="candidate-card">
                <div class="cand-header">
                    <div>
                        <div class="cand-title">{cand['name']}</div>
                        <div class="cand-desc">{cand['description']}</div>
                    </div>
                    <div class="cand-formula">{cand['formula']} ({cand['speed']}x)</div>
                </div>
                <div class="samples-grid">
        """
        for sample in cand["samples"]:
            html += f"""
                    <div class="sample-box">
                        <div class="tag">{sample['title']}</div>
                        <div class="quote">"{sample['text']}"</div>
                        <audio controls src="{sample['filename']}"></audio>
                    </div>
            """
        html += """
                </div>
            </div>
        """

    html += """
        </div>
    </div>
</body>
</html>
"""
    player_path = os.path.join(STATIC_PREVIEW_DIR, "index.html")
    with open(player_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"HTML Player created at: {player_path}")

if __name__ == "__main__":
    main()
