import React, { useState, useEffect, useCallback, useRef } from 'react';
import MainLayout from './components/layout/MainLayout';
import Toolbar from './components/sidebar/Toolbar';
import VideoCanvas from './components/canvas/VideoCanvas';
import TimelineController from './components/timeline/TimelineController';
import { useAIEngine } from './hooks/useAIEngine';
import { X, CheckCircle, AlertCircle, Download, Film, Settings, Copy } from 'lucide-react';

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

  const [copied, setCopied] = useState(false);
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
    trackedFrames
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

  return (
    <>
      {!isConnected && (
        <div className="absolute top-2 right-2 bg-red-500/20 border border-red-500 text-red-400 px-3 py-1 rounded text-xs z-50">
          Disconnected from AI Core
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
            onClearClicks={handleClearClicks}
            onUndoClick={() => setUndoSignal(s => s + 1)}
            onRedoClick={() => setRedoSignal(s => s + 1)}
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
            onTrackForward={() => startTracking(totalFrames, currentFrame + videoOffsetFrame)}
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
                <input 
                  type="text" 
                  value={exportPath}
                  onChange={(e) => setExportPath(e.target.value)}
                  placeholder="e.g. D:\Videos\RotoFox (Leave blank for Downloads)"
                  className="w-full bg-[#222] border border-[#333] rounded-lg p-2 text-sm text-textPrimary focus:border-orange-500 focus:outline-none transition-colors placeholder-[#555]"
                />
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
              className="w-full mt-6 bg-white hover:bg-gray-200 text-black font-semibold py-2 rounded-lg transition-colors"
            >
              Save Settings
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
