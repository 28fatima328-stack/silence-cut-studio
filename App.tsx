
import React, { useState, useRef, useEffect } from 'react';
import { Upload, Scissors, Download, RefreshCw, Play, Pause, Zap, Activity, Flame, Wand2, Check, Mic, Power, Sliders, Volume2, Sparkles, ArrowRight, FileAudio, Loader2, ArrowLeft } from 'lucide-react';
import { decodeAudio, removeSilence, bufferToWav, bufferToMp3, enhanceAudio, AudioRegion } from './lib/audioProcessing';

type ProcessingState = 'idle' | 'decoding' | 'processing' | 'enhancing' | 'done' | 'error';
type SilenceMode = 0.7 | 0.8 | 1.0;
type ExportFormat = 'wav' | 'mp3';
type WorkflowStep = 'landing' | 'import' | 'config';

const WaveformVisualizer = ({ 
  buffer, 
  regions, 
  height = 80, 
  color = '#22c55e', 
  label 
}: { 
  buffer: AudioBuffer | null, 
  regions?: AudioRegion[], 
  height?: number, 
  color?: string,
  label: string
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
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
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    
    // Draw Waveform
    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
      // Simple peak finding
      const startIndex = i * step;
      // Checking 5 samples per step to be faster than checking all
      // but more accurate than checking 1
      for (let j = 0; j < 5; j++) {
        const val = data[startIndex + j * Math.floor(step/5)];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      if (min === 1.0) min = 0; // handle empty/silence

      ctx.moveTo(i, (1 + min) * amp);
      ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();

    // Draw Silence Overlays (Red Highlights)
    if (regions && regions.length > 0) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.3)'; // Red-500 with opacity
      const samplesPerPixel = data.length / width;
      
      for (const r of regions) {
        if (r.isSilence) {
          const x = r.start / samplesPerPixel;
          const w = (r.end - r.start) / samplesPerPixel;
          // Only draw if wide enough to see
          if (w > 0.5) {
            ctx.fillRect(x, 0, w, height);
          }
        }
      }
    }

  }, [buffer, regions, height, color]);

  return (
    <div className="w-full mb-4">
      <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider font-semibold">{label}</div>
      <canvas 
        ref={canvasRef} 
        className="w-full bg-black/20 rounded-lg border border-white/5" 
        style={{ height: `${height}px` }} 
      />
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

  const [status, setStatus] = useState<ProcessingState>('idle');
  const [progress, setProgress] = useState(0);
  const [originalDuration, setOriginalDuration] = useState(0);
  const [newDuration, setNewDuration] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Export Configuration
  const [exportFormat, setExportFormat] = useState<ExportFormat>('wav');
  const [isEncoding, setIsEncoding] = useState(false);
  
  // Waveform Data
  const [originalBuffer, setOriginalBuffer] = useState<AudioBuffer | null>(null);
  const [processedBuffer, setProcessedBuffer] = useState<AudioBuffer | null>(null);
  const [silenceRegions, setSilenceRegions] = useState<AudioRegion[]>([]);

  // Audio playback
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleToolSelect = (intent: 'silence' | 'enhance') => {
    setUploadIntent(intent);
    setWorkflowStep('import');
    
    // Pre-configure toggles based on intent
    if (intent === 'silence') {
      setSilenceEnabled(true);
      setEnhanceEnabled(false);
    } else {
      setSilenceEnabled(false);
      setEnhanceEnabled(true);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0];
      
      // Reset State
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      setFile(selectedFile);
      
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
      
      // Crucial: Set step to config to move past import screen
      setWorkflowStep('config');
    }
    
    // Crucial: Reset input value so onChange fires even if same file selected again
    e.target.value = '';
  };

  const generateDownload = async (buffer: AudioBuffer, format: ExportFormat) => {
    setIsEncoding(true);
    // Short delay to allow UI to render 'loading' state
    await new Promise(r => setTimeout(r, 10));

    try {
      let blob: Blob;
      if (format === 'mp3') {
        blob = await bufferToMp3(buffer);
      } else {
        blob = await bufferToWav(buffer);
      }
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
    // Clear previous errors
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
        // Yield to UI to show state change
        await new Promise(r => setTimeout(r, 50));

        let result = await removeSilence(audioBuffer, {
          removeRatio: mode,
          thresholdDb: -48, // Improved default
          minSilenceDuration: 0.4,
          padding: 0.15 // Improved default
        }, (p) => setProgress(Math.round(p * 100)));

        finalBuffer = result.buffer;
        regions = result.regions;
      }

      // 2. Enhancement
      if (enhanceEnabled) {
        setStatus('enhancing');
        await new Promise(r => setTimeout(r, 20));
        finalBuffer = await enhanceAudio(finalBuffer);
      }

      setProcessedBuffer(finalBuffer);
      setSilenceRegions(regions);
      setNewDuration(finalBuffer.duration);
      
      // Initial export as WAV by default
      setExportFormat('wav');
      await generateDownload(finalBuffer, 'wav');
      
      setStatus('done');

    } catch (err) {
      console.error(err);
      setStatus('error');
      setErrorMsg("Failed to process audio. Format might be unsupported or file corrupted.");
    }
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
    };
  }, [downloadUrl]);

  return (
    <div className="min-h-screen bg-dark-900 text-white font-sans selection:bg-brand-500 selection:text-white flex flex-col items-center justify-center p-4">
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-brand-600/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-blue-600/10 rounded-full blur-3xl"></div>
      </div>

      <div className="relative w-full max-w-5xl bg-dark-800/50 backdrop-blur-xl border border-white/5 rounded-3xl p-6 md:p-10 shadow-2xl transition-all duration-300">
        
        {/* Header */}
        <div className="text-center mb-8 md:mb-12">
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-3 bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent cursor-pointer" onClick={() => { setFile(null); setWorkflowStep('landing'); }}>
            Silence<span className="text-brand-400">Cut</span> Studio
          </h1>
          <p className="text-gray-400 text-lg md:text-xl">Professional Audio Post-Production Suite</p>
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
          <div className="animate-fade-in space-y-8">
            <div className="text-center space-y-2">
              <h2 className="text-2xl font-bold text-white">Choose a tool to start</h2>
              <p className="text-gray-500">Select the primary action you want to perform on your audio</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 max-w-4xl mx-auto">
              {/* Option 1: Silence Remover */}
              <button 
                onClick={() => handleToolSelect('silence')}
                className="group relative flex flex-col p-8 rounded-3xl bg-white/5 border border-white/5 hover:border-brand-500/50 hover:bg-brand-500/5 transition-all duration-300 text-left hover:-translate-y-1 hover:shadow-2xl hover:shadow-brand-500/10"
              >
                <div className="absolute top-6 right-6 p-2 rounded-full bg-white/5 group-hover:bg-brand-500 group-hover:text-black transition-colors">
                  <ArrowRight size={20} />
                </div>
                
                <div className="w-16 h-16 rounded-2xl bg-brand-500/10 text-brand-400 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <Scissors size={32} />
                </div>
                
                <h3 className="text-2xl font-bold text-white mb-2">Silence Remover</h3>
                <p className="text-gray-400 mb-6 leading-relaxed">
                  Automatically detect and eliminate silent parts, pauses, and dead air from your recordings in seconds.
                </p>
                
                <div className="mt-auto flex gap-2">
                   <div className="px-3 py-1 rounded-full bg-white/5 text-xs text-gray-400 border border-white/5">Auto-Cut</div>
                   <div className="px-3 py-1 rounded-full bg-white/5 text-xs text-gray-400 border border-white/5">Gapless</div>
                </div>
              </button>

              {/* Option 2: Voice Enhancer */}
              <button 
                onClick={() => handleToolSelect('enhance')}
                className="group relative flex flex-col p-8 rounded-3xl bg-white/5 border border-white/5 hover:border-blue-500/50 hover:bg-blue-500/5 transition-all duration-300 text-left hover:-translate-y-1 hover:shadow-2xl hover:shadow-blue-500/10"
              >
                 <div className="absolute top-6 right-6 p-2 rounded-full bg-white/5 group-hover:bg-blue-500 group-hover:text-white transition-colors">
                  <ArrowRight size={20} />
                </div>

                <div className="w-16 h-16 rounded-2xl bg-blue-500/10 text-blue-400 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <Wand2 size={32} />
                </div>
                
                <h3 className="text-2xl font-bold text-white mb-2">Voice Enhancer</h3>
                <p className="text-gray-400 mb-6 leading-relaxed">
                  Transform raw recordings into cinema-quality audio with professional noise gating, EQ, and compression.
                </p>

                <div className="mt-auto flex gap-2">
                   <div className="px-3 py-1 rounded-full bg-white/5 text-xs text-gray-400 border border-white/5">Noise Removal</div>
                   <div className="px-3 py-1 rounded-full bg-white/5 text-xs text-gray-400 border border-white/5">Mastering</div>
                </div>
              </button>
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
               <p className="text-gray-400">Upload your audio file to begin {uploadIntent === 'silence' ? 'cutting' : 'enhancing'}</p>
            </div>

            <div 
              onClick={() => fileInputRef.current?.click()}
              className={`group cursor-pointer border-2 border-dashed rounded-3xl p-12 transition-all duration-300 flex flex-col items-center justify-center gap-6
                ${uploadIntent === 'silence' 
                  ? 'border-brand-500/30 hover:border-brand-500 bg-brand-500/5 hover:bg-brand-500/10' 
                  : 'border-blue-500/30 hover:border-blue-500 bg-blue-500/5 hover:bg-blue-500/10'
                }`}
            >
              <div className={`w-20 h-20 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 shadow-2xl
                 ${uploadIntent === 'silence' ? 'bg-brand-500 text-black' : 'bg-blue-500 text-white'}`}>
                 <Upload size={32} />
              </div>
              
              <div className="space-y-1">
                <h3 className="text-xl font-bold text-white">Click to Upload Audio</h3>
                <p className="text-sm text-gray-500 group-hover:text-gray-300 transition-colors">or drag and drop your file here</p>
              </div>
              
              <div className="flex gap-2 text-xs text-gray-500 uppercase tracking-widest font-semibold mt-4">
                 <span className="bg-black/20 px-3 py-1 rounded-full">MP3</span>
                 <span className="bg-black/20 px-3 py-1 rounded-full">WAV</span>
                 <span className="bg-black/20 px-3 py-1 rounded-full">M4A</span>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: CONFIGURATION DASHBOARD */}
        {workflowStep === 'config' && file && status === 'idle' && (
          <div className="space-y-6 animate-fade-in">
             <button 
              onClick={() => { setFile(null); setWorkflowStep('import'); }}
              className="flex items-center text-gray-500 hover:text-white transition-colors gap-2 mb-4"
            >
              <ArrowLeft size={16} />
              <span>Choose different file</span>
            </button>

            {/* File Info Bar with Visual Indicators */}
            <div className="flex items-center justify-between bg-white/5 p-4 rounded-xl border border-white/5">
              <div className="flex items-center space-x-4">
                <div className="w-12 h-12 bg-gray-800 rounded-full flex items-center justify-center flex-shrink-0">
                  <Activity className="text-gray-400" size={24} />
                </div>
                <div className="overflow-hidden">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-white truncate max-w-[150px] md:max-w-md">{file.name}</p>
                    {enhanceEnabled && (
                      <Sparkles size={14} className="text-blue-400 animate-pulse" />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs">
                    <span className="text-gray-500">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                    
                    {silenceEnabled && (
                      <span className="flex items-center gap-1 text-brand-400 bg-brand-400/10 px-2 py-0.5 rounded-full border border-brand-400/20">
                        <Scissors size={10} />
                        <span>Silence Cut</span>
                      </span>
                    )}
                    {enhanceEnabled && (
                      <span className="flex items-center gap-1 text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded-full border border-blue-400/20">
                        <Wand2 size={10} />
                        <span>Enhanced</span>
                      </span>
                    )}
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
                <div className={`p-5 space-y-4 flex-1 transition-all ${silenceEnabled ? 'opacity-100' : 'opacity-30 pointer-events-none'}`}>
                  <div className="text-sm text-gray-400 flex items-center gap-2 mb-2">
                    <Sliders size={14} />
                    <span>Removal Intensity</span>
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
                        <span className="text-xs uppercase tracking-wider text-blue-400 font-bold">Cinema Quality</span>
                        <h4 className="text-white font-medium">Broadcast Mastering</h4>
                     </div>
                     <Sparkles className="text-blue-400" size={20} />
                   </div>
                   
                   <div className="space-y-3">
                     <div className="flex items-center gap-3 text-sm text-gray-400">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                        <span>Noise & Breath Removal Gate</span>
                     </div>
                     <div className="flex items-center gap-3 text-sm text-gray-400">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                        <span>De-Esser (Sibilance Cut)</span>
                     </div>
                     <div className="flex items-center gap-3 text-sm text-gray-400">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                        <span>Analog Saturation & Warmth</span>
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
              {!silenceEnabled && !enhanceEnabled 
                ? 'Select an option above' 
                : (silenceEnabled && enhanceEnabled 
                    ? 'Remove Silence & Enhance Voice' 
                    : (silenceEnabled ? 'Remove Silence Only' : 'Enhance Voice Only')
                  )
              }
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
                {status === 'enhancing' && (
                  <>
                    Applying Broadcast Enhancement...
                    <Sparkles size={20} className="text-blue-500 animate-pulse" />
                  </>
                )}
              </h3>
              {progress > 0 && status === 'processing' && (
                <p className="text-brand-400 font-mono mt-1">{progress}%</p>
              )}
              <p className="text-gray-400 mt-2">Processing locally in your browser...</p>
            </div>
          </div>
        )}

        {/* Done / Result State */}
        {status === 'done' && (
          <div className="space-y-8 animate-fade-in-up">
            <div className="bg-green-500/10 border border-green-500/20 rounded-2xl p-6 text-center relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-green-500 to-transparent opacity-50"></div>
              
              <div className="flex justify-center gap-4 mb-4">
                {silenceEnabled && <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center shadow-lg shadow-green-500/20"><Scissors className="text-black" size={24} /></div>}
                {enhanceEnabled && <div className="w-12 h-12 bg-blue-500 rounded-full flex items-center justify-center shadow-lg shadow-blue-500/20"><Wand2 className="text-white" size={24} /></div>}
              </div>

              <h3 className="text-2xl font-bold text-white mb-1">Processing Complete!</h3>
              
              <div className="flex flex-col md:flex-row justify-center items-center gap-2 text-green-300">
                {silenceEnabled ? (
                   <span>Reduced from <span className="font-mono font-bold text-white">{formatTime(originalDuration)}</span> to <span className="font-mono font-bold text-brand-400">{formatTime(newDuration)}</span></span>
                ) : (
                  <span>Duration: <span className="font-mono font-bold text-brand-400">{formatTime(newDuration)}</span></span>
                )}
                
                {enhanceEnabled && (
                  <span className="hidden md:inline text-white/30">•</span>
                )}

                {enhanceEnabled && (
                   <span className="text-blue-300">Broadcast Quality Applied</span>
                )}
              </div>
            </div>

            {/* WAVEFORM VISUALIZATION */}
            <div className="space-y-4">
              <WaveformVisualizer 
                label={silenceEnabled ? "Original (Red areas removed)" : "Original Audio"}
                buffer={originalBuffer}
                regions={silenceRegions}
                color="#9ca3af" // gray-400
              />
              <WaveformVisualizer 
                label="Processed Result"
                buffer={processedBuffer}
                color={enhanceEnabled ? "#60a5fa" : "#4ade80"} // blue-400 or brand-400
              />
            </div>

            {/* Audio Preview */}
            <div className="bg-white/5 rounded-xl p-4 flex items-center space-x-4 border border-white/5">
               <button 
                onClick={togglePlayback}
                disabled={isEncoding}
                className="w-12 h-12 flex-shrink-0 bg-white text-black rounded-full flex items-center justify-center hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-1" />}
              </button>
              
              <div className="flex-1 flex flex-col space-y-2 justify-center">
                <input 
                  type="range" 
                  min="0" 
                  max={newDuration}
                  step="0.05" 
                  value={currentTime} 
                  onChange={handleSeek}
                  disabled={isEncoding}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-brand-500 hover:accent-brand-400 transition-all"
                />
                <div className="flex justify-between text-xs text-gray-400 font-mono">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(newDuration)}</span>
                </div>
              </div>
            </div>

            {/* Actions: Start Over + Export */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <button
                onClick={() => {
                  setFile(null);
                  setStatus('idle');
                  setWorkflowStep('landing');
                  setDownloadUrl(null);
                  setIsPlaying(false);
                  setCurrentTime(0);
                  setOriginalBuffer(null);
                  setProcessedBuffer(null);
                  setSilenceRegions([]);
                }}
                className="py-4 bg-gray-800 hover:bg-gray-700 text-white font-semibold rounded-xl transition-colors"
              >
                Start Over
              </button>
              
              {/* Export Container */}
              <div className="flex gap-2">
                 <div className="flex bg-white/10 rounded-xl p-1 shrink-0">
                    <button 
                      onClick={() => handleFormatChange('wav')}
                      className={`px-3 py-1 rounded-lg text-sm font-bold transition-all ${exportFormat === 'wav' ? 'bg-brand-500 text-black' : 'text-gray-400 hover:text-white'}`}
                    >
                      WAV
                    </button>
                    <button 
                      onClick={() => handleFormatChange('mp3')}
                      className={`px-3 py-1 rounded-lg text-sm font-bold transition-all ${exportFormat === 'mp3' ? 'bg-brand-500 text-black' : 'text-gray-400 hover:text-white'}`}
                    >
                      MP3
                    </button>
                 </div>
                 
                 <a
                  href={downloadUrl || '#'}
                  download={`silencecut_studio_${Date.now()}.${exportFormat}`}
                  className={`flex-1 py-4 font-bold rounded-xl shadow-[0_0_20px_rgba(34,197,94,0.3)] hover:shadow-[0_0_30px_rgba(34,197,94,0.5)] transition-all flex items-center justify-center space-x-2 
                    ${isEncoding || !downloadUrl 
                      ? 'bg-brand-500/50 cursor-wait' 
                      : 'bg-brand-500 hover:bg-brand-400 text-black'}`
                  }
                  onClick={(e) => {
                    if (isEncoding || !downloadUrl) e.preventDefault();
                  }}
                >
                  {isEncoding ? (
                    <>
                       <Loader2 size={20} className="animate-spin" />
                       <span>Encoding...</span>
                    </>
                  ) : (
                    <>
                      <Download size={20} />
                      <span>Export {exportFormat.toUpperCase()}</span>
                    </>
                  )}
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Error State */}
        {status === 'error' && (
           <div className="text-center py-8 animate-fade-in">
             <div className="text-red-500 font-bold mb-4">{errorMsg}</div>
             <button onClick={() => { setFile(null); setWorkflowStep('landing'); }} className="text-sm underline text-gray-400 hover:text-white">Try different file</button>
           </div>
        )}

        {/* ALWAYS RENDER AUDIO ELEMENT FOR STABILITY */}
        <audio 
          ref={audioRef} 
          onEnded={() => setIsPlaying(false)} 
          onPause={() => setIsPlaying(false)}
          onPlay={() => setIsPlaying(true)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          className="hidden" 
        />

      </div>
      
      <div className="mt-8 text-gray-500 text-sm">
        Processing happens locally. No data leaves your device.
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
