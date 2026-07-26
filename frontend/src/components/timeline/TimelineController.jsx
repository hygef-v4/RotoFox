import React, { useCallback, useMemo, useRef } from 'react';
import { ChevronsLeft, FastForward, Pause, Play, Square } from 'lucide-react';

/**
 * Group sorted frame indices into contiguous ranges for display.
 */
function toContiguousRanges(frames) {
  if (!frames || frames.length === 0) return [];
  const sorted = [...frames].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let previous = sorted[0];

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === previous + 1) {
      previous = sorted[i];
    } else {
      ranges.push({ start, end: previous });
      start = sorted[i];
      previous = sorted[i];
    }
  }
  ranges.push({ start, end: previous });
  return ranges;
}

/**
 * Timeline scrubber, playback transport and per-object tracking coverage.
 *
 * Two corrections from the original implementation:
 *
 * - Frame indices run 0..totalFrames-1. Every bound here used `totalFrames`,
 *   so the playhead never reached 100%, and End seeked to a frame that does not
 *   exist — which returned no mask and looked like the last frame was untracked.
 * - Coverage is now per object. Previously every object row rendered
 *   `getContiguousRanges(trackedFrames)` from the same global list, so all seven
 *   rows drew identical bands, and the helper re-sorted the entire frame list
 *   once per object on every render.
 */
