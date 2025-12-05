
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

export interface EnhanceOptions {
  aggressiveGate?: boolean;
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
 * Estimates the noise floor of the audio buffer in dB.
 * Scans the file to find the quietest consistent sections.
 */
const getNoiseFloor = (buffer: AudioBuffer): number => {
  const data = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  
  // We check 50ms windows
  const windowSize = Math.floor(sampleRate * 0.05); 
  // Hop size: check every 1 second to be fast (scan across file)
  const hopSize = sampleRate; 
  
  const rmsValues: number[] = [];
  
  for (let i = 0; i < data.length; i += hopSize) {
    let sum = 0;
    let count = 0;
    // Calculate RMS of this window
    for (let j = 0; j < windowSize && i + j < data.length; j++) {
      const val = data[i + j];
      sum += val * val;
      count++;
    }
    
    if (count > 0) {
      const rms = Math.sqrt(sum / count);
      if (rms > 0.000001) { // Ignore absolute digital silence
        rmsValues.push(rms);
      }
    }
  }
  
  if (rmsValues.length === 0) return -60; // Default fallback

  // Sort to find quietest parts
  rmsValues.sort((a, b) => a - b);
  
  // Take the 10th percentile (to avoid outliers/dropouts)
  const p10Index = Math.floor(rmsValues.length * 0.1);
  const noiseFloorRms = rmsValues[p10Index] || rmsValues[0];
  
  return 20 * Math.log10(noiseFloorRms);
};

/**
 * Applies a software noise gate to an AudioBuffer.
 * effectively attenuates breaths and background noise.
 */
const applyNoiseGate = async (buffer: AudioBuffer, thresholdDb: number = -45, aggressive: boolean = false): Promise<AudioBuffer> => {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  
  const offlineCtx = new OfflineAudioContext(numChannels, length, sampleRate);
  const outputBuffer = offlineCtx.createBuffer(numChannels, length, sampleRate);
  
  const threshold = Math.pow(10, thresholdDb / 20);
  
  // Aggressive mode uses faster attack/release to chop noise between words
  // V3 Update: Even faster release (0.05s) to cut tight background chatter
  const attackTime = aggressive ? 0.001 : 0.01; 
  const releaseTime = aggressive ? 0.05 : 0.2; 
  
  const attackCoeff = Math.exp(-1 / (sampleRate * attackTime));
  const releaseCoeff = Math.exp(-1 / (sampleRate * releaseTime));

  const chunkSize = 48000; 

  for (let c = 0; c < numChannels; c++) {
    const inputData = buffer.getChannelData(c);
    const outputData = outputBuffer.getChannelData(c);
    let envelope = 0;
    
    for (let i = 0; i < length; i++) {
      const input = inputData[i];
      const absInput = Math.abs(input);
      
      if (absInput > envelope) {
        envelope = attackCoeff * envelope + (1 - attackCoeff) * absInput;
      } else {
        envelope = releaseCoeff * envelope + (1 - releaseCoeff) * absInput;
      }
      
      let gain = 1.0;
      if (envelope < threshold) {
        const ratio = envelope / threshold;
        if (aggressive) {
            // Harder knee for aggressive removal. 
            // Power of 12 makes anything below threshold drop to zero extremely fast.
            gain = Math.pow(ratio, 12); 
        } else {
            // Cubic curve for natural sounding decay
            gain = ratio * ratio * ratio; 
        }
      }
      
      outputData[i] = input * gain;

      if (i % chunkSize === 0) await yieldToMain();
    }
  }
  
  return outputBuffer;
};

/**
 * Enhances audio quality using EQ, Compression and Noise Gating.
 * V6 Tuning: Balanced Studio Profile.
 */
export const enhanceAudio = async (inputBuffer: AudioBuffer, options: EnhanceOptions = {}): Promise<AudioBuffer> => {
  const { aggressiveGate = false } = options;

  // 1. Adaptive Noise Gate
  // Calculate noise floor of this specific file
  const noiseFloor = getNoiseFloor(inputBuffer);
  
  // Set threshold above noise floor. 
  // Standard: +6dB above floor. 
  // Aggressive: +22dB above floor (Very strict, assumes user wants to kill bg noise)
  let gateThreshold = noiseFloor + (aggressiveGate ? 22 : 6);
  
  // Safety Clamps: Ensure we don't gate the actual speech too aggressively
  // If the recording is very quiet, the floor might be -50. -50+22 = -28dB.
  gateThreshold = Math.max(-50, Math.min(-12, gateThreshold));

  console.log(`Measured Noise Floor: ${noiseFloor.toFixed(1)}dB. Gating at: ${gateThreshold.toFixed(1)}dB`);

  const gatedBuffer = await applyNoiseGate(inputBuffer, gateThreshold, aggressiveGate);

  const offlineCtx = new OfflineAudioContext(
    gatedBuffer.numberOfChannels,
    gatedBuffer.length,
    gatedBuffer.sampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = gatedBuffer;

  // 2. High-pass filter (Remove deep rumble / AC hum)
  const highPass = offlineCtx.createBiquadFilter();
  highPass.type = 'highpass';
  // Aggressive mode cuts higher (160Hz) to remove background mud/male voice rumble
  highPass.frequency.value = aggressiveGate ? 160 : 85; 
  highPass.Q.value = 0.7;

  // 3. Natural Warmth (Low Shelf)
  const warmth = offlineCtx.createBiquadFilter();
  warmth.type = 'lowshelf';
  warmth.frequency.value = 100;
  // Reduce warmth boost if aggressive to maintain clarity
  warmth.gain.value = aggressiveGate ? 0.5 : 2.0; 

  // 4. Mud Cut (Clean up boxiness)
  const mudCut = offlineCtx.createBiquadFilter();
  mudCut.type = 'peaking';
  mudCut.frequency.value = 350;
  mudCut.gain.value = -2.5;
  mudCut.Q.value = 1.0;

  // 5. De-Esser Notch 1: Target "SH" (sha)
  const deEsserSh = offlineCtx.createBiquadFilter();
  deEsserSh.type = 'peaking';
  deEsserSh.frequency.value = 5500;
  deEsserSh.gain.value = -5.0;
  deEsserSh.Q.value = 2.5; 

  // 6. De-Esser Notch 2: Target "SS" (sss)
  const deEsserSs = offlineCtx.createBiquadFilter();
  deEsserSs.type = 'peaking';
  deEsserSs.frequency.value = 7500;
  deEsserSs.gain.value = -7.0; 
  deEsserSs.Q.value = 3.0;

  // 7. De-Esser Notch 3: Target "ZZ" (fizz/buzz)
  const deEsserZz = offlineCtx.createBiquadFilter();
  deEsserZz.type = 'peaking';
  deEsserZz.frequency.value = 10000;
  deEsserZz.gain.value = -8.0; 
  deEsserZz.Q.value = 2.0;

  // 8. Low Pass / High Shelf 
  // If aggressive, we low-pass earlier (6.5kHz) to cut high-freq hiss and whispers
  const highShelf = offlineCtx.createBiquadFilter();
  if (aggressiveGate) {
    highShelf.type = 'lowpass';
    highShelf.frequency.value = 6500; 
    highShelf.Q.value = 0.5;
  } else {
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 12000;
    highShelf.gain.value = -6.0;
  }

  // 9. Dynamics Compressor (Broadcast Leveling)
  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 15; 
  compressor.ratio.value = 3.5; 
  compressor.attack.value = 0.002; 
  compressor.release.value = 0.15;

  // 10. Makeup Gain 
  const gain = offlineCtx.createGain();
  gain.gain.value = 1.3; 

  // Chain: Source -> HPF -> Warmth -> MudCut -> DeEssSh -> DeEssSs -> DeEssZz -> HighShelf -> Comp -> Gain -> Out
  source.connect(highPass);
  highPass.connect(warmth);
  warmth.connect(mudCut);
  mudCut.connect(deEsserSh);
  deEsserSh.connect(deEsserSs);
  deEsserSs.connect(deEsserZz);
  deEsserZz.connect(highShelf);
  highShelf.connect(compressor);
  compressor.connect(gain);
  gain.connect(offlineCtx.destination);

  source.start();
  
  return await offlineCtx.startRendering();
};

/**
 * Encodes an AudioBuffer to a WAV Blob.
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
  const mp3encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, 128); 

  const left = buffer.getChannelData(0);
  const right = numChannels > 1 ? buffer.getChannelData(1) : left;

  const sampleBlockSize = 1152 * 10; 
  const mp3Data = [];

  for (let i = 0; i < left.length; i += sampleBlockSize) {
    const end = Math.min(i + sampleBlockSize, left.length);
    const leftChunk = new Int16Array(end - i);
    const rightChunk = numChannels > 1 ? new Int16Array(end - i) : undefined;

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
    thresholdDb = -35, 
    minSilenceDuration = 0.1, 
    padding = 0.05 
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

    if (b % 5000 === 0) await yieldToMain();
  }

  interface Region {
    start: number;
    end: number; 
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

  const regions: Region[] = rawRegions.map(r => ({...r}));

  for (let i = 0; i < regions.length - 1; i++) {
    const current = regions[i];
    const next = regions[i + 1];
    
    if (!current.isSilence && next.isSilence) {
       const shift = Math.min(paddingSamples, next.end - next.start);
       current.end += shift;
       next.start += shift;
    }
  }

  for (let i = regions.length - 1; i > 0; i--) {
    const current = regions[i];
    const prev = regions[i - 1];

    if (!current.isSilence && prev.isSilence) {
      const shift = Math.min(paddingSamples, prev.end - prev.start);
      current.start -= shift;
      prev.end -= shift;
    }
  }

  let outputSamplesCount = 0;
  const regionDirectives: { regionIndex: number, keepRatio: number }[] = [];
  
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const regionLength = r.end - r.start;
    
    if (regionLength <= 0) continue;

    let keepRatio = 1;
    if (r.isSilence && regionLength >= minSilenceSamples) {
      keepRatio = 1 - removeRatio;
    }
    
    const keepSamples = Math.floor(regionLength * keepRatio);
    outputSamplesCount += keepSamples;
    
    regionDirectives.push({ regionIndex: i, keepRatio });
  }
  
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  const outputBuffer = audioContext.createBuffer(numChannels, outputSamplesCount, sampleRate);
  
  for (let c = 0; c < numChannels; c++) {
    const inputData = inputBuffer.getChannelData(c);
    const outputData = outputBuffer.getChannelData(c);
    let writeCursor = 0;
    
    for (let i = 0; i < regionDirectives.length; i++) {
      const { regionIndex, keepRatio } = regionDirectives[i];
      const r = regions[regionIndex];
      
      const regionLength = r.end - r.start;
      
      if (keepRatio === 1) {
        outputData.set(inputData.subarray(r.start, r.end), writeCursor);
        writeCursor += regionLength;
      } else {
        const samplesToKeep = Math.floor(regionLength * keepRatio);
        outputData.set(inputData.subarray(r.start, r.start + samplesToKeep), writeCursor);
        writeCursor += samplesToKeep;
      }
      
      if (c === 0 && onProgress) {
        if (i % 50 === 0) {
            onProgress(i / regions.length);
            await yieldToMain();
        }
      }
    }
  }

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
