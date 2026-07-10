import sys
import urllib.request
from pathlib import Path

# Thêm thư mục backend vào sys.path để import model_manager
base_dir = Path(__file__).resolve().parent.parent
sys.path.append(str(base_dir))

from app.services.model_manager import MODELS, ModelManager

def download_file(model_id, info, checkpoints_dir):
    url = info["url"]
    dest_path = checkpoints_dir / info["checkpoint"]
    
    if dest_path.exists():
        print(f"[BỎ QUA] {info['name']} đã tồn tại ({dest_path.name})")
        return
        
    print(f"\n[ĐANG TẢI] {info['name']}")
    print(f"URL: {url}")
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response:
            total_size = int(response.info().get('Content-Length', 0))
            downloaded = 0
            block_size = 1024 * 1024 * 2 # 2MB block
            
            with open(dest_path, 'wb') as f:
                while True:
                    chunk = response.read(block_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = int((downloaded / total_size) * 100)
                        print(f"\rTiến độ: {percent}% ({downloaded // (1024*1024)}MB / {total_size // (1024*1024)}MB)", end="")
        print(f"\n[HOÀN THÀNH] Đã tải xong {info['name']}.")
    except Exception as e:
        print(f"\n[LỖI] Không thể tải {info['name']}: {e}")

def setup_models():
    print("=== BẮT ĐẦU CÀI ĐẶT MODEL AI ===")
    checkpoints_dir = ModelManager.get_checkpoints_dir()
    checkpoints_dir.mkdir(parents=True, exist_ok=True)
    
    print("1. Đang quét cấu hình hệ thống...")
    sys_info = ModelManager.get_system_info()
    
    print("\n--- THÔNG TIN HỆ THỐNG ---")
    print(f"GPU: {sys_info['gpu_name']} - VRAM: {sys_info['total_vram_gb']} GB")
    print(f"RAM Hệ thống: {sys_info['system_ram_gb']} GB")
    print("--------------------------\n")
    
    print("2. Tải model bắt buộc (MatAnyone 2)...")
    if "matanyone" in MODELS:
        download_file("matanyone", MODELS["matanyone"], checkpoints_dir)
        
    print("\n3. Tải model SAM 2 (Tùy chọn theo cấu hình)")
    
    sam_keys = ["tiny", "small", "base", "large"]
    recommended = sys_info["recommended_model"]
    
    for idx, key in enumerate(sam_keys, 1):
        info = MODELS[key]
        rec_mark = " (Khuyên dùng)" if key == recommended else ""
        print(f"  [{idx}] {info['name']}{rec_mark}")
        print(f"      Yêu cầu: {info.get('vram_req', 0)}GB VRAM | Tốc độ: {info.get('speed', '')}")
    
    print("  [5] Bỏ qua tải SAM 2")
    
    while True:
        try:
            choice = input(f"\nVui lòng chọn phiên bản SAM 2 muốn tải (1-5) [Mặc định: {sam_keys.index(recommended) + 1}]: ").strip()
            if not choice:
                choice = str(sam_keys.index(recommended) + 1)
                
            choice = int(choice)
            if 1 <= choice <= 4:
                selected_key = sam_keys[choice - 1]
                download_file(selected_key, MODELS[selected_key], checkpoints_dir)
                break
            elif choice == 5:
                print("Đã bỏ qua tải SAM 2.")
                break
            else:
                print("Lựa chọn không hợp lệ. Vui lòng nhập số từ 1 đến 5.")
        except ValueError:
            print("Vui lòng nhập một số hợp lệ.")

if __name__ == '__main__':
    setup_models()
