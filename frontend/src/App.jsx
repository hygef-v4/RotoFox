import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, X } from 'lucide-react';

import MainLayout from './components/layout/MainLayout';
import LoadingScreen from './components/layout/LoadingScreen';
import Toolbar from './components/sidebar/Toolbar';
import VideoCanvas from './components/canvas/VideoCanvas';
import TimelineController from './components/timeline/TimelineController';
import SetupWizard from './components/setup/SetupWizard';
import ExportModal from './components/modals/ExportModal';
import SettingsModal from './components/modals/SettingsModal';
import ModelHubModal from './components/modals/ModelHubModal';

import { useAIEngine } from './hooks/useAIEngine';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import {
  MAX_OBJECTS,
  OBJECT_COLORS,
  apiUrl,
  authHeaders,
  getRuntimeStatus,
  initBackendConfig,
  installAiRuntime,
} from './config';

const SETUP_DONE_KEY = 'rotofox_setup_done';

/**
 * Application shell.
 *
 * The previous version of this file was 999 lines, of which roughly 550 were
 * three modals defined inline, plus eight `useRef` mirrors of state that a
 * single dependency-free keyboard effect needed to read. Those modals now live
 * in `components/modals/` and the mirrors are gone: `useKeyboardShortcuts` keeps
 * one ref to the handler object instead.
 */
