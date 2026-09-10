class TTSPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferQueue = [];
    this.readOffset = 0;
    this.samplesRemaining = 0;
    this.isPlaying = false;
    this.silenceSamples = 0;
    // At 48kHz, 120ms debounce is ~5760 samples (approx 45 process cycles of 128 samples)
    this.debounceSampleThreshold = 5760;

    /* Captions are paced by what the speaker has actually emitted, not by what
       the model has generated -- the model runs several seconds ahead of the
       voice, so text that follows generation reads like a transcript arriving
       before the sentence is spoken. Only this node knows how much audio has
       truly left the buffer, so it is the one that reports it. Counted per
       utterance and posted at ~50ms, which is finer than a spoken syllable and
       far cheaper than a message per render quantum. */
    this.samplesPlayed = 0;
    this.progressIntervalSamples = 2400;
    this.samplesSinceProgress = 0;

    // Listen for incoming messages
    this.port.onmessage = (event) => {
      // Check if this is a control message (object with a "type" property).
      if (event.data && typeof event.data === "object" && event.data.type === "clear") {
        // Immediate hard cut on interruption
        this.bufferQueue = [];
        this.readOffset = 0;
        this.samplesRemaining = 0;
        this.silenceSamples = 0;
        this.samplesPlayed = 0;
        this.samplesSinceProgress = 0;
        if (this.isPlaying) {
          this.isPlaying = false;
          this.port.postMessage({ type: 'ttsPlaybackStopped' });
        }
        return;
      }
      
      if (event.data && typeof event.data === "object" && event.data.type === "resetProgress") {
        /* A new spoken turn. Not the same thing as playback resuming: the
           buffer underruns for ~120ms between sentences all the time, and
           restarting the caption clock there would rewind the text mid-reply. */
        this.samplesPlayed = 0;
        this.samplesSinceProgress = 0;
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
          this.port.postMessage({ type: 'ttsPlaybackStopped' });
        }
      }
      return true;
    }

    this.silenceSamples = 0;

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.port.postMessage({ type: 'ttsPlaybackStarted' });
    }

    let outIdx = 0;
    while (outIdx < outputChannel.length && this.bufferQueue.length > 0) {
      const currentBuffer = this.bufferQueue[0];
      const sampleValue = currentBuffer[this.readOffset] / 32768;
      outputChannel[outIdx++] = sampleValue;

      this.readOffset++;
      this.samplesRemaining--;
      this.samplesPlayed++;
      this.samplesSinceProgress++;

      if (this.readOffset >= currentBuffer.length) {
        this.bufferQueue.shift();
        this.readOffset = 0;
      }
    }

    while (outIdx < outputChannel.length) {
      outputChannel[outIdx++] = 0;
    }

    if (this.samplesSinceProgress >= this.progressIntervalSamples) {
      this.samplesSinceProgress = 0;
      this.port.postMessage({
        type: 'ttsProgress',
        secondsPlayed: this.samplesPlayed / sampleRate,
      });
    }

    return true;
  }
}

registerProcessor('tts-playback-processor', TTSPlaybackProcessor);
