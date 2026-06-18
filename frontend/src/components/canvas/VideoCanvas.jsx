import React, { useRef, useEffect, useLayoutEffect, useCallback } from 'react';

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
  isUploading = false,
  viewMode = 'overlay',  // overlay, isolated
  onRequestMask,         // called during playback to sync mask with frame
  objects = [],          // Add objects prop
  activeObjectId,        // Add activeObjectId prop
  deleteObjectSignal,    // Signal to delete a specific object's points
}) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const maskImageObjRef = useRef(null);

  // Stores all committed click points: [{x, y, mode}] in normalized coords
  const clickPointsRef = useRef([]);
  // Stores committed selection boxes: [{x1,y1,x2,y2}]
  const boxesRef = useRef([]);

  // Track previous frame to detect actual frame changes
  const prevFrameRef = useRef(currentFrame);

  // Always-current refs so stable callbacks never go stale
  const clickModeRef = useRef(clickMode);
  useEffect(() => { clickModeRef.current = clickMode; }, [clickMode]);

  const onCanvasClickRef = useRef(onCanvasClick);
  useEffect(() => { onCanvasClickRef.current = onCanvasClick; }, [onCanvasClick]);

  // FIX Bug 3: isPlaying & onPlayToggle refs to avoid stale closure in handleMouseDown
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const onPlayToggleRef = useRef(onPlayToggle);
  useEffect(() => { onPlayToggleRef.current = onPlayToggle; }, [onPlayToggle]);

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

    // 0. Always draw the video frame on the canvas first (ensures sync with mask)
    if (videoRef.current && videoRef.current.readyState >= 2) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    }

    // 1. Mask overlay from AI backend
    if (viewMode === 'isolated') {
      if (maskImageObjRef.current) {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(maskImageObjRef.current, 0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      // Overlay mode - draw mask on top of video
      if (maskImageObjRef.current) {
        ctx.drawImage(maskImageObjRef.current, 0, 0, canvas.width, canvas.height);
      }
    }

    // 2. Committed selection boxes
    boxesRef.current.forEach(({ x1, y1, x2, y2, objId }) => {
      const px1 = x1 * canvas.width;
      const py1 = y1 * canvas.height;
      const pw  = (x2 - x1) * canvas.width;
      const ph  = (y2 - y1) * canvas.height;
      
      ctx.globalAlpha = (objId === activeObjectId) ? 1.0 : 0.4;
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(px1, py1, pw, ph);
      ctx.fillStyle = 'rgba(249,115,22,0.12)';
      ctx.fillRect(px1, py1, pw, ph);
      ctx.globalAlpha = 1.0;
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

    // 4. Click point dots (match object color, or red for remove)
    clickPointsRef.current.forEach(({ x, y, mode, objId }) => {
      const px = x * canvas.width;
      const py = y * canvas.height;

      const isAdd = mode === 'add';
      
      // Find object color
      const obj = objects.find(o => o.id === objId);
      const baseColor = obj ? obj.color : '#22c55e'; // Fallback to green
      
      // If mode is 'remove', we can use red, or just the object's color but maybe smaller/different shape.
      // But the SAM 2 UI usually just uses Red for negative points.
      const fill   = isAdd ? baseColor : '#ef4444';
      const stroke = isAdd ? baseColor : '#dc2626';

      // Draw faint ring if not the active object
      ctx.globalAlpha = (objId === activeObjectId) ? 1.0 : 0.4;

      // Outer glow
      ctx.beginPath();
      ctx.arc(px, py, DOT_RADIUS + 3, 0, Math.PI * 2);
      ctx.fillStyle = isAdd ? `${baseColor}40` : 'rgba(239,68,68,0.25)'; // 40 is hex for 25% opacity
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
      
      ctx.globalAlpha = 1.0;
    });
  }, [viewMode, activeObjectId, objects]); // Re-draw when view mode, active object, or objects array changes

  // ── FIX Bug 1: Set canvas dimensions directly from video metadata ──────────
  // Prevents React from clearing the canvas when width/height props change
  useLayoutEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !videoUrl) return;

    const applyDimensions = () => {
      if (video.videoWidth > 0) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        drawCanvas();
      }
    };

    video.addEventListener('loadedmetadata', applyDimensions);
    // In case metadata is already loaded (e.g. same video re-mounted)
    if (video.readyState >= 1) applyDimensions();

    return () => video.removeEventListener('loadedmetadata', applyDimensions);
  }, [videoUrl, drawCanvas]);

  // ── FIX Bug 2: Redraw canvas when upload finishes (overlay disappears) ──────
  useEffect(() => {
    if (!isUploading) {
      // Use rAF so React has flushed DOM updates before we draw
      const id = requestAnimationFrame(() => drawCanvas());
      return () => cancelAnimationFrame(id);
    }
  }, [isUploading, drawCanvas]);

  // ── Clear all points when clearSignal fires ────────────────────────────────
  useEffect(() => {
    clickPointsRef.current = [];
    boxesRef.current = [];
    drawCanvas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSignal]);

  // ── Remove points for a specific object when deleteObjectSignal fires ──────
  useEffect(() => {
    if (deleteObjectSignal && deleteObjectSignal.id !== undefined) {
      clickPointsRef.current = clickPointsRef.current.filter(p => p.objId !== deleteObjectSignal.id);
      boxesRef.current = boxesRef.current.filter(b => b.objId !== deleteObjectSignal.id);
      drawCanvas();
    }
  }, [deleteObjectSignal, drawCanvas]);

  // ── Clear points when user navigates to a different frame ─────────────────
  useEffect(() => {
    if (prevFrameRef.current !== currentFrame) {
      clickPointsRef.current = [];
      boxesRef.current = [];
      prevFrameRef.current = currentFrame;
      drawCanvas();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame]);

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
    // FIX Bug 4: Always set currentTime (no threshold) so onSeeked always fires
    video.currentTime = targetTime;
  }, [currentFrame, videoOffsetFrame, isPlaying, totalFrames]);

  // ── rAF loop while playing ────────────────────────────────────────────────
  const onRequestMaskRef = useRef(onRequestMask);
  useEffect(() => { onRequestMaskRef.current = onRequestMask; }, [onRequestMask]);

  useEffect(() => {
    if (!isPlaying) return;
    let animId;
    let lastFrame = -1;
    const loop = () => {
      const video = videoRef.current;
      if (!video) return;
      
      const effectiveFps = (totalFrames && video.duration) ? (totalFrames / video.duration) : 30;
      const frame = Math.floor(video.currentTime * effectiveFps) - videoOffsetFrame;
      
      if (frame >= totalFrames) {
        onPlayToggle(false);
        onFrameChange(0);
      } else if (frame >= 0) {
        if (frame !== lastFrame) {
          lastFrame = frame;
          onFrameChange(frame);
          // Sync mask from cache during playback
          onRequestMaskRef.current?.(frame + videoOffsetFrame);
        }
      }
      // Always redraw canvas to sync video frame with mask
      drawCanvas();
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, totalFrames, videoOffsetFrame, onFrameChange, onPlayToggle]);

  // ── Mask image ────────────────────────────────────────────────────────────
  const imageCacheRef = useRef(new Map()); // base64 -> Image obj

  useEffect(() => {
    if (!maskImageBase64) {
      maskImageObjRef.current = null;
      drawCanvas();
      return;
    }

    // Check if we already created an Image for this base64
    if (imageCacheRef.current.has(maskImageBase64)) {
      maskImageObjRef.current = imageCacheRef.current.get(maskImageBase64);
      drawCanvas();
      return;
    }

    const img = new Image();
    img.onload = () => {
      // Cache it for instant retrieval next time
      imageCacheRef.current.set(maskImageBase64, img);
      maskImageObjRef.current = img;
      drawCanvas();
    };
    img.src = `data:image/png;base64,${maskImageBase64}`;
  }, [maskImageBase64, drawCanvas]);

  // Re-draw canvas on seek to sync video frame
  // (no longer need isolated-only rAF since we always draw video on canvas)

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
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  // ── Mouse handlers ────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    // FIX Bug 3: Use isPlayingRef to avoid stale closure (isPlaying not in deps)
    if (isPlayingRef.current) {
      onPlayToggleRef.current?.(false);
      return;
    }
    const { x, y } = getCoords(e);
    const mode = clickModeRef.current;

    if (mode === 'add' || mode === 'remove') {
      // Immediately place a visual dot
      clickPointsRef.current = [...clickPointsRef.current, { x, y, mode, objId: activeObjectId }];
      drawCanvas();
      // Notify parent (sends to WebSocket)
      const filteredPoints = clickPointsRef.current.filter(p => p.objId === activeObjectId);
      const filteredBoxes = boxesRef.current.filter(b => b.objId === activeObjectId);
      onCanvasClickRef.current?.(filteredPoints, filteredBoxes);
    } else {
      // box mode: start drag
      isDraggingRef.current = true;
      dragStartRef.current = { x, y, objId: activeObjectId };
      dragEndRef.current = { x, y };
      drawCanvas();
    }
  }, [drawCanvas, activeObjectId]);

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
        objId: activeObjectId
      };
      // Save box visually
      boxesRef.current = [...boxesRef.current, box];
      // Notify parent
      const filteredPoints = clickPointsRef.current.filter(p => p.objId === activeObjectId);
      const filteredBoxes = boxesRef.current.filter(b => b.objId === activeObjectId);
      onCanvasClickRef.current?.(filteredPoints, filteredBoxes);
    }

    dragStartRef.current = null;
    dragEndRef.current = null;
    drawCanvas();
  }, [drawCanvas, activeObjectId]);

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
          className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none opacity-0"
          controls={false}
          muted
          loop={false}
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={drawCanvas}
          onSeeked={() => {
            // Need to re-draw canvas when video frame seeks, especially for isolated mode
            drawCanvas();
          }}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-textSecondary/50 pointer-events-none select-none">
          <span className="font-mono mb-2 text-lg">No Video Loaded</span>
          <span className="text-sm">Import a video to begin</span>
        </div>
      )}

      {/* Canvas: mask + dots + drag box */}
      {/* FIX Bug 1: Static fallback width/height; actual dims set by useLayoutEffect via video metadata */}
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
      {videoUrl && !isUploading && (
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

      {/* Loading Overlay */}
      {isUploading && (
        <div className="absolute inset-0 z-30 bg-black/50 backdrop-blur-sm flex flex-col items-center justify-center text-orange-400 pointer-events-none select-none">
          <div className="w-10 h-10 border-4 border-orange-500/20 border-t-orange-500 rounded-full animate-spin mb-3"></div>
          <span className="font-mono text-sm font-semibold tracking-wider">INITIALIZING SAM 2...</span>
          <span className="text-[10px] text-textSecondary mt-1">Extracting frames and loading models</span>
        </div>
      )}
    </div>
  );
};

export default VideoCanvas;