function App() {
  const engine = useAIEngine();

  // ── Workspace state ─────────────────────────────────────────────────────
  const [clickMode, setClickMode] = useState('add');
  const [videoUrl, setVideoUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [viewMode, setViewMode] = useState('overlay');
  const [isBackendReady, setIsBackendReady] = useState(false);

  const [objects, setObjects] = useState([{ id: 1, color: OBJECT_COLORS[0], name: 'Object 1' }]);
  const [activeObjectId, setActiveObjectId] = useState(1);
  const [deleteObjectSignal, setDeleteObjectSignal] = useState(null);

  const [clearSignal, setClearSignal] = useState(0);
  const [undoSignal, setUndoSignal] = useState(0);
  const [redoSignal, setRedoSignal] = useState(0);

  // ── Modals ──────────────────────────────────────────────────────────────
  const [activeModal, setActiveModal] = useState(null);  // export | settings | modelhub
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState(null);
  const [setupStatus, setSetupStatus] = useState(null);
  const [showTrackingToast, setShowTrackingToast] = useState(false);

  const [exportSettings, setExportSettings] = useState({
    format: 'mov',
    type: 'transparent',
    bgColor: 'green',
    exportPath: '',
    resolution: 'original',
    fps: 'original',
  });

  const updateExportSettings = useCallback((patch) => {
    setExportSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const lastFrame = Math.max(0, totalFrames - 1);
  const objectUrlRef = useRef(null);
  const trackingToastTimer = useRef(null);
  const wasTracking = useRef(false);

  // ── First-run setup & runtime detection ─────────────────────────────────
  const pollSetupStatus = useCallback(() => {
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 20;
    let timer = null;

    const poll = async () => {
      await initBackendConfig();
      fetch(apiUrl('/api/setup-status'), { headers: authHeaders() })
        .then((response) => response.json())
        .then((data) => {
          if (cancelled) return;
          setSetupStatus(data);
          if (!data.needs_setup) {
            localStorage.setItem(SETUP_DONE_KEY, 'true');
            setShowSetupWizard(false);
          } else {
            localStorage.removeItem(SETUP_DONE_KEY);
            setShowSetupWizard(true);
          }
        })
        .catch(() => {
          if (cancelled) return;
          attempts += 1;
          if (attempts >= MAX_ATTEMPTS) {
            setSetupStatus({
              error: 'The AI backend did not start within 40 seconds. '
                   + 'Check that no other copy of RotoFox is running, then restart the app.',
            });
          } else {
            timer = setTimeout(poll, 2000);
          }
        });
    };

    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    let cleanupPoll = null;
    let cancelled = false;

    async function checkInitialState() {
      const rt = await getRuntimeStatus();
      if (cancelled) return;
      setRuntimeStatus(rt);

      if (!rt.installed) {
        localStorage.removeItem(SETUP_DONE_KEY);
        setShowSetupWizard(true);
        return;
      }

      const alreadyDone = localStorage.getItem(SETUP_DONE_KEY) === 'true';
      if (!alreadyDone) {
        setShowSetupWizard(true);
      }
      cleanupPoll = pollSetupStatus();
    }

    checkInitialState();
    return () => {
      cancelled = true;
      if (cleanupPoll) cleanupPoll();
    };
  }, [pollSetupStatus]);

  const handleInstallRuntime = useCallback(async (installDir) => {
    const updated = await installAiRuntime(installDir);
    setRuntimeStatus(updated);
    pollSetupStatus();
    return updated;
  }, [pollSetupStatus]);

  // Refresh status whenever the wizard is reopened during a session.
  useEffect(() => {
    if (!showSetupWizard || !engine.isConnected) return;
    fetch(apiUrl('/api/setup-status'), { headers: authHeaders() })
      .then((response) => response.json())
      .then(setSetupStatus)
      .catch((err) => console.error('Could not refresh setup status:', err));
  }, [showSetupWizard, engine.isConnected]);

  // ── Tracking feedback ───────────────────────────────────────────────────
  useEffect(() => {
    if (engine.isTracking) setCurrentFrame(engine.progressData.currentFrame);
  }, [engine.progressData.currentFrame, engine.isTracking]);

  useEffect(() => {
    if (wasTracking.current && !engine.isTracking && engine.trackedFrames.length > 0) {
      setShowTrackingToast(true);
      if (trackingToastTimer.current) clearTimeout(trackingToastTimer.current);
      trackingToastTimer.current = setTimeout(() => setShowTrackingToast(false), 3500);
    }
    wasTracking.current = engine.isTracking;
  }, [engine.isTracking, engine.trackedFrames.length]);

  // Release the previous blob when the component unmounts. Each import created
  // an object URL that pinned the whole video file in memory for the lifetime
  // of the session.
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    if (trackingToastTimer.current) clearTimeout(trackingToastTimer.current);
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────────
  const handleVideoImport = useCallback(async (url, file) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = url;

    setVideoUrl(url);
    setIsPlaying(false);
    setCurrentFrame(0);
    setIsBackendReady(false);
    setObjects([{ id: 1, color: OBJECT_COLORS[0], name: 'Object 1' }]);
    setActiveObjectId(1);
    setClearSignal((value) => value + 1);
    engine.clearMaskCache();

    const result = await engine.uploadVideo(file);
    if (result) {
      setTotalFrames(result.frames_count);
      setIsBackendReady(true);
    }
  }, [engine]);

  const handleSeek = useCallback((frame) => {
    if (engine.isTracking) return;
    const clamped = Math.max(0, Math.min(lastFrame, frame));
    setCurrentFrame(clamped);
    if (isBackendReady) engine.requestMask(clamped);
  }, [engine, isBackendReady, lastFrame]);

  const handleCanvasClick = useCallback((points, boxes) => {
    if (!isBackendReady) {
      console.warn('Ignoring click: the backend is still initializing this video.');
      return;
    }
    engine.sendClick(points, boxes, currentFrame, activeObjectId);
  }, [engine, currentFrame, activeObjectId, isBackendReady]);

  const handleClearClicks = useCallback(() => {
    setClearSignal((value) => value + 1);
    engine.clearMaskCache();
    engine.clearBackendState(currentFrame);
  }, [engine, currentFrame]);

  const handleAddObject = useCallback(() => {
    setObjects((prev) => {
      if (prev.length >= MAX_OBJECTS) return prev;
      const newId = prev.length > 0 ? Math.max(...prev.map((o) => o.id)) + 1 : 1;
      setActiveObjectId(newId);
      return [...prev, {
        id: newId,
        color: OBJECT_COLORS[(newId - 1) % OBJECT_COLORS.length],
        name: `Object ${newId}`,
      }];
    });
  }, []);

  const handleDeleteObject = useCallback((event, id) => {
    event.stopPropagation();
    setObjects((prev) => {
      if (prev.length <= 1) return prev;
      const remaining = prev.filter((o) => o.id !== id);
      setActiveObjectId((active) => (active === id ? remaining[0].id : active));
      return remaining;
    });
    engine.removeObject(id, currentFrame);
    setDeleteObjectSignal({ id, at: performance.now() });
  }, [engine, currentFrame]);

  // ── Keyboard ────────────────────────────────────────────────────────────
  useKeyboardShortcuts({
    onStepFrame: (delta) => handleSeek(currentFrame + delta),
    onSeekToStart: () => handleSeek(0),
    onSeekToEnd: () => handleSeek(lastFrame),
    onTogglePlay: () => setIsPlaying((value) => !value),
    onUndo: () => setUndoSignal((value) => value + 1),
    onRedo: () => setRedoSignal((value) => value + 1),
    onEscape: () => setActiveModal(null),
  }, { enabled: !!videoUrl && !engine.isTracking && !activeModal && !showSetupWizard });

  // ── Derived UI state ────────────────────────────────────────────────────
  const models = engine.systemInfo.models ?? [];
  const samReady = models.some((m) => m.id !== 'matanyone' && m.downloaded);
  const showMissingModelsBanner = engine.isConnected && !showSetupWizard && models.length > 0 && !samReady;
  const canTrack = !!engine.maskBitmap || engine.trackedFrames.length > 0;

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background">
      {!engine.isConnected && !showSetupWizard && (
        <LoadingScreen isConnected={engine.isConnected} error={engine.connectionError} />
      )}

      {showMissingModelsBanner && (
        <div className="bg-red-950/80 backdrop-blur-md border-b border-red-500/20 text-red-200 px-6 py-3 text-xs flex justify-between items-center z-40 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
            <span>
              <strong>No tracking model installed.</strong> RotoFox needs a SAM 2.1
              checkpoint before it can segment anything.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowSetupWizard(true)}
            className="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-4 py-1.5 rounded-lg transition-colors shadow-lg"
          >
            Download Now
          </button>
        </div>
      )}

      {engine.lastError && (
        <div className="bg-red-950/70 border-b border-red-500/20 text-red-200 px-6 py-2 text-xs flex justify-between items-center z-40 flex-shrink-0">
          <span className="flex items-center gap-2">
            <AlertCircle size={13} className="flex-shrink-0" />
            {engine.lastError}
          </span>
          <button
            type="button"
            onClick={engine.dismissError}
            aria-label="Dismiss error"
            className="text-red-300/60 hover:text-red-200 transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex-1 relative overflow-hidden">
        {showTrackingToast && (
          <div className="fixed bottom-[180px] left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 bg-[#0f1a0f]/95 border border-green-500/30 backdrop-blur-md px-4 py-2.5 rounded-xl shadow-lg text-xs font-semibold text-green-400">
            <CheckCircle size={15} className="flex-shrink-0" />
            <span>Tracking complete — {engine.trackedFrames.length} frames processed</span>
            <button
              type="button"
              onClick={() => setShowTrackingToast(false)}
              aria-label="Dismiss notification"
              className="ml-1 text-green-400/50 hover:text-green-400 transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        )}

        <MainLayout
          toolbar={(
            <Toolbar
              clickMode={clickMode}
              setClickMode={setClickMode}
              onVideoImport={handleVideoImport}
              onExportClick={() => setActiveModal('export')}
              onSettingsClick={() => setActiveModal('settings')}
              onModelHubClick={() => setActiveModal('modelhub')}
              onUndoClick={() => setUndoSignal((value) => value + 1)}
              onRedoClick={() => setRedoSignal((value) => value + 1)}
              onClearClicks={handleClearClicks}
              viewMode={viewMode}
              setViewMode={setViewMode}
              objects={objects}
              activeObjectId={activeObjectId}
              setActiveObjectId={setActiveObjectId}
              handleAddObject={handleAddObject}
              handleDeleteObject={handleDeleteObject}
            />
          )}
          canvas={(
            <VideoCanvas
              videoUrl={videoUrl}
              clickMode={clickMode}
              onCanvasClick={handleCanvasClick}
              maskBitmap={engine.maskBitmap}
              isPlaying={isPlaying}
              currentFrame={currentFrame}
              totalFrames={totalFrames}
              onVideoMetadataLoaded={() => {}}
              onFrameChange={setCurrentFrame}
              onPlayToggle={setIsPlaying}
              clearSignal={clearSignal}
              undoSignal={undoSignal}
              redoSignal={redoSignal}
              uploadProgress={engine.uploadProgress}
              viewMode={viewMode}
              onRequestMask={engine.requestMask}
              objects={objects}
              activeObjectId={activeObjectId}
              deleteObjectSignal={deleteObjectSignal}
              onVideoImport={handleVideoImport}
            />
          )}
          timeline={(
            <TimelineController
              currentFrame={currentFrame}
              totalFrames={totalFrames}
              isPlaying={isPlaying}
              isTracking={engine.isTracking}
              hasVideo={!!videoUrl}
              objects={objects}
              activeObjectId={activeObjectId}
              trackedFrames={engine.trackedFrames}
              objectCoverage={engine.objectCoverage}
              onPlayToggle={() => !engine.isTracking && setIsPlaying((value) => !value)}
              onTrackForward={() => engine.startTracking(totalFrames, currentFrame, false)}
              onTrackBackward={() => engine.startTracking(totalFrames, currentFrame, true)}
              canTrack={canTrack}
              onCancelTracking={engine.cancelTracking}
              onSeek={handleSeek}
            />
          )}
        />

        <ExportModal
          open={activeModal === 'export'}
          exportState={engine.exportState}
          settings={exportSettings}
          onChange={updateExportSettings}
          onStart={engine.startExport}
          onCancel={engine.cancelExport}
          onClose={() => { setActiveModal(null); engine.resetExport(); }}
        />

        <SettingsModal
          open={activeModal === 'settings'}
          settings={exportSettings}
          onChange={updateExportSettings}
          onClose={() => setActiveModal(null)}
        />

        <ModelHubModal
          open={activeModal === 'modelhub'}
          systemInfo={engine.systemInfo}
          downloadStatus={engine.downloadStatus}
          onDownload={engine.downloadModel}
          onCancelDownload={engine.cancelDownload}
          onActivate={engine.loadModel}
          onSetCheckpointsDir={engine.setCheckpointsDir}
          onOpenDirectory={engine.openDirectory}
          onClose={() => { setActiveModal(null); engine.resetDownloadStatus(); }}
        />

        {showSetupWizard && (
          <SetupWizard
            runtimeStatus={runtimeStatus}
            setupStatus={setupStatus}
            downloadStatus={engine.downloadStatus}
            downloadModel={engine.downloadModel}
            cancelDownload={engine.cancelDownload}
            onInstallRuntime={handleInstallRuntime}
            onSetCheckpointsDir={engine.setCheckpointsDir}
            onComplete={() => {
              localStorage.setItem(SETUP_DONE_KEY, 'true');
              setShowSetupWizard(false);
              engine.getSystemInfo();
            }}
          />
        )}
      </div>
    </div>
  );
}

export default App;
