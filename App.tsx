import React, { useState, useRef, useEffect } from 'react';
import { Upload, Scissors, Download, RefreshCw, Play, Pause, Zap, Activity, Flame, Wand2, Check, Mic, Power, Sliders, Volume2, Sparkles, ArrowRight, FileAudio, Loader2, ArrowLeft, AlertTriangle, ZoomIn, ZoomOut, List, Trash2, CheckSquare, Square, Save, Home, Star, Music, Waves, Layers, MousePointerClick, StopCircle } from 'lucide-react';
import { decodeAudio, removeSilence, bufferToWav, bufferToMp3, enhanceAudio, AudioRegion } from './lib/audioProcessing';

type ProcessingState = 'idle' | 'decoding' | 'processing' | 'enhancing' | 'done' | 'error';
type SilenceMode = 0.7 | 0.8 | 1.0;
type ExportFormat = 'wav' | 'mp3';
type WorkflowStep = 'landing' | 'import' | 'config';

interface BatchItem {
  id: string;
  fileName: string;
  originalDuration: number;
  newDuration: number;
  blob: Blob;
  format: ExportFormat;
  timestamp: number;
}

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
};

/**
 * Placeholder component for Google AdSense
 */
const AdBanner = ({ className }: { className?: string }) => {
  return (
    <div className={`w-full bg-dark-800/50 border border-white/5 rounded-xl p-4 flex flex-col items-center justify-center text-center overflow-hidden ${className}`}>
      <span className="text-xs text-gray-600 uppercase tracking-widest font-semibold mb-2">Advertisement</span>
      <div className="w-full h-[90px] bg-white/5 rounded border border-dashed border-white/10 flex items-center justify-center text-gray-500 text-sm">
        Ad Space (Auto-Responsive)
      </div>
    </div>
  );
};