const TimelineController = ({
  currentFrame,
  totalFrames,
  isPlaying,
  isTracking,
  hasVideo,
  objects = [],
  activeObjectId = null,
  trackedFrames = [],
  objectCoverage = {},
  onPlayToggle,
  onTrackForward,
  onTrackBackward,
  onCancelTracking,
  onSeek,
  canTrack = false,
}) => {
  const trackRef = useRef(null);

  // Valid indices are 0..lastFrame. Progress is measured against lastFrame so
  // the playhead actually reaches the right-hand edge on the final frame.
  const lastFrame = Math.max(0, totalFrames - 1);
  const progress = lastFrame > 0 ? (currentFrame / lastFrame) * 100 : 0;

  const ticks = useMemo(() => {
    if (lastFrame <= 0) return [];
    const interval = lastFrame <= 30 ? 5
      : lastFrame <= 100 ? 10
        : lastFrame <= 250 ? 20
          : lastFrame <= 600 ? 50 : 100;
    const result = [];
    for (let i = 0; i <= lastFrame; i += interval) result.push(i);
    if (result[result.length - 1] !== lastFrame) result.push(lastFrame);
    return result;
  }, [lastFrame]);

  // Computed once per coverage change, not once per object per render.
  const rangesByObject = useMemo(() => {
    const result = {};
    const hasPerObject = Object.keys(objectCoverage).length > 0;
    objects.forEach((obj) => {
      const frames = hasPerObject ? (objectCoverage[obj.id] ?? []) : trackedFrames;
      result[obj.id] = toContiguousRanges(frames);
    });
    return result;
  }, [objects, objectCoverage, trackedFrames]);

  const clientXToFrame = useCallback((clientX) => {
    const track = trackRef.current;
    if (!track || lastFrame <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(ratio * lastFrame);
  }, [lastFrame]);

  const handleTrackMouseDown = (event) => {
    if (isPlaying && onPlayToggle) onPlayToggle(false);
    onSeek?.(clientXToFrame(event.clientX));

    const onMove = (moveEvent) => onSeek?.(clientXToFrame(moveEvent.clientX));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const seekBy = (delta) => onSeek?.(Math.max(0, Math.min(lastFrame, currentFrame + delta)));

  return (
    <div className="flex flex-col w-full px-4 py-2 select-none gap-3">
      <div className="flex items-center justify-between px-2 pt-1">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onPlayToggle}
            disabled={!hasVideo}
            aria-label={isPlaying ? 'Pause playback' : 'Start playback'}
            className={`p-1.5 rounded-full transition-all duration-200 border focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${
              hasVideo
                ? 'text-orange-500 hover:text-orange-400 bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.08] cursor-pointer shadow-md'
                : 'text-orange-500/20 border-white/[0.01] cursor-not-allowed'
            }`}
            title={hasVideo ? (isPlaying ? 'Pause (Space)' : 'Play (Space)') : 'Please import a video first'}
          >
            {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>

          <div className="text-xs font-mono text-textSecondary">
            <span className="text-textPrimary font-bold text-sm">{currentFrame}</span>
            <span className="mx-1">/</span>
            <span>{lastFrame}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isTracking ? (
            <button
              type="button"
              onClick={onCancelTracking}
              aria-label="Stop tracking propagation"
              className="flex items-center gap-2 bg-red-600/80 hover:bg-red-500 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 text-white border border-red-500/20 shadow-md active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:outline-none"
              title="Stop tracking AI propagation"
            >
              <Square size={13} fill="currentColor" /> Stop
            </button>
          ) : (
            <>
              {/* SAM 2 supports reverse propagation; the UI simply never exposed
                  it, so a user who clicked their subject mid-clip could never
                  produce masks for the frames before that point. */}
              <button
                type="button"
                onClick={onTrackBackward}
                disabled={!hasVideo || !canTrack || currentFrame === 0}
                aria-label="Track backward from the current frame"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 border focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:outline-none ${
                  hasVideo && canTrack && currentFrame > 0
                    ? 'bg-white/[0.04] hover:bg-white/[0.09] text-textPrimary border-white/[0.08] cursor-pointer active:scale-[0.98]'
                    : 'bg-white/[0.02] text-white/25 border-white/[0.02] cursor-not-allowed'
                }`}
                title={currentFrame === 0 ? 'Already at the first frame' : 'Track the mask backward to the start'}
              >
                <ChevronsLeft size={13} /> Back
              </button>

              <button
                type="button"
                onClick={onTrackForward}
                disabled={!hasVideo || !canTrack}
                aria-label="Start tracking propagation"
                className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 text-white border focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:outline-none ${
                  hasVideo && canTrack
                    ? 'bg-blue-600/80 hover:bg-blue-500 border-blue-500/20 shadow-md cursor-pointer active:scale-[0.98]'
                    : 'bg-blue-600/20 text-white/30 border-white/[0.02] cursor-not-allowed'
                }`}
                title={!hasVideo ? 'Please import a video first' : !canTrack ? 'Place at least one click point or box first' : 'Track the mask forward through the timeline'}
              >
                <FastForward size={13} /> Track
              </button>
            </>
          )}
        </div>
      </div>

      <div className="px-2 pb-2 flex flex-col">
        {hasVideo && (
          <div className="relative w-full h-5 mb-1 text-textSecondary/40 text-[9px] font-mono select-none">
            {ticks.map((tick) => (
              <div
                key={tick}
                className="absolute transform -translate-x-1/2 flex flex-col items-center"
                style={{ left: `${lastFrame > 0 ? (tick / lastFrame) * 100 : 0}%` }}
              >
                <div className="w-px h-1 bg-white/[0.12] mb-0.5" />
                <span>{tick}</span>
              </div>
            ))}
          </div>
        )}

        <div className="relative" style={{ height: '24px' }}>
          <div
            ref={trackRef}
            onMouseDown={hasVideo ? handleTrackMouseDown : undefined}
            tabIndex={hasVideo ? 0 : -1}
            role="slider"
            aria-label="Video timeline slider"
            aria-valuemin={0}
            aria-valuemax={lastFrame}
            aria-valuenow={currentFrame}
            onKeyDown={(event) => {
              if (!hasVideo) return;
              const actions = {
                ArrowRight: () => seekBy(1),
                ArrowUp: () => seekBy(1),
                ArrowLeft: () => seekBy(-1),
                ArrowDown: () => seekBy(-1),
                PageUp: () => seekBy(10),
                PageDown: () => seekBy(-10),
                Home: () => onSeek?.(0),
                End: () => onSeek?.(lastFrame),
              };
              const handler = actions[event.key];
              if (handler) {
                event.preventDefault();
                handler();
              }
            }}
            className={`absolute inset-x-0 top-0 bottom-0 bg-[#0e0e13]/60 rounded-lg border border-white/[0.04] overflow-hidden focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${
              hasVideo ? 'cursor-pointer' : 'cursor-not-allowed opacity-30'
            }`}
          >
            <div
              className="absolute inset-y-0 bg-blue-500/15 border-r border-blue-500/30 transition-all duration-100 ease-linear pointer-events-none"
              style={{ left: '0%', width: `${progress}%` }}
            />
            {hasVideo && (
              <div
                className="absolute top-0 bottom-0 w-[1px] bg-red-500 shadow-[0_0_8px_red] z-10 pointer-events-none"
                style={{ left: `${progress}%` }}
              />
            )}
          </div>

          {hasVideo && (
            <div
              className="absolute -top-1 w-2.5 h-2.5 bg-red-500 rotate-45 z-20 pointer-events-none transform -translate-x-1/2"
              style={{ left: `${progress}%` }}
            />
          )}
        </div>
      </div>

      {hasVideo && objects.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-white/[0.04] pt-2 mt-1 px-2">
          {objects.map((obj) => {
            const isActive = obj.id === activeObjectId;
            const ranges = rangesByObject[obj.id] ?? [];
            return (
              <div key={obj.id} className="flex items-center gap-3 w-full">
                <div className="w-20 flex-shrink-0 flex items-center gap-1.5 text-[11px] font-semibold text-textSecondary">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: obj.color }} />
                  <span className={isActive ? 'text-textPrimary' : ''}>{obj.name}</span>
                </div>

                <div className="flex-1">
                  <div className="relative h-2 bg-white/[0.02] border border-white/[0.03] rounded w-full overflow-hidden">
                    {ranges.map((range) => (
                      <div
                        key={`${obj.id}-${range.start}`}
                        className="absolute h-full rounded-sm"
                        style={{
                          left: `${lastFrame > 0 ? (range.start / lastFrame) * 100 : 0}%`,
                          width: `${lastFrame > 0 ? ((range.end - range.start + 1) / (lastFrame + 1)) * 100 : 0}%`,
                          backgroundColor: obj.color,
                          opacity: isActive ? 0.45 : 0.22,
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
