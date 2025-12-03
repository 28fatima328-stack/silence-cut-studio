
/**
 * Configuration for silence removal.
 */
export interface SilenceOptions {
  /**
   * 0 to 1. How much of the detected silence duration to remove.
   * 0.7 means remove 70% of the silent gap, leaving 30%.
   */
  removeRatio: number; 
  /**
   * Decibel threshold to consider as silence. Default -40dB.
   */
  thresholdDb?: number;
  /**
   * Minimum duration of silence (in seconds) to trigger removal. Default 0.2s.
   */
  minSilenceDuration?: number;
  /**
   * Padding in seconds to keep around speech. 
   * Prevents cutting off the attack/decay of words. Default 0.15s.
   */
  padding?: number;
}

export interface AudioRegion {
  start: number; // sample index
  end: number;   // sample index
  isSilence: boolean;
}

export interface ProcessResult {
  buffer: AudioBuffer;
  regions: AudioRegion[];
}

// Global declaration for lamejs
declare const lamejs: any;

const yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Decodes an audio file into an AudioBuffer.
 */
export const decodeAudio = async (file: File): Promise<AudioBuffer> => {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  return await audioContext.decodeAudioData(arrayBuffer);
};

/**
 * Applies a software noise gate to an AudioBuffer.
 * effectively attenuates breaths and background noise.
 */
const applyNoiseGate = (buffer: AudioBuffer, thresholdDb: number = -45): AudioBuffer => {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  
  // Create a new buffer for the gated output
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  const newBuffer = audioContext.createBuffer(numChannels, length, sampleRate);
  
  const threshold = Math.pow(10, thresholdDb / 20);
  const attackTime = 0.005; // 5ms attack
  const releaseTime = 0.1; // 100ms release
  
  // Coefficients for envelope follower
  const attackCoeff = Math.exp(-1 / (sampleRate * attackTime));
  const releaseCoeff = Math.exp(-1 / (sampleRate * releaseTime));

  for (let c = 0; c < numChannels; c++) {
    const inputData = buffer.getChannelData(c);
    const outputData = newBuffer.getChannelData(c);
    let envelope = 0;
    
    for (let i = 0; i < length; i++) {
      const input = inputData[i];
      const absInput = Math.abs(input);
      
      // Envelope follower
      if (absInput > envelope) {
        envelope = attackCoeff * envelope + (1 - attackCoeff) * absInput;
      } else {
        envelope = releaseCoeff * envelope + (1 - releaseCoeff) * absInput;
      }
      
      // Gate Logic (Expander)
      let gain = 1.0;
      if (envelope < threshold) {
        // Smoothly attenuate signals below threshold
        // The further below, the more we cut (Expander ratio ~ 4:1 effectively)
        const ratio = envelope / threshold;
        gain = ratio * ratio * ratio; // Cubic curve for natural sounding decay
      }
      
      outputData[i] = input * gain;
    }
  }
  
  return newBuffer;
};

/**
 * Enhances audio quality using EQ, Compression and Noise Gating.
 * V3 Tuning: Noise Gate for breath/bg noise, stricter filters.
 */