const WaveformVisualizer = ({ 
  buffer, 
  regions, 
  height = 120, 
  color = '#22c55e', 
  label,
  thresholdDb 
}: { 
  buffer: AudioBuffer | null, 
  regions?: AudioRegion[], 
  height?: number, 
  color?: string,
  label: string,
  thresholdDb?: number
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [scroll, setScroll] = useState(0); // Normalized 0 to 1

  // Reset view when buffer changes
  useEffect(() => {
    setZoom(1);
    setScroll(0);
  }, [buffer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    // Get actual display width
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    
    // Set explicit resolution
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    // Draw background/midline
    ctx.beginPath();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    const data = buffer.getChannelData(0);
    const totalSamples = data.length;
    
    // Calculate View Window
    const visibleSamples = Math.floor(totalSamples / zoom);
    const maxStart = Math.max(0, totalSamples - visibleSamples);
    const startSample = Math.floor(scroll * maxStart);
    const endSample = Math.min(startSample + visibleSamples, totalSamples);

    // Drawing Params
    const amp = height / 2;
    const samplesPerPixel = visibleSamples / width;
    
    // Optimizing step size for performance vs detail
    const step = Math.max(1, Math.floor(samplesPerPixel)); 
    const lookahead = Math.min(5, step); 

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    
    // Draw Waveform
    for (let i = 0; i < width; i++) {
      const sampleIdx = startSample + Math.floor(i * samplesPerPixel);
      
      if (sampleIdx >= totalSamples) break;

      let min = 1.0;
      let max = -1.0;

      // Peak finding in the chunk represented by this pixel
      for (let j = 0; j < lookahead; j++) {
        const idx = sampleIdx + Math.floor((j / lookahead) * step);
        if (idx < totalSamples) {
           const val = data[idx];
           if (val < min) min = val;
           if (val > max) max = val;
        }
      }
      
      // If we didn't find data (e.g. end of file), center it
      if (min > max) {
         min = 0; max = 0;
      }

      ctx.moveTo(i, (1 + min) * amp);
      ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();

    // Draw Threshold Lines if provided
    if (thresholdDb !== undefined) {
      // dB to Linear: 10^(db/20)
      // thresholdDb is usually negative (e.g., -30). 
      // If signal is 0 to 1.
      const thresholdLinear = Math.pow(10, thresholdDb / 20);
      const yOffset = thresholdLinear * amp;

      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      // Top line
      ctx.moveTo(0, (amp) - yOffset);
      ctx.lineTo(width, (amp) - yOffset);
      // Bottom line
      ctx.moveTo(0, (amp) + yOffset);
      ctx.lineTo(width, (amp) + yOffset);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw Silence Overlays (Red Highlights)
    if (regions && regions.length > 0) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.3)'; // Red-500 with opacity
      
      for (const r of regions) {
        if (!r.isSilence) continue;
        
        // Skip if region is completely outside view
        if (r.end < startSample || r.start > endSample) continue;

        // Map region coords to screen pixels
        // regionStart relative to window start
        const relStart = Math.max(0, r.start - startSample);
        const relEnd = Math.min(visibleSamples, r.end - startSample);
        
        const x = (relStart / visibleSamples) * width;
        const w = ((relEnd - relStart) / visibleSamples) * width;
        
        if (w > 0.5) {
          ctx.fillRect(x, 0, w, height);
        }
      }
    }

  }, [buffer, regions, height, color, zoom, scroll, thresholdDb]);

  return (
    <div className="w-full mb-6 bg-black/20 rounded-xl p-3 border border-white/5">
      {/* Header / Controls */}
      <div className="flex flex-wrap items-center justify-between mb-3 gap-2">
        <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold flex items-center gap-2">
          {label}
        </div>
        
        <div className="flex items-center gap-3 bg-white/5 rounded-lg px-2 py-1">
          <button 
            onClick={() => setZoom(z => Math.max(1, z - 1))}
            className="text-gray-400 hover:text-white transition-colors p-1"
            title="Zoom Out"
          >
            <ZoomOut size={14} />
          </button>
          
          <input 
            type="range" 
            min="1" 
            max="50" 
            step="0.1" 
            value={zoom} 
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-24 md:w-32 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-brand-500"
            title={`Zoom: ${zoom.toFixed(1)}x`}
          />
          
          <button 
            onClick={() => setZoom(z => Math.min(50, z + 1))}
            className="text-gray-400 hover:text-white transition-colors p-1"
            title="Zoom In"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="relative w-full overflow-hidden rounded-lg bg-black/40 border border-white/5">
        <canvas 
          ref={canvasRef} 
          className="w-full block"
          style={{ height: `${height}px` }} 
        />
      </div>

      {/* Scrollbar (Only visible when zoomed) */}
      {zoom > 1 && (
        <div className="mt-2 flex items-center gap-2 animate-fade-in">
           <span className="text-[10px] text-gray-600 font-mono w-8 text-right">
             {Math.round(scroll * 100)}%
           </span>
           <input 
            type="range" 
            min="0" 
            max="1" 
            step="0.001" 
            value={scroll} 
            onChange={(e) => setScroll(Number(e.target.value))}
            className="flex-1 h-2 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-gray-500 hover:accent-gray-400"
          />
        </div>
      )}
    </div>
  );
};

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  
  // Workflow State
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('landing');
  const [uploadIntent, setUploadIntent] = useState<'silence' | 'enhance'>('silence');

  // Feature Toggles
  const [silenceEnabled, setSilenceEnabled] = useState(true);
  const [enhanceEnabled, setEnhanceEnabled] = useState(false);
  const [mode, setMode] = useState<SilenceMode>(0.7);
  const [thresholdDb, setThresholdDb] = useState(-35); // Default threshold
  const [aggressiveRemoval, setAggressiveRemoval] = useState(false);

  // Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimerRef = useRef<number | null>(null);

  const [status, setStatus] = useState<ProcessingState>('idle');
  const [progress, setProgress] = useState(0);
  const [originalDuration, setOriginalDuration] = useState(0);
  const [newDuration, setNewDuration] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [originalBlobUrl, setOriginalBlobUrl] = useState<string | null>(null); // For Compare
  const [errorMsg, setErrorMsg] = useState('');
  
  // Export Configuration
  const [exportFormat, setExportFormat] = useState<ExportFormat>('wav');
  const [isEncoding, setIsEncoding] = useState(false);
  
  // Waveform Data
  const [originalBuffer, setOriginalBuffer] = useState<AudioBuffer | null>(null);
  const [processedBuffer, setProcessedBuffer] = useState<AudioBuffer | null>(null);
  const [silenceRegions, setSilenceRegions] = useState<AudioRegion[]>([]);

  // Batch History State
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(new Set());

  // Audio playback
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleToolSelect = (intent: 'silence' | 'enhance') => {
    setUploadIntent(intent);
    setWorkflowStep('import');
    
    if (intent === 'silence') {
      setSilenceEnabled(true);
      setEnhanceEnabled(false);
    } else {
      setSilenceEnabled(false);
      setEnhanceEnabled(true);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
        // Convert Blob to File
        const recordedFile = new File([blob], `recording_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.webm`, { type: blob.type });
        handleNewFile(recordedFile);
        
        // Stop all tracks to release mic
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setIsRecording(true);
      setRecordingTime(0);

      recordingTimerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

    } catch (err) {
      console.error("Error accessing microphone:", err);
      setErrorMsg("Could not access microphone. Please verify permissions.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    }
  };

  const handleNewFile = (selectedFile: File) => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    if (originalBlobUrl) URL.revokeObjectURL(originalBlobUrl);
    
    setFile(selectedFile);
    setOriginalBlobUrl(URL.createObjectURL(selectedFile));
    
    setDownloadUrl(null);
    setStatus('idle');
    setNewDuration(0);
    setOriginalDuration(0);
    setOriginalBuffer(null);
    setProcessedBuffer(null);
    setSilenceRegions([]);
    setErrorMsg('');
    setIsPlaying(false);
    setProgress(0);
    setCurrentTime(0);
    setExportFormat('wav');
    
    setWorkflowStep('config');
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleNewFile(e.target.files[0]);
    }
    e.target.value = '';
  };

  const createBlobFromBuffer = async (buffer: AudioBuffer, format: ExportFormat): Promise<Blob> => {
    if (format === 'mp3') {
      return await bufferToMp3(buffer);
    } else {
      return await bufferToWav(buffer);
    }
  };

  const generateDownload = async (buffer: AudioBuffer, format: ExportFormat) => {
    setIsEncoding(true);
    await new Promise(r => setTimeout(r, 10));

    try {
      const blob = await createBlobFromBuffer(buffer, format);
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
    } catch (e) {
      console.error("Encoding error", e);
      setErrorMsg("Failed to encode audio.");
    } finally {
      setIsEncoding(false);
    }
  };

  const handleProcess = async () => {
    setErrorMsg('');
    
    if (!file) return;
    if (!silenceEnabled && !enhanceEnabled) {
      setErrorMsg("Please enable at least one feature.");
      setStatus('error');
      return;
    }

    try {
      setStatus('decoding');
      const audioBuffer = await decodeAudio(file);
      setOriginalDuration(audioBuffer.duration);
      setOriginalBuffer(audioBuffer);

      let finalBuffer = audioBuffer;
      let regions: AudioRegion[] = [];

      // 1. Silence Removal
      if (silenceEnabled) {
        setStatus('processing');
        await new Promise(r => setTimeout(r, 50));

        let result = await removeSilence(audioBuffer, {
          removeRatio: mode,
          thresholdDb: thresholdDb,
          minSilenceDuration: 0.1,
          padding: 0.05
        }, (p) => setProgress(Math.round(p * 100)));

        finalBuffer = result.buffer;
        regions = result.regions;
      }

      // 2. Enhancement
      if (enhanceEnabled) {
        setStatus('enhancing');
        await new Promise(r => setTimeout(r, 20));
        finalBuffer = await enhanceAudio(finalBuffer, { aggressiveGate: aggressiveRemoval });
      }

      setProcessedBuffer(finalBuffer);
      setSilenceRegions(regions);
      setNewDuration(finalBuffer.duration);
      
      setExportFormat('wav');
      await generateDownload(finalBuffer, 'wav');
      
      setStatus('done');

    } catch (err) {
      console.error(err);
      setStatus('error');
      setErrorMsg("Failed to process audio. Format might be unsupported or file corrupted.");
    }
  };

  // Compare Functionality
  const handleCompareDown = () => {
    if (!audioRef.current || !originalBlobUrl) return;
    // Save current playing state and time
    const wasPlaying = !audioRef.current.paused;
    const currTime = audioRef.current.currentTime;
    
    // Switch to original
    audioRef.current.src = originalBlobUrl;
    audioRef.current.currentTime = currTime;
    if (wasPlaying) audioRef.current.play();
  };

  const handleCompareUp = () => {
    if (!audioRef.current || !downloadUrl) return;
    const wasPlaying = !audioRef.current.paused;
    const currTime = audioRef.current.currentTime;
    
    // Switch back to processed
    audioRef.current.src = downloadUrl;
    audioRef.current.currentTime = currTime;
    if (wasPlaying) audioRef.current.play();
  };

  // Batch Operations
  const handleAddToBatch = async () => {
    if (!processedBuffer || !file) return;

    setIsEncoding(true);
    try {
      // Encode immediately to save state
      const blob = await createBlobFromBuffer(processedBuffer, exportFormat);
      
      const newItem: BatchItem = {
        id: Math.random().toString(36).substring(7),
        fileName: `processed_${file.name.replace(/\.[^/.]+$/, "")}.${exportFormat}`,
        originalDuration,
        newDuration,
        blob,
        format: exportFormat,
        timestamp: Date.now()
      };

      setBatchItems(prev => [...prev, newItem]);
      setSelectedBatchIds(prev => new Set(prev).add(newItem.id)); // Auto select new item

      // Reset for next file
      setFile(null);
      setStatus('idle');
      setWorkflowStep('import');
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      if (originalBlobUrl) URL.revokeObjectURL(originalBlobUrl);
      setDownloadUrl(null);
      setOriginalBlobUrl(null);

    } catch (e) {
      console.error("Failed to add to batch", e);
      setErrorMsg("Could not save to history.");
    } finally {
      setIsEncoding(false);
    }
  };

  const toggleBatchSelect = (id: string) => {
    const newSet = new Set(selectedBatchIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedBatchIds(newSet);
  };

  const toggleSelectAll = () => {
    if (selectedBatchIds.size === batchItems.length) {
      setSelectedBatchIds(new Set());
    } else {
      setSelectedBatchIds(new Set(batchItems.map(i => i.id)));
    }
  };

  const deleteBatchItem = (id: string) => {
    setBatchItems(prev => prev.filter(i => i.id !== id));
    setSelectedBatchIds(prev => {
      const newSet = new Set(prev);
      newSet.delete(id);
      return newSet;
    });
  };

  const downloadBatch = () => {
    batchItems.forEach(item => {
      if (selectedBatchIds.has(item.id)) {
        const url = URL.createObjectURL(item.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = item.fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        // Clean up URL after small delay
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    });
  };

  // When user changes format, regenerate
  const handleFormatChange = async (format: ExportFormat) => {
    if (format === exportFormat || !processedBuffer) return;
    setExportFormat(format);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    await generateDownload(processedBuffer, format);
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !downloadUrl) return;
    
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      try {
        if (audio.ended) {
            audio.currentTime = 0;
        }
        await audio.play();
      } catch (err) {
        console.warn("Playback interrupted or failed:", err);
        setIsPlaying(false);
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  };

  useEffect(() => {
    if (audioRef.current && downloadUrl) {
      audioRef.current.src = downloadUrl;
      audioRef.current.load();
      setCurrentTime(0);
    }
  }, [downloadUrl]);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      if (originalBlobUrl) URL.revokeObjectURL(originalBlobUrl);
    };
  }, [downloadUrl, originalBlobUrl]);

  return (
    <div className="min-h-screen bg-dark-900 text-white font-sans selection:bg-brand-500 selection:text-white flex flex-col items-center justify-center p-4 overflow-hidden relative">
      {/* Background Decor - Enhanced */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-brand-600/10 rounded-full blur-[100px] animate-pulse-slow"></div>
        <div className="absolute bottom-[-20%] right-[-10%] w-[600px] h-[600px] bg-blue-600/10 rounded-full blur-[100px] animate-pulse-slow" style={{ animationDelay: '1.5s' }}></div>
        <div className="absolute top-[30%] left-[50%] -translate-x-1/2 w-96 h-96 bg-purple-500/5 rounded-full blur-[80px]"></div>
      </div>

      <div className="relative w-full max-w-5xl bg-dark-800/40 backdrop-blur-2xl border border-white/5 rounded-3xl p-6 md:p-10 shadow-2xl transition-all duration-300 mb-20 z-10">
        
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-3 bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent cursor-pointer hover:scale-[1.01] transition-transform" onClick={() => { setFile(null); setWorkflowStep('landing'); }}>
            Silence<span className="text-brand-400">Cut</span> Studio
          </h1>
          <p className="text-gray-400 text-lg md:text-xl font-light">Professional Audio Post-Production Suite</p>
        </div>

        {/* Ad Unit: Top Leaderboard */}
        <div className="mb-8">
          <AdBanner />
        </div>

        {/* Global Hidden Input - Improved with explicit accept and ref check */}
        <input 
          ref={fileInputRef}
          type="file" 
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.aiff" 
          onChange={handleFileChange} 
          className="hidden" 
        />

        {/* STEP 1: LANDING */}
        {workflowStep === 'landing' && (
          <div className="animate-fade-in space-y-12 py-8">
            {/* Modern Hero Section */}
            <div className="text-center space-y-8 max-w-3xl mx-auto">
               <div className="inline-flex items-center gap-2 bg-brand-500/10 border border-brand-500/20 rounded-full px-4 py-1.5 text-sm text-brand-400 font-medium mb-4 shadow-sm backdrop-blur-md">
                  <Star size={14} fill="currentColor" />
                  <span>v2.0 Professional</span>
               </div>
               <h2 className="text-5xl md:text-7xl font-bold text-white tracking-tight leading-[1.1]">
                 Make Your Audio <br/>
                 <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-400 to-emerald-300">Crystal Clear</span>
               </h2>
               <p className="text-lg md:text-xl text-gray-400 leading-relaxed max-w-2xl mx-auto font-light">
                 Instantly remove silence and enhance voice quality directly in your browser. 
                 <span className="text-gray-300 font-medium"> Private, secure, and 100% free.</span>
               </p>
            </div>

            {/* Feature Cards - Glassmorphism */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
              {/* Option 1: Silence Remover */}
              <button 
                onClick={() => handleToolSelect('silence')}
                className="group relative flex flex-col p-8 rounded-[2rem] bg-gradient-to-br from-white/[0.07] to-white/[0.01] border border-white/10 hover:border-brand-500/50 transition-all duration-500 text-left hover:-translate-y-2 hover:shadow-[0_20px_50px_-15px_rgba(34,197,94,0.3)] overflow-hidden"
              >
                <div className="absolute inset-0 bg-brand-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-xl"></div>
                
                <div className="relative z-10 flex flex-col h-full">
                  <div className="flex justify-between items-start mb-6">
                    <div className="w-16 h-16 rounded-2xl bg-brand-500/20 text-brand-400 flex items-center justify-center group-hover:scale-110 transition-transform duration-500 shadow-inner">
                      <Scissors size={32} />
                    </div>
                    <div className="p-2.5 rounded-full bg-white/5 group-hover:bg-brand-500 group-hover:text-black transition-colors duration-300">
                      <ArrowRight size={20} />
                    </div>
                  </div>
                  
                  <h3 className="text-2xl font-bold text-white mb-3">Silence Remover</h3>
                  <p className="text-gray-400 mb-6 leading-relaxed flex-grow">
                    Automatically strip dead air and pauses. Perfect for lectures, podcasts, and raw footage cleanup.
                  </p>
                  
                  <div className="flex flex-wrap gap-2 mt-auto">
                     <span className="px-3 py-1 rounded-full bg-white/5 text-xs text-brand-300 font-medium border border-brand-500/20 backdrop-blur-sm">Auto-Trim</span>
                     <span className="px-3 py-1 rounded-full bg-white/5 text-xs text-brand-300 font-medium border border-brand-500/20 backdrop-blur-sm">Gapless</span>
                  </div>
                </div>
              </button>

              {/* Option 2: Voice Enhancer */}
              <button 
                onClick={() => handleToolSelect('enhance')}
                className="group relative flex flex-col p-8 rounded-[2rem] bg-gradient-to-br from-white/[0.07] to-white/[0.01] border border-white/10 hover:border-blue-500/50 transition-all duration-500 text-left hover:-translate-y-2 hover:shadow-[0_20px_50px_-15px_rgba(59,130,246,0.3)] overflow-hidden"
              >
                <div className="absolute inset-0 bg-blue-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-xl"></div>

                <div className="relative z-10 flex flex-col h-full">
                  <div className="flex justify-between items-start mb-6">
                     <div className="w-16 h-16 rounded-2xl bg-blue-500/20 text-blue-400 flex items-center justify-center group-hover:scale-110 transition-transform duration-500 shadow-inner">
                      <Wand2 size={32} />
                    </div>
                     <div className="p-2.5 rounded-full bg-white/5 group-hover:bg-blue-500 group-hover:text-white transition-colors duration-300">
                      <ArrowRight size={20} />
                    </div>
                  </div>
                  
                  <h3 className="text-2xl font-bold text-white mb-3">Voice Enhancer</h3>
                  <p className="text-gray-400 mb-6 leading-relaxed flex-grow">
                    Transform amateur recordings into broadcast quality using studio-grade EQ, compression, and gating.
                  </p>

                  <div className="flex flex-wrap gap-2 mt-auto">
                     <span className="px-3 py-1 rounded-full bg-white/5 text-xs text-blue-300 font-medium border border-blue-500/20 backdrop-blur-sm">De-Esser</span>
                     <span className="px-3 py-1 rounded-full bg-white/5 text-xs text-blue-300 font-medium border border-blue-500/20 backdrop-blur-sm">Noise Gate</span>
                  </div>
                </div>
              </button>
            </div>
            
            {/* Trust Badges */}
            <div className="flex flex-wrap justify-center gap-6 md:gap-12 text-gray-500 pt-8 opacity-70">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Music size={18} className="text-brand-500/50" />
                <span>WAV & MP3 Support</span>
              </div>
              <div className="flex items-center gap-2 text-sm font-medium">
                <Layers size={18} className="text-brand-500/50" />
                <span>Local Processing</span>
              </div>
              <div className="flex items-center gap-2 text-sm font-medium">
                <Zap size={18} className="text-brand-500/50" />
                <span>Lightning Fast</span>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: IMPORT WORKSPACE */}
        {workflowStep === 'import' && (
          <div className="animate-fade-in max-w-2xl mx-auto text-center space-y-8">
            <button 
              onClick={() => setWorkflowStep('landing')}
              className="flex items-center text-gray-500 hover:text-white transition-colors gap-2 mx-auto"
            >
              <ArrowLeft size={16} />
              <span>Back to Tools</span>
            </button>
            
            <div className="space-y-2">
               <h2 className="text-2xl font-bold text-white">
                 {uploadIntent === 'silence' ? 'Silence Remover Workspace' : 'Voice Enhancer Workspace'}
               </h2>
               <p className="text-gray-400">Upload your audio file or record directly to begin.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className={`group cursor-pointer border-2 border-dashed rounded-3xl p-8 md:p-12 transition-all duration-300 flex flex-col items-center justify-center gap-6
                    ${uploadIntent === 'silence' 
                      ? 'border-brand-500/30 hover:border-brand-500 bg-brand-500/5 hover:bg-brand-500/10' 
                      : 'border-blue-500/30 hover:border-blue-500 bg-blue-500/5 hover:bg-blue-500/10'
                    }`}
                >
                  <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 shadow-2xl
                     ${uploadIntent === 'silence' ? 'bg-brand-500 text-black' : 'bg-blue-500 text-white'}`}>
                     <Upload size={28} />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-lg font-bold text-white">Upload File</h3>
                    <p className="text-xs text-gray-400">MP3, WAV, M4A</p>
                  </div>
                </div>

                <button 
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`group cursor-pointer border-2 border-dashed rounded-3xl p-8 md:p-12 transition-all duration-300 flex flex-col items-center justify-center gap-6
                    ${isRecording 
                        ? 'border-red-500 bg-red-500/10 animate-pulse' 
                        : uploadIntent === 'silence'
                           ? 'border-brand-500/30 hover:border-brand-500 bg-brand-500/5 hover:bg-brand-500/10' 
                           : 'border-blue-500/30 hover:border-blue-500 bg-blue-500/5 hover:bg-blue-500/10'
                    }`}
                >
                  <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 shadow-2xl relative
                     ${isRecording ? 'bg-red-500 text-white' : (uploadIntent === 'silence' ? 'bg-brand-500 text-black' : 'bg-blue-500 text-white')}`}>
                     {isRecording ? <StopCircle size={28} /> : <Mic size={28} />}
                     {isRecording && <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-400 rounded-full animate-ping"></span>}
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-lg font-bold text-white">{isRecording ? 'Stop Recording' : 'Record Mic'}</h3>
                    <p className="text-xs text-gray-400 font-mono min-h-[1rem]">
                       {isRecording ? formatTime(recordingTime) : 'Click to start'}
                    </p>
                  </div>
                </button>
            </div>
          </div>
        )}

        {/* STEP 3: CONFIGURATION DASHBOARD */}
        {workflowStep === 'config' && file && status === 'idle' && (
          <div className="space-y-6 animate-fade-in">
             <div className="flex gap-4">
               <button 
                onClick={() => { setFile(null); setWorkflowStep('import'); }}
                className="flex items-center text-gray-500 hover:text-white transition-colors gap-2 mb-4"
              >
                <ArrowLeft size={16} />
                <span>Choose different file</span>
              </button>
              
               <button 
                onClick={() => { setFile(null); setWorkflowStep('landing'); }}
                className="flex items-center gap-2 mb-4 px-4 py-1.5 rounded-full bg-brand-500 text-black font-bold hover:bg-brand-400 transition-all shadow-lg shadow-brand-500/20 hover:scale-105"
              >
                <Home size={16} />
                <span>Home</span>
              </button>
             </div>

            {/* File Info Bar - Added Waveform Preview with Threshold */}
            <div className="bg-white/5 p-4 rounded-xl border border-white/5 space-y-4">
               <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 bg-gray-800 rounded-full flex items-center justify-center flex-shrink-0">
                      <Activity className="text-gray-400" size={24} />
                    </div>
                    <div className="overflow-hidden">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-white truncate max-w-[150px] md:max-w-md">{file.name}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs">
                        <span className="text-gray-500">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={() => { setFile(null); setWorkflowStep('import'); }}
                    className="text-gray-400 hover:text-white transition-colors p-2"
                    title="Change File"
                  >
                    <RefreshCw size={20} />
                  </button>
               </div>
               
               {/* Pre-process visualization to show threshold */}
               {originalBuffer && silenceEnabled && (
                  <div className="mt-4 pt-4 border-t border-white/5">
                     <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider font-semibold">Preview & Threshold Adjustment</p>
                     <WaveformVisualizer 
                        buffer={originalBuffer} 
                        label="" 
                        color="#555" 
                        height={80} 
                        thresholdDb={thresholdDb}
                     />
                     <div className="flex justify-between text-xs text-gray-500 px-1">
                        <span>Quiet (-60dB)</span>
                        <span>Loud (-10dB)</span>
                     </div>
                  </div>
               )}
            </div>

            {/* Config Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Left Panel: Silence Remover */}
              <div className={`rounded-2xl border transition-all duration-300 overflow-hidden flex flex-col ${silenceEnabled ? 'bg-white/5 border-brand-500/50 shadow-lg shadow-brand-500/5' : 'bg-white/5 border-white/5 opacity-60'}`}>
                {/* Panel Header */}
                <div className="p-5 flex items-center justify-between border-b border-white/5 bg-white/5">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${silenceEnabled ? 'bg-brand-500 text-black' : 'bg-gray-700 text-gray-400'}`}>
                      <Scissors size={20} />
                    </div>
                    <h3 className="font-bold text-lg">Silence Remover</h3>
                  </div>
                  <button 
                    onClick={() => setSilenceEnabled(!silenceEnabled)}
                    className={`w-12 h-6 rounded-full transition-colors relative ${silenceEnabled ? 'bg-brand-500' : 'bg-gray-700'}`}
                  >
                    <div className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${silenceEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                  </button>
                </div>
                
                {/* Panel Body */}
                <div className={`p-5 space-y-6 flex-1 transition-all ${silenceEnabled ? 'opacity-100' : 'opacity-30 pointer-events-none'}`}>
                  
                  {/* Option 1: Ratio Buttons (Preserved Core Function) */}
                  <div className="space-y-2">
                    <div className="text-sm text-gray-400 flex items-center gap-2">
                        <Sliders size={14} />
                        <span>Aggressiveness (Amount Removed)</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <button onClick={() => setMode(0.7)} className={`flex flex-col items-center justify-center p-3 rounded-xl border transition-all ${mode === 0.7 ? 'bg-brand-500 text-black border-brand-500' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                        <span className="font-bold text-lg">70%</span>
                        <span className="text-[10px] opacity-75">Balanced</span>
                        </button>
                        <button onClick={() => setMode(0.8)} className={`flex flex-col items-center justify-center p-3 rounded-xl border transition-all ${mode === 0.8 ? 'bg-brand-500 text-black border-brand-500' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                        <span className="font-bold text-lg">80%</span>
                        <span className="text-[10px] opacity-75">Fast</span>
                        </button>
                        <button onClick={() => setMode(1.0)} className={`flex flex-col items-center justify-center p-3 rounded-xl border transition-all ${mode === 1.0 ? 'bg-brand-500 text-black border-brand-500' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                        <Flame size={16} className="mb-1" />
                        <span className="text-[10px] font-bold">MAX</span>
                        </button>
                    </div>
                  </div>

                  {/* Option 2: New Visual Threshold Slider */}
                  <div className="space-y-3 pt-4 border-t border-white/10">
                     <div className="flex justify-between items-center text-sm">
                        <div className="flex items-center gap-2 text-gray-400">
                           <Volume2 size={14} />
                           <span>Sensitivity Threshold</span>
                        </div>
                        <span className="text-brand-400 font-mono">{thresholdDb}dB</span>
                     </div>
                     <input 
                        type="range" 
                        min="-60" 
                        max="-10" 
                        step="1" 
                        value={thresholdDb}
                        onChange={(e) => setThresholdDb(Number(e.target.value))}
                        className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-brand-500"
                     />
                     <p className="text-xs text-gray-500">
                        Signal below this line is considered silence. Lower values = cuts less.
                     </p>
                  </div>

                </div>
              </div>

              {/* Right Panel: Voice Enhancer */}
              <div className={`rounded-2xl border transition-all duration-300 overflow-hidden flex flex-col ${enhanceEnabled ? 'bg-blue-900/10 border-blue-500/50 shadow-lg shadow-blue-500/5' : 'bg-white/5 border-white/5 opacity-60'}`}>
                {/* Panel Header */}
                <div className="p-5 flex items-center justify-between border-b border-white/5 bg-white/5">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${enhanceEnabled ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-400'}`}>
                      <Wand2 size={20} />
                    </div>
                    <h3 className="font-bold text-lg">Voice Enhancer</h3>
                  </div>
                  <button 
                    onClick={() => setEnhanceEnabled(!enhanceEnabled)}
                    className={`w-12 h-6 rounded-full transition-colors relative ${enhanceEnabled ? 'bg-blue-500' : 'bg-gray-700'}`}
                  >
                    <div className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${enhanceEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                  </button>
                </div>

                 {/* Panel Body */}
                 <div className={`p-5 flex-1 transition-all ${enhanceEnabled ? 'opacity-100' : 'opacity-30 pointer-events-none'}`}>
                   <div className="flex items-start justify-between mb-4">
                     <div className="space-y-1">
                        <span className="text-xs uppercase tracking-wider text-blue-400 font-bold">Adobe Podcast Style</span>
                        <h4 className="text-white font-medium">Balanced Studio Voice</h4>
                     </div>
                     <Sparkles className="text-blue-400" size={20} />
                   </div>
                   
                   <div className="space-y-4">
                     <div className="space-y-3">
                       <div className="flex items-center gap-3 text-sm text-gray-400">
                          <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                          <span>Smart Noise Gate & EQ</span>
                       </div>
                       <div className="flex items-center gap-3 text-sm text-gray-400">
                          <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                          <span>Triple De-Esser (Kills SSS/SHH/ZZZ)</span>
                       </div>
                     </div>

                     <div className="pt-3 border-t border-white/10">
                        <label className="flex items-center gap-3 cursor-pointer group">
                           <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${aggressiveRemoval ? 'bg-blue-500 border-blue-500' : 'border-gray-500 group-hover:border-gray-400'}`}>
                              {aggressiveRemoval && <Check size={14} className="text-white" />}
                           </div>
                           <input 
                              type="checkbox" 
                              className="hidden" 
                              checked={aggressiveRemoval}
                              onChange={(e) => setAggressiveRemoval(e.target.checked)}
                           />
                           <div>
                              <span className="block text-sm font-bold text-gray-300 group-hover:text-white">Aggressive Background Removal</span>
                              <span className="block text-xs text-gray-500">Cuts background voices but might sound drier.</span>
                           </div>
                        </label>
                     </div>
                   </div>
                 </div>
              </div>

            </div>

            {/* Action Area */}
            <button
              onClick={handleProcess}
              disabled={!silenceEnabled && !enhanceEnabled}
              className={`w-full py-4 font-bold text-lg rounded-xl shadow-[0_0_20px_rgba(34,197,94,0.1)] transition-all transform active:scale-[0.98]
                ${!silenceEnabled && !enhanceEnabled 
                  ? 'bg-gray-800 text-gray-500 cursor-not-allowed shadow-none' 
                  : 'bg-brand-500 hover:bg-brand-400 hover:shadow-[0_0_30px_rgba(34,197,94,0.4)] text-black'
                }`}
            >
              Start Processing
            </button>
          </div>
        )}

        {/* Processing State */}
        {(status === 'decoding' || status === 'processing' || status === 'enhancing') && (
          <div className="py-12 flex flex-col items-center justify-center space-y-6">
            <div className="relative w-24 h-24">
              <div className="absolute inset-0 border-4 border-white/10 rounded-full"></div>
              <div className={`absolute inset-0 border-4 rounded-full border-t-transparent animate-spin ${status === 'enhancing' ? 'border-blue-500' : 'border-brand-500'}`}></div>
              {status === 'enhancing' 
                ? <Wand2 className="absolute inset-0 m-auto text-blue-500 animate-pulse" size={32} />
                : <Scissors className="absolute inset-0 m-auto text-brand-500 animate-pulse" size={32} />
              }
            </div>
            <div className="text-center">
              <h3 className="text-xl font-bold flex items-center justify-center gap-2">
                {status === 'decoding' && 'Importing Audio...'}
                {status === 'processing' && 'Eliminating Silence...'}
                {status === 'enhancing' && 'Enhancing Audio...'}
              </h3>
              {progress > 0 && status === 'processing' && (
                <p className="text-brand-400 font-mono mt-1">{progress}%</p>
              )}
            </div>
          </div>
        )}

        {/* Done / Result State */}
        {status === 'done' && (
          <div className="space-y-8 animate-fade-in-up">
            
            <AdBanner />

            {/* Warning if no silence removed */}
            {silenceEnabled && Math.abs(originalDuration - newDuration) < 0.1 && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex items-start gap-3">
                 <AlertTriangle className="text-yellow-500 shrink-0 mt-0.5" size={20} />
                 <div className="text-sm text-yellow-200/90">
                    <p className="font-bold text-yellow-400 mb-1">No silence was detected/removed</p>
                    <p>This usually happens if the audio has background noise.</p>
                 </div>
              </div>
            )}

            <div className="bg-green-500/10 border border-green-500/20 rounded-2xl p-6 text-center relative overflow-hidden">
              <h2 className="text-3xl font-extrabold text-white mb-2">Processing Complete!</h2>
              <div className="text-gray-400 flex flex-wrap justify-center gap-4 mt-4">
                <div className="bg-black/20 px-4 py-2 rounded-lg">
                  <span className="block text-xs text-gray-500 uppercase tracking-wider">Original</span>
                  <span className="font-mono text-lg">{formatTime(originalDuration)}</span>
                </div>
                <div className="flex items-center text-gray-600">
                  <ArrowRight size={20} />
                </div>
                <div className="bg-brand-500/10 border border-brand-500/20 px-4 py-2 rounded-lg">
                  <span className="block text-xs text-brand-400 uppercase tracking-wider">New Length</span>
                  <span className="font-mono text-lg text-brand-400">{formatTime(newDuration)}</span>
                </div>
              </div>
            </div>

            {/* Visualizer Section */}
            <div className="bg-black/20 rounded-2xl p-6 border border-white/5 space-y-2">
               <div>
                 <WaveformVisualizer 
                   buffer={originalBuffer} 
                   regions={silenceRegions}
                   label="Original (Red areas removed)"
                   color="#555"
                 />
               </div>
               <div>
                  <WaveformVisualizer 
                   buffer={processedBuffer} 
                   label="Final Result"
                   color={enhanceEnabled ? '#3b82f6' : '#22c55e'}
                 />
               </div>
            </div>

            {/* Audio Player */}
            <div className="bg-white/5 rounded-2xl p-6 border border-white/5">
              <audio ref={audioRef} onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)} onEnded={() => setIsPlaying(false)} className="hidden" />
              
              <div className="flex items-center gap-4">
                <button 
                  onClick={togglePlayback}
                  className="w-14 h-14 bg-white text-black rounded-full flex items-center justify-center hover:scale-105 transition-transform shadow-lg"
                >
                  {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1" />}
                </button>
                
                {/* Hold to Compare Button - New Feature */}
                <button
                  onMouseDown={handleCompareDown}
                  onMouseUp={handleCompareUp}
                  onMouseLeave={handleCompareUp}
                  onTouchStart={handleCompareDown}
                  onTouchEnd={handleCompareUp}
                  className="h-14 px-4 bg-gray-700 text-gray-200 rounded-xl font-bold text-sm flex flex-col items-center justify-center active:scale-95 transition-transform hover:bg-gray-600 select-none"
                  title="Play Original Audio"
                >
                  <MousePointerClick size={18} />
                  <span className="text-[10px] mt-1">HOLD COMPARE</span>
                </button>

                <div className="flex-1 space-y-2">
                   <div className="flex justify-between text-xs font-medium text-gray-400">
                      <span>{formatTime(currentTime)}</span>
                      <span>{formatTime(newDuration)}</span>
                   </div>
                   <input 
                    type="range" 
                    min="0" 
                    max={newDuration} 
                    step="0.01"
                    value={currentTime} 
                    onChange={handleSeek}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-brand-500"
                  />
                </div>
              </div>
            </div>

            {/* Export & Reset */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
               {/* Format Toggle */}
               <div className="flex bg-white/5 rounded-xl p-1 border border-white/10 h-14 col-span-1">
                  <button 
                    onClick={() => handleFormatChange('wav')}
                    className={`flex-1 rounded-lg text-sm font-bold transition-all ${exportFormat === 'wav' ? 'bg-white text-black shadow-sm' : 'text-gray-400 hover:text-white'}`}
                  >
                    WAV
                  </button>
                  <button 
                    onClick={() => handleFormatChange('mp3')}
                    className={`flex-1 rounded-lg text-sm font-bold transition-all ${exportFormat === 'mp3' ? 'bg-white text-black shadow-sm' : 'text-gray-400 hover:text-white'}`}
                  >
                    MP3
                  </button>
               </div>

               <a 
                href={downloadUrl || '#'} 
                download={`processed_audio.${exportFormat}`}
                className={`flex items-center justify-center gap-2 bg-white text-black font-bold h-14 rounded-xl hover:bg-gray-200 transition-all ${isEncoding ? 'opacity-75 pointer-events-none' : ''}`}
              >
                {isEncoding ? <Loader2 size={20} className="animate-spin" /> : <Download size={20} />}
                Download Current
              </a>
              
              <button 
                onClick={handleAddToBatch}
                className="col-span-1 md:col-span-2 flex items-center justify-center gap-2 bg-white/5 text-gray-300 hover:text-white font-bold h-14 rounded-xl hover:bg-white/10 transition-all border border-white/10"
              >
                <Save size={20} />
                Save to Batch & Process Next
              </button>
              
               <button 
                onClick={() => { setFile(null); setWorkflowStep('landing'); setStatus('idle'); }}
                className="col-span-1 md:col-span-2 flex items-center justify-center gap-2 bg-brand-500 text-black font-bold h-16 rounded-xl hover:bg-brand-400 transition-all shadow-[0_0_20px_rgba(34,197,94,0.3)] hover:shadow-[0_0_30px_rgba(34,197,94,0.5)] transform hover:scale-[1.01]"
              >
                <Home size={20} />
                Back to Home
              </button>
            </div>
            
          </div>
        )}
        
        {/* BATCH HISTORY SECTION */}
        {batchItems.length > 0 && (workflowStep === 'import' || workflowStep === 'landing' || status === 'done') && (
           <div className="mt-12 pt-12 border-t border-white/10 animate-fade-in">
             <div className="flex items-center justify-between mb-6">
                <h3 className="text-2xl font-bold flex items-center gap-2">
                   <List className="text-brand-500" />
                   Batch History
                   <span className="text-sm bg-white/10 px-2 py-0.5 rounded-full text-gray-400 font-normal">
                     {batchItems.length} items
                   </span>
                </h3>
                
                <div className="flex gap-2">
                  <button 
                    onClick={toggleSelectAll}
                    className="text-sm text-gray-400 hover:text-white flex items-center gap-1 px-3 py-1.5 rounded-lg hover:bg-white/5"
                  >
                    {selectedBatchIds.size === batchItems.length ? <CheckSquare size={14} /> : <Square size={14} />}
                    Select All
                  </button>
                  
                  {selectedBatchIds.size > 0 && (
                    <button 
                      onClick={downloadBatch}
                      className="text-sm bg-brand-500 text-black font-bold px-4 py-1.5 rounded-lg hover:bg-brand-400 flex items-center gap-1"
                    >
                      <Download size={14} />
                      Download Selected ({selectedBatchIds.size})
                    </button>
                  )}
                </div>
             </div>

             <div className="bg-black/20 rounded-xl border border-white/5 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-white/5 text-gray-400 text-xs uppercase">
                       <tr>
                         <th className="p-4 w-10"></th>
                         <th className="p-4">File Name</th>
                         <th className="p-4">Duration Cut</th>
                         <th className="p-4">Format</th>
                         <th className="p-4 text-right">Actions</th>
                       </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                       {batchItems.map((item) => (
                         <tr key={item.id} className={`hover:bg-white/5 transition-colors ${selectedBatchIds.has(item.id) ? 'bg-brand-500/5' : ''}`}>
                            <td className="p-4">
                              <button 
                                onClick={() => toggleBatchSelect(item.id)}
                                className="text-gray-400 hover:text-brand-400"
                              >
                                {selectedBatchIds.has(item.id) ? <CheckSquare size={18} className="text-brand-500" /> : <Square size={18} />}
                              </button>
                            </td>
                            <td className="p-4 font-medium truncate max-w-[200px]" title={item.fileName}>
                              {item.fileName}
                            </td>
                            <td className="p-4 text-gray-400 text-sm">
                               {formatTime(item.originalDuration)} <ArrowRight size={10} className="inline mx-1" /> {formatTime(item.newDuration)}
                               <span className="ml-2 text-brand-400 text-xs bg-brand-500/10 px-1.5 py-0.5 rounded">
                                 -{((1 - (item.newDuration/item.originalDuration)) * 100).toFixed(0)}%
                               </span>
                            </td>
                            <td className="p-4 text-gray-500 text-xs uppercase">{item.format}</td>
                            <td className="p-4 flex items-center justify-end gap-2">
                               <a 
                                 href={URL.createObjectURL(item.blob)} 
                                 download={item.fileName}
                                 className="p-2 hover:bg-white/10 rounded-lg text-gray-400 hover:text-white transition-colors"
                                 title="Download Single"
                               >
                                 <Download size={16} />
                               </a>
                               <button 
                                 onClick={() => deleteBatchItem(item.id)}
                                 className="p-2 hover:bg-red-500/10 rounded-lg text-gray-600 hover:text-red-500 transition-colors"
                                 title="Remove from history"
                               >
                                 <Trash2 size={16} />
                               </button>
                            </td>
                         </tr>
                       ))}
                    </tbody>
                  </table>
                </div>
             </div>
           </div>
        )}
      </div>
    </div>
  );
}