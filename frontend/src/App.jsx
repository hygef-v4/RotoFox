import React, { useState, useEffect, useCallback, useRef } from 'react';
import MainLayout from './components/layout/MainLayout';
import Toolbar from './components/sidebar/Toolbar';
import VideoCanvas from './components/canvas/VideoCanvas';
import TimelineController from './components/timeline/TimelineController';
import { useAIEngine } from './hooks/useAIEngine';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import SetupWizard from './components/setup/SetupWizard';
import LoadingScreen from './components/layout/LoadingScreen';
import { X, CheckCircle, AlertCircle, Download, Film, Settings, Copy, Cpu, FolderOpen } from 'lucide-react';

const OBJECT_COLORS = [
  '#FF3B30', // Red
  '#007AFF', // Blue
  '#34C759', // Green
  '#FF9500', // Orange
  '#AF52DE', // Purple
  '#5AC8FA', // Cyan
  '#FFCC00', // Yellow
];

function App() {
  const [clickMode, setClickMode] = useState('add');
  const [videoUrl, setVideoUrl] = useState(null);
  
  // Playback & workspace states
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(100);
  const videoOffsetFrame = 0;

  // Incrementing this number tells VideoCanvas to clear all click dots/boxes
  const [clearSignal, setClearSignal] = useState(0);
  // Incrementing this number tells VideoCanvas to undo the last placed point/box
  const [undoSignal, setUndoSignal] = useState(0);
  // Incrementing this number tells VideoCanvas to redo the last undone point/box
  const [redoSignal, setRedoSignal] = useState(0);

  // Export overlay states
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormat, setExportFormat] = useState('mp4');
  const [exportType, setExportType] = useState('solid');
  const [exportPath, setExportPath] = useState('');
  const [exportBgColor, setExportBgColor] = useState('green'); // green, blue, black, white
  const [exportResolution, setExportResolution] = useState('original'); // original, 1080p, 720p
  const [exportFps, setExportFps] = useState('original'); // original, 24, 30, 60
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // View Mode
  const [viewMode, setViewMode] = useState('overlay'); // overlay, isolated

  // Multi-object tracking state
  const [objects, setObjects] = useState([{ id: 1, color: OBJECT_COLORS[0], name: 'Object 1' }]);
  const [activeObjectId, setActiveObjectId] = useState(1);
  const [deleteObjectSignal, setDeleteObjectSignal] = useState(null);

  // Model Hub modal visibility
  const [showModelHubModal, setShowModelHubModal] = useState(false);

  // Setup Wizard
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [setupStatus, setSetupStatus] = useState(null);

  const [copied, setCopied] = useState(false);
  // IMPROVE-03: Toast notification when tracking completes
  const [showTrackingDoneToast, setShowTrackingDoneToast] = useState(false);
  const trackingDoneTimerRef = useRef(null);
  const handleCopyPath = () => {
    if (exportFilePath) {
      navigator.clipboard.writeText(exportFilePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const {
    isConnected,
    isTracking,
    maskImage,
    progressData,
    sendClick,
    startTracking,
    cancelTracking,
    uploadVideo,
    
    // Export values
    exportProgress,
    exportStatus,
    exportMessage,
    exportFilePath,
    startExport,
    resetExport,
    requestMask,
    clearMaskCache,
    clearBackendState,
    removeObject,
    trackedFrames,
    
    // Model Hub
    systemInfo,
    downloadStatus,
    getSystemInfo,
    downloadModel,
    loadModel,
    resetDownloadStatus,
    setCheckpointsDir,
    openDirectory
  } = useAIEngine();

  const [backendFramesCount, setBackendFramesCount] = useState(null);
  const backendFramesCountRef = useRef(null); // ref to avoid stale closure in handleVideoMetadataLoaded
  const [isUploading, setIsUploading] = useState(false);
  const isUploadingRef = useRef(false);         // ref to avoid stale closure in handleCanvasClick
  const [isBackendReady, setIsBackendReady] = useState(false);
  const isBackendReadyRef = useRef(false);      // ref to avoid stale closure in handleCanvasClick

  // Keyboard shortcut refs – avoid stale closures in the single keydown listener
  const currentFrameRef_kb = useRef(0);
  useEffect(() => { currentFrameRef_kb.current = currentFrame; }, [currentFrame]);
  const totalFramesRef_kb = useRef(100);
  useEffect(() => { totalFramesRef_kb.current = totalFrames; }, [totalFrames]);
  const isTrackingRef_kb = useRef(false);
  useEffect(() => { isTrackingRef_kb.current = isTracking; }, [isTracking]);
  const videoOffsetFrameRef_kb = useRef(0);
  useEffect(() => { videoOffsetFrameRef_kb.current = videoOffsetFrame; }, [videoOffsetFrame]);
  const hasVideoRef_kb = useRef(false);
  useEffect(() => { hasVideoRef_kb.current = !!videoUrl; }, [videoUrl]);

  const hasAutoOpenedRef = useRef(false);

  // First-run detection via localStorage — independent of WebSocket state.
  // Shows wizard immediately, then updates with live backend data via HTTP polling.
  useEffect(() => {
    if (hasAutoOpenedRef.current) return;

    const SETUP_DONE_KEY = 'rotofox_setup_done';
    if (localStorage.getItem(SETUP_DONE_KEY) === 'true') return;

    // Show wizard immediately (loading state) on first run
    hasAutoOpenedRef.current = true;
    setShowSetupWizard(true);

    // Poll /api/setup-status until backend is ready (retries every 2s)
    let cancelled = false;
    let retries = 0;
    const MAX_RETRIES = 15; // 30 seconds

    const poll = () => {
      fetch('http://127.0.0.1:8000/api/setup-status')
        .then(r => r.json())
        .then(data => {
          if (cancelled) return;
          setSetupStatus(data);
          if (!data.needs_setup) {
            // All models already present — close wizard and mark done
            localStorage.setItem(SETUP_DONE_KEY, 'true');
            setShowSetupWizard(false);
          }
        })
        .catch(() => {
          if (cancelled) return;
          retries++;
          if (retries >= MAX_RETRIES) {
            setSetupStatus({ error: "Backend failed to start after 30 seconds. Please check if your system meets the requirements or if another app is using port 8000." });
          } else {
            setTimeout(poll, 2000);
          }
        });
    };
    poll();
    return () => { cancelled = true; };
  }, []);

  // Update setupStatus whenever the Setup Wizard is opened in-session
  useEffect(() => {
    if (showSetupWizard && isConnected) {
      fetch('http://127.0.0.1:8000/api/setup-status')
        .then(r => r.json())
        .then(data => {
          setSetupStatus(data);
        })
        .catch(err => {
          console.error("Failed to update setup status:", err);
        });
    }
  }, [showSetupWizard, isConnected]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!hasVideoRef_kb.current) return;
      if (isTrackingRef_kb.current) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const f = Math.max(0, currentFrameRef_kb.current - 1);
        setCurrentFrame(f);
        if (isBackendReadyRef.current && requestMask) requestMask(f + videoOffsetFrameRef_kb.current);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const f = Math.min(totalFramesRef_kb.current, currentFrameRef_kb.current + 1);
        setCurrentFrame(f);
        if (isBackendReadyRef.current && requestMask) requestMask(f + videoOffsetFrameRef_kb.current);
      } else if (e.key === ' ') {
        e.preventDefault();
        setIsPlaying(prev => !prev);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        setRedoSignal(s => s + 1);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        setUndoSignal(s => s + 1);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        setRedoSignal(s => s + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => {
    if (isTracking && progressData.currentFrame !== currentFrame) {
      setCurrentFrame(progressData.currentFrame);
    }
  }, [progressData.currentFrame, isTracking]);

  // IMPROVE-03: Detect tracking completion by watching isTracking go from true -> false
  const wasTrackingRef = useRef(false);
  useEffect(() => {
    if (wasTrackingRef.current && !isTracking && trackedFrames.length > 0) {
      setShowTrackingDoneToast(true);
      if (trackingDoneTimerRef.current) clearTimeout(trackingDoneTimerRef.current);
      trackingDoneTimerRef.current = setTimeout(() => setShowTrackingDoneToast(false), 3500);
    }
    wasTrackingRef.current = isTracking;
  }, [isTracking, trackedFrames.length]);

  const handleVideoImport = async (url, file) => {
    setVideoUrl(url);
    setIsPlaying(false);
    setCurrentFrame(0);
    setBackendFramesCount(null); // Reset for new video
    setIsUploading(true);
    isUploadingRef.current = true;
    setIsBackendReady(false);
    isBackendReadyRef.current = false;
    clearMaskCache();  // Flush cached masks from previous video
    console.log("Importing video locally:", file.name);

    // Upload to backend for SAM 2 frame extraction + model loading
    const result = await uploadVideo(file);
    if (result) {
      console.log(`Video successfully loaded into SAM 2 engine. Extracted ${result.frames_count} frames.`);
      backendFramesCountRef.current = result.frames_count; // update ref immediately (sync)
      setBackendFramesCount(result.frames_count);
      setTotalFrames(result.frames_count);
      isBackendReadyRef.current = true;   // update ref immediately before setState batch
      setIsBackendReady(true);
    }
    isUploadingRef.current = false;       // update ref immediately before setState
    setIsUploading(false);
  };

  // Sample video logic removed for production ready state

  const handleVideoMetadataLoaded = (metadata) => {
    // Use ref (not state) to always get the latest backendFramesCount, avoiding stale closure race condition
    const actualFrames = backendFramesCountRef.current || metadata.totalFrames;
    setTotalFrames(actualFrames);
    setCurrentFrame(0);
    console.log(`Video loaded: ${actualFrames} frames (backend: ${backendFramesCountRef.current}, metadata est: ${metadata.totalFrames}), duration ${metadata.duration.toFixed(2)}s`);
  };

  const handleCanvasClick = useCallback((pointsData, boxesData) => {
    // Use refs instead of state to always read the latest value (avoid stale closure)
    const uploading = isUploadingRef.current;
    const ready = isBackendReadyRef.current;
    console.log(`handleCanvasClick: points=${pointsData.length}, boxes=${boxesData.length}, isUploading=${uploading}, isBackendReady=${ready}`);
    if (uploading || !ready) {
      console.warn("Ignored click: Backend is still initializing the video.");
      return;
    }
    // Send absolute frame index (current relative frame + trim offset) to the backend
    sendClick(pointsData, boxesData, currentFrame + videoOffsetFrame, activeObjectId);
  }, [currentFrame, videoOffsetFrame, sendClick, activeObjectId]);

  const handlePlayToggle = (val) => {
    if (isTracking) return;
    setIsPlaying(prev => (val !== undefined ? val : !prev));
  };

  const handleSeek = (frame) => {
    if (isTracking) return;
    const clamped = Math.max(0, Math.min(totalFrames, frame));
    setCurrentFrame(clamped);
    if (isBackendReady && requestMask) {
      requestMask(clamped + videoOffsetFrame);
    }
  };



  const handleClearClicks = () => {
    setClearSignal(s => s + 1);
    clearMaskCache();  // Flush cached masks when clearing points
    clearBackendState(currentFrame + videoOffsetFrame); // Tell backend to reset SAM 2 inference state
  };

  const handleAddObject = () => {
    if (objects.length >= 7) return;
    const newId = objects.length > 0 ? Math.max(...objects.map(o => o.id)) + 1 : 1;
    const color = OBJECT_COLORS[(newId - 1) % OBJECT_COLORS.length];
    setObjects(prev => [...prev, { id: newId, color, name: `Object ${newId}` }]);
    setActiveObjectId(newId);
  };

  const handleDeleteObject = (e, id) => {
    e.stopPropagation();
    if (objects.length <= 1) return;
    
    removeObject(id, currentFrame + videoOffsetFrame);
    const newObjects = objects.filter(o => o.id !== id);
    setObjects(newObjects);
    if (activeObjectId === id) {
      setActiveObjectId(newObjects.length > 0 ? newObjects[0].id : null);
    }
    // Only delete points for this object on the canvas
    setDeleteObjectSignal({ id, t: Date.now() });
  };

  const hasModelsLoaded = systemInfo && systemInfo.models && systemInfo.models.length > 0;
  const matanyoneModel = hasModelsLoaded && systemInfo.models.find(m => m.id === 'matanyone');
  const samModels = hasModelsLoaded && systemInfo.models.filter(m => m.id !== 'matanyone');
  
  const matanyoneReady = matanyoneModel && matanyoneModel.downloaded;
  const samReady = samModels && samModels.some(m => m.downloaded);
  
  const showMissingModelsBanner = isConnected && !showSetupWizard && hasModelsLoaded && (!matanyoneReady || !samReady);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background">
      {!isConnected && (
        <LoadingScreen isConnected={isConnected} />
      )}

      {showMissingModelsBanner && (
        <div className="bg-red-950/80 backdrop-blur-md border-b border-red-500/20 text-red-200 px-6 py-3 text-xs flex justify-between items-center z-40 animate-fade-in flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
            <div className="flex items-center gap-1.5">
              <AlertCircle size={14} className="text-red-400" />
              <span>
                <strong>AI Models Missing:</strong> Local AI models are not downloaded. Rotoscoping and refinement are disabled.
              </span>
            </div>
          </div>
          <button 
            onClick={() => setShowSetupWizard(true)}
            className="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-4 py-1.5 rounded-lg transition-colors shadow-lg shadow-orange-500/20 cursor-pointer active:scale-[0.98]"
          >
            Download Now
          </button>
        </div>
      )}

      <div className="flex-1 relative overflow-hidden">

      {/* IMPROVE-03: Tracking Complete Toast */}
      {showTrackingDoneToast && (
        <div className="fixed bottom-[180px] left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 bg-[#0f1a0f]/95 border border-green-500/30 backdrop-blur-md px-4 py-2.5 rounded-xl shadow-lg shadow-green-950/40 text-xs font-semibold text-green-400 animate-in fade-in slide-in-from-bottom-3 duration-300">
          <CheckCircle size={15} className="text-green-400 flex-shrink-0" />
          <span>Tracking complete — {trackedFrames.length} frames processed</span>
          <button onClick={() => setShowTrackingDoneToast(false)} className="ml-1 text-green-400/50 hover:text-green-400 transition-colors">
            <X size={12} />
          </button>
        </div>
      )}
      
      <MainLayout 
        toolbar={
          <Toolbar 
            clickMode={clickMode} 
            setClickMode={setClickMode} 
            onVideoImport={handleVideoImport}
            onExportClick={() => setShowExportModal(true)}
            onSettingsClick={() => setShowSettingsModal(true)}
            onModelHubClick={() => setShowModelHubModal(true)}
            onUndoClick={() => setUndoSignal(s => s + 1)}
            onRedoClick={() => setRedoSignal(s => s + 1)}
            onClearClicks={handleClearClicks}
            viewMode={viewMode}
            setViewMode={setViewMode}
            objects={objects}
            activeObjectId={activeObjectId}
            setActiveObjectId={setActiveObjectId}
            handleAddObject={handleAddObject}
            handleDeleteObject={handleDeleteObject}
          />
        }
        canvas={
          <VideoCanvas 
            videoUrl={videoUrl}
            clickMode={clickMode}
            onCanvasClick={handleCanvasClick}
            maskImageBase64={maskImage}
            isPlaying={isPlaying}
            currentFrame={currentFrame}
            videoOffsetFrame={videoOffsetFrame}
            totalFrames={totalFrames}
            onVideoMetadataLoaded={handleVideoMetadataLoaded}
            onFrameChange={setCurrentFrame}
            onPlayToggle={setIsPlaying}
            clearSignal={clearSignal}
            undoSignal={undoSignal}
            redoSignal={redoSignal}
            isUploading={isUploading}
            viewMode={viewMode}
            onRequestMask={requestMask}
            objects={objects}
            activeObjectId={activeObjectId}
            deleteObjectSignal={deleteObjectSignal}
            onVideoImport={handleVideoImport}
          />
        }
        timeline={
          <TimelineController 
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            isPlaying={isPlaying}
            isTracking={isTracking}
            hasVideo={!!videoUrl}
            objects={objects}
            activeObjectId={activeObjectId}
            trackedFrames={trackedFrames}
            onPlayToggle={() => handlePlayToggle()}
            // ISSUE-04 FIX: Only allow tracking if there's at least one mask/click on current video
            onTrackForward={() => startTracking(totalFrames, currentFrame + videoOffsetFrame)}
            canTrack={!!maskImage || trackedFrames.length > 0}
            onCancelTracking={cancelTracking}
            onSeek={handleSeek}
          />
        }
      />

      {/* Export Popup Modal */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-[#171717] border border-[#333] rounded-xl w-[500px] p-6 shadow-2xl relative">
            <button 
              onClick={() => {
                setShowExportModal(false);
                resetExport();
              }}
              className="absolute top-4 right-4 text-textSecondary hover:text-textPrimary transition-colors"
            >
              <X size={20} />
            </button>

            <h3 className="text-xl font-bold mb-4 text-orange-500 flex items-center gap-2">
              <Download size={22} />
              Export RotoFox Project
            </h3>

            {exportStatus === "idle" && (
              <div className="space-y-4">
                <p className="text-xs text-textSecondary">
                  Render and compile your mask frames into a production-ready alpha/matte video.
                </p>
                
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Export Format</label>
                    <div className="grid grid-cols-3 gap-2">
                      {['mp4', 'mov', 'webm'].map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setExportFormat(f)}
                          className={`px-3 py-2 rounded-md border text-xs font-semibold transition-all ${exportFormat === f ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-[#222] border-[#333] hover:border-[#444] text-textSecondary'}`}
                        >
                          {f.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Render Type</label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { id: 'solid', label: 'Solid Color', desc: 'Isolated background' },
                        { id: 'alpha', label: 'Alpha Matte', desc: 'B&W mask video' },
                        { id: 'overlay', label: 'Video Overlay', desc: 'Mask on video' }
                      ].map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setExportType(t.id)}
                          className={`p-2 rounded-lg border text-left transition-all ${exportType === t.id ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-[#222] border-[#333] hover:border-[#444] text-textSecondary'}`}
                        >
                          <div className="text-[11px] font-semibold text-textPrimary">{t.label}</div>
                          <div className="text-[9px] mt-0.5 opacity-70">{t.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  </div>

                  {exportType === 'solid' && (
                    <div className="animate-fade-in">
                      <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Background Color</label>
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { id: 'green', color: '#00FF00', label: 'Green' },
                          { id: 'blue', color: '#0000FF', label: 'Blue' },
                          { id: 'black', color: '#000000', label: 'Black' },
                          { id: 'white', color: '#FFFFFF', label: 'White' }
                        ].map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setExportBgColor(c.id)}
                            className={`py-1.5 rounded-md border flex flex-col items-center justify-center transition-all ${exportBgColor === c.id ? 'border-orange-500 bg-[#333]' : 'border-[#333] hover:border-[#555] bg-[#222]'}`}
                          >
                            <div className="w-3 h-3 rounded-full border border-[#555] mb-1" style={{ backgroundColor: c.color }}></div>
                            <div className="text-[9px] font-semibold text-textSecondary">{c.label}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => startExport({ format: exportFormat, type: exportType, bg_color: exportBgColor, total_frames: totalFrames, export_path: exportPath, resolution: exportResolution, fps: exportFps })}
                    className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2.5 rounded-lg transition-colors mt-4 flex items-center justify-center gap-2"
                  >
                    Start Exporting
                  </button>
                </div>
              )}

            {exportStatus === "rendering" && (
              <div className="py-6 flex flex-col items-center justify-center text-center">
                <div className="relative w-16 h-16 mb-4 flex items-center justify-center">
                  <div className="absolute inset-0 border-4 border-orange-500/20 border-t-orange-500 rounded-full animate-spin"></div>
                  <Film className="text-orange-500 animate-pulse" size={24} />
                </div>
                
                <h4 className="font-semibold text-textPrimary mb-1">Rendering Project...</h4>
                <p className="text-xs text-textSecondary mb-4">{exportMessage}</p>

                <div className="w-full bg-[#222] rounded-full h-2 overflow-hidden mb-2">
                  <div 
                    className="bg-orange-500 h-full transition-all duration-300 ease-out" 
                    style={{ width: `${exportProgress}%` }}
                  />
                </div>
                <span className="text-sm font-mono text-orange-400 font-semibold">{exportProgress}%</span>
              </div>
            )}

            {exportStatus === "completed" && (
              <div className="py-6 flex flex-col items-center justify-center text-center">
                <CheckCircle className="text-green-500 mb-4 animate-bounce" size={48} />
                <h4 className="font-bold text-textPrimary text-lg mb-1">Export Successful!</h4>
                <p className="text-xs text-textSecondary mb-6">{exportMessage}</p>

                <div className="w-full flex items-center justify-between gap-3 bg-[#222] border border-[#333] rounded-lg p-3 mb-6">
                  <div className="text-left font-mono text-[10px] text-textSecondary overflow-x-auto select-all flex-1 pr-2">
                    <span className="text-textSecondary block mb-1 uppercase font-sans font-bold tracking-wider">Saved Path:</span>
                    {exportFilePath}
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyPath}
                    aria-label="Copy export file path to clipboard"
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10px] font-bold transition-all duration-200 border flex-shrink-0 ${
                      copied 
                        ? 'bg-green-500/10 border-green-500/30 text-green-400 font-sans' 
                        : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.08] text-textSecondary hover:text-textPrimary focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none font-sans'
                    }`}
                  >
                    <Copy size={11} />
                    {copied ? 'Copied!' : 'Copy Path'}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setShowExportModal(false);
                    resetExport();
                  }}
                  className="w-full bg-white hover:bg-gray-200 text-black font-semibold py-2.5 rounded-lg transition-colors"
                >
                  Done
                </button>
              </div>
            )}

            {exportStatus === "error" && (
              <div className="py-6 flex flex-col items-center justify-center text-center">
                <AlertCircle className="text-red-500 mb-4 animate-shake" size={48} />
                <h4 className="font-bold text-textPrimary text-lg mb-1">Export Failed</h4>
                <p className="text-xs text-textSecondary mb-6">{exportMessage}</p>

                <button
                  type="button"
                  onClick={() => startExport({ format: exportFormat, type: exportType, bg_color: exportBgColor, total_frames: totalFrames, export_path: exportPath, resolution: exportResolution, fps: exportFps })}
                  className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2.5 rounded-lg transition-colors mb-2"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportModal(false);
                    resetExport();
                  }}
                  className="w-full bg-surfaceHover hover:bg-[#333] text-textPrimary font-semibold py-2.5 rounded-lg transition-colors"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showSettingsModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-[#171717] border border-[#333] rounded-xl w-[450px] p-6 shadow-2xl relative">
            <button 
              onClick={() => setShowSettingsModal(false)}
              className="absolute top-4 right-4 text-textSecondary hover:text-textPrimary transition-colors"
            >
              <X size={20} />
            </button>

            <h3 className="text-xl font-bold mb-6 text-textPrimary flex items-center gap-2">
              <Settings size={22} className="text-orange-500" />
              Output Settings
            </h3>

            <div className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Export Folder Path</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={exportPath}
                    readOnly
                    placeholder="Click Browse to choose a folder..."
                    className="flex-1 bg-[#222] border border-[#333] rounded-lg p-2 text-sm text-textPrimary placeholder-[#555] cursor-default"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const selected = await openDialog({ directory: true, multiple: false, title: 'Choose Export Folder' });
                      if (selected) setExportPath(selected);
                    }}
                    className="flex items-center gap-1.5 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/25 text-orange-400 text-[11px] font-bold px-3 py-2 rounded-lg transition-colors flex-shrink-0"
                  >
                    <FolderOpen size={13} />
                    Browse
                  </button>
                  {exportPath && (
                    <button
                      type="button"
                      onClick={() => setExportPath('')}
                      className="text-textSecondary hover:text-red-400 transition-colors flex-shrink-0"
                      title="Clear path"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-textSecondary mt-1">If blank, exports will be saved to your Downloads/RotoFox Exports folder.</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Resolution</label>
                <select 
                  value={exportResolution}
                  onChange={(e) => setExportResolution(e.target.value)}
                  className="w-full bg-[#222] border border-[#333] rounded-lg p-2 text-sm text-textPrimary focus:border-orange-500 focus:outline-none transition-colors"
                >
                  <option value="original">Original (Match Video)</option>
                  <option value="1080p">1080p (1920x1080)</option>
                  <option value="720p">720p (1280x720)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Framerate (FPS)</label>
                <select 
                  value={exportFps}
                  onChange={(e) => setExportFps(e.target.value)}
                  className="w-full bg-[#222] border border-[#333] rounded-lg p-2 text-sm text-textPrimary focus:border-orange-500 focus:outline-none transition-colors"
                >
                  <option value="original">Original (25 fps approx)</option>
                  <option value="24">24 FPS (Cinematic)</option>
                  <option value="30">30 FPS</option>
                  <option value="60">60 FPS (Smooth)</option>
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowSettingsModal(false)}
              className="w-full mt-6 bg-white hover:bg-gray-200 text-black font-semibold py-2 rounded-lg transition-colors cursor-pointer"
            >
              Save Settings
            </button>
          </div>
        </div>
      )}

      {showModelHubModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-[#171717] border border-[#333] rounded-xl w-[600px] p-6 shadow-2xl relative">
            <button 
              onClick={() => {
                setShowModelHubModal(false);
                resetDownloadStatus();
              }}
              className="absolute top-4 right-4 text-textSecondary hover:text-textPrimary transition-colors cursor-pointer"
            >
              <X size={20} />
            </button>

            <h3 className="text-xl font-bold mb-1 text-textPrimary flex items-center gap-2">
              <Cpu size={22} className="text-orange-500 animate-pulse-subtle" />
              RotoFox AI Model Hub
            </h3>
            <p className="text-xs text-textSecondary mb-4">
              Local Hardware Profiler & Segment Anything Model (SAM) Manager.
            </p>

            {/* Hardware Profile Panel */}
            <div className="bg-black/35 rounded-lg p-3.5 border border-white/[0.04] mb-4">
              <div className="text-[10px] font-bold text-textSecondary/60 uppercase tracking-wider mb-2">Hardware Detection Profile</div>
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-textSecondary block">Graphics Processing Unit (GPU):</span>
                  <span className={`font-semibold ${systemInfo.gpu_available ? 'text-green-400' : 'text-orange-400'}`}>
                    {systemInfo.gpu_name} {systemInfo.total_vram_gb ? `(${systemInfo.total_vram_gb} GB VRAM)` : ''}
                  </span>
                </div>
                <div>
                  <span className="text-textSecondary block">System Memory (RAM):</span>
                  <span className="font-semibold text-textPrimary">
                    {systemInfo.system_ram_gb ? `${systemInfo.system_ram_gb} GB RAM` : 'Local Host'}
                  </span>
                </div>
              </div>
              <div className="mt-2.5 pt-2.5 border-t border-white/[0.04] flex items-center gap-2 text-xs text-textSecondary">
                <span>Recommended configuration for your PC:</span>
                <span className="bg-orange-500/10 text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider">
                  SAM 2.1 {systemInfo.recommended_model.toUpperCase()}
                </span>
              </div>
            </div>

            {/* Checkpoints Directory Configuration */}
            <div className="bg-black/35 rounded-lg p-3.5 border border-white/[0.04] mb-4 animate-fade-in">
              <div className="text-[10px] font-bold text-textSecondary/60 uppercase tracking-wider mb-2">Model Storage Folder</div>
              <div className="flex items-center gap-2">
                <input 
                  type="text" 
                  defaultValue={systemInfo.checkpoints_dir || ''}
                  onBlur={(e) => {
                    if (e.target.value !== systemInfo.checkpoints_dir) {
                      setCheckpointsDir(e.target.value);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.target.blur();
                    }
                  }}
                  placeholder="e.g. D:\Models\SAM2 (Leave blank for default folder)"
                  className="flex-1 bg-[#222] border border-[#333] rounded-lg px-3 py-1.5 text-xs text-textPrimary focus:border-orange-500 focus:outline-none transition-colors placeholder-[#555]"
                />
                <button
                  type="button"
                  onClick={() => openDirectory()}
                  className="bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/25 text-[10px] font-bold text-orange-400 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
                  title="Open folder in System Explorer"
                >
                  <FolderOpen size={12} />
                  Open Folder
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCheckpointsDir('');
                  }}
                  className="bg-white/[0.02] hover:bg-white/[0.07] border border-white/[0.04] text-[10px] font-bold text-textSecondary hover:text-textPrimary px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
                  title="Reset to default checkpoints directory"
                >
                  Reset Default
                </button>
              </div>
              <p className="text-[9px] text-textSecondary/70 mt-1 leading-relaxed">
                {systemInfo.is_custom_dir 
                  ? "✓ Custom path active. Model checkpoints will be saved to and loaded from this directory."
                  : "Using default local checkpoints directory inside backend application."}
              </p>
            </div>

            {/* Download Status Panel */}
            {downloadStatus.status === 'downloading' && (
              <div className="mb-4 bg-orange-500/5 border border-orange-500/20 rounded-lg p-3 animate-pulse-subtle">
                <div className="flex justify-between items-center text-xs font-semibold text-orange-400 mb-1.5">
                  <span>{downloadStatus.message}</span>
                  <span>{downloadStatus.progress}%</span>
                </div>
                <div className="w-full bg-black/40 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-orange-500 h-full transition-all duration-200" style={{ width: `${downloadStatus.progress}%` }}></div>
                </div>
              </div>
            )}
            
            {downloadStatus.status === 'completed' && (
              <div className="mb-4 bg-green-500/10 border border-green-500/25 rounded-lg p-2.5 flex items-center gap-2 text-xs text-green-400">
                <CheckCircle size={15} />
                <span>{downloadStatus.message} Model checkpoint is downloaded and ready to activate.</span>
              </div>
            )}

            {downloadStatus.status === 'error' && (
              <div className="mb-4 bg-red-500/10 border border-red-500/25 rounded-lg p-2.5 flex items-center gap-2 text-xs text-red-400">
                <AlertCircle size={15} />
                <span>{downloadStatus.message}</span>
              </div>
            )}

            {/* Models list */}
            <div className="space-y-4 max-h-[300px] overflow-y-auto pr-1">
              
              {/* SAM 2.1 section */}
              <div>
                <div className="text-[10px] font-bold text-orange-400/90 uppercase tracking-wider mb-2 flex items-center gap-1">
                  <span>1. Live Object Tracking Models (SAM 2.1)</span>
                  <span className="text-[9px] text-textSecondary/50 font-normal normal-case">(Download & activate exactly one to start prompting)</span>
                </div>
                
                <div className="space-y-2">
                  {systemInfo.models.filter(m => m.id !== 'matanyone').map((model) => {
                    const isActive = systemInfo.active_model === model.id;
                    const isRecommended = model.recommended;
                    
                    return (
                      <div 
                        key={model.id} 
                        className={`flex items-center justify-between p-3 rounded-lg border transition-all ${isActive ? 'bg-orange-500/[0.03] border-orange-500/40 shadow-[0_0_12px_rgba(249,115,22,0.04)]' : 'bg-black/10 border-white/[0.04] hover:bg-white/[0.01] hover:border-white/[0.08]'}`}
                      >
                        <div className="flex-1 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-textPrimary">{model.name}</span>
                            {isRecommended && (
                              <span className="bg-green-500/10 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wide">Recommended</span>
                            )}
                            {isActive && (
                              <span className="bg-orange-500 text-white px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wide animate-pulse">Active</span>
                            )}
                          </div>
                          <p className="text-[10px] text-textSecondary mt-0.5 leading-relaxed">{model.description}</p>
                          <div className="flex gap-3 text-[9px] text-textSecondary/70 mt-1 font-mono">
                            <span>Speed: {model.speed}</span>
                            <span>•</span>
                            <span>VRAM Req: {model.vram_req} GB</span>
                            {model.downloaded && (
                              <>
                                <span>•</span>
                                <span className="text-textSecondary/90 font-bold">Size: {model.size_mb} MB</span>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex-shrink-0">
                          {model.downloaded ? (
                            <button
                              type="button"
                              onClick={() => loadModel(model.id)}
                              disabled={isActive || downloadStatus.status === 'downloading'}
                              className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all cursor-pointer ${isActive ? 'bg-white/[0.03] text-textSecondary cursor-not-allowed border border-white/[0.04]' : 'bg-white hover:bg-gray-200 text-black shadow-sm font-semibold active:scale-[0.97]'}`}
                            >
                              {isActive ? 'Active' : 'Activate'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => downloadModel(model.id)}
                              disabled={downloadStatus.status === 'downloading'}
                              className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all cursor-pointer ${downloadStatus.status === 'downloading' ? 'bg-[#222] text-textSecondary border border-[#333] cursor-not-allowed' : 'bg-orange-500 hover:bg-orange-600 text-white shadow-md active:scale-[0.97] border border-orange-400/20'}`}
                            >
                              Download
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* MatAnyone 2 section */}
              {systemInfo.models.some(m => m.id === 'matanyone') && (
                <div className="pt-2 border-t border-white/[0.03]">
                  <div className="text-[10px] font-bold text-orange-400/90 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <span>2. Edge Refinement Models (MatAnyone 2)</span>
                    <span className="text-[9px] text-textSecondary/50 font-normal normal-case">(Optional - Runs silently during Export to refine hair/edges)</span>
                  </div>
                  
                  {systemInfo.models.filter(m => m.id === 'matanyone').map((model) => {
                    const isDownloaded = model.downloaded;
                    
                    return (
                      <div 
                        key={model.id} 
                        className={`flex items-center justify-between p-3 rounded-lg border transition-all ${isDownloaded ? 'bg-green-500/[0.01] border-green-500/20' : 'bg-black/10 border-white/[0.04] hover:bg-white/[0.01]'}`}
                      >
                        <div className="flex-1 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-textPrimary">{model.name}</span>
                            {isDownloaded && (
                              <span className="bg-green-500/10 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wide">Ready for Export</span>
                            )}
                          </div>
                          <p className="text-[10px] text-textSecondary mt-0.5 leading-relaxed">{model.description}</p>
                          <div className="flex gap-3 text-[9px] text-textSecondary/70 mt-1 font-mono">
                            <span>VRAM Req: {model.vram_req} GB</span>
                            {model.downloaded && (
                              <>
                                <span>•</span>
                                <span className="text-textSecondary/90 font-bold">Size: {model.size_mb} MB</span>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex-shrink-0">
                          {isDownloaded ? (
                            <span className="text-[10px] font-bold text-green-400 border border-green-500/30 bg-green-500/5 px-2.5 py-1.5 rounded-md">
                              Installed
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => downloadModel(model.id)}
                              disabled={downloadStatus.status === 'downloading'}
                              className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all cursor-pointer ${downloadStatus.status === 'downloading' ? 'bg-[#222] text-textSecondary border border-[#333] cursor-not-allowed' : 'bg-orange-500 hover:bg-orange-600 text-white shadow-md active:scale-[0.97] border border-orange-400/20'}`}
                            >
                              Download
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            
            <div className="mt-5 pt-4 border-t border-white/[0.04] text-[9px] text-textSecondary text-center">
              Make sure you have a stable internet connection for model downloads. Checkpoint weights will be stored in your backend/checkpoints directory.
            </div>
          </div>
        </div>
      )}

      {/* First-Run Setup Wizard */}
      {showSetupWizard && (
        <SetupWizard
          setupStatus={setupStatus}
          downloadStatus={downloadStatus}
          downloadModel={downloadModel}
          onComplete={() => {
            localStorage.setItem('rotofox_setup_done', 'true');
            setShowSetupWizard(false);
          }}
        />
      )}
      </div>
    </div>
  );
}

export default App;
