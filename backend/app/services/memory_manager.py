import gc
import torch

class MemoryManager:
    @staticmethod
    def cleanup():
        """
        Dọn dẹp bộ nhớ RAM và VRAM rác. 
        Gọi hàm này sau khi hoàn thành hoặc huỷ bỏ quá trình Tracking/Matting.
        """
        print("MemoryManager: Running garbage collection...")
        gc.collect()
        
        if torch.cuda.is_available():
            print("MemoryManager: Emptying CUDA cache...")
            torch.cuda.empty_cache()
            
            # (Tùy chọn) Có thể log thông tin bộ nhớ đã giải phóng
            # allocated = torch.cuda.memory_allocated()
            # print(f"CUDA Memory Allocated: {allocated / (1024**2):.2f} MB")
