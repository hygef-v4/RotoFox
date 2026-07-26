import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, ChevronRight, Cpu, Download, Sparkles, Zap } from 'lucide-react';

/**
 * First-run wizard.
 *
 * The required and optional models were previously inverted. MatAnyone 2 was
 * labelled "Required" and blocked the Continue button until it finished
 * downloading, while SAM 2.1 was labelled "Recommended" and offered a "Skip for
 * now" button.
 *
 * The code says the opposite. `ai_engine.run_export` checks whether the
 * MatAnyone checkpoint exists and falls back to raw SAM 2 masks when it does
 * not — it is genuinely optional. Without a SAM 2 checkpoint the predictor is
 * `None` and every canvas click raises, so a user who took the "Skip for now"
 * option landed in an application that could not do anything at all.
 *
 * Steps are therefore reordered: SAM 2.1 first and mandatory, MatAnyone second
 * and skippable.
 */

const STEP_WELCOME = 0;
const STEP_SAM = 1;
const STEP_MATANYONE = 2;
const STEP_DONE = 3;

const STEP_LABELS = ['Welcome', 'Tracking', 'Refinement', 'Done'];

const vramColour = (vram, gpuAvailable) => {
  if (!gpuAvailable) return 'text-textSecondary';
  if (vram <= 2) return 'text-green-400';
  if (vram <= 6) return 'text-orange-400';
  return 'text-red-400';
};

