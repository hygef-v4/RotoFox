import React, { useRef, useEffect, useCallback } from 'react';

const DOT_RADIUS = 6; // px on the 1280×720 canvas

const VideoCanvas = ({
  videoUrl,
  clickMode,
  onCanvasClick,
  maskImageBase64,
  isPlaying,
  currentFrame,
  videoOffsetFrame = 0,
  totalFrames,
  onVideoMetadataLoaded,
  onFrameChange,
  onPlayToggle,
  clearSignal,           // increments from parent to trigger clearing all dots
}) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const maskImageObjRef = useRef(null);

  // Stores all committed click points: [{x, y, mode}] in normalized coords
  const clickPointsRef = useRef([]);
  // Stores committed selection boxes: [{x1,y1,x2,y2}]
  const boxesRef = useRef([]);

  // Always-current refs so stable callbacks never go stale
  const clickModeRef = useRef(clickMode);
  useEffect(() => { clickModeRef.current = clickMode; }, [clickMode]);

  const onCanvasClickRef = useRef(onCanvasClick);
  useEffect(() => { onCanvasClickRef.current = onCanvasClick; }, [onCanvasClick]);

  // Drag state
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef(null);
  const dragEndRef = useRef(null);

  // ── Stable draw function ──────────────────────────────────────────────────
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Mask overlay from AI backend
    if (maskImageObjRef.current) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(maskImageObjRef.current, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1.0;
    }

    // 2. Committed selection boxes
    boxesRef.current.forEach(({ x1, y1, x2, y2 }) => {
      const px1 = x1 * canvas.width;
      const py1 = y1 * canvas.height;
      const pw  = (x2 - x1) * canvas.width;
      const ph  = (y2 - y1) * canvas.height;
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(px1, py1, pw, ph);
      ctx.fillStyle = 'rgba(249,115,22,0.12)';
      ctx.fillRect(px1, py1, pw, ph);
    });

    // 3. Live drag box (box mode only)
    if (clickModeRef.current === 'box' && isDraggingRef.current && dragStartRef.current && dragEndRef.current) {
      const x1 = dragStartRef.current.x * canvas.width;
      const y1 = dragStartRef.current.y * canvas.height;
      const x2 = dragEndRef.current.x * canvas.width;
      const y2 = dragEndRef.current.y * canvas.height;
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(249,115,22,0.1)';
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }

    // 4. Click point dots (Add = green, Remove = red)
    clickPointsRef.current.forEach(({ x, y, mode }) => {
      const px = x * canvas.width;
      const py = y * canvas.height;

      const isAdd = mode === 'add';
      const fill   = isAdd ? '#22c55e' : '#ef4444';
      const stroke = isAdd ? '#16a34a' : '#dc2626';

      // Outer glow
      ctx.beginPath();
      ctx.arc(px, py, DOT_RADIUS + 3, 0, Math.PI * 2);
      ctx.fillStyle = isAdd ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)';
      ctx.fill();

      // Solid dot
      ctx.beginPath();
      ctx.arc(px, py, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();

      // White center
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    });
  }, []); // stable: only reads refs

  // ── Clear all points when clearSignal changes ─────────────────────────────
  useEffect(() => {
    clickPointsRef.current = [];
    boxesRef.current = [];
    drawCanvas();
  }, [clearSignal, drawCanvas]);

  // ── Sync video play / pause ───────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.play().catch(err => console.warn('Playback blocked:', err));
    } else {
      video.pause();
    }
  }, [isPlaying]);

  // ── Seek to frame while paused ────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying) return;
    
    // Calculate effective FPS based on true totalFrames vs video duration
    const effectiveFps = (totalFrames && video.duration) ? (totalFrames / video.duration) : 30;
    
    const targetTime = (currentFrame + videoOffsetFrame) / effectiveFps;
    if (Math.abs(video.currentTime - targetTime) > 0.05) {
      video.currentTime = targetTime;
    }
  }, [currentFrame, videoOffsetFrame, isPlaying, totalFrames]);

  // ── rAF loop while playing ────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) return;
    let animId;
    const loop = () => {
      const video = videoRef.current;
      if (!video) return;
      
      const effectiveFps = (totalFrames && video.duration) ? (totalFrames / video.duration) : 30;
      const frame = Math.floor(video.currentTime * effectiveFps) - videoOffsetFrame;
      
      if (frame >= totalFrames) {
        onPlayToggle(false);
        onFrameChange(0);
      } else if (frame >= 0) {
        onFrameChange(frame);
      }
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, totalFrames, videoOffsetFrame, onFrameChange, onPlayToggle]);

  // ── Mask image ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!maskImageBase64) {
      maskImageObjRef.current = null;
      drawCanvas();
      return;
    }
    const img = new Image();
    img.onload = () => {
      maskImageObjRef.current = img;
      drawCanvas();
    };
    img.src = `data:image/png;base64,${maskImageBase64}`;
  }, [maskImageBase64, drawCanvas]);

  // Clear live drag on mode switch
  useEffect(() => {
    isDraggingRef.current = false;
    dragStartRef.current = null;
    dragEndRef.current = null;
    drawCanvas();
  }, [clickMode, drawCanvas]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const getCoords = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  };

  // ── Mouse handlers ────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    const { x, y } = getCoords(e);
    const mode = clickModeRef.current;

    if (mode === 'add' || mode === 'remove') {
      // Immediately place a visual dot
      clickPointsRef.current = [...clickPointsRef.current, { x, y, mode }];
      drawCanvas();
      // Notify parent (sends to WebSocket)
      onCanvasClickRef.current?.([x, y], mode);
    } else {
      // box mode: start drag
      isDraggingRef.current = true;
      dragStartRef.current = { x, y };
      dragEndRef.current = { x, y };
      drawCanvas();
    }
  }, [drawCanvas]);

  const handleMouseMove = useCallback((e) => {
    if (!isDraggingRef.current) return;
    const { x, y } = getCoords(e);
    dragEndRef.current = { x, y };
    drawCanvas();
  }, [drawCanvas]);

  const handleMouseUp = useCallback((e) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    const { x, y } = getCoords(e);
    const start = dragStartRef.current ?? { x, y };
    const dist = Math.hypot(x - start.x, y - start.y);

    if (dist > 0.01) {
      const box = {
        x1: Math.min(start.x, x),
        y1: Math.min(start.y, y),
        x2: Math.max(start.x, x),
        y2: Math.max(start.y, y),
      };
      // Save box visually
      boxesRef.current = [...boxesRef.current, box];
      // Notify parent
      onCanvasClickRef.current?.([box.x1, box.y1, box.x2, box.y2], 'box');
    }

    dragStartRef.current = null;
    dragEndRef.current = null;
    drawCanvas();
  }, [drawCanvas]);

  const handleMouseLeave = useCallback(() => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      dragStartRef.current = null;
      dragEndRef.current = null;
      drawCanvas();
    }
  }, [drawCanvas]);

  const handleLoadedMetadata = useCallback((e) => {
    const video = e.target;
    onVideoMetadataLoaded?.({
      duration: video.duration,
      totalFrames: Math.floor(video.duration * 30),
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }, [onVideoMetadataLoaded]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black overflow-hidden"
    >
      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
          controls={false}
          muted
          loop={false}
          onLoadedMetadata={handleLoadedMetadata}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-textSecondary/50 pointer-events-none select-none">
          <span className="font-mono mb-2 text-lg">No Video Loaded</span>
          <span className="text-sm">Import a video to begin</span>
        </div>
      )}

      {/* Canvas: mask + dots + drag box */}
      <canvas
        ref={canvasRef}
        width={1280}
        height={720}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        className="absolute inset-0 w-full h-full object-contain z-10"
        style={{
          cursor: clickMode === 'box' ? 'crosshair' : 'cell',
          touchAction: 'none',
        }}
      />

      {/* HUD: show current mode and point count */}
      {videoUrl && (
        <div className="absolute bottom-2 right-2 z-20 flex items-center gap-2 bg-black/60 backdrop-blur-sm px-2 py-1 rounded text-[10px] font-mono text-textSecondary pointer-events-none select-none">
          <span className={
            clickMode === 'add' ? 'text-green-400' :
            clickMode === 'remove' ? 'text-red-400' :
            'text-orange-400'
          }>
            {clickMode === 'add' ? '● ADD' : clickMode === 'remove' ? '● REMOVE' : '□ BOX'}
          </span>
          {clickPointsRef.current.length > 0 && (
            <span>{clickPointsRef.current.length} pts</span>
          )}
        </div>
      )}
    </div>
  );
};

export default VideoCanvas;
