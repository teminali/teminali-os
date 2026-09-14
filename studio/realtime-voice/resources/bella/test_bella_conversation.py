import asyncio
import json
import time
import websockets

async def test_bella():
    uri = "ws://localhost:8000/ws"
    print(f"Connecting to {uri}...")
    async with websockets.connect(uri) as ws:
        print("Connected to Countess Bella WebSocket!")
        
        # Drain initial messages
        await asyncio.sleep(0.5)
        while True:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=0.5)
                # print("Init msg:", msg[:80])
            except asyncio.TimeoutError:
                break
        
        test_prompts = [
            "Good evening, Bella.",
            "I'm thinking of challenging you to a race across Switzerland.",
            "Thank you, Countess."
        ]
        
        for prompt in test_prompts:
            print(f"\n🗣️ USER: {prompt}")
            payload = {
                "type": "text_input",
                "text": prompt
            }
            t0 = time.time()
            await ws.send(json.dumps(payload))
            
            first_token_time = None
            final_answer = ""
            audio_chunks = 0
            
            while True:
                try:
                    res = await asyncio.wait_for(ws.recv(), timeout=12.0)
                except asyncio.TimeoutError:
                    print("Timeout waiting for assistant turn.")
                    break
                
                if isinstance(res, bytes):
                    audio_chunks += 1
                    continue
                
                data = json.loads(res)
                mtype = data.get("type")
                
                if mtype in ("partial_assistant_answer", "quick_answer_chunk"):
                    if first_token_time is None:
                        first_token_time = time.time() - t0
                
                elif mtype == "final_assistant_answer":
                    final_answer = data.get("content", "")
                    total_time = time.time() - t0
                    ttft_str = f"{first_token_time:.2f}s" if first_token_time else "N/A"
                    print(f"✨ BELLA: {final_answer}")
                    print(f"⏱️ TTFT: {ttft_str} | Total: {total_time:.2f}s | Audio Chunks: {audio_chunks}")
                    break

asyncio.run(test_bella())
