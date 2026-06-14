import React, { useState, useEffect } from 'react';
import MainLayout from './components/layout/MainLayout';
import Toolbar from './components/sidebar/Toolbar';
import VideoCanvas from './components/canvas/VideoCanvas';
import TimelineController from './components/timeline/TimelineController';
import { useAIEngine } from './hooks/useAIEngine';
import { X, CheckCircle, AlertCircle, Download, Film } from 'lucide-react';

function App() {
  const [clickMode, setClickMode] = useState('add');
  const [videoUrl, setVideoUrl] = useState(null);
  
  // Playback & workspace states
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(100);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(100);
  const [videoOffsetFrame, setVideoOffsetFrame] = useState(0);

  // Incrementing this number tells VideoCanvas to clear all click dots/boxes
  const [clearSignal, setClearSignal] = useState(0);

  // Export overlay states
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormat, setExportFormat] = useState('mp4');
  const [exportType, setExportType] = useState('alpha');

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
    resetExport
  } = useAIEngine();

  const [backendFramesCount, setBackendFramesCount] = useState(null);

  // Sync current frame from AI tracking progress updates
  useEffect(() => {
    if (isTracking && progressData.currentFrame !== currentFrame) {
      setCurrentFrame(progressData.currentFrame);
    }
  }, [progressData.currentFrame, isTracking]);

  const handleVideoImport = async (url, file) => {
    setVideoUrl(url);
    setIsPlaying(false);
    setCurrentFrame(0);
    setVideoOffsetFrame(0);
    setBackendFramesCount(null); // Reset for new video
    console.log("Importing video locally:", file.name);

    // Upload to backend for SAM 2 frame extraction + model loading
    const result = await uploadVideo(file);
    if (result) {
      console.log(`Video successfully loaded into SAM 2 engine. Extracted ${result.frames_count} frames.`);
      setBackendFramesCount(result.frames_count);
      setTotalFrames(result.frames_count);
      setTrimEnd(result.frames_count);
    }
  };

  // Sample video logic removed for production ready state

  const handleVideoMetadataLoaded = (metadata) => {
    // If backend already returned true frame count, use it. Else estimate 30fps.
    const actualFrames = backendFramesCount || metadata.totalFrames;
    setTotalFrames(actualFrames);
    setTrimStart(0);
    setTrimEnd(actualFrames);
    setCurrentFrame(0);
    setVideoOffsetFrame(0);
    console.log(`Video loaded: ${actualFrames} frames, duration ${metadata.duration.toFixed(2)}s`);
  };

  const handleCanvasClick = (coords, mode) => {
    // Send absolute frame index (current relative frame + trim offset) to the backend
    sendClick(coords, mode, currentFrame + videoOffsetFrame);
  };

  const handlePlayToggle = (val) => {
    if (isTracking) return;
    setIsPlaying(prev => (val !== undefined ? val : !prev));
  };

  const handleSeek = (frame) => {
    if (isTracking) return;
    setCurrentFrame(Math.max(0, Math.min(totalFrames, frame)));
  };

  const handleSetTrimStart = (frame) => {
    if (frame < trimEnd) {
      setTrimStart(frame);
    }
  };

  const handleSetTrimEnd = (frame) => {
    if (frame > trimStart) {
      setTrimEnd(frame);
    }
  };

  const handleApplyCut = () => {
    // non-destructive cropping: shift offset frame and shorten total frame duration
    const newOffset = videoOffsetFrame + trimStart;
    const newTotal = trimEnd - trimStart;
    
    setVideoOffsetFrame(newOffset);
    setTotalFrames(newTotal);
    setTrimStart(0);
    setTrimEnd(newTotal);
    setCurrentFrame(0);
    setIsPlaying(false);
    console.log(`Cut applied. New offset: ${newOffset}, Total frames: ${newTotal}`);
  };

  const handleClearClicks = () => {
    setClearSignal(s => s + 1);
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
            onClearClicks={handleClearClicks}
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
          />

        }
        timeline={
          <TimelineController 
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            isPlaying={isPlaying}
            isTracking={isTracking}
            trimStart={trimStart}
            trimEnd={trimEnd}
            onPlayToggle={() => handlePlayToggle()}
            onTrackForward={() => startTracking(totalFrames)}
            onCancelTracking={cancelTracking}
            onSetTrimStart={handleSetTrimStart}
            onSetTrimEnd={handleSetTrimEnd}
            onApplyCut={handleApplyCut}
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
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { id: 'alpha', label: 'Alpha Matte (B&W)', desc: 'High-contrast mask' },
                        { id: 'overlay', label: 'Video Overlay', desc: 'Mask overlay on video' }
                      ].map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setExportType(t.id)}
                          className={`p-3 rounded-lg border text-left transition-all ${exportType === t.id ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-[#222] border-[#333] hover:border-[#444] text-textSecondary'}`}
                        >
                          <div className="text-xs font-semibold text-textPrimary">{t.label}</div>
                          <div className="text-[10px] text-textSecondary mt-0.5">{t.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => startExport({ format: exportFormat, type: exportType, total_frames: totalFrames })}
                  className="w-full mt-4 bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
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

                <div className="w-full bg-[#222] border border-[#333] rounded-lg p-3 text-left font-mono text-[10px] text-textSecondary overflow-x-auto select-all mb-6">
                  <span className="text-textSecondary block mb-1 uppercase font-sans font-bold tracking-wider">Saved Path:</span>
                  {exportFilePath}
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
                  onClick={() => startExport({ format: exportFormat, type: exportType, total_frames: totalFrames })}
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
    </>
  );
}

export default App;
