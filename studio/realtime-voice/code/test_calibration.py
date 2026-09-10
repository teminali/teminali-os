import json
import urllib.request
import time

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "qwen3:8b"

def run_prompt(system_prompt: str, user_message: str):
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ],
        "stream": False,
        "options": {
            "temperature": 0.7,
            "top_p": 0.9
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

if __name__ == "__main__":
    with open("system_prompt.txt", "r") as f:
        sys_prompt = f.read()
    
    test_cases = [
        "Are you ready?",
        "You there?",
        "Coffee or tea?",
        "I feel like doing nothing today.",
        "Why do we build things if everything eventually dies?",
        "Run the unit tests for me."
    ]
    
    for tc in test_cases:
        ans, el = run_prompt(sys_prompt, tc)
        print(f"\nUser: {tc}")
        print(f"Temi ({el:.2f}s, {len(ans.split())} words):\n{ans}")