export default function SetupWizard({
  setupStatus,
  downloadStatus,
  downloadModel,
  cancelDownload,
  onComplete,
}) {
  const [step, setStep] = useState(STEP_WELCOME);
  const [selectedSam, setSelectedSam] = useState(null);

  const samReady = setupStatus?.sam_ready ?? false;
  const matanyoneReady = setupStatus?.matanyone_ready ?? false;
  const samModels = (setupStatus?.models ?? []).filter((m) => m.id !== 'matanyone');
  const matanyoneModel = (setupStatus?.models ?? []).find((m) => m.id === 'matanyone');
  const recommendedSam = setupStatus?.recommended_sam ?? 'base';
  const isDownloading = downloadStatus?.status === 'downloading';

  useEffect(() => {
    if (!selectedSam && recommendedSam) setSelectedSam(recommendedSam);
  }, [recommendedSam, selectedSam]);

  const renderProgress = () => (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-orange-400 font-semibold">
        <span>{downloadStatus.message}</span>
        <span>{downloadStatus.progress}%</span>
      </div>
      <div className="w-full bg-black/40 rounded-full h-2 overflow-hidden">
        <div
          className="bg-orange-500 h-full transition-all duration-200"
          style={{ width: `${downloadStatus.progress}%` }}
        />
      </div>
      <button
        type="button"
        onClick={cancelDownload}
        className="text-[10px] text-textSecondary hover:text-red-400 underline transition-colors"
      >
        Cancel download
      </button>
    </div>
  );

  const renderWelcome = () => (
    <div className="flex flex-col items-center text-center py-4">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-orange-500 to-orange-700 flex items-center justify-center mb-6 shadow-lg shadow-orange-500/20">
        <Sparkles size={38} className="text-white" />
      </div>
      <h2 className="text-2xl font-bold text-textPrimary mb-2">Welcome to RotoFox</h2>
      <p className="text-sm text-textSecondary max-w-xs leading-relaxed mb-2">
        Before you can start rotoscoping, RotoFox needs to install its AI models
        on this machine.
      </p>
      <p className="text-xs text-textSecondary/60 max-w-xs leading-relaxed">
        This is a one-time setup. Models are stored locally — no cloud, no tracking.
      </p>

      <div className="mt-8 w-full max-w-xs space-y-2 text-left">
        {[
          { label: 'SAM 2.1 Tracking Model', required: true },
          { label: 'MatAnyone 2 Edge Refinement', required: false },
        ].map((item) => (
          <div
            key={item.label}
            className="flex items-center gap-3 bg-black/25 rounded-lg px-3 py-2.5 border border-white/[0.04]"
          >
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.required ? 'bg-orange-500' : 'bg-green-500'}`} />
            <span className="text-xs text-textPrimary flex-1">{item.label}</span>
            <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
              item.required
                ? 'text-red-400 border-red-500/30 bg-red-500/5'
                : 'text-blue-400 border-blue-500/30 bg-blue-500/5'
            }`}
            >
              {item.required ? 'Required' : 'Optional'}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setStep(STEP_SAM)}
        className="mt-8 w-full max-w-xs bg-orange-500 hover:bg-orange-600 active:scale-[0.98] text-white font-semibold py-3 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-orange-500/20"
      >
        Get Started
        <ChevronRight size={16} />
      </button>
    </div>
  );

  const renderSam = () => (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-orange-500/15 border border-orange-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Cpu size={14} className="text-orange-400" />
        </div>
        <div>
          <h3 className="text-base font-bold text-textPrimary">
            Step 1: SAM 2.1 Tracking Model
            <span className="text-[10px] font-bold text-red-400 border border-red-500/30 bg-red-500/5 px-1.5 py-0.5 rounded ml-1">
              Required
            </span>
          </h3>
          <p className="text-xs text-textSecondary mt-0.5 leading-relaxed">
            Segments and tracks your subject. RotoFox cannot generate any mask
            without it. Detected hardware:{' '}
            <span className="text-textPrimary font-semibold">{setupStatus?.gpu_name ?? 'CPU'}</span>
            {setupStatus?.total_vram_gb ? (
              <span className="text-orange-400 font-semibold ml-1">({setupStatus.total_vram_gb} GB VRAM)</span>
            ) : null}
          </p>
        </div>
      </div>

      <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
        {samModels.map((model) => {
          const isSelected = selectedSam === model.id;
          const fits = !setupStatus?.total_vram_gb || model.vram_req <= setupStatus.total_vram_gb;

          return (
            <button
              key={model.id}
              type="button"
              onClick={() => setSelectedSam(model.id)}
              className={`w-full text-left p-3 rounded-xl border transition-all ${
                isSelected ? 'bg-orange-500/10 border-orange-500/50' : 'bg-black/20 border-white/[0.05] hover:border-white/[0.12]'
              } ${!fits && !model.downloaded ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold text-textPrimary">{model.name}</span>
                  {model.id === recommendedSam && (
                    <span className="text-[8px] font-bold uppercase tracking-wide text-green-400 border border-green-500/25 bg-green-500/10 px-1.5 py-0.5 rounded">
                      Best for your PC
                    </span>
                  )}
                  {model.downloaded && (
                    <span className="text-[8px] font-bold uppercase tracking-wide text-blue-400 border border-blue-500/25 bg-blue-500/10 px-1.5 py-0.5 rounded">
                      Installed
                    </span>
                  )}
                  {model.partial && (
                    <span className="text-[8px] font-bold uppercase tracking-wide text-red-400 border border-red-500/25 bg-red-500/10 px-1.5 py-0.5 rounded">
                      Incomplete
                    </span>
                  )}
                </div>
                <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all ${
                  isSelected ? 'border-orange-500 bg-orange-500' : 'border-[#444]'
                }`}
                >
                  {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>
              </div>
              <p className="text-[10px] text-textSecondary leading-relaxed">{model.description}</p>
              <div className="flex gap-3 mt-1.5 text-[9px] font-mono text-textSecondary/70 flex-wrap">
                <span>{model.speed}</span>
                <span>•</span>
                <span className={vramColour(model.vram_req, setupStatus?.gpu_available)}>
                  VRAM: {model.vram_req} GB
                </span>
                <span>•</span>
                <span>~{model.approx_mb} MB</span>
              </div>
            </button>
          );
        })}
      </div>

      {samReady ? (
        <div className="flex items-center gap-2 text-xs text-green-400 bg-green-500/5 border border-green-500/20 rounded-lg px-3 py-2.5">
          <CheckCircle size={14} />
          A tracking model is installed and ready.
        </div>
      ) : isDownloading ? renderProgress() : null}

      {downloadStatus?.status === 'error' && (
        <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2.5">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          {downloadStatus.message}
        </div>
      )}

      <div className="flex gap-2">
        {!samReady && !isDownloading && (
          <button
            type="button"
            onClick={() => downloadModel(selectedSam)}
            disabled={!selectedSam}
            className="flex-1 bg-orange-500 hover:bg-orange-600 active:scale-[0.98] text-white font-semibold py-2.5 rounded-xl transition-all text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download size={14} />
            Download {selectedSam ? `SAM 2.1 ${selectedSam}` : 'model'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setStep(STEP_MATANYONE)}
          disabled={!samReady || isDownloading}
          className={`font-semibold py-2.5 rounded-xl transition-all text-sm flex items-center justify-center gap-1 ${
            samReady && !isDownloading
              ? 'flex-1 bg-white hover:bg-gray-200 text-black active:scale-[0.98]'
              : 'flex-1 bg-white/10 text-textSecondary cursor-not-allowed'
          }`}
        >
          {samReady ? <>Continue <ChevronRight size={16} /></> : 'Download required to continue'}
        </button>
      </div>
    </div>
  );

  const renderMatanyone = () => (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-blue-500/15 border border-blue-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Download size={14} className="text-blue-400" />
        </div>
        <div>
          <h3 className="text-base font-bold text-textPrimary">
            Step 2: MatAnyone 2
            <span className="text-[10px] font-bold text-blue-400 border border-blue-500/30 bg-blue-500/5 px-1.5 py-0.5 rounded ml-1">
              Optional
            </span>
          </h3>
          <p className="text-xs text-textSecondary mt-0.5 leading-relaxed">
            Refines hair, smoke and fine edges during export. Skip it and RotoFox
            exports with the SAM 2 masks instead — you can add it any time from
            the Model Hub.
          </p>
        </div>
      </div>

      <div className="bg-black/30 rounded-xl border border-white/[0.04] p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-sm font-bold text-textPrimary">MatAnyone 2 — Edge Refinement</div>
            <div className="text-[10px] text-textSecondary mt-0.5">
              VRAM: {matanyoneModel?.vram_req ?? 4} GB · ~{matanyoneModel?.approx_mb ?? 135} MB download
            </div>
          </div>
          {matanyoneReady && (
            <span className="text-[10px] font-bold text-green-400 border border-green-500/30 bg-green-500/5 px-2.5 py-1.5 rounded-lg">
              Ready
            </span>
          )}
        </div>

        {matanyoneReady ? (
          <div className="flex items-center gap-2 text-xs text-green-400 bg-green-500/5 border border-green-500/20 rounded-lg px-3 py-2.5">
            <CheckCircle size={14} />
            Installed and ready to use during export.
          </div>
        ) : isDownloading ? renderProgress() : (
          <button
            type="button"
            onClick={() => downloadModel('matanyone')}
            className="w-full bg-orange-500 hover:bg-orange-600 active:scale-[0.98] text-white font-semibold py-2.5 rounded-lg transition-all text-sm flex items-center justify-center gap-2"
          >
            <Download size={14} />
            Download MatAnyone 2
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => setStep(STEP_DONE)}
        disabled={isDownloading}
        className="w-full bg-white hover:bg-gray-200 active:scale-[0.98] text-black font-semibold py-2.5 rounded-xl transition-all text-sm flex items-center justify-center gap-1 disabled:opacity-50"
      >
        {matanyoneReady ? 'Continue' : 'Skip for now'}
        <ChevronRight size={16} />
      </button>
    </div>
  );

  const renderDone = () => (
    <div className="flex flex-col items-center text-center py-4">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center mb-6 shadow-lg shadow-green-500/20">
        <Zap size={38} className="text-white" />
      </div>
      <h2 className="text-2xl font-bold text-textPrimary mb-2">You&apos;re all set</h2>
      <p className="text-sm text-textSecondary max-w-xs leading-relaxed mb-6">
        Import a video, click your subject, then press Track.
      </p>

      <div className="w-full max-w-xs space-y-2 text-left mb-8">
        {[
          { label: 'SAM 2.1 Tracking', done: samReady },
          { label: 'MatAnyone 2 Refinement', done: matanyoneReady },
        ].map((item) => (
          <div
            key={item.label}
            className="flex items-center gap-3 bg-black/25 rounded-lg px-3 py-2.5 border border-white/[0.04]"
          >
            {item.done
              ? <CheckCircle size={14} className="text-green-400 flex-shrink-0" />
              : <AlertCircle size={14} className="text-textSecondary/50 flex-shrink-0" />}
            <span className={`text-xs flex-1 ${item.done ? 'text-textPrimary' : 'text-textSecondary/50'}`}>
              {item.label}
            </span>
            <span className={`text-[9px] font-bold uppercase ${item.done ? 'text-green-400' : 'text-textSecondary/40'}`}>
              {item.done ? 'Ready' : 'Skipped'}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onComplete}
        className="w-full max-w-xs bg-orange-500 hover:bg-orange-600 active:scale-[0.98] text-white font-semibold py-3 rounded-xl transition-all shadow-lg shadow-orange-500/20 flex items-center justify-center gap-2"
      >
        <Zap size={16} />
        Launch RotoFox
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[100] backdrop-blur-sm">
      <div className="bg-[#111] border border-white/[0.06] rounded-2xl w-[520px] max-h-[90vh] overflow-y-auto shadow-2xl">
        {!setupStatus && (
          <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
            <div className="w-14 h-14 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center mb-5">
              <div className="w-6 h-6 border-2 border-orange-500/30 border-t-orange-500 rounded-full animate-spin" />
            </div>
            <h3 className="text-base font-bold text-textPrimary mb-1">Starting AI Core…</h3>
            <p className="text-xs text-textSecondary max-w-xs leading-relaxed">
              Waiting for the backend to initialise. This can take up to 30 seconds on first launch.
            </p>
          </div>
        )}

        {setupStatus?.error && (
          <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
            <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-5">
              <AlertCircle size={24} className="text-red-500" />
            </div>
            <h3 className="text-base font-bold text-textPrimary mb-1">Initialisation Failed</h3>
            <p className="text-xs text-textSecondary max-w-xs leading-relaxed">{setupStatus.error}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm text-white transition-all border border-white/10"
            >
              Retry Connection
            </button>
          </div>
        )}

        {setupStatus && !setupStatus.error && (
          <>
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/[0.04]">
              {STEP_LABELS.map((label, index) => (
                <div key={label} className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                    index < step ? 'bg-green-500 text-white'
                      : index === step ? 'bg-orange-500 text-white'
                        : 'bg-white/[0.06] text-textSecondary'
                  }`}
                  >
                    {index < step ? '✓' : index + 1}
                  </div>
                  <span className={`text-[10px] font-semibold hidden sm:block ${
                    index === step ? 'text-textPrimary' : 'text-textSecondary/50'
                  }`}
                  >
                    {label}
                  </span>
                  {index < STEP_LABELS.length - 1 && (
                    <div className={`w-8 h-px mx-1 ${index < step ? 'bg-green-500/50' : 'bg-white/[0.06]'}`} />
                  )}
                </div>
              ))}
            </div>

            <div className="p-6">
              {step === STEP_WELCOME && renderWelcome()}
              {step === STEP_SAM && renderSam()}
              {step === STEP_MATANYONE && renderMatanyone()}
              {step === STEP_DONE && renderDone()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
