import React from 'react';

const MainLayout = ({ toolbar, canvas, timeline }) => {
  return (
    <div className="flex h-screen w-screen bg-gradient-to-br from-[#060608] via-[#0b0b0e] to-[#121217] overflow-hidden text-textPrimary">
      {/* Sidebar / Toolbar (Bên trái) */}
      <div className="w-64 flex-shrink-0 bg-[#0d0d12]/60 backdrop-blur-lg border-r border-white/[0.06] flex flex-col relative z-20 overflow-y-auto shadow-2xl">
        {toolbar}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative overflow-hidden">
        {/* Canvas Area (Video + Mask Overlay) */}
        <div className="flex-1 bg-[#040406] flex items-center justify-center relative overflow-hidden">
          {canvas}
        </div>

        {/* Timeline Controller (Dưới cùng) */}
        <div className="h-auto min-h-32 max-h-48 overflow-y-auto flex-shrink-0 bg-[#0d0d12]/60 backdrop-blur-lg border-t border-white/[0.06] relative z-20 shadow-2xl">
          {timeline}
        </div>
      </div>
    </div>
  );
};

export default MainLayout;