export const enhanceAudio = async (inputBuffer: AudioBuffer): Promise<AudioBuffer> => {
  // 1. First, apply Noise Gate to clean up source material (breaths, hiss)
  const gatedBuffer = applyNoiseGate(inputBuffer, -48);

  const offlineCtx = new OfflineAudioContext(
    gatedBuffer.numberOfChannels,
    gatedBuffer.length,
    gatedBuffer.sampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = gatedBuffer;

  // 2. High-pass filter (Stricter cut for rumble/pops @ 100Hz)
  const highPass = offlineCtx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 100;
  highPass.Q.value = 0.7;

  // 3. Low-pass filter (Remove ultra-high hiss/electronic noise @ 15kHz)
  const lowPass = offlineCtx.createBiquadFilter();
  lowPass.type = 'lowpass';
  lowPass.frequency.value = 15000;
  lowPass.Q.value = 0.7;

  // 4. Warmth/Body Boost (Fullness around 200Hz)
  const warmth = offlineCtx.createBiquadFilter();
  warmth.type = 'peaking';
  warmth.frequency.value = 220;
  warmth.gain.value = 2.0; 
  warmth.Q.value = 0.9;

  // 5. Gentle Clarity (Intelligibility around 3.5kHz)
  const clarity = offlineCtx.createBiquadFilter();
  clarity.type = 'peaking';
  clarity.frequency.value = 3500;
  clarity.gain.value = 1.5; 
  clarity.Q.value = 1.0;

  // 6. De-Harsh / De-Ess (Cut the "ss" sharp frequencies around 7kHz)
  const deHarsh = offlineCtx.createBiquadFilter();
  deHarsh.type = 'peaking';
  deHarsh.frequency.value = 7000;
  deHarsh.gain.value = -4.5; // Cut sibilance
  deHarsh.Q.value = 2.5;

  // 7. Dynamics Compressor (Even out the volume)
  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 30; 
  compressor.ratio.value = 3; 
  compressor.attack.value = 0.005; // Fast attack to catch peaks
  compressor.release.value = 0.20;

  // 8. Makeup Gain 
  const gain = offlineCtx.createGain();
  gain.gain.value = 1.5; 

  // Chain: Source -> HighPass -> LowPass -> Warmth -> Clarity -> DeHarsh -> Compressor -> Gain -> Dest
  source.connect(highPass);
  highPass.connect(lowPass);
  lowPass.connect(warmth);
  warmth.connect(clarity);
  clarity.connect(deHarsh);
  deHarsh.connect(compressor);
  compressor.connect(gain);
  gain.connect(offlineCtx.destination);

  source.start();
  
  return await offlineCtx.startRendering();
};

/**
 * Encodes an AudioBuffer to a WAV Blob.
 * Async to prevent UI freezing on large files.
 */
export const bufferToWav = async (buffer: AudioBuffer): Promise<Blob> => {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferOut = new ArrayBuffer(length);
  const view = new DataView(bufferOut);
  const channels = [];
  
  let offset = 0;
  
  const writeString = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
    offset += s.length;
  };
  
  const writeUint32 = (d: number) => {
    view.setUint32(offset, d, true);
    offset += 4;
  }
  
  const writeUint16 = (d: number) => {
    view.setUint16(offset, d, true);
    offset += 2;
  }

  writeString("RIFF");
  writeUint32(length - 8);
  writeString("WAVE");
  writeString("fmt ");
  writeUint32(16);
  writeUint16(1); // PCM
  writeUint16(numOfChan);
  writeUint32(buffer.sampleRate);
  writeUint32(buffer.sampleRate * 2 * numOfChan);
  writeUint16(numOfChan * 2);
  writeUint16(16);
  writeString("data");
  writeUint32(length - offset - 4);

  // Audio Data
  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  const chunkSize = 4096;
  let pos = 0;
  
  while (pos < buffer.length) {
    const end = Math.min(pos + chunkSize, buffer.length);
    
    for (; pos < end; pos++) {
      for (let i = 0; i < numOfChan; i++) {
        let sample = Math.max(-1, Math.min(1, channels[i][pos]));
        sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }
    
    // Yield to main thread to prevent freezing
    if (pos % (chunkSize * 10) === 0) await yieldToMain();
  }
  
  return new Blob([bufferOut], { type: "audio/wav" });
}

/**
 * Encodes an AudioBuffer to an MP3 Blob using lamejs.
 */
export const bufferToMp3 = async (buffer: AudioBuffer): Promise<Blob> => {
  if (typeof lamejs === 'undefined') {
    throw new Error("lamejs not loaded");
  }

  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const mp3encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, 128); // 128kbps

  const left = buffer.getChannelData(0);
  const right = numChannels > 1 ? buffer.getChannelData(1) : left;

  // Process in chunks to prevent UI freeze
  const sampleBlockSize = 1152 * 10; // multiple of 1152 for efficiency
  const mp3Data = [];

  for (let i = 0; i < left.length; i += sampleBlockSize) {
    const end = Math.min(i + sampleBlockSize, left.length);
    const leftChunk = new Int16Array(end - i);
    const rightChunk = numChannels > 1 ? new Int16Array(end - i) : undefined;

    // Convert float to int16
    for (let j = 0; j < end - i; j++) {
      let s = Math.max(-1, Math.min(1, left[i + j]));
      leftChunk[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      
      if (rightChunk && numChannels > 1) {
         let s2 = Math.max(-1, Math.min(1, right[i + j]));
         rightChunk[j] = s2 < 0 ? s2 * 0x8000 : s2 * 0x7FFF;
      }
    }

    let mp3buf;
    if (numChannels === 1) {
      mp3buf = mp3encoder.encodeBuffer(leftChunk);
    } else {
      mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
    }
    
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }

    // Yield to main thread
    await yieldToMain();
  }

  const mp3buf = mp3encoder.flush();
  if (mp3buf.length > 0) {
    mp3Data.push(mp3buf);
  }

  return new Blob(mp3Data, { type: 'audio/mp3' });
};

/**
 * Main logic to remove silence.
 */
