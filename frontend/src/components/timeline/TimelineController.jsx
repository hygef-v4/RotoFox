import React from 'react';
import { Play, Pause, SkipForward, SkipBack, FastForward, Square, Scissors } from 'lucide-react';

const TimelineController = ({ 
  currentFrame, 
  totalFrames, 
  isPlaying, 
  isTracking,
  trimStart,
  trimEnd,
  onPlayToggle,
  onTrackForward,
  onCancelTracking,
  onSetTrimStart,
  onSetTrimEnd,
  onApplyCut,
  onSeek
}) => {
  // Progress calculations
  const progress = totalFrames > 0 ? (currentFrame / totalFrames) * 100 : 0;
  const trimStartPct = totalFrames > 0 ? (trimStart / totalFrames) * 100 : 0;
  const trimEndPct = totalFrames > 0 ? (trimEnd / totalFrames) * 100 : 100;

  // Handle timeline seeking by clicking/dragging
  const handleSeekEvent = (e) => {
    const track = e.currentTarget.closest('#timeline-track');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    const targetFrame = Math.round(pct * totalFrames);
    if (onSeek) {
      onSeek(targetFrame);
    }
  };

  const handleMouseDown = (e) => {
    if (isPlaying && onPlayToggle) {
      onPlayToggle(false);
    }
    handleSeekEvent(e);
    
    const handleMouseMove = (moveEvent) => {
      const track = document.getElementById('timeline-track');
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const clickX = moveEvent.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      const targetFrame = Math.round(pct * totalFrames);
      if (onSeek) {
        onSeek(targetFrame);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div className="flex flex-col h-full w-full p-2 justify-between">
      {/* Playback Controls & Info */}
      <div className="flex items-center justify-between px-4 pt-1">
        <div className="flex items-center gap-4">
          <button 
            onClick={onPlayToggle} 
            className="p-1.5 hover:bg-surfaceHover rounded-full transition-colors text-orange-500 hover:text-orange-400"
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          
          <div className="text-xs font-mono text-textSecondary">
            Frame: <span className="text-textPrimary font-semibold">{currentFrame}</span> / {totalFrames}
          </div>
        </div>

        {/* Video Cutting / Trimming buttons */}
        <div className="flex items-center gap-2">
          <button 
            onClick={() => onSetTrimStart(currentFrame)}
            className="px-2 py-1 bg-surfaceHover hover:bg-[#333] border border-[#333] rounded text-xs text-textSecondary hover:text-textPrimary transition-colors"
            title="Mark Trim Start"
          >
            [ Mark Start
          </button>
          <span className="text-xs text-textSecondary font-mono">{trimStart}</span>
          
          <button 
            onClick={() => onSetTrimEnd(currentFrame)}
            className="px-2 py-1 bg-surfaceHover hover:bg-[#333] border border-[#333] rounded text-xs text-textSecondary hover:text-textPrimary transition-colors"
            title="Mark Trim End"
          >
            Mark End ]
          </button>
          <span className="text-xs text-textSecondary font-mono">{trimEnd}</span>

          {(trimStart > 0 || trimEnd < totalFrames) && (
            <button 
              onClick={onApplyCut}
              className="ml-2 flex items-center gap-1 px-3 py-1 bg-red-500/20 border border-red-500 hover:bg-red-500/30 text-red-400 rounded text-xs transition-colors font-medium"
              title="Apply Video Cut"
            >
              <Scissors size={12} /> Cut Video
            </button>
          )}
        </div>

        {/* Tracking Controls */}
        <div className="flex items-center gap-2">
          {isTracking ? (
            <button 
              onClick={onCancelTracking}
              className="flex items-center gap-2 bg-red-500 hover:bg-red-600 px-4 py-1.5 rounded text-xs font-semibold transition-colors text-white"
            >
              <Square size={14} fill="currentColor" /> Stop Tracking
            </button>
          ) : (
            <button 
              onClick={onTrackForward}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded text-xs font-semibold transition-colors text-white"
            >
              <FastForward size={14} /> Track Forward
            </button>
          )}
        </div>
      </div>

      {/* Timeline Track */}
      <div className="px-4 pb-2 flex items-center">
        <div 
          id="timeline-track"
          onMouseDown={handleMouseDown}
          className="relative w-full h-10 bg-[#1e1e1e] rounded-md border border-[#333] overflow-hidden cursor-pointer select-none"
        >
          {/* Trimmed region overlay: Left (Grayed out) */}
          <div 
            className="absolute top-0 bottom-0 left-0 bg-red-950/20 border-r border-[#333] z-0"
            style={{ width: `${trimStartPct}%` }}
          />

          {/* Trimmed region overlay: Right (Grayed out) */}
          <div 
            className="absolute top-0 bottom-0 bg-red-950/20 border-l border-[#333] z-0"
            style={{ left: `${trimEndPct}%`, width: `${100 - trimEndPct}%` }}
          />

          {/* Active Workable range indicator */}
          <div 
            className="absolute top-0 bottom-0 bg-orange-500/5 z-0 pointer-events-none"
            style={{ left: `${trimStartPct}%`, width: `${trimEndPct - trimStartPct}%` }}
          />

          {/* Progress Bar (Xanh lá / Lam - cho tracking AI) */}
          <div 
            className="absolute top-0 bottom-0 bg-blue-500/15 border-r border-blue-500/30 transition-all duration-100 ease-linear pointer-events-none"
            style={{ left: `${trimStartPct}%`, width: `${Math.max(0, Math.min(progress, trimEndPct) - trimStartPct)}%` }}
          />
          
          {/* Playhead (Đỏ - Con trỏ thời gian hiện tại) */}
          <div 
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none"
            style={{ left: `${progress}%` }}
          />
          
          {/* Mini Playhead Handle */}
          <div 
            className="absolute -top-1 w-2 h-3 bg-red-500 rounded-sm shadow-md z-15 transform -translate-x-1/2 pointer-events-none"
            style={{ left: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
};

export default TimelineController;
