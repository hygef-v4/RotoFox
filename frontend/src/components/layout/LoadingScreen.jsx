import React, { useState, useEffect } from 'react';
import { Sparkles, AlertCircle, RefreshCw } from 'lucide-react';

export default function LoadingScreen({ isConnected }) {
  const [statusIndex, setStatusIndex] = useState(0);
  const [secondsElapsed, setSecondsElapsed] = useState(0);

  const statuses = [
    "Connecting to RotoFox Core...",
    "Starting local AI engine...",
    "Tuning CUDA hardware configuration...",
    "Loading neural networks into memory...",
    "Optimizing pipeline execution..."
  ];

  // Rotate status message every 4 seconds
  useEffect(() => {
    const statusTimer = setInterval(() => {
      setStatusIndex((prev) => (prev < statuses.length - 1 ? prev + 1 : prev));
    }, 4000);
    return () => clearInterval(statusTimer);
  }, []);

  // Track time elapsed for troubleshooting timeout
  useEffect(() => {
    const elapsedTimer = setInterval(() => {
      setSecondsElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(elapsedTimer);
  }, []);

  const handleRetry = () => {
    window.location.reload();
  };

  const isTimeout = secondsElapsed >= 30;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-gradient-to-br from-[#060608] via-[#0b0b0e] to-[#121217] text-white z-[9999] overflow-hidden select-none">
      {/* Self-contained shimmer animation keyframes */}
      <style>{`
        @keyframes shimmer-bar {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .animate-shimmer-bar {
          animation: shimmer-bar 2s infinite ease-in-out;
        }
      `}</style>

      {/* Decorative background grid and ambient lighting */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-orange-500/5 via-transparent to-transparent opacity-70 pointer-events-none z-0" />
      <div className="absolute -top-[40%] -left-[30%] w-[80%] h-[80%] rounded-full bg-orange-500/5 blur-[120px] pointer-events-none z-0" />
      <div className="absolute -bottom-[40%] -right-[30%] w-[80%] h-[80%] rounded-full bg-orange-500/5 blur-[120px] pointer-events-none z-0" />

      <div className="relative bg-[#0d0d12]/50 backdrop-blur-2xl border border-white/[0.05] p-8 md:p-12 rounded-3xl max-w-md w-full mx-4 shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col items-center text-center transition-all duration-500 z-10">
        
        {/* Animated Brand Header / Spinner */}
        {!isTimeout ? (
          <div className="relative w-24 h-24 mb-8 flex items-center justify-center">
            {/* Glowing outer aura */}
            <div className="absolute inset-0 bg-orange-500/10 blur-xl rounded-full animate-pulse" />
            
            {/* Double ring loaders */}
            <div className="absolute inset-0 border-[3px] border-t-orange-500 border-r-transparent border-b-transparent border-l-transparent rounded-full animate-spin" style={{ animationDuration: '1.2s' }} />
            <div className="absolute inset-2 border border-white/[0.05] rounded-full" />
            <div className="absolute inset-2 border-[1.5px] border-b-amber-500/60 border-t-transparent border-r-transparent border-l-transparent rounded-full animate-spin" style={{ animationDuration: '2s', animationDirection: 'reverse' }} />
            
            {/* Inner Brand Card */}
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center shadow-lg shadow-orange-500/35 z-10">
              <Sparkles size={26} className="text-white animate-pulse" />
            </div>
          </div>
        ) : (
          <div className="w-20 h-20 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-8 shadow-lg shadow-red-500/10">
            <AlertCircle size={38} className="text-red-500" />
          </div>
        )}

        {/* Title */}
        <h1 className="text-3xl font-extrabold tracking-wider bg-gradient-to-r from-orange-500 via-amber-500 to-amber-400 bg-clip-text text-transparent mb-1">
          ROTOFOX
        </h1>
        
        <p className="text-[10px] text-white/40 font-mono tracking-widest uppercase mb-6">
          Smart Roto & Matte Studio
        </p>

        {/* Indeterminate Shimmer Progress Bar */}
        {!isTimeout && (
          <div className="w-48 bg-white/[0.03] h-[3px] rounded-full overflow-hidden mb-6 border border-white/[0.02] relative">
            <div className="absolute inset-0 bg-gradient-to-r from-orange-500/20 to-amber-400/20" />
            <div className="absolute top-0 bottom-0 left-0 w-1/2 bg-gradient-to-r from-orange-500 to-amber-400 rounded-full animate-shimmer-bar" />
          </div>
        )}

        {/* Dynamic Status / Error Messages */}
        <div className="min-h-[50px] flex items-center justify-center">
          {!isTimeout ? (
            <p className="text-sm font-medium text-white/80 transition-all duration-300">
              {statuses[statusIndex]}
            </p>
          ) : (
            <div className="space-y-4">
              <h3 className="text-base font-bold text-red-400">Connection Timeout</h3>
              <p className="text-xs text-white/60 leading-relaxed max-w-xs">
                RotoFox Core is taking longer than usual to start. This may happen if dependencies are downloading or another app is using port 8000.
              </p>
            </div>
          )}
        </div>

        {/* Action Button for Timeout */}
        {isTimeout && (
          <button
            type="button"
            onClick={handleRetry}
            className="mt-8 w-full max-w-[200px] bg-white hover:bg-white/90 text-black font-semibold py-2.5 px-4 rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-white/5 active:scale-[0.98] cursor-pointer"
          >
            <RefreshCw size={14} className="animate-spin" style={{ animationDuration: '3s' }} />
            Retry Connection
          </button>
        )}
      </div>
    </div>
  );
}
