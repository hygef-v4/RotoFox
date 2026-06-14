import asyncio
import time
from app.core.engine_state import EngineState
from app.services.memory_manager import MemoryManager

class AIEngineMock:
    def __init__(self):
        self.state = EngineState()

    async def run_propagation(self, websocket):
        """
        Giả lập luồng Propagation (bám đuổi khung hình) của SAM 2.
        Nhận vào websocket để báo cáo tiến độ (progress).
        """
        if not self.state.is_tracking:
            return

        print(f"AI Engine: Starting propagation for {self.state.total_frames} frames...")
        
        try:
            for frame_idx in range(self.state.current_frame + 1, self.state.total_frames + 1):
                # Kiểm tra cờ huỷ
                if self.state.cancel_requested:
                    print(f"AI Engine: Propagation cancelled at frame {frame_idx}")
                    await websocket.send_json({"status": "cancelled", "frame": frame_idx})
                    break
                
                self.state.current_frame = frame_idx
                
                # TODO: Tại đây sẽ gọi model thực tế SAM2.predict_next_frame()
                # Giả lập thời gian xử lý: 0.1s mỗi frame (tương đương 10 FPS)
                await asyncio.sleep(0.1) 
                
                # Gửi kết quả về Frontend (Mock: Chỉ gửi % tiến độ)
                progress = int((frame_idx / self.state.total_frames) * 100)
                await websocket.send_json({
                    "status": "tracking",
                    "frame": frame_idx,
                    "progress": progress
                })

            if not self.state.cancel_requested:
                print("AI Engine: Propagation completed successfully.")
                await websocket.send_json({"status": "completed"})

        except Exception as e:
            print(f"AI Engine Error: {e}")
            await websocket.send_json({"status": "error", "message": str(e)})
        finally:
            self.state.reset()
            MemoryManager.cleanup()
