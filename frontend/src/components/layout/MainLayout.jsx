import React from 'react';

const MainLayout = ({ toolbar, canvas, timeline }) => {
  return (
    <div className="flex h-screen w-screen bg-background overflow-hidden text-textPrimary">
      {/* Sidebar / Toolbar (Bên trái) */}
      <div className="w-64 flex-shrink-0 bg-surface border-r border-surfaceHover flex flex-col relative z-20 overflow-y-auto">
        {toolbar}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative overflow-hidden">
        {/* Canvas Area (Video + Mask Overlay) */}
        <div className="flex-1 bg-black flex items-center justify-center relative overflow-hidden">
          {canvas}
        </div>

        {/* Timeline Controller (Dưới cùng) */}
        <div className="h-32 flex-shrink-0 bg-surface border-t border-surfaceHover relative z-20">
          {timeline}
        </div>
      </div>
    </div>
  );
};

export default MainLayout;
