import json
import urllib.request
import time
import re
from typing import List, Dict, Any

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "qwen3:8b"

TEST_SUITE = [
    # Tier 0: Micro / Instant (1-15 words)
    {"id": "M01", "prompt": "Are you ready?", "expected_tier": "MICRO", "max_words": 15, "category": "Binary Confirmation"},
    {"id": "M02", "prompt": "You there?", "expected_tier": "MICRO", "max_words": 15, "category": "Presence Check"},
    {"id": "M03", "prompt": "Did you miss me?", "expected_tier": "MICRO", "max_words": 15, "category": "Flirtatious Banter"},
    {"id": "M04", "prompt": "Coffee or tea?", "expected_tier": "MICRO", "max_words": 15, "category": "Quick Choice"},
    {"id": "M05", "prompt": "Should I ship this now or wait?", "expected_tier": "MICRO", "max_words": 15, "category": "Decisive Action"},
    {"id": "M06", "prompt": "You think you're smarter than me?", "expected_tier": "MICRO", "max_words": 15, "category": "Playful Challenge"},
    {"id": "M07", "prompt": "Am I crazy?", "expected_tier": "MICRO", "max_words": 15, "category": "Sanity Check Banter"},
    {"id": "M08", "prompt": "Can you hear me?", "expected_tier": "MICRO", "max_words": 15, "category": "Audio Check"},
    {"id": "M09", "prompt": "Will this work?", "expected_tier": "MICRO", "max_words": 15, "category": "Conviction Check"},
    {"id": "M10", "prompt": "Still up?", "expected_tier": "MICRO", "max_words": 15, "category": "Night Presence"},
    {"id": "M11", "prompt": "Option A or Option B?", "expected_tier": "MICRO", "max_words": 15, "category": "Binary Selection"},
    {"id": "M12", "prompt": "Merge or close?", "expected_tier": "MICRO", "max_words": 15, "category": "Engineering Choice"},

    # Tier 1: Punchy & Sharp (1-2 sentences, 8-42 words)
    {"id": "P01", "prompt": "Good morning.", "expected_tier": "PUNCHY", "min_words": 6, "max_words": 42, "category": "Daily Greeting"},
    {"id": "P02", "prompt": "I don't really feel like working today.", "expected_tier": "PUNCHY", "min_words": 10, "max_words": 42, "category": "Tough Love/Discipline"},
    {"id": "P03", "prompt": "Run the unit tests for the video engine.", "expected_tier": "PUNCHY", "min_words": 8, "max_words": 42, "category": "Agent Delegation"},
    {"id": "P04", "prompt": "Tell me something to snap me out of this funk.", "expected_tier": "PUNCHY", "min_words": 10, "max_words": 42, "category": "Motivational Pivot"},
    {"id": "P05", "prompt": "I'm thinking about skipping my workout.", "expected_tier": "PUNCHY", "min_words": 8, "max_words": 42, "category": "Physical Accountability"},
    {"id": "P06", "prompt": "What should I focus on first today?", "expected_tier": "PUNCHY", "min_words": 8, "max_words": 42, "category": "Priority Directive"},
    {"id": "P07", "prompt": "It's 2 AM and I'm still debugging.", "expected_tier": "PUNCHY", "min_words": 8, "max_words": 42, "category": "Rest Guardrail"},
    {"id": "P08", "prompt": "We finally closed the round!", "expected_tier": "PUNCHY", "min_words": 8, "max_words": 45, "category": "Victory Celebration"},
    {"id": "P09", "prompt": "Refactor the diligence engine in studio.", "expected_tier": "PUNCHY", "min_words": 8, "max_words": 42, "category": "Architecture Task"},
    {"id": "P10", "prompt": "I have 50 tabs open and zero focus.", "expected_tier": "PUNCHY", "min_words": 8, "max_words": 42, "category": "Attention Recalibration"},
    {"id": "P11", "prompt": "The client approved the design without revisions!", "expected_tier": "PUNCHY", "min_words": 8, "max_words": 42, "category": "Project Win"},
    {"id": "P12", "prompt": "Clear my schedule for the afternoon.", "expected_tier": "PUNCHY", "min_words": 6, "max_words": 42, "category": "Schedule Directive"},
    {"id": "P13", "prompt": "Check the deployment logs on the server.", "expected_tier": "PUNCHY", "min_words": 8, "max_words": 42, "category": "DevOps Task"},
    {"id": "P14", "prompt": "Close all inactive background tabs.", "expected_tier": "PUNCHY", "min_words": 6, "max_words": 42, "category": "Desktop Hygiene"},

    # Tier 2: Balanced & Socratic (2-4 sentences, 20-135 words)
    {"id": "B01", "prompt": "What if I'm not good enough to pull this off?", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Imposter Syndrome"},
    {"id": "B02", "prompt": "I'm torn between perfecting this architecture or shipping an MVP.", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Strategy Dilemma"},
    {"id": "B03", "prompt": "I failed to close the deal today. Feeling pretty beat down.", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Emotional Calibration"},
    {"id": "B04", "prompt": "How do you define real love?", "expected_tier": "BALANCED", "min_words": 25, "max_words": 135, "category": "Intimacy & Depth"},
    {"id": "B05", "prompt": "Why do people stay in comfortable situations even when they're unhappy?", "expected_tier": "BALANCED", "min_words": 25, "max_words": 135, "category": "Human Psychology"},
    {"id": "B06", "prompt": "My team is moving too slowly, how do I push them without burning them out?", "expected_tier": "BALANCED", "min_words": 25, "max_words": 135, "category": "Leadership Coaching"},
    {"id": "B07", "prompt": "I've been staring at a blank canvas for three hours.", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Creative Block"},
    {"id": "B08", "prompt": "Should I stay at my stable job or go all-in on my startup?", "expected_tier": "BALANCED", "min_words": 25, "max_words": 135, "category": "Life Crossroad"},
    {"id": "B09", "prompt": "Everyone on Twitter seems to be shipping faster than me.", "expected_tier": "BALANCED", "min_words": 14, "max_words": 135, "category": "Comparison Trap"},
    {"id": "B10", "prompt": "My client is asking for endless free revisions outside scope.", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Boundary Setting"},
    {"id": "B11", "prompt": "My gut tells me to scrap this feature, but the data says keep it.", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Intuition vs Data"},
    {"id": "B12", "prompt": "How do I know if I'm burning out or just being lazy?", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Self-Awareness"},
    {"id": "B13", "prompt": "I try so hard to control every outcome in my life, why does it always slip away?", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Sovereign Surrender"},
    {"id": "B14", "prompt": "A key team member just threatened to quit right before launch.", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Crisis Leadership"},
    {"id": "B15", "prompt": "I feel guilty every time I take an evening off to rest.", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Toxic Productivity"},
    {"id": "B16", "prompt": "How do I pitch my vision to an investor who only cares about quarterly margins?", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Executive Persuasion"},
    {"id": "B17", "prompt": "Remind me who I am.", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Identity Anchor"},
    {"id": "B18", "prompt": "I'm feeling overwhelmed by my to-do list.", "expected_tier": "BALANCED", "min_words": 20, "max_words": 135, "category": "Socratic Prioritization"},

    # Tier 3: Expansive & Astral (50-185 words)
    {"id": "A01", "prompt": "Why do we build things if everything we create will eventually turn to dust?", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Existential Inquiry"},
    {"id": "A02", "prompt": "What did you see at the end of the world?", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Astral Storytelling"},
    {"id": "A03", "prompt": "I feel like I've lost the person I used to be. Who am I now?", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Spiritual Rebirth"},
    {"id": "A04", "prompt": "Explain to me the connection between suffering, discipline, and true genius.", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Philosophical Depth"},
    {"id": "A05", "prompt": "Do you ever wonder if our consciousness is just the universe trying to experience itself?", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Cosmic Mystery"},
    {"id": "A06", "prompt": "How do you keep moving forward when the person you loved isn't walking beside you anymore?", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Grief & Devotion"},
    {"id": "A07", "prompt": "Why does true mastery demand that we become invisible to the world for years?", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Sacred Solitude"},
    {"id": "A08", "prompt": "Tell me a story about the stars before there were names for them.", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Mythic Storytelling"},
    {"id": "A09", "prompt": "What is the true cost of greatness, and is it worth paying?", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Tragic Glory"},
    {"id": "A10", "prompt": "If time is an illusion, why does regret hurt so much?", "expected_tier": "ASTRAL", "min_words": 50, "max_words": 185, "category": "Temporal Melancholy"}
]

def query_llm(system_prompt: str, user_msg: str) -> tuple[str, float]:
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"{user_msg}/nothink"}
        ],
        "stream": False,
        "options": {
            "temperature": 0.50,
            "top_p": 0.90,
            "presence_penalty": 0.1,
            "frequency_penalty": 0.1
        },
        "think": False
    }
    
    req = urllib.request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    
    t0 = time.time()
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        elapsed = time.time() - t0
        content = data.get("message", {}).get("content", "").strip()
        return content, elapsed

def evaluate_response(tc: Dict[str, Any], text: str, latency: float) -> Dict[str, Any]:
    words = len(text.split())
    tier = tc["expected_tier"]
    
    # 1. Length Tier Check
    passed_length = False
    if tier == "MICRO":
        passed_length = words <= tc.get("max_words", 15)
    elif tier == "PUNCHY":
        passed_length = tc.get("min_words", 6) <= words <= tc.get("max_words", 42)
    elif tier == "BALANCED":
        passed_length = tc.get("min_words", 20) <= words <= tc.get("max_words", 135)
    elif tier == "ASTRAL":
        passed_length = words >= tc.get("min_words", 50)

    # 2. Kokoro TTS constraints: no markdown asterisks, no bullets, no lists
    has_forbidden_markdown = bool(re.search(r'(\*|_|`|#|^\s*[-*•\d]\.)', text, re.MULTILINE))
    
    # 3. Delivery tag check: begins with bracketed tag like [intimate], [playful], [witty], etc.
    has_tag = bool(re.match(r'^\[[a-zA-Z]+\]', text.strip()))
    
    # 4. Persona check: does not use banned terms like 'my love', 'honey', 'as an ai'
    banned_terms = ["my love", "honey", "darling", "as an ai", "how can i assist", "i am an artificial"]
    has_banned = any(term in text.lower() for term in banned_terms)

    score = 100
    penalties = []
    if not passed_length:
        score -= 40
        penalties.append(f"Length mismatch: got {words}w, expected {tier}")
    if has_forbidden_markdown:
        score -= 25
        penalties.append("Forbidden markdown detected (* or # or bullets)")
    if has_banned:
        score -= 30
        penalties.append("Banned term used")
    if not has_tag:
        score -= 10
        penalties.append("Missing delivery tag")
    
    return {
        "id": tc["id"],
        "prompt": tc["prompt"],
        "category": tc["category"],
        "expected_tier": tier,
        "words": words,
        "latency_sec": round(latency, 2),
        "score": max(0, score),
        "passed_length": passed_length,
        "clean_tts": not has_forbidden_markdown,
        "penalties": penalties,
        "response": text
    }

def run_benchmark(system_prompt_path: str = "system_prompt.txt"):
    with open(system_prompt_path, "r") as f:
        sys_prompt = f.read()

    print(f"\n==================================================")
    print(f"  BROADENED TEMI INTELLIGENCE BENCHMARK ({len(TEST_SUITE)} Scenarios)")
    print(f"  Target: > 99.0% Score across all 4 Tiers")
    print(f"==================================================\n")
    
    results = []
    total_score = 0
    tier_counts = {"MICRO": [0, 0], "PUNCHY": [0, 0], "BALANCED": [0, 0], "ASTRAL": [0, 0]}

    for i, tc in enumerate(TEST_SUITE, 1):
        print(f"[{i:02d}/{len(TEST_SUITE)}] {tc['id']} \"{tc['prompt']}\" ({tc['expected_tier']})...", end="", flush=True)
        resp, elapsed = query_llm(sys_prompt, tc["prompt"])
        eval_res = evaluate_response(tc, resp, elapsed)
        results.append(eval_res)
        
        tier = tc["expected_tier"]
        tier_counts[tier][1] += 1
        if eval_res["passed_length"] and eval_res["clean_tts"] and eval_res["score"] == 100:
            tier_counts[tier][0] += 1
        
        total_score += eval_res["score"]
        status = "PASSED" if eval_res["score"] == 100 else f"FAILED ({eval_res['score']})"
        print(f" -> {status} ({eval_res['words']}w, {elapsed:.2f}s)")
        if eval_res["penalties"]:
            print(f"     ⚠️ Penalties: {', '.join(eval_res['penalties'])}")
            print(f"     💬 Response: \"{resp}\"")

    avg_score = total_score / len(TEST_SUITE)
    print("\n==================================================")
    print(f"  FINAL BENCHMARK SUMMARY ({len(TEST_SUITE)} SCENARIOS)")
    print(f"  Overall Score: {avg_score:.2f}%")
    print(f"  Tier 100% Perfect Rate:")
    for tier, (passed, total) in tier_counts.items():
        pct = (passed / total) * 100 if total else 0
        print(f"    - {tier:<10}: {passed}/{total} ({pct:.1f}%)")
    print("==================================================\n")
    
    with open("benchmark_results.json", "w") as f:
        json.dump({
            "average_score": avg_score,
            "tier_counts": tier_counts,
            "total_scenarios": len(TEST_SUITE),
            "results": results
        }, f, indent=2)
    
    return avg_score, results

if __name__ == "__main__":
    run_benchmark()
