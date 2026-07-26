# RotoFox — Báo cáo Audit Toàn diện & Kế hoạch Triển khai

**Dự án:** `F:\code\git\Smart Mask Local` (RotoFox — Smart Video Segmentation)
**Ngày:** 26/07/2026
**Phạm vi đã đọc:** toàn bộ code do team viết — backend FastAPI/SAM2/MatAnyone (8 file, ~1.550 dòng), frontend React/Tauri (10 file, ~2.900 dòng), build scripts (.bat, .spec, scripts/), tài liệu (README.md, project_document.md, .agents/ARCHITECTURE.md), cộng với các điểm tích hợp trong code vendored (`sam2_src/sam2/sam2_video_predictor.py`, `third_party/MatAnyone2/inference_matanyone2.py`) để đối chiếu API.

**Tổng kết:** 46 vấn đề. Trong đó **7 lỗi P0** (chặn tính năng chính hoặc crash), **10 lỗi P1** (cho kết quả sai / mất dữ liệu), **6 vấn đề bảo mật**, **9 vấn đề hiệu năng/rò rỉ**, **14 vấn đề kiến trúc & tài liệu**.

> Mọi phát hiện dưới đây đã qua một vòng phản biện độc lập (đọc lại code, đối chiếu số dòng, chạy thử OpenCV để xác nhận hành vi). Các suy luận sai trong bản nháp đã được sửa hoặc loại bỏ — xem mục [Ghi chú về cách xác minh](#verify) ở cuối.

Đánh giá chung: kiến trúc phân tầng tốt (services tách bạch, WebSocket/REST rõ ràng, docstring đầy đủ, có xử lý `run_in_threadpool` đúng chỗ để không nghẽn event loop). Vấn đề nằm ở **đường xuất bản (export pipeline)** và **vòng đời tiến trình khi đóng gói** — đây là hai chỗ hỏng nặng nhất và cũng là hai chỗ người dùng cuối chạm vào nhiều nhất.

---

## MỤC LỤC

- [P0 — Chặn tính năng chính / crash](#p0)
- [P1 — Sai kết quả / mất dữ liệu](#p1)
- [P2 — Bảo mật](#p2)
- [P3 — Hiệu năng & rò rỉ tài nguyên](#p3)
- [P4 — Kiến trúc, chất lượng, tài liệu](#p4)
- [Khoảng cách giữa tài liệu và code](#gap)
- [KẾ HOẠCH TRIỂN KHAI](#plan)

---

<a name="p0"></a>
## P0 — Chặn tính năng chính / crash

### P0-1. `requirements.txt` thiếu 3 dependency bắt buộc → upload video crash ngay lần đầu

**File:** `backend/requirements.txt`

```
fastapi
uvicorn[standard]
websockets
opencv-python
numpy
torch
torchvision
ffmpeg-python
```

Ba thư viện đang được import trong code nhưng **không có trong requirements**:

| Thư viện | Dùng ở đâu | Hậu quả khi thiếu |
|:---|:---|:---|
| `python-multipart` | FastAPI cần để parse `UploadFile = File(...)` trong `routes.py:56` | `RuntimeError: Form data requires "python-multipart" to be installed` ngay khi POST `/upload` |
| `pillow` | `ai_engine.py:19` `from PIL import Image` | `ImportError` khi khởi tạo AIEngine → không load được video |
| `psutil` | `model_manager.py:148` | Bị nuốt bởi `except Exception: pass` → `system_ram_gb = None`, Model Hub hiển thị "Local Host" thay vì dung lượng RAM |

**Kịch bản hỏng:** người dùng mới clone repo → `pip install -r requirements.txt` → chạy `main.py` → server khởi động OK → import video → HTTP 500. Toàn bộ ứng dụng không dùng được.

**Bổ sung:** `torch` không ghi index URL → trên Windows `pip install torch` cài **bản CPU-only**. README hứa "CUDA acceleration" nhưng cài theo hướng dẫn sẽ ra bản CPU chạy chậm 20-50 lần. Không có version pin nào → build hôm nay và build tháng sau ra hai môi trường khác nhau.

**Đề xuất:**
```
fastapi==0.115.*
uvicorn[standard]==0.32.*
websockets==13.*
python-multipart==0.0.12
opencv-python==4.10.*
numpy<2.0
pillow==11.*
psutil==6.*
--extra-index-url https://download.pytorch.org/whl/cu121
torch==2.5.1+cu121
torchvision==0.20.1+cu121
hydra-core==1.3.2
iopath==0.1.10
```
(`numpy<2.0` vì SAM2 và OpenCV bản cũ chưa tương thích NumPy 2.x — cần verify trên máy thật.)

---

### P0-2. MatAnyone tự tải lại model từ GitHub mỗi lần export — phá vỡ cam kết "100% offline"

**File:** `backend/third_party/MatAnyone2/inference_matanyone2.py:27-30`

```python
def main(input_path, mask_path, output_path, ckpt_path, ...):
    # download ckpt for the first inference
    pretrain_model_url = "https://github.com/pq-yang/MatAnyone2/releases/download/v1.0.0/matanyone2.pth"
    ckpt_path = load_file_from_url(pretrain_model_url, 'pretrained_models')   # ← GHI ĐÈ tham số truyền vào
```

`ai_engine.py:564` truyền `ckpt_path=str(matanyone_checkpoint)` (trỏ tới file người dùng đã tải qua Model Hub), nhưng dòng đầu tiên của `main()` **ghi đè vô điều kiện** biến này. Kết quả:

1. Model đã tải qua Model Hub (`checkpoints/matanyone2.pth`, **135 MB** trên máy bạn) **không bao giờ được dùng**.
2. Lần export đầu tiên sẽ **gọi ra internet** tải lại từ GitHub → vi phạm trực tiếp cam kết `"🔒 100% Secure & Offline — Zero external API calls"` trong README và mục 1.3 của `project_document.md`.
3. Nếu người dùng không có mạng → export fail (được nuốt bởi `except` ở `ai_engine.py:572` → âm thầm fallback về mask thô, người dùng không biết vì sao chất lượng viền tệ).
4. File tải về nằm ở `./pretrained_models/` **tương đối theo CWD** → trong bản đóng gói portable sẽ ghi vào thư mục cài đặt hoặc thư mục tạm.

**Đề xuất:** không gọi `main()` của bên thứ ba. Viết `backend/app/services/matting_engine.py` gọi thẳng `InferenceCore` + `get_matanyone2_model(ckpt_path, device)` để kiểm soát hoàn toàn. Nếu muốn sửa nhanh trước mắt, patch:
```python
if not ckpt_path or not os.path.exists(ckpt_path):
    ckpt_path = load_file_from_url(pretrain_model_url, 'pretrained_models')
```
nhưng đây là file trong `third_party/` — sửa trực tiếp sẽ mất khi cập nhật upstream. Nên dùng wrapper riêng.

---

### P0-3. Export kèm MatAnyone **luôn crash ở frame đầu tiên**, ở mọi độ phân giải

**File:** `backend/app/services/ai_engine.py:604-613`

Đây là lỗi nghiêm trọng nhất trong pipeline export, và nó xảy ra **100% số lần** người dùng export với MatAnyone bật.

MatAnyone ghi file alpha ra dưới dạng ảnh **1 kênh (grayscale)** — `inference_matanyone2.py:110` tạo `pha = mask.unsqueeze(2)` shape `(H,W,1)`, ghi bằng `cv2.imwrite` ở dòng `:121`. Khi export đọc lại:

```python
m = cv2.imread(str(current_mask_path), cv2.IMREAD_UNCHANGED)     # dòng 605 → mảng 2 chiều (H,W)
if m is not None and len(m.shape) == 3 and m.shape[2] == 4:      # dòng 606 → False
    mask = m[:, :, 3]
elif m is not None:
    mask = cv2.cvtColor(m, cv2.COLOR_BGR2GRAY)                   # dòng 609 → NÉM EXCEPTION
```

`IMREAD_UNCHANGED` với ảnh grayscale trả về mảng **2 chiều**, nên nhánh `len(m.shape) == 3` là False và luồng rơi xuống `cvtColor(..., COLOR_BGR2GRAY)` — hàm này yêu cầu ảnh 3 kênh. Đã kiểm chứng thực tế với OpenCV 4.13:

```
cv2.error: (-15:Bad number of channels) Source image must have 3 or 4 channels in function 'cvtColor'
```

**Kịch bản hỏng:** người dùng có MatAnyone (nghĩa là đã theo đúng Setup Wizard, vốn ép tải nó) → bấm Export → MatAnyone chạy vài phút → tới lúc composite thì chết ở **frame đầu tiên** → UI hiện "Export Failed" với thông báo `cvtColor` khó hiểu. Toàn bộ thời gian refinement bị lãng phí.

Điều này có nghĩa: **đường export chính của sản phẩm chưa bao giờ chạy thông với MatAnyone.** Nhánh không có MatAnyone thì chạy được vì mask do SAM 2 lưu là RGBA 4 kênh (khớp nhánh dòng 606).

**Vấn đề thứ hai, ẩn phía sau:** `ai_engine.py:566` truyền `max_size=512` → MatAnyone resize video xuống (`inference_matanyone2.py:49-56`) và ghi `pha/*.png` ở kích thước đã giảm (1920×1080 → 910×512). Vòng lặp export **chỉ resize mask khi `export_w != self.video_width`** (dòng 611-613), nên với "original resolution" mask sẽ không được đưa về đúng kích thước. Sau khi sửa lỗi `cvtColor` ở trên, lỗi này sẽ lộ ra ngay — và biểu hiện của nó **không phải exception**: với `export_type == "alpha"` (giá trị mặc định trong `settings.get("type", "alpha")`), dòng 616 **thay thế** `out_frame` hoàn toàn, nên khung hình sai kích thước sẽ bị `VideoWriter` **âm thầm bỏ qua** → video xuất ra rỗng hoặc thiếu frame mà không có lỗi nào.

**Đề xuất (phải sửa cả hai):**
```python
m = cv2.imread(str(current_mask_path), cv2.IMREAD_UNCHANGED)
if m is not None:
    if m.ndim == 2:                       # grayscale (MatAnyone)
        mask = m
    elif m.shape[2] == 4:                 # RGBA overlay (SAM 2)
        mask = m[:, :, 3]
    else:                                 # BGR
        mask = cv2.cvtColor(m, cv2.COLOR_BGR2GRAY)

# LUÔN đưa mask về đúng kích thước frame, không phụ thuộc nhánh đổi resolution
if mask.shape[:2] != out_frame.shape[:2]:
    mask = cv2.resize(mask, (out_frame.shape[1], out_frame.shape[0]), interpolation=cv2.INTER_LINEAR)
```
Đồng thời cân nhắc `max_size=-1` (giữ nguyên độ phân giải) và cho người dùng chọn — MatAnyone ở 512px làm mất chính cái "chi tiết sợi tóc" mà nó được thêm vào để giải quyết.

---

### P0-4. SAM 2 bị unload khi export và **không bao giờ được load lại**

**File:** `backend/app/services/ai_engine.py:551-556`

```python
# Unload SAM 2 to avoid VRAM Out Of Memory during MatAnyone 2 inference
self.predictor = None
if self.inference_state is not None:
    del self.inference_state
    self.inference_state = None
MemoryManager.cleanup()
```

Ý tưởng đúng (tránh OOM khi 2 model cùng nằm trên VRAM), nhưng khối `finally` ở dòng 648-658 **chỉ xóa thư mục tạm**, không khôi phục predictor.

**Kịch bản hỏng:** người dùng track xong → export → export thành công → muốn sửa thêm vài điểm rồi export lại → click canvas → `RuntimeError: No video loaded into AI engine` (dòng 231-232). Không có thông báo hướng dẫn nào trong UI.

Có **một** đường phục hồi trong app nhưng hoàn toàn không trực giác: mở Model Hub → bấm "Activate" trên model đang dùng → `load_model` (`websockets.py:110-124`) dựng lại predictor và tự gọi `load_video` ở dòng 115-118. Người dùng bình thường sẽ không đoán ra điều này và sẽ khởi động lại app. Đáng chú ý: gửi lại `set_video_id` **không** phục hồi được, vì `websockets.py:48` kiểm tra `if ai_engine.predictor is not None` — lúc này là False nên khối load bị bỏ qua.

**Đề xuất:** trong `finally`, gọi lại `self.load_model(self.active_model_id)` và `self.load_video(self.video_id, self.video_fps)`, phát WebSocket message `engine_reloading` để UI hiện trạng thái. Cân nhắc: đẩy MatAnyone sang **tiến trình con riêng** (`multiprocessing`) → VRAM được HĐH thu hồi tự động khi tiến trình kết thúc, SAM 2 không cần unload chút nào.

---

### P0-5. Backend sidecar không bị tắt khi đóng app → tiến trình mồ côi, lần mở sau kẹt cổng

**File:** `frontend/src-tauri/src/lib.rs:26-36`

```rust
let sidecar_exe = "rotofox-backend-x86_64-pc-windows-msvc.exe";
match Command::new(sidecar_exe).spawn() {
    Ok(child) => { println!("... (PID: {}).", child.id()); }   // ← child bị drop ngay
    Err(err)  => { eprintln!("..."); }
}
```

`std::process::Command::spawn()` trả về `Child`; biến `child` ra khỏi scope ngay trong nhánh match và Rust **không kill tiến trình con khi drop** (khác với Node.js/Python). Không có handler `RunEvent::Exit` hay `on_window_event`.

**Hậu quả dây chuyền:**
1. Người dùng đóng cửa sổ RotoFox → backend .exe (61 MB, kèm PyTorch + model 1-2 GB đang nằm trong RAM/VRAM) **vẫn chạy nền vô thời hạn**.
2. Mở lại RotoFox → sidecar mới spawn → `uvicorn` không bind được cổng 8000 (đã bị instance cũ chiếm) → tiến trình mới chết âm thầm (`console=True` nhưng cửa sổ console bị ẩn ở bản release).
3. Frontend kết nối vào **instance CŨ** → có vẻ hoạt động, nhưng nó vẫn giữ `inference_state` của video trước; hoặc nếu instance cũ đã bị người dùng kill thì UI treo ở màn hình "Starting AI Core…" 30 giây rồi báo lỗi cổng 8000.
4. Mỗi lần mở/đóng app tích thêm một tiến trình mồ côi.

**Đề xuất:** Cargo.toml **đã có** `tauri-plugin-shell = "2"` và `capabilities/default.json` **đã khai báo** `shell:allow-spawn` cho sidecar — nhưng code không dùng. Chuyển sang API sidecar chính thức:
```rust
use tauri_plugin_shell::{ShellExt, process::CommandChild};
use std::sync::Mutex;

struct BackendProcess(Mutex<Option<CommandChild>>);

// trong setup():
let (_rx, child) = app.shell().sidecar("rotofox-backend")?.spawn()?;
app.manage(BackendProcess(Mutex::new(Some(child))));

// trong .build().run(|app, event|):
if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
    if let Some(c) = app.state::<BackendProcess>().0.lock().unwrap().take() {
        let _ = c.kill();
    }
}
```
Bổ sung: đọc stdout/stderr từ `_rx` và ghi ra log file — hiện tại mọi `print()` của backend biến mất hoàn toàn ở bản release.

---

### P0-6. Tên sidecar hardcode theo Windows → Linux/macOS không thể chạy

**File:** `frontend/src-tauri/src/lib.rs:28`

```rust
let sidecar_exe = "rotofox-backend-x86_64-pc-windows-msvc.exe";
```

README ghi `**OS**: Windows 10/11 or Ubuntu Linux`; `project_document.md` mục 1.2 ghi `**Hệ điều hành:** Hỗ trợ Windows và Linux`. Trên Linux, `Command::new("rotofox-backend-x86_64-pc-windows-msvc.exe")` fail ngay, chỉ in ra stderr rồi app chạy tiếp với backend không tồn tại → treo ở màn hình loading vĩnh viễn.

Ngoài ra `build_portable.bat`, `package_backend.py` (tên `rotofox-backend.exe`), và `.spec` đều chỉ hỗ trợ Windows. **Thực trạng: đây là dự án Windows-only.** Cần hoặc bỏ cam kết Linux khỏi tài liệu, hoặc dùng API sidecar của Tauri (tự động resolve target triple theo nền tảng) + thêm nhánh build Linux.

---

### P0-7. Cache ghi sai vị trí trong bản đóng gói

**File:** `backend/app/services/cache_manager.py:11`

```python
CACHE_BASE_DIR: Path = Path(__file__).resolve().parent.parent.parent / "cache_workspace"
```

`model_manager.py:64-68` và `:119-125` **đã xử lý đúng** trường hợp đóng gói:
```python
if getattr(sys, 'frozen', False):
    base_dir = Path(sys.executable).parent
```
nhưng `cache_manager.py` thì không. Trong bản PyInstaller `--onedir`, `__file__` nằm trong `_internal/` (hoặc trong thư mục `_MEIxxxxx` tạm nếu chuyển sang onefile). Kết quả:

- **onedir:** cache frame JPG (có thể vài GB) ghi vào `_internal/cache_workspace/` — lẫn vào runtime của ứng dụng, không được dọn khi gỡ cài, khiến thư mục cài đặt phình to.
- **onefile (nếu sau này đổi):** ghi vào thư mục temp bị Windows xóa → cache biến mất giữa các phiên, mất toàn bộ mask đã track.

Đây cũng là lý do bạn thấy `backend/cache_workspace/video_1784264402/` với 287 file JPG (~40 MB) đang nằm trong repo — cache không có cơ chế dọn theo tuổi/dung lượng, chỉ bị xóa sạch khi upload video mới.

**Đề xuất:** thống nhất một helper `app/core/paths.py`:
```python
def app_data_dir() -> Path:
    if getattr(sys, 'frozen', False):
        base = Path(os.getenv('LOCALAPPDATA', Path.home())) / "RotoFox"
    else:
        base = Path(__file__).resolve().parents[2]
    base.mkdir(parents=True, exist_ok=True)
    return base
```
Cache nên nằm ở `%LOCALAPPDATA%\RotoFox\cache` chứ không phải trong thư mục cài đặt (Program Files thường read-only cho user thường).

---

<a name="p1"></a>
## P1 — Sai kết quả / mất dữ liệu

### P1-1. Alpha Matte xuất ra **màu xám 150/255** thay vì trắng 255

**File:** `backend/app/services/ai_engine.py:35-43`, `:296-303`, `:604-616`

Bảng màu overlay dùng alpha = 150 (để nhìn xuyên qua trên canvas):
```python
PALETTE = { 1: [255, 59, 48, 150], 2: [0, 122, 255, 150], ... }
```
`run_propagation` lưu **chính ảnh overlay này** xuống `masks/*.png` (dòng 374-378). Đến lúc export:
```python
mask = m[:, :, 3]                                  # ← alpha = 150 ở vùng foreground
...
if export_type == "alpha":
    out_frame = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)   # → xám (150,150,150)
```

**Hậu quả thực tế:** người dùng chọn "Alpha Matte — B&W mask video", đưa file vào Premiere/After Effects làm Track Matte → chủ thể hiển thị ở **59% opacity** thay vì đục hoàn toàn, nền không đen tuyệt đối. Đây là lỗi im lặng: file xuất ra trông "gần đúng", người dùng chỉ phát hiện khi composite.

Ngoài ra ngưỡng `mask < 127` ở chế độ "solid" đang hoạt động **nhờ may mắn** (150 > 127). Nếu ai đó chỉnh alpha palette xuống 120 cho đẹp hơn thì toàn bộ export solid sẽ đảo ngược foreground/background.

**Đề xuất:** tách hai loại dữ liệu — lưu song song `masks/{idx}.png` (overlay màu, cho UI) và `alpha/{idx}.png` (grayscale 0/255, cho export). Hoặc lưu duy nhất mask nhị phân và tô màu ở phía client.

---

### P1-2. Xóa object không bao giờ cập nhật mask trên canvas (code chết)

**File:** `backend/app/services/ai_engine.py:450-456`

```python
_, updated_frames = self.predictor.remove_object(self.inference_state, obj_id)
if frame_idx is not None and isinstance(updated_frames, dict) and frame_idx in updated_frames:
    out_obj_ids, out_mask_logits = updated_frames[frame_idx]
    return self._masks_to_base64(...)
return None
```

SAM 2 trả về `updated_frames` là **list các tuple** `(frame_idx, video_res_masks)` — đã xác minh tại `sam2_src/sam2/sam2_video_predictor.py:952`:
```python
updated_frames.append((frame_idx, video_res_masks))
...
return inference_state["obj_ids"], updated_frames
```

`isinstance(list, dict)` luôn `False` → hàm **luôn trả `None`** → `websockets.py:245` `if b64_mask is not None` luôn False → không gửi `mask_update`. Người dùng xóa Object 3, mask đỏ/xanh của nó **vẫn hiển thị trên canvas** cho đến khi chuyển frame khác.

**Lưu ý thêm:** ở `sam2_video_predictor.py:884-886`, khi object bị xóa là object **cuối cùng**, SAM 2 gọi `reset_state` và trả về list **rỗng**. Vì vậy bản sửa chỉ duyệt list là chưa đủ — cần xử lý riêng trường hợp này để gửi `mask_base64: null` cho client xóa overlay.

**Đề xuất:**
```python
obj_ids, updated_frames = self.predictor.remove_object(self.inference_state, obj_id)
if not obj_ids:                       # đã xóa object cuối cùng → không còn mask nào
    return None                       # (websocket cần gửi mask_base64: null, không phải bỏ qua)
for f_idx, masks in updated_frames:
    if f_idx == frame_idx:
        return self._masks_to_base64(obj_ids, masks, self.video_width, self.video_height)
return None
```
Đồng thời sửa `websockets.py:245` để **luôn** gửi `mask_update` (kể cả khi mask là `None`), thay vì `if b64_mask is not None`.

---

### P1-3. MatAnyone chỉ nhận mask của 1 frame và 1 object — mất toàn bộ multi-object khi refine

**File:** `backend/app/services/ai_engine.py:546-549`

```python
masks_list = sorted(list(mask_dir.glob("*.png")))
first_mask_path = masks_list[0]
```

Ba vấn đề chồng lên nhau:

1. **Chỉ frame đầu tiên.** MatAnyone được thiết kế nhận mask 1 frame rồi tự propagate — nhưng nếu người dùng track từ frame 200 (không từ frame 0), `masks_list[0]` là frame 200 trong khi `temp_input_dir` chứa **toàn bộ** frame từ 0. MatAnyone sẽ dùng mask của frame 200 làm mask khởi tạo cho frame 0 → sai hoàn toàn.

2. **Toàn bộ 7 object bị gộp thành một khối duy nhất.** `inference_matanyone2.py:69` làm `Image.open(mask_path).convert('L')` trên file overlay RGBA. PIL bỏ kênh alpha, tính luminance từ RGB → mọi object đều ra một giá trị **khác 0** (đỏ ≈ 116, xanh ≈ 101, …). Sau đó `gen_dilate` (`matanyone2/utils/inference_utils.py:45`) làm `np.not_equal(alpha, 0).astype(np.float32) * 255` — **nhị phân hóa mọi giá trị khác 0 thành 255**. Kết quả: MatAnyone nhận một mask duy nhất là **hợp (union) của cả 7 object**, refine chúng như một khối liền, và trả về một alpha channel duy nhất. Thông tin phân tách object bị mất hoàn toàn.

   (Điểm tích cực nhỏ: vì `gen_dilate` nhị phân hóa nên chất lượng refinement **không** phụ thuộc vào màu bạn gán cho object — nhưng việc gộp object thì vẫn là mất mát thật.)

3. **Model chỉ được cấu hình cho 1 object.** `inference_matanyone2.py:73` đặt `objects = [1]` cố định và truyền vào `processor.step(image, mask, objects=objects)` ở dòng `:98`. Ngay cả khi mask đầu vào có nhiều nhãn, pipeline cũng chỉ xử lý một object.

**Kết quả tổng hợp:** README quảng cáo "up to 7 concurrent, color-coded mask layers", nhưng sau khi qua MatAnyone thì chỉ còn **một** alpha channel gộp chung. Với người dùng chỉ tách 1 chủ thể (đa số trường hợp) thì không nhận ra; với người dùng tách nhiều đối tượng thì kết quả sai hoàn toàn.

**Đề xuất:** ghi mask nhị phân 0/255 riêng **cho từng `obj_id`**; xác định frame khởi tạo đúng (frame nhỏ nhất trong `interaction_frames`); chạy MatAnyone lặp cho từng object rồi hợp nhất alpha theo thứ tự layer (hoặc chấp nhận giới hạn 1 object và **ghi rõ trong UI + README** thay vì để người dùng tự phát hiện).

---

### P1-4. `cv2.VideoWriter` không kiểm tra `isOpened()` → báo "Export Successful" cho file 0 byte

**File:** `backend/app/services/ai_engine.py:581-586, 636-641`

```python
if export_format == "webm":
    fourcc = cv2.VideoWriter_fourcc(*'vp80')
else:
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
writer = cv2.VideoWriter(output_path, fourcc, fps, (export_w, export_h))
# ... vòng lặp write ...
writer.release()
await websocket.send_json({"status": "export_completed", "file_path": ...})
```

`cv2.VideoWriter` **không ném exception** khi không mở được — nó chỉ trả về object với `isOpened() == False`, và mọi `write()` sau đó là no-op. Các trường hợp gây fail: OpenCV build thiếu codec VP8 (rất phổ biến với `opencv-python` bản wheel), container `.webm` + fourcc `vp80` không tương thích, kích thước lẻ, đường dẫn không ghi được.

Người dùng thấy màn hình xanh "Export Successful!" kèm đường dẫn, mở ra thì file 0 KB hoặc không phát được.

**Thêm:** chọn format `mov` ở UI cũng dùng fourcc `mp4v` → tạo file `.mov` chứa stream MPEG-4 Part 2 — hợp lệ về kỹ thuật nhưng **không phải ProRes 4444** như README/spec cam kết, và **không có kênh alpha**.

**Đề xuất:** thêm `if not writer.isOpened(): raise RuntimeError(...)`; và chuyển hẳn sang FFmpeg cho các format cần alpha (xem P1-5).

---

### P1-5. Không có xuất alpha thật, không có ProRes 4444, không có PNG sequence

**Cam kết trong tài liệu:**
- README dòng 47: `📤 Production-Ready Exports | Export masks as transparent **ProRes 4444 (.mov)** or a **Luma Matte Sequence** (grayscale PNG images)`
- `project_document.md` mục 1.2: `Xuất video giữ nguyên độ phân giải gốc dưới dạng Video Alpha Channel (.mov ProRes 4444) hoặc chuỗi ảnh đen trắng (Luma Matte Sequence)`

**Thực tế trong code:** chỉ có 2 fourcc (`mp4v`, `vp80`) qua `cv2.VideoWriter`, cả hai đều là **3 kênh BGR, không mang alpha**. Không có nhánh nào ghi PNG sequence. `ffmpeg-python` có trong requirements nhưng **không được import ở bất kỳ đâu** trong code backend.

**Đề xuất:** dùng FFmpeg (bundle binary vào bản portable):
```bash
# ProRes 4444 với alpha
ffmpeg -framerate {fps} -i frames/%05d.png -i alpha/%05d.png \
  -filter_complex "[0][1]alphamerge" -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le out.mov
# PNG sequence (luma matte)
# → chỉ cần copy alpha/*.png ra thư mục đích, gần như miễn phí
```
PNG sequence là món dễ nhất và cũng là món editor dùng nhiều nhất — nên làm trước.

---

### P1-6. Track / Export có thể chạy chồng nhau, phá hỏng inference state

**File:** `backend/app/api/websockets.py:165-174` và `:254-256`

```python
elif action == "track_forward":
    ai_engine.state.start_tracking(video_id, total_frames)
    asyncio.create_task(ai_engine.run_propagation(websocket, start_frame))   # không guard
...
elif action == "export":
    asyncio.create_task(ai_engine.run_export(websocket, data))               # không guard
```

Không có kiểm tra "đang chạy rồi thì bỏ qua". Frontend có disable nút khi `isTracking` (`TimelineController.jsx:116`), nhưng:
- `isTracking` là state client, có thể lệch (mất kết nối, reconnect, F5).
- Bất kỳ client nào khác (hoặc trang web bất kỳ — xem P2-1) đều gửi được lệnh.
- Nút Export **không hề bị disable** khi đang export — người dùng bấm 2 lần trong modal lỗi/retry là ra 2 task.

**Hậu quả:** hai generator `propagate_in_video` chạy đồng thời trên **cùng một `inference_state`** → memory bank của SAM 2 bị hai luồng ghi xen kẽ → mask sai hoặc `RuntimeError` giữa chừng. Hai export → hai `VideoWriter` ghi vào hai file khác nhau nhưng cùng đọc/xóa `matanyone_input`/`matanyone_output` → cái này xóa thư mục tạm của cái kia.

**Đề xuất:** thêm `asyncio.Lock` cấp engine, hoặc kiểm tra `if self.state.is_tracking: send error; return` ngay đầu handler. Với export, thêm cờ `is_exporting`.

---

### P1-7. Tải model không atomic → file cụt vẫn được coi là "đã cài"

**File:** `backend/app/services/model_manager.py:217-244`

```python
dest_path = cls.get_checkpoints_dir() / model_info["checkpoint"]
...
with open(dest_path, "wb") as f:      # ← ghi thẳng vào tên đích
    while True:
        chunk = await run_in_threadpool(conn.read, block_size)
```

Mất mạng / người dùng đóng app giữa chừng → file `sam2.1_hiera_large.pt` cụt (ví dụ 300 MB / 2.4 GB) nằm lại trong `checkpoints/`. Lần sau:
- `get_system_info()` chỉ kiểm tra `checkpoint_path.exists()` → báo **`downloaded: True`**, UI hiện "Installed", nút chuyển thành "Activate".
- `SetupWizard` cho qua bước.
- Bấm Activate → `torch.load` ném `RuntimeError: PytorchStreamReader failed` hoặc `UnpicklingError` — thông báo lỗi không gợi ý gì về việc file hỏng.
- Không có cách nào tải lại từ UI (nút đã đổi thành "Activate").

Không có checksum, không có kiểm tra kích thước, không có cơ chế resume, không có nút hủy download.

**Đề xuất:** tải vào `{name}.part` → `os.replace()` khi hoàn tất → xóa `.part` trong `except`. Thêm `expected_size`/`sha256` vào registry `MODELS` và verify sau khi tải. Kiểm tra size khi liệt kê để phát hiện file hỏng.

---

### P1-8. Off-by-one xuyên suốt timeline

Frame hợp lệ là `0 .. totalFrames-1`, nhưng code dùng `totalFrames` làm biên trên:

| File:dòng | Code | Hậu quả |
|:---|:---|:---|
| `TimelineController.jsx:20` | `progress = (currentFrame / totalFrames) * 100` | Playhead không bao giờ chạm 100%; ở frame cuối vẫn hiện ~99.7% |
| `TimelineController.jsx:195` | `onSeek?.(totalFrames)` (phím End) | Nhảy tới frame không tồn tại |
| `TimelineController.jsx:180` | `onSeek?.(Math.min(totalFrames, currentFrame + 1))` | Cho phép vượt frame cuối |
| `TimelineController.jsx:186` | `onSeek?.(Math.min(totalFrames, currentFrame + 10))` (PageUp) | Như trên |
| `App.jsx:203` | `Math.min(totalFramesRef_kb.current, ...)` (phím →) | Như trên |
| `App.jsx:298` | `Math.max(0, Math.min(totalFrames, frame))` | Như trên |

Ở frame `totalFrames`, `requestMask()` gửi lên backend, `masks/{N:05d}.png` không tồn tại → trả `mask_base64: null` → mask biến mất. Người dùng tưởng frame cuối chưa được track.

**Đề xuất:** đổi toàn bộ biên thành `totalFrames - 1`; `progress` chia cho `Math.max(1, totalFrames - 1)`.

---

### P1-9. Timeline đa đối tượng hiển thị dữ liệu giống hệt nhau cho mọi object

**File:** `frontend/src/components/timeline/TimelineController.jsx:230-255`

```jsx
{objects.map((obj) => {
  const ranges = getContiguousRanges(trackedFrames);   // ← trackedFrames KHÔNG phân theo object
  ...
```

`trackedFrames` đến từ `useAIEngine.js:97` `Array.from(maskCacheRef.current.keys())` — là danh sách **frame index**, không có thông tin `obj_id` (backend gộp tất cả object vào một ảnh overlay duy nhất và một `masks/{idx}.png` duy nhất).

Kết quả: 7 track trong UI hiển thị **các dải màu y hệt nhau**, chỉ khác màu tô. Tính năng "Multi-Object Timeline" trong README về mặt hình ảnh là giả.

**Thêm:** `getContiguousRanges` được gọi lại **trong vòng lặp map**, tức chạy `objects.length` lần mỗi render, mỗi lần `sort()` toàn bộ mảng frame. Trong lúc tracking (re-render mỗi frame), với 3000 frame và 7 object là ~21.000 phép sort/giây.

**Đề xuất:** backend gửi kèm `obj_ids` trong message `tracking`; frontend lưu `Map<objId, Set<frame>>`. `useMemo` cho `getContiguousRanges`, tính một lần ngoài vòng map.

---

### P1-10. Thanh tiến trình upload là **số ngẫu nhiên**, không phản ánh tiến độ thật

**File:** `frontend/src/components/canvas/VideoCanvas.jsx:47-66`

```js
setUploadProgress(prev => {
  if (prev < 40)      return prev + Math.floor(Math.random() * 5) + 2;
  else if (prev < 80) return prev + Math.floor(Math.random() * 3) + 1;
  else if (prev < 98) return prev + 1;
  return prev;
});
```

Và nhãn trạng thái ("Uploading video file…" / "Extracting frames…" / "Initializing SAM 2 AI model…") cũng suy ra từ con số giả này. Video 10 giây thì thanh chạy tới 98% rồi đứng chờ; video 10 phút thì thanh đứng ở 98% cả phút trong khi backend đang giải nén hàng nghìn frame.

Backend **có** thông tin thật (`VideoProcessor.extract_frames` biết `total_source_frames` và `frame_count` hiện tại) nhưng không phát ra ngoài.

**Đề xuất:** dùng `XMLHttpRequest.upload.onprogress` cho phần upload thật, và cho `extract_frames` nhận callback đẩy tiến độ qua WebSocket (`{"status": "extract_progress", "current": i, "total": n}`).

---

<a name="p2"></a>
## P2 — Bảo mật

### P2-1. WebSocket không xác thực và không kiểm `Origin` — **bất kỳ trang web nào cũng điều khiển được backend**

**File:** `backend/app/api/websockets.py:24-31`

```python
@router.websocket("/ws/editor")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()      # chấp nhận vô điều kiện
```

**Điểm mấu chốt:** CORS **không áp dụng cho WebSocket**. Trong khi RotoFox đang chạy, bất kỳ tab trình duyệt nào của người dùng (một quảng cáo, một trang bất kỳ) đều có thể chạy:
```js
const ws = new WebSocket('ws://127.0.0.1:8000/ws/editor');
ws.onopen = () => ws.send(JSON.stringify({action: 'export', export_path: 'C:\\Users\\...\\Startup', ...}));
```
và trình duyệt sẽ kết nối thành công. Từ đó gọi được toàn bộ các action:

| Action | Khả năng lạm dụng |
|:---|:---|
| `export` | Ghi file video vào **đường dẫn tùy ý** (`export_path` không giới hạn) — kể cả thư mục Startup |
| `open_directory` | Mở Explorer/xdg-open ở **đường dẫn tùy ý** do attacker chỉ định |
| `set_checkpoints_dir` | Ghi `rotofox_config.json`, đổi thư mục model |
| `download_model` | Ép tải 2.4 GB từ mạng, làm đầy ổ đĩa |
| `cancel_tracking` / `clear_clicks` | Phá công việc đang làm của người dùng (`clear_clicks` **xóa vĩnh viễn** thư mục `masks/`) |
| `get_system_info` | Rò rỉ tên GPU, dung lượng RAM/VRAM, đường dẫn tuyệt đối tới thư mục người dùng |

Rủi ro thật, không lý thuyết — đây là mô hình tấn công quen thuộc với các app desktop mở HTTP server local.

**Đề xuất (theo thứ tự ưu tiên):**
1. Sinh token ngẫu nhiên khi backend khởi động, ghi ra file cạnh exe; Tauri đọc file và inject vào frontend; WebSocket yêu cầu token → `websocket.close(code=1008)` nếu sai.
2. Kiểm `websocket.headers.get("origin")` — chỉ chấp nhận `tauri://localhost`, `http://localhost:1420`, hoặc **không có** Origin (client không phải trình duyệt).
3. Whitelist `export_path` và `open_directory` trong danh sách thư mục cho phép.

---

### P2-2. CORS `allow_origins=["*"]` cộng `allow_credentials=True`

**File:** `backend/main.py:18-24`. Tổ hợp này bị chính spec CORS cấm (trình duyệt sẽ từ chối), và ngay cả khi bỏ credentials thì `*` cũng cho phép **mọi trang web** gọi `POST /upload` và `GET /api/setup-status`. Comment trong code đã ghi nhận vấn đề (`# In production, restrict this to Tauri's local origin`) nhưng chưa làm.

---

### P2-3. Path traversal ở endpoint upload

**File:** `backend/app/api/routes.py:70-76`

```python
video_dir = CacheManager.get_video_dir(video_id)
video_path = video_dir / file.filename        # ← filename do client kiểm soát hoàn toàn
with open(video_path, "wb") as f:
    f.write(await file.read())
```

`file.filename` không được sanitize. Payload `filename="../../../../Users/hung/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.bat"` sẽ ghi file ra ngoài cache. Kết hợp với P2-2 (`allow_origins=["*"]`), một trang web bất kỳ gửi được `POST /upload` này.

Tương tự, `video_id` từ WebSocket (`set_video_id`) đi thẳng vào `CacheManager.get_video_dir()` mà không validate → `video_id = "../../.."` cho phép `shutil.rmtree` (trong `clear_clicks`) xóa thư mục ngoài ý muốn.

**Đề xuất:** dùng tên cố định (`source{Path(file.filename).suffix}`) và validate `video_id` bằng regex `^video_\d+$`.

---

### P2-4. Toàn bộ file video nạp vào RAM khi upload

**File:** `backend/app/api/routes.py:75-76` — `content = await file.read()`. Video 4K 10 phút (~5 GB) → 5 GB RAM chỉ để lưu ra đĩa. Trên máy 16 GB đang chạy PyTorch, đây là OOM chắc chắn. Nên stream: `shutil.copyfileobj(file.file, f)` hoặc đọc chunk 1 MB.

---

### P2-5. Tauri CSP bị tắt

**File:** `frontend/src-tauri/tauri.conf.json` → `"security": { "csp": null }`. Không có Content Security Policy. `index.css` còn `@import` font từ `fonts.googleapis.com` — nghĩa là app "100% offline" vẫn gọi ra Google mỗi lần khởi động (và font sẽ không load khi không có mạng, UI rơi về sans-serif hệ thống).

**Đề xuất:** đặt CSP `default-src 'self'; connect-src 'self' ws://127.0.0.1:8000 http://127.0.0.1:8000; img-src 'self' data: blob:`. Self-host font Inter vào `public/` để thực sự offline.

---

### P2-6. `open_directory` thực thi lệnh hệ thống với đường dẫn từ client

**File:** `backend/app/api/websockets.py:147-163`. `subprocess.run(["xdg-open", path])` — không dùng `shell=True` nên không có shell injection, nhưng vẫn cho phép mở bất kỳ thư mục nào, và trên Windows `os.startfile()` với một đường dẫn **file** sẽ **thực thi/mở file đó bằng app mặc định**. Kết hợp P2-1 và P2-3 (ghi được file `.bat` vào cache rồi gọi `open_directory` trỏ vào nó) → chuỗi thực thi code từ xa.

---

<a name="p3"></a>
## P3 — Hiệu năng & rò rỉ tài nguyên

### P3-1. Hai tầng cache mask base64, tầng lớn nhất **không giới hạn**

- `useAIEngine.js:49` `maskCacheRef = new Map()` — frame_idx → chuỗi base64. **Không bao giờ evict**, chỉ clear khi đổi video.
- `VideoCanvas.jsx:420-421` `imageCacheRef` — giới hạn 200 `Image`, nhưng **key là chính chuỗi base64** → giữ thêm 200 bản sao chuỗi.

Với video 3.000 frame, mỗi mask PNG ~40-80 KB → base64 ~55-110 KB → **165-330 MB** chỉ riêng `maskCacheRef`, cộng ~20 MB ở `imageCacheRef`. Đây là chuỗi JS trong heap của WebView — tab sẽ chậm dần rồi crash trong phiên làm việc dài.

**Đề xuất:** chuyển sang `ImageBitmap` + `createImageBitmap(blob)` (lưu trong GPU memory, nhẹ hơn nhiều), hoặc đơn giản là **không cache ở client** — mask đã nằm trên đĩa, `get_mask` đọc lại rất nhanh. Nếu vẫn muốn cache, dùng LRU giới hạn ~150 frame quanh vị trí hiện tại.

---

### P3-2. `setTrackedFrames` tạo mảng mới **mỗi frame** trong lúc tracking

**File:** `useAIEngine.js:96-98`
```js
maskCacheRef.current.set(data.frame, data.mask_base64);
setTrackedFrames(Array.from(maskCacheRef.current.keys()));   // O(n) mỗi frame
setMaskImage(data.mask_base64);
```
Frame thứ 3000 → tạo mảng 3000 phần tử → re-render `App` → re-render `TimelineController` → chạy `getContiguousRanges` (sort 3000 phần tử) **× số object**. Tổng chi phí trong một lần track là O(n²·objects). Đây là lý do UI giật dần về cuối quá trình tracking.

**Đề xuất:** cập nhật `trackedFrames` theo throttle (mỗi 250 ms) thay vì mỗi frame; `useMemo` cho ranges.

---

### P3-3. Vòng lặp rAF "marching ants" chạy vĩnh viễn kể cả khi không có gì để vẽ

**File:** `VideoCanvas.jsx:324-336`
```js
useEffect(() => {
  let animId;
  const tick = () => {
    dashOffsetRef.current = (dashOffsetRef.current + 0.5) % 24;
    if (boxesRef.current.length > 0 && !isPlayingRef.current) drawCanvas();
    animId = requestAnimationFrame(tick);        // ← luôn schedule lại
  };
  animId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(animId);
}, [drawCanvas]);
```
Vòng lặp chạy 60 lần/giây **ngay cả khi chưa import video nào**. Trên laptop, đây là wake-up liên tục ngăn CPU vào trạng thái idle sâu → hao pin rõ rệt. Chỉ nên chạy khi `boxesRef.current.length > 0`.

---

### P3-4. `_masks_to_base64` copy thừa một tensor GPU→CPU cho mỗi frame

**File:** `ai_engine.py:289-291`
```python
mask_np = (out_mask_logits[0] > 0.0).cpu().numpy().squeeze()   # chỉ dùng để lấy .shape
h, w = mask_np.shape
rgba = np.zeros((h, w, 4), dtype=np.uint8)
for idx, obj_id in enumerate(out_obj_ids):
    mask = (out_mask_logits[idx] > 0.0).cpu().numpy().squeeze()   # tính lại object 0
```
Object đầu tiên bị tính và chuyển về CPU **hai lần**. Với video 1080p, mỗi lần là ~2 MB đồng bộ hóa GPU. Trên 3000 frame là 3000 lần sync thừa.

**Đề xuất:** lấy shape từ `out_mask_logits.shape[-2:]` (không cần `.cpu()`), hoặc chuyển cả batch một lần: `masks = (out_mask_logits > 0.0).cpu().numpy()`.

---

### P3-5. `torch.autocast(...).__enter__()` gọi mà không có `__exit__` — rò context manager

**File:** `ai_engine.py:68-69`
```python
if torch.cuda.get_device_capability()[0] >= 8:
    torch.autocast("cuda", dtype=torch.bfloat16).__enter__()
```
Bật autocast **toàn cục vĩnh viễn**, không bao giờ thoát. Sau đó code lại lồng thêm `with torch.autocast(...)` ở 4 chỗ khác (`load_video`, `add_point_or_box`, `run_propagation`) — dư thừa và làm stack autocast lồng nhau. Ảnh hưởng: mọi phép toán torch sau đó (kể cả trong MatAnyone) đều chạy bfloat16 ngoài ý muốn, có thể làm giảm độ chính xác alpha matte.

**Đề xuất:** bỏ dòng `__enter__()`; giữ các `with` cục bộ, và gom logic lặp lại thành một context helper:
```python
@contextmanager
def _amp(self):
    if self.device.type == "cuda" and torch.cuda.get_device_capability()[0] >= 8:
        with torch.autocast("cuda", dtype=torch.bfloat16):
            yield
    else:
        yield
```
Việc này cũng xóa được ~60 dòng code trùng lặp trong `run_propagation` (hai nhánh if/else giống hệt nhau chỉ khác cái `with`).

---

### P3-6. Copy toàn bộ frame JPG sang thư mục tạm khi export → nhân đôi dung lượng đĩa

**File:** `ai_engine.py:529-532`
```python
temp_input_dir = video_dir / "matanyone_input"
for f in video_dir.glob("*.jpg"):
    shutil.copy2(f, temp_input_dir / f.name)
```
Video 5 phút @30fps 1080p ≈ 9.000 frame × 150 KB ≈ **1.35 GB**, copy thành 2.7 GB. Chỉ để đưa vào một thư mục có tên khác. Có thể dùng symlink/junction, hoặc truyền thẳng `video_dir` và đặt `suffix` để phân biệt output.

---

### P3-7. `clear_all_cache()` mỗi lần upload → không thể có nhiều project

**File:** `routes.py:66-68`
```python
await run_in_threadpool(CacheManager.clear_all_cache)   # xóa TOÀN BỘ cache_workspace
```
Mở video B sẽ xóa sạch mọi mask đã track của video A. Mâu thuẫn trực tiếp với **FR-01** trong `project_document.md`: *"Người dùng có thể Import video và **lưu/mở lại file Project** để tiếp tục làm việc."* Hiện tại không có khái niệm project, không lưu được gì.

**Đề xuất:** dọn cache theo LRU/tuổi (giữ N session gần nhất hoặc giới hạn tổng dung lượng), thay vì xóa sạch.

---

### P3-8. `URL.createObjectURL` không bao giờ được revoke

**File:** `Toolbar.jsx:14`, `VideoCanvas.jsx:482`, `VideoCanvas.jsx:495`. Mỗi lần import video tạo một blob URL mới; blob cũ (giữ tham chiếu tới **toàn bộ file video trong bộ nhớ**) không được giải phóng. Import 5 video trong một phiên = 5 file video nằm trong RAM của WebView.

**Đề xuất:** lưu URL hiện tại trong ref, `URL.revokeObjectURL(prev)` trước khi tạo mới, và revoke trong cleanup của `useEffect`.

---

### P3-9. Trích xuất frame đơn luồng, không phản hồi tiến độ

**File:** `video_processor.py:58-69`. Vòng `cap.read()` + `cv2.imwrite(quality=95)` tuần tự. Video 5 phút @60fps: đọc 18.000 frame, ghi 9.000 file JPEG chất lượng 95 (~150 KB/file) — mất vài phút, hoàn toàn im lặng (xem P1-10). JPEG q95 hơi dư cho input của SAM 2 (SAM resize về 1024px); q90 giảm ~35% dung lượng và thời gian ghi mà không ảnh hưởng chất lượng mask.

---

<a name="p4"></a>
## P4 — Kiến trúc, chất lượng, tài liệu

### P4-1. Repo "bẩn" hoàn toàn vì thiếu `.gitattributes` (CRLF)

Kiểm tra trên máy bạn:
```
$ git diff --stat
25 files changed, 6913 insertions(+), 6913 deletions(-)

$ git diff --ignore-all-space --stat
1 file changed, 0 insertions(+), 0 deletions(-)
```
**6913 thêm / 6913 xóa mà không có thay đổi nội dung nào** — 100% là chênh lệch CRLF vs LF. Không có file `.gitattributes`, `core.autocrlf` chưa cấu hình.

**Hậu quả:** mọi `git diff`, mọi Pull Request, mọi code review đều vô dụng — bạn không thể nhìn thấy thay đổi thật giữa 6913 dòng nhiễu. Đây là vấn đề nền tảng cần sửa **trước tiên**, vì nó chặn việc review mọi sửa đổi khác.

**Cách sửa:**
```bash
# tạo .gitattributes
* text=auto eol=lf
*.bat text eol=crlf
*.png binary
*.pt binary
*.pth binary
*.exe binary

git add .gitattributes
git add --renormalize .
git commit -m "chore: normalize line endings via .gitattributes"
```

---

### P4-2. Rác trong thư mục làm việc và một quy tắc `.gitignore` gây hiểu lầm

Kiểm tra bằng `git ls-files`: `.agents/` (187 file) và `graphify-out/` (39 file, gồm `graph.html` 275 KB) **đều không được track** — `.gitignore` đang hoạt động đúng với chúng. Đây là rác cục bộ trên đĩa, không phải rác trong repo. Không cần `git rm --cached`, nhưng nên cân nhắc chuyển ra ngoài thư mục dự án vì chúng gây nhiễu khi tìm file (`.agents/` chứa 187 file markdown mô tả agent, dễ lẫn với tài liệu thật của dự án).

Vấn đề thật nằm ở quy tắc `*.spec`:
```gitignore
*.spec
```
nhưng `backend/rotofox-backend.spec` **đang được track** (nó được thêm vào repo trước khi rule ra đời). File `rotofox-backend.spec` ở thư mục gốc thì **không** được track. Kết quả: hai file cùng tên, cùng vai trò, một cái trong git một cái không — và rule `.gitignore` nói rằng cả hai đều bị bỏ qua. Bất kỳ ai sửa file spec ở root sẽ thấy thay đổi của mình biến mất khi commit. Xem thêm P4-3.

Ngoài ra `backend/cache_workspace/video_1784264402/` (288 file, 41 MB) đang tồn tại trên đĩa — rule `backend/cache_workspace/*` có che, nhưng nên có script dọn định kỳ (xem P3-7).

---

### P4-3. File `.spec` hardcode đường dẫn tuyệt đối của máy bạn

**File:** `backend/rotofox-backend.spec`
```python
a = Analysis(
    ['F:\\code\\git\\Smart Mask Local\\backend\\main.py'],
    pathex=['F:\\code\\git\\Smart Mask Local\\backend\\sam2_src'],
    datas=[('F:\\code\\git\\Smart Mask Local\\backend\\sam2_src\\sam2\\configs', 'sam2\\configs')],
```
Không ai khác build được. Đồng thời có **2 file .spec** (root và backend) với vai trò trùng nhau — trong đó chỉ file ở `backend/` được git track (xem P4-2) — và `package_backend.py` lại **không dùng file .spec nào cả**: nó build bằng dòng lệnh CLI với danh sách `--hidden-import` riêng. Ba nguồn sự thật cho cùng một cấu hình đóng gói, chắc chắn sẽ lệch nhau.

Đáng chú ý: bản CLI trong `package_backend.py` **thiếu** `--add-data` cho `sam2/configs` mà file `.spec` có. Nếu `package_backend.py` là đường build chính (như `setup_and_build.bat` gọi), thì bản đóng gói **thiếu file config YAML của SAM 2** → `build_sam2_video_predictor` fail khi chạy. `build_portable.bat` có copy configs thủ công sang `%DIST_DIR%\configs` — nhưng đường dẫn đó không nằm trong nơi Hydra tìm kiếm.

**Đề xuất:** giữ **một** file `.spec` duy nhất, dùng đường dẫn tương đối (`SPECPATH`), và để `package_backend.py` gọi `pyinstaller rotofox-backend.spec`.

---

### P4-4. `setup_and_build.bat` không thể chạy tự động

**File:** `setup_and_build.bat`

1. `cd backend` — dùng đường dẫn **tương đối**, phụ thuộc CWD lúc chạy. Nếu double-click từ Explorer thì OK, nếu chạy từ terminal ở thư mục khác thì fail. (`run_backend.bat` và `run_all.bat` làm đúng với `%~dp0`.)
2. `python scripts\setup_models.py` chứa `input()` (dòng 75) → **script build treo vô thời hạn** chờ người dùng gõ phím. Đây là "Automated Installation Setup & Build" theo README, nhưng thực tế không tự động được.
3. `setup_sam2.py` tải **SAM 2.1 Large 1.2 GB** trước khi người dùng được hỏi (dòng 32-35, có guard `if not WEIGHTS_FILE.exists()` nên không tải lại nếu đã có). Ngay sau đó `setup_models.py` mới hỏi muốn dùng bản nào. Với máy sạch, người dùng chọn Tiny/Small vẫn phải chờ tải xong 1.2 GB bản Large không bao giờ dùng tới. Nên đảo thứ tự: hỏi trước, tải sau.
4. Không có `if errorlevel 1` sau `pip install` / `npm install` → lỗi bị bỏ qua, script chạy tiếp và fail ở bước sau với thông báo khó hiểu.
5. Thông báo cuối chỉ tới `frontend\src-tauri\target\release\` trong khi README nói `...\bundle\nsis\RotoFox_1.0.0_x64-setup.exe`.

---

### P4-5. Nhãn "Required / Recommended" trong Setup Wizard **bị đảo ngược**

**File:** `frontend/src/components/setup/SetupWizard.jsx:74-77, 108, 160-168` và `backend/app/api/routes.py:44`

| Model | UI hiện tại | Thực tế trong code |
|:---|:---|:---|
| MatAnyone 2 | `Required`, nút Continue **bị khóa** cho tới khi tải xong | **Tùy chọn** — `ai_engine.py:516` `use_matanyone = checkpoint.exists()`, không có thì fallback về mask SAM 2 |
| SAM 2.1 | `Recommended`, có nút **"Skip for now"** | **Bắt buộc** — không có SAM thì `predictor is None`, mọi click đều ném `RuntimeError`, ứng dụng vô dụng hoàn toàn |

Backend cũng sai: `routes.py:44` `needs_setup = not matanyone_ready or not sam_ready`.

**Kịch bản hỏng:** người dùng mạng chậm bấm "Skip for now" ở bước SAM, vào app, import video, click → không có gì xảy ra ngoài lỗi trong console. Ngược lại, người dùng chỉ muốn mask thô nhanh vẫn bị ép tải MatAnyone.

**Sai sót phụ:** `SetupWizard.jsx:119` ghi `"VRAM Req: 4 GB · ~600 MB download"`, nhưng file `matanyone2.pth` thật chỉ **135 MB**. Con số 600 MB làm người dùng mạng chậm nản ngay ở bước bắt buộc đầu tiên.

**Đề xuất:** đảo lại — SAM 2.1 là bắt buộc và đưa lên bước 1; MatAnyone là tùy chọn ở bước 2 với nút "Skip". Sửa `needs_setup` ở `routes.py:44` thành `not sam_ready`. Sửa lại con số dung lượng, hoặc tốt hơn: đọc `Content-Length` thật từ registry `MODELS` thay vì hardcode trong JSX.

---

### P4-6. `App.jsx` — 999 dòng, 4 modal inline

**File:** `frontend/src/App.jsx`

Chứa: state toàn cục, 6 `useRef` mirror để tránh stale closure, keyboard handler, polling setup status, **Export modal (185 dòng)**, **Settings modal (88 dòng)**, **Model Hub modal (255 dòng)**, banner cảnh báo, toast. JSX modal chiếm ~55% file.

Dấu hiệu cụ thể của việc state quá tải: 6 cặp `useState` + `useRef` mirror (`currentFrameRef_kb`, `totalFramesRef_kb`, `isTrackingRef_kb`, `videoOffsetFrameRef_kb`, `hasVideoRef_kb`, `isUploadingRef`, `isBackendReadyRef`, `backendFramesCountRef`) chỉ để một `useEffect` với deps rỗng đọc được giá trị mới nhất. Đây là workaround cho việc thiếu `useReducer`/`useEvent`.

**Đề xuất tách:**
```
src/components/modals/ExportModal.jsx
src/components/modals/SettingsModal.jsx
src/components/modals/ModelHubModal.jsx
src/components/layout/MissingModelsBanner.jsx
src/hooks/useKeyboardShortcuts.js
src/state/editorReducer.js       // gom currentFrame/totalFrames/isPlaying/objects
src/config.js                    // BACKEND_URL, WS_URL — hiện hardcode rải rác 4 chỗ
```
Mục tiêu: `App.jsx` xuống dưới 200 dòng.

---

### P4-7. `AIEngine` là singleton toàn cục dùng chung cho mọi kết nối

**File:** `backend/app/api/websockets.py:21` `ai_engine = AIEngine()` (module level), được `routes.py:14` import lại.

`video_id`, `inference_state`, `interaction_frames`, `video_width/height` đều là state chia sẻ. Comment ở dòng 33 (`session_video_id = None  # Per-connection session tracking to avoid contamination`) cho thấy vấn đề đã được nhận biết, nhưng chỉ guard được action `click`.

**Kịch bản hỏng:** mở 2 cửa sổ RotoFox (hoặc mở app + mở `localhost:1420` trên browser để debug) → cả hai dùng chung một `inference_state`. Cửa sổ B import video → `load_video` reset state → cửa sổ A đang track bỗng nhiên track nhầm video của B.

Với kiến trúc single-user desktop thì singleton chấp nhận được — nhưng cần **từ chối kết nối thứ hai** (`websocket.close(1013, "Another editor session is active")`) thay vì im lặng đè lên nhau.

---

### P4-8. `EngineState` singleton nhưng các field không đồng bộ

**File:** `backend/app/core/engine_state.py`

`_lock` chỉ bảo vệ lúc tạo instance. `cancel_requested` được ghi từ **event loop** (`websockets.py:177`) và đọc từ vòng lặp `run_propagation` — hiện tại chạy được nhờ GIL và vì generator của SAM 2 chạy trên event loop thread, nhưng nếu sau này chuyển propagation sang threadpool (nên làm, vì nó đang chặn event loop giữa các frame) thì sẽ thành race condition.

Thêm nữa: `docstring` ghi "Thread-safe Singleton" nhưng không thread-safe ở mức field. Nên dùng `threading.Event` cho `cancel_requested`.

**Vấn đề liên quan quan trọng hơn:** `run_propagation` chạy `self.predictor.propagate_in_video(...)` — một generator **đồng bộ, nặng GPU** — **trực tiếp trên event loop**. `await asyncio.sleep(0.001)` mỗi frame chỉ nhường quyền một khoảnh khắc, nhưng phần tính toán mỗi frame (50-200 ms) hoàn toàn **chặn** event loop → trong suốt quá trình tracking, mọi WebSocket message khác (kể cả `cancel_tracking`) bị xếp hàng chờ. Đó là lý do nút "Stop" phản hồi chậm.

**Đề xuất:** chạy generator trong threadpool và đẩy kết quả qua `asyncio.Queue`.

---

### P4-9. 60+ lệnh `print()` thay vì `logging`

Toàn bộ backend dùng `print()`. Trong bản đóng gói (`console=True` nhưng cửa sổ bị Tauri ẩn), **mọi log biến mất**. Khi người dùng báo lỗi, không có gì để đọc — không log file, không level, không timestamp, không traceback được lưu.

**Đề xuất:** `logging` với `RotatingFileHandler` ghi vào `%LOCALAPPDATA%\RotoFox\logs\backend.log`, và một action WebSocket `get_logs` để UI hiển thị khi có lỗi.

---

### P4-10. Không có test nào, không có CI

0 file test trong toàn bộ dự án. Với một pipeline có nhiều bước biến đổi dữ liệu (logits → mask → PNG → alpha → composite), test là cách duy nhất bắt được các lỗi kiểu P1-1 (alpha 150 thay vì 255) — vốn không gây crash, chỉ cho kết quả sai.

**Đề xuất mức tối thiểu:**
- `test_export_alpha.py`: tạo mask giả 0/255, chạy composite, assert pixel foreground == 255.
- `test_mask_encoding.py`: `_masks_to_base64` với tensor giả → decode → assert shape & màu theo obj_id.
- `test_paths.py`: `video_id` độc hại bị từ chối; `frozen` vs dev cho ra đúng thư mục.
- `test_video_processor.py`: video 3 giây 60fps → assert `frame_count` và `effective_fps` đúng.
- GitHub Actions: `pytest` + `npm run build` + `ruff` trên mỗi push.

---

### P4-11. Hai bản sao vendored của SAM 2

`backend/sam2_src/` (submodule git) và `backend/third_party/segment-anything-2/` là **cùng một repo Meta**, cùng phiên bản, mỗi bản **198 MB** (kể cả notebook 10 MB, video mẫu, dataset SAV). `.gitignore` có `backend/third_party/` nên bản thứ hai không được commit — nhưng nó vẫn chiếm 198 MB đĩa và gây nhầm lẫn khi grep tìm code (mọi kết quả tìm kiếm đều ra 2 lần). Xóa bản `third_party/segment-anything-2/` thu hồi ~198 MB.

---

### P4-12. Phím tắt global không khớp README

README liệt kê `Page Up`, `Page Down`, `Home`, `End` là phím tắt toàn cục. Thực tế:
- `App.jsx:190-219` (handler global) chỉ có: `←`, `→`, `Space`, `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`.
- `PageUp/PageDown/Home/End` chỉ có trong `onKeyDown` của phần tử `#timeline-track` (`TimelineController.jsx:176-196`) → **chỉ hoạt động khi người dùng đã tab/click vào thanh timeline**. Người dùng bình thường bấm Home sẽ không thấy gì xảy ra.

README cũng ghi `Page Up = Jump forward 10 frames` / `Page Down = Jump backward` — trùng khớp với code, nhưng theo quy ước NLE thì thường ngược lại (PageUp = lùi). Nên xem lại.

---

### P4-13. Không có track ngược (backward propagation) dù SAM 2 hỗ trợ sẵn

`sam2_video_predictor.py:546-552` có tham số `reverse=False`. README dòng 146 mô tả: *"propagates (tracks) that mask **forwards/backwards** across the timeline"*. Nhưng `ai_engine.run_propagation` không bao giờ truyền `reverse=True`, và UI chỉ có nút "Track" (forward).

**Hậu quả thực tế:** người dùng click chọn chủ thể ở frame 200 (nơi chủ thể rõ nhất) → track → chỉ có mask từ frame 200 trở đi. Frame 0-199 **không có mask nào** và không có cách nào tạo được ngoài việc quay lại click ở frame 0. Đây là tính năng thiếu ảnh hưởng trực tiếp tới quy trình làm việc thực tế.

---

### P4-14. Tính năng có trong đặc tả nhưng chưa triển khai

| Mã | Yêu cầu (`project_document.md`) | Trạng thái |
|:---|:---|:---|
| FR-01 | Lưu / mở lại file Project | ❌ Không có. Ngược lại, `clear_all_cache()` xóa sạch khi mở video mới (P3-7) |
| FR-02 | Zoom / Pan canvas bằng chuột | ❌ Không có. Canvas cố định `object-contain`, không có transform/wheel handler |
| — | Export ProRes 4444 (.mov) | ❌ Không có (P1-5) |
| — | Export Luma Matte PNG Sequence | ❌ Không có (P1-5) |
| — | Hỗ trợ Linux | ❌ Không có (P0-6) |
| NFR-03 | Triệt tiêu flickering biên mask | ⚠️ Chưa có xử lý temporal smoothing nào |

Với FR-02 (Zoom/Pan): đây là tính năng **thiết yếu** cho rotoscoping — người dùng cần phóng to để chấm điểm chính xác vào sợi tóc. Thiếu nó, sản phẩm không dùng được cho công việc thật ở độ chi tiết mà nó quảng cáo.

---

### P4-15. Vấn đề nhỏ nhưng nên dọn

| # | Vấn đề | File |
|:---|:---|:---|
| a | Cổng 8000 hardcode, không fallback nếu bận → treo 30s rồi báo lỗi | `main.py:43`, `useAIEngine.js:3`, `App.jsx:149,177` |
| b | `document.getElementById('timeline-track')` thay vì `useRef` | `TimelineController.jsx:61` |
| c | Hàm `greet()` mẫu của Tauri vẫn còn | `lib.rs:5-8` |
| d | Import thừa (pyflakes): `os` (`ai_engine.py:11`), `Tuple` (`ai_engine.py:15`), `shutil` (`poc_pipeline.py:7`). Riêng `torch` (`poc_pipeline.py:80`) và `ffmpeg` (`:102`) là **re-import trùng** bên trong hàm — đã import ở đầu file và có dùng | `ai_engine.py`, `poc_pipeline.py` |
| e | `_masks_to_base64` nhận `width`/`height` nhưng **không dùng** | `ai_engine.py:273` |
| f | `run_propagation` có 2 nhánh if/else **giống hệt nhau ~30 dòng**, chỉ khác `with autocast` | `ai_engine.py:360-422` |
| g | Comment tiếng Việt lẫn tiếng Anh trong cùng file (`useAIEngine.js:18`, `MainLayout.jsx:6,21`, `index.css:13`) | nhiều file |
| h | Comment kiểu `// BUG-03 FIX`, `// ISSUE-11 FIX`, `// IMPROVE-05 FIX` — lịch sử sửa lỗi nên nằm ở git log, không phải trong code | `useAIEngine.js`, `VideoCanvas.jsx`, `App.jsx` |
| i | Font Google Fonts qua `@import` → gọi mạng dù app "offline" | `index.css:1` |
| j | `LICENSE` được README tham chiếu nhưng **file không tồn tại** ở root | `README.md:327` |
| k | `console.log("WS Received:", data)` in **mọi** message kể cả base64 mask → DevTools console ngập và chậm | `useAIEngine.js:87` |

---

<a name="gap"></a>
## Khoảng cách giữa tài liệu và code — tóm tắt

Tài liệu (README + `project_document.md`) mô tả một sản phẩm hoàn chỉnh hơn code hiện tại khá nhiều. Các cam kết **không đúng với code**:

| Cam kết | Thực tế |
|:---|:---|
| "Zero external API calls, works fully offline" | MatAnyone tải model 135 MB từ GitHub mỗi lần export (P0-2); font tải từ Google Fonts mỗi lần khởi động (P2-5) |
| "Export ProRes 4444 / Luma Matte Sequence" | Chỉ có MP4/WebM không alpha (P1-5) |
| "Windows 10/11 or Ubuntu Linux" | Windows-only (P0-6) |
| "up to 7 concurrent color-coded mask layers" | Có ở UI, nhưng MatAnyone chỉ refine 1 object (P1-3), timeline hiển thị giống nhau (P1-9) |
| "propagate forwards/backwards" | Chỉ forward (P4-13) |
| "Page Up/Down, Home/End" là phím tắt | Chỉ hoạt động khi focus vào timeline (P4-12) |
| "one-time setup, MatAnyone required" | MatAnyone thực ra tùy chọn, SAM mới bắt buộc (P4-5) |
| FR-01 lưu/mở project, FR-02 Zoom/Pan | Chưa có (P4-14) |

**Khuyến nghị:** cùng với việc sửa code, cập nhật tài liệu để phản ánh đúng trạng thái, hoặc chuyển các mục chưa làm sang phần "Roadmap". Một README hứa quá lời sẽ tạo ấn tượng xấu hơn một README trung thực có roadmap rõ ràng.

---
---

<a name="plan"></a>
# KẾ HOẠCH TRIỂN KHAI

Nguyên tắc sắp xếp: **sửa cái chặn việc review trước → sửa cái làm ứng dụng không chạy được → sửa cái cho kết quả sai → vá bảo mật → tối ưu → refactor**. Mỗi phase kết thúc bằng một commit sạch có thể kiểm chứng.

Ước lượng theo "ngày công" (1 người, ~6 giờ tập trung/ngày).

---

## Phase 0 — Dọn nền để có thể review (0,5 ngày) 🔴 làm trước mọi thứ

Không sửa được gì có ý nghĩa khi `git diff` cho ra 6913 dòng nhiễu.

| # | Việc | File | Ước lượng |
|:---|:---|:---|:---|
| 0.1 | Tạo `.gitattributes`, chạy `git add --renormalize .`, commit riêng | root | 30 ph |
| 0.2 | Quyết định số phận `.agents/`, `graphify-out/`, `*.spec` trong `.gitignore` — hoặc `git rm --cached` hoặc bỏ rule | `.gitignore` | 30 ph |
| 0.3 | Xóa `backend/third_party/segment-anything-2/` (trùng với `sam2_src`) | — | 15 ph |
| 0.4 | Thêm `LICENSE` (MIT) mà README đang trỏ tới | root | 10 ph |
| 0.5 | Tạo branch `fix/audit-p0` để làm các phase sau | — | 5 ph |

**Nghiệm thu:** `git diff --stat` trên working tree sạch trả về 0 file. `git status` gọn.

---

## Phase 1 — Làm cho ứng dụng chạy được từ đầu (2 ngày) 🔴

Mục tiêu: người lạ clone repo → làm theo README → dùng được, không cần bạn hỗ trợ.

| # | Việc | Vấn đề | File | Ước lượng |
|:---|:---|:---|:---|:---|
| 1.1 | Bổ sung + pin `requirements.txt`; thêm index URL CUDA; tách `requirements-dev.txt` | P0-1 | `backend/requirements.txt` | 2 h |
| 1.2 | Tạo `app/core/paths.py` (`app_data_dir()`, `cache_dir()`, `logs_dir()`); sửa `cache_manager` dùng nó | P0-7 | `cache_manager.py` mới `paths.py` | 2 h |
| 1.3 | Chuyển sidecar sang API Tauri chính thức (`ShellExt::sidecar`), giữ `CommandChild`, kill ở `RunEvent::Exit`; đọc stdout ra log | P0-5, P0-6 | `lib.rs` | 4 h |
| 1.4 | Reload SAM 2 + `init_state` trong `finally` của `run_export`; phát message `engine_reloading` cho UI | P0-4 | `ai_engine.py`, `useAIEngine.js` | 3 h |
| 1.5 | Viết `app/services/matting_engine.py` gọi trực tiếp `InferenceCore`, dùng đúng `ckpt_path` local, không gọi mạng | P0-2 | file mới | 5 h |
| 1.6 | **Sửa đọc mask: xử lý ảnh 1 kênh (`m.ndim == 2`) trước khi gọi `cvtColor`** + luôn resize mask về kích thước frame trước composite + thêm `writer.isOpened()` check | P0-3, P1-4 | `ai_engine.py:604-616` | 2 h |
| 1.7 | Sửa `setup_and_build.bat`: `%~dp0`, thêm flag `--non-interactive` cho `setup_models.py`, kiểm `errorlevel`, bỏ tải trùng SAM Large trong `setup_sam2.py` | P4-4 | `.bat`, `setup_*.py` | 3 h |
| 1.8 | Hợp nhất về **một** `.spec` dùng đường dẫn tương đối; `package_backend.py` gọi spec đó; verify `sam2/configs` có trong bundle | P4-3 | `.spec`, `package_backend.py` | 3 h |

**Nghiệm thu:**
- Trên máy sạch (VM Windows mới): clone → `setup_and_build.bat` chạy hết không cần gõ phím → cài .exe → import video → click → thấy mask.
- Đóng app → Task Manager **không còn** `rotofox-backend.exe`.
- Ngắt mạng → export vẫn chạy được với MatAnyone (dùng checkpoint local).
- Export "original resolution" + MatAnyone → ra file hợp lệ, không exception.

---

## Phase 2 — Sửa các lỗi cho kết quả sai (2,5 ngày) 🟠

Mục tiêu: cái người dùng xuất ra phải đúng.

| # | Việc | Vấn đề | File | Ước lượng |
|:---|:---|:---|:---|:---|
| 2.1 | Tách lưu trữ: `masks/` (overlay màu, cho UI) và `alpha/` (grayscale 0/255, cho export). Export đọc `alpha/` | P1-1 | `ai_engine.py` | 4 h |
| 2.2 | Sửa `remove_object` — đọc đúng list tuple `(frame_idx, masks)` | P1-2 | `ai_engine.py:450` | 30 ph |
| 2.3 | MatAnyone: dùng mask nhị phân từ `alpha/`, chọn frame khởi tạo = `min(interaction_frames)`, chạy lặp cho từng `obj_id` rồi hợp nhất | P1-3 | `matting_engine.py` | 6 h |
| 2.4 | Thêm export **PNG Luma Matte Sequence** (dễ nhất, giá trị cao nhất) | P1-5 | `ai_engine.py`, `ExportModal` | 3 h |
| 2.5 | Thêm export **ProRes 4444 có alpha** qua FFmpeg; bundle `ffmpeg.exe` vào bản portable | P1-5 | `ai_engine.py`, `build_portable.bat` | 6 h |
| 2.6 | Guard chống chạy chồng cho `track_forward` / `export` (`asyncio.Lock` + kiểm tra state) | P1-6 | `websockets.py` | 2 h |
| 2.7 | Tải model atomic (`.part` → `os.replace`), verify size/sha256, thêm nút Cancel, throttle progress | P1-7, P3-… | `model_manager.py`, `ModelHubModal` | 5 h |
| 2.8 | Sửa off-by-one toàn timeline (`totalFrames - 1`) | P1-8 | `TimelineController.jsx`, `App.jsx` | 1,5 h |
| 2.9 | Backend gửi `obj_ids` kèm message tracking; frontend lưu `Map<objId, Set<frame>>`; timeline hiển thị đúng từng object | P1-9 | `ai_engine.py`, `useAIEngine.js`, `TimelineController.jsx` | 4 h |
| 2.10 | Tiến độ upload/extract thật (`XHR.upload.onprogress` + callback từ `extract_frames`) | P1-10 | `video_processor.py`, `useAIEngine.js`, `VideoCanvas.jsx` | 4 h |

**Nghiệm thu:**
- Export Alpha Matte → mở trong Photoshop, pixel foreground = 255 tuyệt đối.
- Export ProRes 4444 → import vào Premiere/AE, kênh alpha nhận được, nền trong suốt.
- Track 3 object → 3 dải khác nhau trên timeline; xóa object 2 → mask biến mất ngay lập tức.
- Bấm Track 5 lần liên tiếp → chỉ 1 tiến trình chạy, 4 lần sau nhận thông báo.
- Ngắt mạng giữa lúc tải model → file `.part` bị xóa, UI vẫn hiện nút "Download".

---

## Phase 3 — Bảo mật (1 ngày) 🟡

| # | Việc | Vấn đề | File | Ước lượng |
|:---|:---|:---|:---|:---|
| 3.1 | Token xác thực: backend sinh token khi start, ghi ra `app_data_dir()/session.token`; Tauri đọc và inject qua `window.__ROTOFOX_TOKEN__`; WebSocket từ chối nếu sai | P2-1 | `main.py`, `websockets.py`, `lib.rs`, `useAIEngine.js` | 4 h |
| 3.2 | Kiểm `Origin` header ở WebSocket; whitelist CORS về `tauri://localhost` + `http://localhost:1420` | P2-1, P2-2 | `main.py`, `websockets.py` | 1,5 h |
| 3.3 | Sanitize: `video_id` theo regex, tên file upload dùng tên cố định, whitelist thư mục cho `export_path` và `open_directory` | P2-3, P2-6 | `routes.py`, `websockets.py`, `cache_manager.py` | 2,5 h |
| 3.4 | Upload theo stream (`shutil.copyfileobj`), thêm giới hạn dung lượng | P2-4 | `routes.py` | 1 h |
| 3.5 | Bật CSP trong `tauri.conf.json`; self-host font Inter | P2-5 | `tauri.conf.json`, `index.css`, `public/` | 1,5 h |

**Nghiệm thu:** mở tab browser bất kỳ chạy `new WebSocket('ws://127.0.0.1:8000/ws/editor')` → bị đóng với code 1008. Upload file tên `../../evil.txt` → lưu thành `source.txt` trong cache dir.

---

## Phase 4 — Hiệu năng & ổn định phiên dài (1,5 ngày) 🟢

| # | Việc | Vấn đề | File | Ước lượng |
|:---|:---|:---|:---|:---|
| 4.1 | Bỏ cache base64 phía client, chuyển sang `ImageBitmap` + LRU 150 frame; revoke blob URL | P3-1, P3-8 | `useAIEngine.js`, `VideoCanvas.jsx` | 5 h |
| 4.2 | Throttle `setTrackedFrames` (250 ms); `useMemo` cho `getContiguousRanges` | P3-2 | `useAIEngine.js`, `TimelineController.jsx` | 2 h |
| 4.3 | rAF marching-ants chỉ chạy khi có box | P3-3 | `VideoCanvas.jsx` | 30 ph |
| 4.4 | Bỏ `autocast().__enter__()`; gom thành context helper `_amp()`; hợp nhất 2 nhánh trùng lặp trong `run_propagation` | P3-5, P4-15f | `ai_engine.py` | 3 h |
| 4.5 | Bỏ copy thừa GPU→CPU trong `_masks_to_base64`; bỏ tham số width/height không dùng | P3-4, P4-15e | `ai_engine.py` | 1 h |
| 4.6 | Chạy `propagate_in_video` trong threadpool + `asyncio.Queue` → nút Stop phản hồi tức thì | P4-8 | `ai_engine.py` | 4 h |
| 4.7 | Dùng symlink/junction thay copy cho `matanyone_input`; JPEG quality 90 | P3-6, P3-9 | `ai_engine.py`, `video_processor.py` | 2 h |
| 4.8 | Dọn cache theo LRU (giữ 3 session gần nhất) thay vì `clear_all_cache()` | P3-7 | `cache_manager.py`, `routes.py` | 2 h |

**Nghiệm thu:** track video 3.000 frame → RAM của WebView tăng dưới 150 MB (đo bằng Task Manager); UI không giật ở frame 2.900 như frame 100; bấm Stop dừng trong dưới 300 ms.

---

## Phase 5 — Kiến trúc, chất lượng, tài liệu (2,5 ngày) 🔵

| # | Việc | Vấn đề | Ước lượng |
|:---|:---|:---|:---|
| 5.1 | Tách `App.jsx`: 3 modal + banner + `useKeyboardShortcuts` + `config.js`. Mục tiêu < 200 dòng | P4-6 | 6 h |
| 5.2 | Thay toàn bộ `print()` bằng `logging` + `RotatingFileHandler` vào `logs_dir()`; thêm action `get_logs` | P4-9 | 3 h |
| 5.3 | Từ chối kết nối WebSocket thứ hai với code 1013 | P4-7 | 1 h |
| 5.4 | `threading.Event` cho `cancel_requested` | P4-8 | 1 h |
| 5.5 | Đảo lại nhãn Required/Recommended trong SetupWizard + `needs_setup` ở backend; đưa SAM lên bước 1 | P4-5 | 2 h |
| 5.6 | Đưa `PageUp/PageDown/Home/End` vào handler global | P4-12 | 1 h |
| 5.7 | Viết bộ test tối thiểu (5 file như liệt kê ở P4-10) + GitHub Actions | P4-10 | 6 h |
| 5.8 | Dọn: import thừa, `greet()`, comment `// BUG-xx FIX`, `console.log` mask, thống nhất ngôn ngữ comment | P4-15 | 2 h |
| 5.9 | Cập nhật README + `project_document.md` cho khớp thực tế; chuyển mục chưa làm sang Roadmap | Gap | 3 h |

---

## Phase 6 — Tính năng còn thiếu theo đặc tả (4-6 ngày) ⚪ tùy ưu tiên sản phẩm

Xếp theo giá trị cho người dùng thật:

| # | Tính năng | Vì sao quan trọng | Ước lượng |
|:---|:---|:---|:---|
| 6.1 | **Track ngược (`reverse=True`)** | Người dùng luôn muốn click ở frame đẹp nhất (giữa video) rồi track cả hai chiều. Thiếu nó là thiếu một nửa quy trình. SAM 2 đã hỗ trợ sẵn — chỉ cần thêm tham số + nút UI | 0,5 ngày |
| 6.2 | **Zoom / Pan canvas (FR-02)** | Không phóng to được thì không chấm điểm chính xác được — cản trở trực tiếp mục đích của sản phẩm | 1,5 ngày |
| 6.3 | **Cổng động + service discovery** | Bỏ hardcode 8000: backend bind port 0, ghi port ra file, Tauri đọc và inject. Xóa hẳn lớp lỗi "port đang bận" | 0,5 ngày |
| 6.4 | **Lưu / Mở Project (FR-01)** | Cho phép quay lại công việc dở dang. Cần định dạng `.rotofox` (JSON metadata + thư mục mask) | 2 ngày |
| 6.5 | **Temporal smoothing chống flicker (NFR-03)** | Chất lượng đầu ra chuyên nghiệp; có thể làm đơn giản bằng morphological open/close + trung bình trượt alpha 3 frame | 1 ngày |

---

## Tóm tắt lộ trình

| Phase | Nội dung | Thời gian | Ưu tiên |
|:---|:---|:---|:---|
| 0 | Dọn nền (`.gitattributes`) | 0,5 ngày | 🔴 Bắt buộc trước |
| 1 | Chạy được từ đầu | 2 ngày | 🔴 Bắt buộc |
| 2 | Kết quả xuất ra đúng | 2,5 ngày | 🟠 Cao |
| 3 | Bảo mật | 1 ngày | 🟡 Cao (app phân phối cho người khác) |
| 4 | Hiệu năng, phiên dài | 1,5 ngày | 🟢 Trung bình |
| 5 | Kiến trúc, test, tài liệu | 2,5 ngày | 🔵 Trung bình |
| 6 | Tính năng còn thiếu | 4-6 ngày | ⚪ Theo ưu tiên sản phẩm |
| | **Tổng (Phase 0-5)** | **~10 ngày công** | |
| | **Tổng (kèm Phase 6)** | **~15 ngày công** | |

### Nếu chỉ có 1 ngày

Làm đúng 5 việc này, giá trị/công sức cao nhất:

1. **Phase 0.1** — `.gitattributes` (30 phút) → mọi việc sau đó mới review được.
2. **P0-3** — thêm nhánh `if m.ndim == 2: mask = m` trước `cvtColor` (**10 phút**) → export với MatAnyone chạy được lần đầu tiên. Đây là tỉ lệ giá trị/công sức cao nhất trong toàn bộ báo cáo.
3. **P0-1** — bổ sung `requirements.txt` (30 phút) → dự án cài được trên máy sạch.
4. **P1-2** — sửa `isinstance(dict)` thành duyệt list (5 phút) → xóa object hoạt động trở lại.
5. **P0-5** — kill sidecar khi thoát (2 giờ) → hết tiến trình mồ côi, hết lỗi kẹt cổng 8000.

(Nếu còn thời gian: **P1-1** alpha 255 thay vì 150, ~1 giờ → file matte xuất ra dùng được thật trong Premiere/AE.)

---

<a name="verify"></a>
## Ghi chú về cách xác minh

Báo cáo này đã qua **hai vòng**: một vòng đọc code, và một vòng phản biện độc lập với nhiệm vụ *bác bỏ* từng phát hiện. Vòng phản biện đã loại bỏ 3 phát hiện sai và sửa 10 chi tiết — những nội dung dưới đây là phần đã sống sót.

**Đã xác minh trực tiếp trên source code, kèm số dòng chính xác:**

- `updated_frames` là list tuple, và trả list rỗng khi xóa object cuối: `sam2_src/sam2/sam2_video_predictor.py:873, 884-886, 952, 954`
- `propagate_in_video` có tham số `reverse=False`: `sam2_video_predictor.py:546-552`; `ai_engine.py:362, 393` không bao giờ truyền `reverse`
- MatAnyone ghi đè `ckpt_path` vô điều kiện: `third_party/MatAnyone2/inference_matanyone2.py:29`
- MatAnyone ghi PNG **1 kênh**: `inference_matanyone2.py:110, 121`; resize theo `max_size`: `:49-56`
- MatAnyone nhị phân hóa mask đầu vào: `matanyone2/utils/inference_utils.py:45`; `objects = [1]` cố định: `inference_matanyone2.py:73, 98`
- CRLF churn: `git diff --stat` = **6913 thêm / 6913 xóa**, `git diff --ignore-all-space --stat` = 0 dòng
- Trạng thái git thật: `git ls-files` xác nhận `.agents/` (187 file) và `graphify-out/` (39 file) **không** được track; chỉ `backend/rotofox-backend.spec` được track
- Không có file `LICENSE`: `find -maxdepth 2 -iname "LICENSE*"` không trả kết quả nào ở thư mục gốc
- Import thừa: `pyflakes`
- `App.jsx` đúng 999 dòng; `ffmpeg` chỉ xuất hiện ở `scripts/poc_pipeline.py`, không có trong `backend/`
- Kích thước: `sam2_src` = 198 MB, `third_party/segment-anything-2` = 198 MB, `matanyone2.pth` = 135 MB, cache 288 file = 41 MB

**Đã kiểm chứng bằng thực nghiệm:**

- P0-3: chạy thật OpenCV 4.13 với ảnh grayscale 1 kênh → `cv2.error: (-15:Bad number of channels) Source image must have 3 or 4 channels in function 'cvtColor'`. Đây là lý do P0-3 được nâng từ "shape mismatch có điều kiện" lên "crash 100% ở frame đầu tiên".

**Các phát hiện trong bản nháp đã bị LOẠI vì sai:**

| Phát hiện bị loại | Vì sao sai |
|:---|:---|
| "Chất lượng refinement phụ thuộc vào màu gán cho object" | `gen_dilate` nhị phân hóa mọi giá trị khác 0 trước khi mask tới model → màu không ảnh hưởng. Đã thay bằng phát hiện đúng: 7 object bị **gộp thành một khối** (P1-3) |
| "`.agents/` và `graphify-out/` đã bị track từ trước" | `git ls-files` cho thấy 0 file được track. `.gitignore` đang hoạt động đúng. Đã viết lại P4-2 |
| "`systemInfo.recommended_model.toUpperCase()` sẽ ném nếu backend trả null" | `useAIEngine.js:30` khởi tạo `'tiny'`, và `model_manager.py:154` đặt `recommended_model = "tiny"` làm mặc định vô điều kiện — mọi nhánh chỉ ghi đè bằng chuỗi khác. Không bao giờ null |

**Điểm duy nhất còn chưa kiểm chứng thực tế:** tính tương thích NumPy 2.x với bản SAM 2 đang vendored. Đề xuất `numpy<2.0` trong P0-1 là **phòng ngừa** — nên thử `pip install numpy>=2` trên môi trường sạch và chạy thử một lần track trước khi quyết định pin.
