class TTSPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferQueue = [];
    this.readOffset = 0;
    this.samplesRemaining = 0;
    this.isPlaying = false;
    this.silenceSamples = 0;
    // At 48kHz, 400ms debounce is ~19200 samples to prevent inter-sentence gap flapping
    this.debounceSampleThreshold = 19200;

    // Listen for incoming messages
    this.port.onmessage = (event) => {
      // Check if this is a control message (object with a "type" property).
      if (event.data && typeof event.data === "object" && event.data.type === "clear") {
        // Immediate hard cut on interruption
        this.bufferQueue = [];
        this.readOffset = 0;
        this.samplesRemaining = 0;
        this.silenceSamples = 0;
        if (this.isPlaying) {
          this.isPlaying = false;
          this.port.postMessage({ type: 'ttsPlaybackStopped' });
        }
        return;
      }
      
      // Otherwise assume it's a PCM chunk (e.g., an Int16Array)
      this.bufferQueue.push(event.data);
      this.samplesRemaining += event.data.length;
      this.silenceSamples = 0; // Reset silence counter on incoming audio
    };
  }

  process(inputs, outputs) {
    const outputChannel = outputs[0][0];

    if (this.samplesRemaining === 0) {
      outputChannel.fill(0);
      if (this.isPlaying) {
        this.silenceSamples += outputChannel.length;
        if (this.silenceSamples >= this.debounceSampleThreshold) {
          this.isPlaying = false;
          this.silenceSamples = 0;
          this.lastReported = 0;
          this.port.postMessage({ type: 'ttsPlaybackStopped' });
        }
      }
      return true;
    }

    this.silenceSamples = 0;

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.samplesPlayed = 0;
      this.port.postMessage({ type: 'ttsPlaybackStarted' });
    }

    this.samplesPlayed = (this.samplesPlayed || 0) + outputChannel.length;
    // ~every 40ms at 48kHz. Frequent enough to look continuous, rare enough not to
    // flood the main thread from the audio thread.
    if ((this.samplesPlayed - (this.lastReported || 0)) >= 1920) {
      this.lastReported = this.samplesPlayed;
      this.port.postMessage({ type: 'ttsPlaybackProgress', samplesPlayed: this.samplesPlayed });
    }

    let outIdx = 0;
    while (outIdx < outputChannel.length && this.bufferQueue.length > 0) {
      const currentBuffer = this.bufferQueue[0];
      const sampleValue = currentBuffer[this.readOffset] / 32768;
      outputChannel[outIdx++] = sampleValue;

      this.readOffset++;
      this.samplesRemaining--;

      if (this.readOffset >= currentBuffer.length) {
        this.bufferQueue.shift();
        this.readOffset = 0;
      }
    }

    while (outIdx < outputChannel.length) {
      outputChannel[outIdx++] = 0;
    }

    return true;
  }
}

registerProcessor('tts-playback-processor', TTSPlaybackProcessor);