export const removeSilence = async (
  inputBuffer: AudioBuffer, 
  options: SilenceOptions,
  onProgress?: (progress: number) => void
): Promise<ProcessResult> => {
  const { 
    removeRatio, 
    thresholdDb = -48, // Lower threshold for better sensitivity
    minSilenceDuration = 0.25,
    padding = 0.15 // Default padding to keep words intact
  } = options;
  
  const threshold = Math.pow(10, thresholdDb / 20);
  const sampleRate = inputBuffer.sampleRate;
  const minSilenceSamples = Math.floor(minSilenceDuration * sampleRate);
  const paddingSamples = Math.floor(padding * sampleRate);
  
  const numChannels = inputBuffer.numberOfChannels;
  const length = inputBuffer.length;
  
  const blockSize = 1024;
  const numBlocks = Math.ceil(length / blockSize);
  const blockIsSilence = new Uint8Array(numBlocks);
  
  // 1. Analyze for silence regions
  for (let b = 0; b < numBlocks; b++) {
    const start = b * blockSize;
    const end = Math.min(start + blockSize, length);
    let maxAmp = 0;
    
    for (let c = 0; c < numChannels; c++) {
      const data = inputBuffer.getChannelData(c);
      for (let i = start; i < end; i++) {
        const abs = Math.abs(data[i]);
        if (abs > maxAmp) maxAmp = abs;
        if (maxAmp > threshold) break;
      }
      if (maxAmp > threshold) break;
    }
    
    if (maxAmp < threshold) {
      blockIsSilence[b] = 1;
    }

    // Yield occasionally during analysis
    if (b % 5000 === 0) await yieldToMain();
  }

  // 2. Identify raw contiguous silent blocks
  interface Region {
    start: number;
    end: number; // exclusive
    isSilence: boolean;
  }
  
  const rawRegions: Region[] = [];
  let currentStart = 0;
  let currentIsSilence = blockIsSilence[0] === 1;
  
  for (let b = 1; b < numBlocks; b++) {
    const isSil = blockIsSilence[b] === 1;
    if (isSil !== currentIsSilence) {
      rawRegions.push({ 
        start: currentStart * blockSize, 
        end: b * blockSize, 
        isSilence: currentIsSilence 
      });
      currentStart = b;
      currentIsSilence = isSil;
    }
  }
  rawRegions.push({ 
    start: currentStart * blockSize, 
    end: numBlocks * blockSize, 
    isSilence: currentIsSilence 
  });

  // 3. Apply Padding (Safety Margins)
  // We expand 'sound' regions into 'silence' regions by `paddingSamples`
  // This ensures breath, attack, and decay are preserved.
  
  // Clone regions to modify boundaries
  const regions: Region[] = rawRegions.map(r => ({...r}));

  // Iterate forward to extend end of sound
  for (let i = 0; i < regions.length - 1; i++) {
    const current = regions[i];
    const next = regions[i + 1];
    
    // If current is SOUND and next is SILENCE
    if (!current.isSilence && next.isSilence) {
       // Extend current end by padding
       const shift = Math.min(paddingSamples, next.end - next.start);
       current.end += shift;
       next.start += shift;
    }
  }

  // Iterate backward to extend start of sound
  for (let i = regions.length - 1; i > 0; i--) {
    const current = regions[i];
    const prev = regions[i - 1];

    // If current is SOUND and prev is SILENCE
    if (!current.isSilence && prev.isSilence) {
      // Extend current start backward
      const shift = Math.min(paddingSamples, prev.end - prev.start);
      current.start -= shift;
      prev.end -= shift;
    }
  }

  // 4. Determine new total length & create copy directives
  let outputSamplesCount = 0;
  const regionDirectives: { regionIndex: number, keepRatio: number }[] = [];
  
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const regionLength = r.end - r.start;
    
    // Skip empty regions (caused by padding consuming small silences)
    if (regionLength <= 0) continue;

    let keepRatio = 1;
    if (r.isSilence && regionLength >= minSilenceSamples) {
      keepRatio = 1 - removeRatio;
    }
    
    const keepSamples = Math.floor(regionLength * keepRatio);
    outputSamplesCount += keepSamples;
    
    regionDirectives.push({ regionIndex: i, keepRatio });
  }
  
  // 5. Create output buffer
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  const outputBuffer = audioContext.createBuffer(numChannels, outputSamplesCount, sampleRate);
  
  // 6. Copy data
  for (let c = 0; c < numChannels; c++) {
    const inputData = inputBuffer.getChannelData(c);
    const outputData = outputBuffer.getChannelData(c);
    let writeCursor = 0;
    
    for (let i = 0; i < regionDirectives.length; i++) {
      const { regionIndex, keepRatio } = regionDirectives[i];
      const r = regions[regionIndex];
      
      const regionLength = r.end - r.start;
      
      if (keepRatio === 1) {
        // Copy full sound or short silence
        outputData.set(inputData.subarray(r.start, r.end), writeCursor);
        writeCursor += regionLength;
      } else {
        // Truncate silence
        // Keep the start of the silence (natural decay)
        const samplesToKeep = Math.floor(regionLength * keepRatio);
        outputData.set(inputData.subarray(r.start, r.start + samplesToKeep), writeCursor);
        writeCursor += samplesToKeep;
      }
      
      if (c === 0 && onProgress) {
        // Report progress occasionally
        if (i % 50 === 0) {
            onProgress(i / regions.length);
            await yieldToMain();
        }
      }
    }
  }

  // 7. Convert regions back to AudioRegion format for visualization
  // We use the adjusted regions so the visualizer shows the padding
  const finalRegions: AudioRegion[] = regions.filter(r => (r.end - r.start) > 0).map(r => ({
    start: r.start,
    end: r.end,
    isSilence: r.isSilence
  }));

  return {
    buffer: outputBuffer,
    regions: finalRegions
  };
};
