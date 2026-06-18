import React from 'react';
import { Play, Pause, FastForward, Square } from 'lucide-react';

const TimelineController = ({ 
  currentFrame, 
  totalFrames, 
  isPlaying, 
  isTracking,
  hasVideo,
  objects = [],
  activeObjectId = null,
  trackedFrames = [],
  onPlayToggle,
  onTrackForward,
  onCancelTracking,
  onSeek
}) => {
  const progress = totalFrames > 0 ? (currentFrame / totalFrames) * 100 : 0;

  // ── Helper: get tick interval dynamically based on total frames ──────────
  const getTickInterval = (total) => {
    if (total <= 30) return 5;
    if (total <= 100) return 10;
    if (total <= 250) return 20;
    if (total <= 600) return 50;
    return 100;
  };

  const ticks = [];
  if (totalFrames > 0) {
    const interval = getTickInterval(totalFrames);
    for (let i = 0; i <= totalFrames; i += interval) {
      ticks.push(i);
    }
  }

  // ── Helper: cluster contiguous tracked frames into visual bands ───────────
  const getContiguousRanges = (frames) => {
    if (!frames || frames.length === 0) return [];
    const sorted = [...frames].sort((a, b) => a - b);
    const ranges = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === prev + 1) {
        prev = sorted[i];
      } else {
        ranges.push({ start, end: prev });
        start = sorted[i];
        prev = sorted[i];
      }
    }
    ranges.push({ start, end: prev });
    return ranges;
  };

  // ── Helper: convert clientX → frame number ──────────────────────────────
  const clientXToFrame = (clientX) => {
    const track = document.getElementById('timeline-track');
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(pct * totalFrames);
  };

  // ── Timeline seek (click/drag on track background) ───────────────────────
  const handleTrackMouseDown = (e) => {
    if (isPlaying && onPlayToggle) onPlayToggle(false);
    onSeek?.(clientXToFrame(e.clientX));

    const onMove = (mv) => onSeek?.(clientXToFrame(mv.clientX));
    const onUp   = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  };

  return (
    <div className="flex flex-col w-full px-4 py-2 select-none gap-3">

      {/* ── Top controls row ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-2 pt-1">

        {/* Left: Play + Frame counter */}
        <div className="flex items-center gap-3">
          <button 
            onClick={onPlayToggle} 
            disabled={!hasVideo}
            aria-label={isPlaying ? "Pause playback" : "Start playback"}
            className={`p-1.5 rounded-full transition-all duration-200 border focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${
              hasVideo 
                ? "text-orange-500 hover:text-orange-400 bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.08] hover:border-white/[0.1] cursor-pointer shadow-md" 
                : "text-orange-500/20 border-white/[0.01] cursor-not-allowed"
            }`}
            title={hasVideo ? (isPlaying ? 'Pause (Space)' : 'Play (Space)') : 'Please import a video first'}
          >
            {isPlaying
              ? <Pause size={20} fill="currentColor" />
              : <Play  size={20} fill="currentColor" />
            }
          </button>

          <div className="text-xs font-mono text-textSecondary">
            <span className="text-textPrimary font-bold text-sm">{currentFrame}</span>
            <span className="mx-1">/</span>
            <span>{totalFrames}</span>
          </div>
        </div>

        {/* Right: Track Forward / Stop */}
        <div className="flex items-center gap-2">
          {isTracking ? (
            <button 
              onClick={onCancelTracking}
              aria-label="Stop tracking propagation"
              className="flex items-center gap-2 bg-red-600/80 hover:bg-red-500 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 text-white border border-red-500/20 shadow-md shadow-red-950/20 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:outline-none"
              title="Stop tracking AI propagation"
            >
              <Square size={13} fill="currentColor" /> Stop
            </button>
          ) : (
            <button 
              onClick={onTrackForward}
              disabled={!hasVideo}
              aria-label="Start tracking propagation"
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 text-white border focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:outline-none ${
                hasVideo 
                  ? "bg-blue-600/80 hover:bg-blue-500 border-blue-500/20 shadow-md shadow-blue-950/10 cursor-pointer active:scale-[0.98]" 
                  : "bg-blue-600/20 text-white/30 border-white/[0.02] cursor-not-allowed"
              }`}
              title={hasVideo ? "Start tracking mask forward through timeline" : "Please import a video first"}
            >
              <FastForward size={13} /> Track
            </button>
          )}
        </div>
      </div>

      {/* ── Timeline track & ruler ────────────────────────────────────────── */}
      <div className="px-2 pb-2 flex flex-col">
        {/* Timeline Ruler */}
        {hasVideo && (
          <div className="relative w-full h-5 mb-1 text-textSecondary/40 text-[9px] font-mono select-none">
            {ticks.map((t) => {
              const pct = (t / totalFrames) * 100;
              return (
                <div 
                  key={t} 
                  className="absolute transform -translate-x-1/2 flex flex-col items-center"
                  style={{ left: `${pct}%` }}
                >
                  <div className="w-px h-1 bg-white/[0.12] mb-0.5" />
                  <span>{t}</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="relative animate-fade-in" style={{ height: '24px' }}>

          {/* The actual timeline bar (overflow-hidden for internal fills) */}
          <div
            id="timeline-track"
            onMouseDown={hasVideo ? handleTrackMouseDown : undefined}
            tabIndex={hasVideo ? 0 : -1}
            role="slider"
            aria-label="Video timeline slider"
            aria-valuemin={0}
            aria-valuemax={totalFrames}
            aria-valuenow={currentFrame}
            onKeyDown={(e) => {
              if (!hasVideo) return;
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                e.preventDefault();
                onSeek?.(Math.min(totalFrames, currentFrame + 1));
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                e.preventDefault();
                onSeek?.(Math.max(0, currentFrame - 1));
              } else if (e.key === 'PageUp') {
                e.preventDefault();
                onSeek?.(Math.min(totalFrames, currentFrame + 10));
              } else if (e.key === 'PageDown') {
                e.preventDefault();
                onSeek?.(Math.max(0, currentFrame - 10));
              } else if (e.key === 'Home') {
                e.preventDefault();
                onSeek?.(0);
              } else if (e.key === 'End') {
                e.preventDefault();
                onSeek?.(totalFrames);
              }
            }}
            className={`absolute inset-x-0 top-0 bottom-0 bg-[#0e0e13]/60 rounded-lg border border-white/[0.04] overflow-hidden focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${
              hasVideo ? "cursor-pointer" : "cursor-not-allowed opacity-30"
            }`}
          >
            {/* AI tracking progress fill */}
            <div
              className="absolute inset-y-0 bg-blue-500/15 border-r border-blue-500/30 transition-all duration-100 ease-linear pointer-events-none"
              style={{ left: '0%', width: `${progress}%` }}
            />
            {/* Playhead line */}
            {hasVideo && (
              <div
                className="absolute top-0 bottom-0 w-[1px] bg-red-500 shadow-[0_0_8px_red] z-10 pointer-events-none"
                style={{ left: `${progress}%` }}
              />
            )}
          </div>

          {/* Playhead diamond handle (above bar) */}
          {hasVideo && (
            <div
              className="absolute -top-1 w-2.5 h-2.5 bg-red-500 rotate-45 z-20 pointer-events-none transform -translate-x-1/2"
              style={{ left: `${progress}%` }}
            />
          )}

        </div>
      </div>

      {/* Object Tracks Layer */}
      {hasVideo && objects.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-white/[0.04] pt-2 mt-1 px-2">
          {objects.map((obj) => {
            const isActive = obj.id === activeObjectId;
            const ranges = getContiguousRanges(trackedFrames);
            return (
              <div key={obj.id} className="flex items-center gap-3 w-full animate-fade-in">
                {/* Object name track label */}
                <div className="w-20 flex-shrink-0 flex items-center gap-1.5 text-[11px] font-semibold text-textSecondary">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: obj.color }} />
                  <span className={isActive ? "text-textPrimary" : ""}>{obj.name}</span>
                </div>
                
                {/* Visual track line matching timeline width */}
                <div className="flex-1">
                  <div className="relative h-2 bg-white/[0.02] border border-white/[0.03] rounded w-full overflow-hidden">
                    {ranges.map((r, idx) => (
                      <div
                        key={idx}
                        className="absolute h-full rounded-sm"
                        style={{
                          left: `${(r.start / totalFrames) * 100}%`,
                          width: `${((r.end - r.start + 1) / totalFrames) * 100}%`,
                          backgroundColor: obj.color,
                          opacity: isActive ? 0.4 : 0.22
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TimelineController;
