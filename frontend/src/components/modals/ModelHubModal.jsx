import React from 'react';
import { AlertCircle, CheckCircle, Cpu, FolderOpen, X } from 'lucide-react';

/**
 * Hardware profile and model checkpoint manager.
 *
 * A checkpoint whose file is present but too small to be valid is now shown as
 * "Incomplete" with a Retry action. Previously any file that merely existed
 * counted as installed, so an interrupted download left the UI claiming the
 * model was ready while activating it failed with a stream-reader error and no
 * way to re-download.
 */
export default function ModelHubModal({
  open,
  systemInfo,
  downloadStatus,
  onDownload,
  onCancelDownload,
  onActivate,
  onSetCheckpointsDir,
  onOpenDirectory,
  onClose,
}) {
  if (!open) return null;

  const models = systemInfo.models ?? [];
  const samModels = models.filter((m) => m.id !== 'matanyone');
  const matanyoneModels = models.filter((m) => m.id === 'matanyone');
  const isDownloading = downloadStatus.status === 'downloading';

  const renderActions = (model) => {
    if (model.downloaded) {
      const isActive = systemInfo.active_model === model.id;
      if (model.role === 'refinement') {
        return (
          <span className="text-[10px] font-bold text-green-400 border border-green-500/30 bg-green-500/5 px-2.5 py-1.5 rounded-md">
            Installed
          </span>
        );
      }
      return (
        <button
          type="button"
          onClick={() => onActivate(model.id)}
          disabled={isActive || isDownloading}
          className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all ${
            isActive
              ? 'bg-white/[0.03] text-textSecondary cursor-not-allowed border border-white/[0.04]'
              : 'bg-white hover:bg-gray-200 text-black shadow-sm active:scale-[0.97]'
          }`}
        >
          {isActive ? 'Active' : 'Activate'}
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={() => onDownload(model.id)}
        disabled={isDownloading}
        className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all ${
          isDownloading
            ? 'bg-[#222] text-textSecondary border border-[#333] cursor-not-allowed'
            : 'bg-orange-500 hover:bg-orange-600 text-white shadow-md active:scale-[0.97] border border-orange-400/20'
        }`}
      >
        {model.partial ? 'Retry' : 'Download'}
      </button>
    );
  };

  const renderModelRow = (model) => {
    const isActive = systemInfo.active_model === model.id;
    return (
      <div
        key={model.id}
        className={`flex items-center justify-between p-3 rounded-lg border transition-all ${
          isActive
            ? 'bg-orange-500/[0.03] border-orange-500/40'
            : 'bg-black/10 border-white/[0.04] hover:border-white/[0.08]'
        }`}
      >
        <div className="flex-1 pr-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-textPrimary">{model.name}</span>
            {model.recommended && (
              <span className="bg-green-500/10 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wide">
                Recommended
              </span>
            )}
            {isActive && (
              <span className="bg-orange-500 text-white px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wide">
                Active
              </span>
            )}
            {model.partial && (
              <span className="bg-red-500/10 text-red-400 border border-red-500/25 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wide">
                Incomplete
              </span>
            )}
          </div>
          <p className="text-[10px] text-textSecondary mt-0.5 leading-relaxed">{model.description}</p>
          <div className="flex gap-3 text-[9px] text-textSecondary/70 mt-1 font-mono flex-wrap">
            <span>{model.speed}</span>
            <span>•</span>
            <span>VRAM: {model.vram_req} GB</span>
            <span>•</span>
            <span>
              {model.downloaded ? `Size: ${model.size_mb} MB` : `Download: ~${model.approx_mb} MB`}
            </span>
          </div>
        </div>
        <div className="flex-shrink-0">{renderActions(model)}</div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-[#171717] border border-[#333] rounded-xl w-[620px] max-h-[90vh] overflow-y-auto p-6 shadow-2xl relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close model hub"
          className="absolute top-4 right-4 text-textSecondary hover:text-textPrimary transition-colors"
        >
          <X size={20} />
        </button>

        <h3 className="text-xl font-bold mb-1 text-textPrimary flex items-center gap-2">
          <Cpu size={22} className="text-orange-500" />
          RotoFox AI Model Hub
        </h3>
        <p className="text-xs text-textSecondary mb-4">
          Local hardware profile and Segment Anything Model manager.
        </p>

        <div className="bg-black/35 rounded-lg p-3.5 border border-white/[0.04] mb-4">
          <div className="text-[10px] font-bold text-textSecondary/60 uppercase tracking-wider mb-2">
            Hardware Profile
          </div>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-textSecondary block">Graphics (GPU)</span>
              <span className={`font-semibold ${systemInfo.gpu_available ? 'text-green-400' : 'text-orange-400'}`}>
                {systemInfo.gpu_name}
                {systemInfo.total_vram_gb ? ` (${systemInfo.total_vram_gb} GB VRAM)` : ''}
              </span>
            </div>
            <div>
              <span className="text-textSecondary block">System Memory</span>
              <span className="font-semibold text-textPrimary">
                {systemInfo.system_ram_gb ? `${systemInfo.system_ram_gb} GB RAM` : 'Unknown'}
              </span>
            </div>
          </div>
          <div className="mt-2.5 pt-2.5 border-t border-white/[0.04] flex items-center gap-2 text-xs text-textSecondary">
            <span>Recommended for this PC:</span>
            <span className="bg-orange-500/10 text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider">
              SAM 2.1 {(systemInfo.recommended_model ?? 'tiny').toUpperCase()}
            </span>
          </div>
        </div>

        <div className="bg-black/35 rounded-lg p-3.5 border border-white/[0.04] mb-4">
          <div className="text-[10px] font-bold text-textSecondary/60 uppercase tracking-wider mb-2">
            Model Storage Folder
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              defaultValue={systemInfo.checkpoints_dir ?? ''}
              key={systemInfo.checkpoints_dir}
              onBlur={(event) => {
                if (event.target.value !== systemInfo.checkpoints_dir) {
                  onSetCheckpointsDir(event.target.value);
                }
              }}
              onKeyDown={(event) => { if (event.key === 'Enter') event.target.blur(); }}
              placeholder="e.g. D:\Models\SAM2 (blank for default)"
              className="flex-1 bg-[#222] border border-[#333] rounded-lg px-3 py-1.5 text-xs text-textPrimary focus:border-orange-500 focus:outline-none transition-colors placeholder-[#555]"
            />
            <button
              type="button"
              onClick={() => onOpenDirectory()}
              className="bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/25 text-[10px] font-bold text-orange-400 px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
              title="Open this folder in your file manager"
            >
              <FolderOpen size={12} />
              Open
            </button>
            <button
              type="button"
              onClick={() => onSetCheckpointsDir('')}
              className="bg-white/[0.02] hover:bg-white/[0.07] border border-white/[0.04] text-[10px] font-bold text-textSecondary hover:text-textPrimary px-2.5 py-1.5 rounded-lg transition-colors"
              title="Reset to the default checkpoints directory"
            >
              Reset
            </button>
          </div>
        </div>

        {isDownloading && (
          <div className="mb-4 bg-orange-500/5 border border-orange-500/20 rounded-lg p-3">
            <div className="flex justify-between items-center text-xs font-semibold text-orange-400 mb-1.5">
              <span>{downloadStatus.message}</span>
              <span>{downloadStatus.progress}%</span>
            </div>
            <div className="w-full bg-black/40 rounded-full h-1.5 overflow-hidden mb-2">
              <div className="bg-orange-500 h-full transition-all duration-200" style={{ width: `${downloadStatus.progress}%` }} />
            </div>
            <button
              type="button"
              onClick={onCancelDownload}
              className="text-[10px] text-textSecondary hover:text-red-400 underline transition-colors"
            >
              Cancel download
            </button>
          </div>
        )}

        {downloadStatus.status === 'completed' && (
          <div className="mb-4 bg-green-500/10 border border-green-500/25 rounded-lg p-2.5 flex items-center gap-2 text-xs text-green-400">
            <CheckCircle size={15} />
            <span>{downloadStatus.message}</span>
          </div>
        )}

        {downloadStatus.status === 'error' && (
          <div className="mb-4 bg-red-500/10 border border-red-500/25 rounded-lg p-2.5 flex items-start gap-2 text-xs text-red-400">
            <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
            <span>{downloadStatus.message}</span>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <div className="text-[10px] font-bold text-orange-400/90 uppercase tracking-wider mb-2">
              1. Tracking model (required)
              <span className="text-[9px] text-textSecondary/50 font-normal normal-case ml-1">
                — download and activate exactly one
              </span>
            </div>
            <div className="space-y-2">{samModels.map(renderModelRow)}</div>
          </div>

          {matanyoneModels.length > 0 && (
            <div className="pt-2 border-t border-white/[0.03]">
              <div className="text-[10px] font-bold text-orange-400/90 uppercase tracking-wider mb-2">
                2. Edge refinement (optional)
                <span className="text-[9px] text-textSecondary/50 font-normal normal-case ml-1">
                  — improves hair and fine edges during export
                </span>
              </div>
              <div className="space-y-2">{matanyoneModels.map(renderModelRow)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
