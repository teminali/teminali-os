Here is the complete architectural breakdown and developer lesson extracted from the video. This documentation is formatted specifically for you to drop into Antigravity so you can begin scaffolding the local environment.

## **End-to-End Local Voice Agent: Architecture & Optimization Guide**

This document outlines the architecture for a fully local, low-latency agentic voice assistant capable of running entirely on a single 12GB VRAM GPU (based on the *Pythagoras* open-source framework).

### **1\. The Model Stack**

To fit an entire agentic stack on a 12GB card without sacrificing capability, model selection and aggressive offloading are critical.

| Component | Model Selected | Justification / Configuration |
| :---- | :---- | :---- |
| **LLM (Brain)** | Qwen 35B Mixture of Experts (MoE) | Strikes the balance between speed and agentic capability. Most experts are pushed to system RAM/CPU, keeping VRAM usage minimal while maintaining \~40 tokens/sec. |
| **TTS (Voice)** | Breeze TTS2 (3.5B Parameters) | High-quality open-weights model. **Crucial:** Run via audio.cpp with Q8 quantization (instead of BF16) to support audio streaming and save \~4GB of VRAM. |
| **ASR (Ears)** | Whisper | Lightweight (\~140MB footprint). |
| **VAD (Turn Detection)** | Silero VAD | Handles turn-taking. Listens for when the user starts and stops speaking. |
| **Vision** | Standard Vision Encoder | Added for multimodal tasks (\~1GB footprint). |

### **2\. VRAM Allocation Strategy (12GB Limit)**

Fitting this on one card requires precise memory budgeting. Here is the final breakdown to replicate:

* **LLM Weights:** \~2 GB (Heavy CPU offloading for MoE experts).  
* **LLM Context (100k tokens):** \~1 GB.  
* **LLM Compute Buffer:** \~500 MB.  
* **MTP (Multi-Token Prediction):** \~400 MB (Speeds up tool calls as they are highly predictable).  
* **Breeze TTS2 (Q8 Quantized):** \~4.5 GB (Reduced from 8.5GB by switching from BF16 to Q8).  
* **Vision Encoder:** \~1 GB.  
* **Whisper:** \~140 MB.  
* **Remaining:** \~1.4 GB buffer for sudden memory spikes during operation.

### **3\. Achieving Sub-3s Latency (The Implementation Core)**

The hardest part of building a voice agent is the harness. A naive sequential pipeline (Wait \-\> Transcribe \-\> Think \-\> Generate Text \-\> Generate Audio \-\> Play) takes 8-10 seconds. You must implement the following optimizations to cut latency to \~2.5 seconds.

&nbsp;

&nbsp;

&nbsp;

&nbsp;

**1.Continuous Transcription:**Eliminates ASR wait time.

Instead of waiting for the user to finish speaking before transcribing, transcribe the audio stream in chunks *while* the user is talking (every couple of seconds). When Silero VAD detects the user has stopped, the text is already ready. *Note: Leave a deliberate \~1-second VAD silence threshold so the agent doesn't interrupt "ums" or brief pauses.*

&nbsp;

&nbsp;

**2.Bypass Initial 'Thinking':**Fixes LLM hesitation.

Modern reasoning models take time to output their first token. Configure the LLM so that "thinking" (Chain of Thought) is disabled for the very first immediate response/greeting, but re-enabled for subsequent tool calls and background work.

&nbsp;

&nbsp;

**3.Sentence-Level Chunking:**Eliminates LLM generation wait time.

Do not wait for the LLM to generate the entire response. As the LLM writes, cut the text into phrases at the end of every sentence (or short 3-word chunks). Dispatch the first completed sentence directly to the TTS engine while the LLM continues generating the rest in the background.

&nbsp;

&nbsp;

**4.Parallel TTS Queuing:**Eliminates gaps between sentences.

While Sentence 1 is playing, the TTS engine must already be generating Sentence 2\. Keep up to two finished audio sentences in a queue so the speaker always has audio ready to pull. *Requirement: Your TTS must generate audio slightly faster than real-time playback (e.g., 1.1x speed).*

&nbsp;

&nbsp;

**5.Streaming Audio Playback:**Eliminates TTS generation wait time.

By running Breeze TTS2 through audio.cpp, you unlock streaming audio. The speaker can start playing the audio buffer almost as soon as the TTS model starts generating it, rather than waiting for the whole sentence's audio file to render.

### **4\. Agentic Workflow & UX Enhancements**

A fast voice is just a toy; an agent needs to do work. Because tool use (like browsing) introduces unavoidable delays, you must engineer the UX to mask the latency.

* **Fixing Prefill Bottlenecks:** Reading a web page or tool output can take 15,000+ tokens. With a standard micro-batch size of 128, this takes 1.5 minutes. **Fix:** Use the VRAM saved from quantizing the TTS model to increase the micro-batch size to 1024 and pull a few expert layers back to the GPU. This pushes prefill speeds from 200 to 800 tokens/second.  
* **Context Caching:** Save the conversation cache to disk. The model should never re-read the whole conversation history on every turn—it should only read the delta (what's new).  
* **The "Audio Mode" Prompt Tag:** Prefix incoming voice prompts with an \[Audio Mode\] tag. Instruct the system prompt that when this tag is present, the AI must keep responses brief and verbally announce any tool it is about to use before executing it.  
* **Verbal Fillers for Dead Air:** When the agent is executing a long tool call or compacting its context window, it will output no text, resulting in dead air. Implement a system that detects these states and injects randomized pre-recorded TTS phrases (e.g., *"Let me think about that for a moment..."* or *"My context is getting full, let me compact our conversation..."*).

### **Next Steps for Antigravity**

To start implementing this, I recommend scaffolding the project in this order:

> 1. **The Audio VAD/ASR loop:** Get Silero and Whisper streaming text to the console continuously.  
> 2. **The LLM/TTS Pipeline:** Connect the Qwen model and implement the sentence-chunking logic feeding into audio.cpp.  
> 3. **The Agent Harness:** Add the caching, the increased micro-batching, and the tool-calling logic with verbal filler injections.