# ĐẶC TẢ DỰ ÁN: SMARTMASK LOCAL

**Hệ thống tự động tách nền và tạo Mặt nạ Video bằng AI chạy cục bộ**

---

## 1. PHẠM VI DỰ ÁN (PROJECT SCOPE)

### 1.1. Mục tiêu (Goal)

Xây dựng một ứng dụng Desktop chạy hoàn toàn ngoại tuyến (**Offline / Local**), cho phép các nhà làm phim và editor tự động hóa quy trình Rotoscope (cắt mặt nạ video). Người dùng chỉ cần tương tác bằng chuột ở một vài khung hình chính, AI sẽ tự động tính toán, bám đuổi vật thể và tách nền mượt mà đến từng sợi tóc.

### 1.2. Giới hạn dự án (In-Scope)

* **Hệ điều hành:** Hỗ trợ Windows và Linux (tối ưu hóa tối đa cho phần cứng PC cá nhân).
* **Lõi xử lý AI (Hybrid Core):**
  * **SAM 2 (Segment Anything Model 2):** Phụ trách việc định hình hình dáng và bám đuổi vật thể (Tracking/Propagation) qua các khung hình dựa trên điểm click chuột.
  * **MatAnyone 2:** Phụ trách tinh chỉnh viền (Refinement), xử lý các chi tiết siêu nhỏ như tóc, khói, hiệu ứng nhòe chuyển động (Motion blur) để tạo ra lớp Alpha Matte mịn màng.
* **Tính năng tương tác:** Cơ chế Point-and-Click (Chuột trái lấy vùng, Chuột phải xóa vùng thừa), dòng thời gian (Timeline) cho phép can thiệp sửa lỗi cục bộ (Keyframe correction).
* **Xuất bản dữ liệu (Export):** Xuất video giữ nguyên độ phân giải gốc dưới dạng Video Alpha Channel (`.mov` ProRes 4444) hoặc chuỗi ảnh đen trắng (Luma Matte Sequence).

### 1.3. Ngoài phạm vi (Out-of-Scope)

* Không xử lý trên Điện toán đám mây (Cloud) để đảm bảo tuyệt đối bảo mật dữ liệu.
* Không tích hợp các công cụ dựng phim chuyên sâu (như chỉnh màu, cắt ghép âm thanh).

---

## 2. YÊU CẦU HỆ THỐNG (PROJECT REQUIREMENTS)

### 2.1. Yêu cầu chức năng (Functional Requirements)

* **FR-01 (Quản lý File):** Người dùng có thể Import video (`.mp4`, `.mov`) và lưu/mở lại file Project để tiếp tục làm việc.
* **FR-02 (Canvas tương tác trực quan):** Trình xem video hỗ trợ Phóng to/Thu nhỏ (Zoom/Pan) bằng chuột để chấm điểm chính xác.
* **FR-03 (Tương tác Trợ lý AI):** Khi người dùng click chuột lên Canvas, AI phải phản hồi và vẽ lớp phủ (Mask Overlay) thời gian thực tại Frame đó.
* **FR-04 (Bám đuổi Video - Propagation):** Nút kích hoạt AI tự động chạy tuyến tính để tạo mask cho toàn bộ video.
* **FR-05 (Sửa lỗi Dòng thời gian):** Khi người dùng sửa đổi Mask tại Frame $N$, hệ thống phải tự động cập nhật lại các Frame phía sau ($N+1, N+2...$) dựa trên dữ liệu mới.

### 2.2. Yêu cầu phi chức năng (Non-Functional Requirements)

* **NFR-01 (Tối ưu phần cứng Local):** Chạy mượt mà trên card đồ họa phổ thông (VRAM từ 6GB đến 8GB). Sử dụng các bản model thu gọn (Tiny/Small) khi chạy cấu hình thấp.
* **NFR-02 (Tốc độ xử lý):** Tốc độ phân tích vật thể (Inference) đạt tối thiểu $10 - 15 \text{ FPS}$ trên cấu hình khuyến nghị.
* **NFR-03 (Tính nhất quán - Temporal Consistency):** Triệt tiêu hiện tượng "nhấp nháy" (flickering) biên độ mặt nạ giữa các khung hình liên tiếp.
* **NFR-04 (Trải nghiệm ứng dụng):** Tiến trình AI chạy ngầm không được gây nghẽn luồng xử lý giao diện (UI Thread).

---

## 3. THIẾT KẾ HỆ THỐNG (PROJECT DESIGN)

### 3.1. Kiến trúc phân tầng (Architecture Layers)

Ứng dụng sử dụng mô hình **Kiến trúc lai cục bộ (Local Hybrid Architecture)**. Phần Giao diện (Frontend) kết nối với Lõi AI (Backend) thông qua giao thức **Local WebSockets / IPC** để truyền tải tọa độ và hình ảnh real-time.

```
+-----------------------------------------------------------------+
|                     FRONTEND UI (React + Vite)                  |
|  - Chạy trên Electron hoặc Tauri (Tạo Desktop App)              |
|  - Canvas Player: Vẽ các điểm Prompt (X,Y) và phủ lớp Mask màu  |
|  - Timeline Controller: Quản lý vị trí Frame và Keyframe        |
+-----------------------------------------------------------------+
                                │ ▲
               Gửi Tọa độ Click │ │ Trả về ma trận Mask (PNG/Base64)
              & Lệnh điều khiển │ │ và Tiến độ xử lý (% Progress)
                                ▼ │
+-----------------------------------------------------------------+
|               BACKEND AI CORE (Python FastAPI Engine)           |
|  - OpenCV & FFmpeg: Rã video thành Frame chuỗi, quản lý bộ đệm  |
|  - SAM 2 Predictor: Tiếp nhận Click -> Tạo & Đuổi Mask Vector   |
|  - MatAnyone 2 Core: Tinh chỉnh rìa tóc & Làm mịn Alpha Matte   |
+-----------------------------------------------------------------+
                                │ ▲
                     Đọc / Ghi  │ │ Đẩy Tensor tính toán
                   Frame Cache  ▼ │ qua CUDA / TensorRT
                +------------------------------------+
                |  SSD Local Cache  │  GPU (CUDA)    |
                +------------------------------------+
```

### 3.2. Luồng xử lý dữ liệu (Data Flow)

1. **Trích xuất Video thành Frame:** Khi Import Video, Backend dùng OpenCV bóc tách video thành các file ảnh Frame riêng lẻ lưu vào thư mục Cache tạm thời trên SSD, giúp tối ưu hóa tốc độ đọc ngẫu nhiên (Random Access) khi người dùng kéo Timeline qua lại.
2. **Tạo Embedding & Nhận diện Vật thể:** Khi dừng ở 1 frame, SAM 2 Image Encoder mã hóa frame đó thành dạng Feature Embedding. Khi người dùng click chuột, tọa độ được gửi xuống Backend để SAM 2 Decoder tính toán ra vùng chứa vật thể (Binary Mask) ngay lập tức.
3. **Lan truyền Mặt nạ (Propagation):** Người dùng bấm nút "Track". Trình `Video Predictor` của SAM 2 sẽ kích hoạt, truyền trạng thái bộ nhớ (Memory Bank) từ frame hiện tại sang các frame kế tiếp để tự động giữ mặt nạ bám theo chuyển động của vật thể.
4. **Làm mịn và Tách viền (Matting):** Các chuỗi Mặt nạ thô từ SAM 2 được đẩy qua mô hình **MatAnyone 2**. Tại đây, AI sẽ đối chiếu ảnh gốc với mặt nạ thô để tính toán giá trị độ mờ (Alpha values) cho vùng rìa, tách chính xác các chi tiết siêu nhỏ (tóc bay, chuyển động nhòe).
5. **Đóng gói Sản phẩm Đầu ra:** Mặt nạ hoàn chỉnh sau tinh chỉnh được FFmpeg đọc lên, áp thành kênh Alpha đè lên video gốc để xuất ra định dạng trong suốt `.mov` (ProRes 4444) hoặc chuỗi ảnh Luma Matte theo yêu cầu của Editor.

### 3.3. Thiết kế giao diện (UI Wireframe Layout)

Giao diện được phân chia khoa học nhằm mang lại trải nghiệm tiện lợi nhất cho một Editor:

```
+-----------------------------------------------------------------------+
|  Menu: Dự Án | Cấu Hình Model AI (SAM2-Tiny | SAM2-Small) | Trợ Giúp   |
+-----------------------------------+-----------------------------------+
|                                   |  [BẢNG CÔNG CỤ AI]                |
|                                   |  [*] Chọn Vật Thể (Chấm Điểm)     |
|          CANVAS VIEW              |  [+] Thêm vùng  [-] Xóa vùng      |
|                                   |  Layer: [Mask Người] [Mask Xe]    |
|    (Hiển thị Video gốc            |-----------------------------------|
|     + Điểm click xanh/đỏ          |  [ĐIỀU KHIỂN TRACKING]            |
|     + Lớp màu Mask mờ đè lên)     |  [◀ Track Ngược]  [Track Vượt ▶]  |
|                                   |-----------------------------------|
|                                   |  [CẤU HÌNH EXPORT]                |
|                                   |  - Định dạng: ProRes 4444 (.mov)  |
|                                   |  - [ XUẤT VIDEO TRONG SUỐT ]      |
+-----------------------------------+-----------------------------------+
|  TIMELINE CONTROLLER:                                                 |
|  [ ⏩ Play ] [00:02:15] [|||||||||||||||||▮||||||||||||||||||||||||] |
|  (Biểu tượng ▮ đánh dấu Keyframe nơi người dùng đã click để sửa lỗi)  |
+-----------------------------------------------------------------------+
```

---

## 4. CÔNG NGHỆ SỬ DỤNG (TECHNOLOGY STACK)

Để đáp ứng được kiến trúc lai (Hybrid Architecture) và yêu cầu khắt khe về tối ưu hóa phần cứng cục bộ, dự án sẽ sử dụng các công nghệ sau:

### 4.1. Core AI & Xử lý Dữ liệu (Backend)
* **Ngôn ngữ lập trình:** Python 3.10+
* **Framework giao tiếp:** **FastAPI** (Hỗ trợ xử lý bất đồng bộ Async và WebSockets thời gian thực với độ trễ cực thấp).
* **AI Models:**
  * **SAM 2 (Segment Anything 2 - Meta):** Nhân cốt lõi để nhận diện vật thể và tracking qua các frame (Sử dụng các biến thể: `sam2_hiera_tiny`, `sam2_hiera_small` để tối ưu VRAM).
  * **MatAnyone 2:** Tích hợp quy trình xử lý Matting, nhận đầu vào là Trimap/Mask thô từ SAM 2 để tạo ra lớp Alpha Matte siêu thực.
* **Xử lý Đồ họa & Video:** 
  * **OpenCV:** Đọc/ghi hình ảnh ma trận, xử lý mask nhị phân (Binary Mask) và Morphological operations (Dilation/Erosion).
  * **FFmpeg / PyAV:** Rã video gốc thành chuỗi frame không nén và ghép ngược thành định dạng Video Alpha (`.mov` ProRes 4444 hoặc `.webm`).
* **Tính toán phần cứng:** **PyTorch** kết hợp với **CUDA Toolkit** & **TensorRT** (NVIDIA) để tăng tốc độ xử lý trực tiếp trên GPU.

### 4.2. Giao diện Người dùng (Frontend & Desktop App)
* **Framework UI:** **React.js** kết hợp với **Vite** (Build cực nhanh) và **Tailwind CSS** (Tạo giao diện Editor tối màu chuyên nghiệp).
* **Desktop Wrapper:** **Tauri** (ưu tiên) hoặc **Electron**. Tauri sử dụng backend Rust giúp file cài đặt nhẹ hơn, tiêu thụ ít RAM hơn so với Electron, nhường tối đa tài nguyên hệ thống cho AI Core.
* **Thành phần tương tác (Canvas):** Sử dụng HTML5 `<canvas>` API hoặc **Fabric.js** để vẽ các điểm tương tác (Points), hình chữ nhật (Bounding Box) và render lớp mask phủ (Overlay) thời gian thực không gây lag.

---

## 5. LỘ TRÌNH PHÁT TRIỂN (DEVELOPMENT ROADMAP)

Dự án được chia làm 4 giai đoạn chính (Phát triển theo mô hình Agile/Scrum):

### Giai đoạn 1: Lõi AI & Chứng minh khả thi (Proof of Concept - PoC)
* **Mục tiêu:** Kiểm chứng chất lượng đầu ra của pipeline SAM 2 + MatAnyone 2.
* **Công việc:**
  * Khởi tạo môi trường ảo Python.
  * Tích hợp thành công SAM 2 Video Predictor: Đưa 1 điểm click tọa độ (X, Y) vào frame đầu tiên, xuất ra chuỗi mask thô cho toàn video.
  * Đưa mask thô qua MatAnyone 2 để xử lý chi tiết tóc/viền.
  * Viết script đóng gói kết quả thành video `.mov` trong suốt.

### Giai đoạn 2: Xây dựng Backend Engine & Tối ưu hóa (Optimization)
* **Mục tiêu:** Sẵn sàng kết nối với giao diện và giải quyết bài toán phần cứng.
* **Công việc:**
  * Xây dựng API Server với FastAPI, mở cổng WebSockets.
  * Lập trình hệ thống quản lý Cache ảnh tạm thời trên ổ cứng SSD nội bộ.
  * Tối ưu hóa bộ nhớ: Tự động dọn dẹp RAM/VRAM các frame đã xử lý xong.
  * Xây dựng cơ chế hủy/dừng (Interrupt) tiến trình AI an toàn giữa chừng.

### Giai đoạn 3: Phát triển Frontend Giao diện Editor
* **Mục tiêu:** Xây dựng ứng dụng hoàn chỉnh có thể tương tác.
* **Công việc:**
  * Dựng Layout (Canvas hiển thị, Thanh công cụ AI, Cấu hình Render).
  * Phát triển Timeline Controller (Kéo thả Playhead, hiển thị track mask).
  * Ghép nối luồng dữ liệu: Bấm trên Canvas -> Gửi WebSockets -> Nhận ảnh Mask đè lên Canvas.
  * Phát triển tính năng "Correction": Cho phép người dùng dừng lại ở Frame bị lệch mask, chấm thêm điểm click để sửa lỗi, sau đó hệ thống cập nhật tự động các frame kế tiếp.

### Giai đoạn 4: Đóng gói & Phát hành (Deployment)
* **Mục tiêu:** Tạo bản cài đặt 1-Click (Portable/Installer) cho người dùng cuối.
* **Công việc:**
  * Đóng gói Python Backend thành file thực thi độc lập (Dùng PyInstaller hoặc Nuitka).
  * Đóng gói toàn bộ Frontend UI và Backend bằng Tauri/Electron.
  * Thêm logic tự động tải Model Checkpoint (SAM 2 & MatAnyone weights) từ server vào lần chạy đầu tiên để giảm dung lượng file setup.
  * Kiểm thử và phát hành phiên bản Beta v1.0.

---

## 6. QUẢN TRỊ RỦI RO & BIỆN PHÁP KHẮC PHỤC (RISKS & MITIGATIONS)

| Rủi ro (Risk) | Mức độ | Biện pháp khắc phục (Mitigation) |
| :--- | :---: | :--- |
| **Tràn VRAM (Out of Memory) trên GPU yếu** | Cao | Cung cấp tùy chọn cấu hình AI: Khuyến khích người dùng chọn SAM 2 bản `Tiny` hoặc hạ độ phân giải tính toán (Inference size) xuống $480p/720p$ (Chỉ nội suy mask, video gốc vẫn giữ nguyên). |
| **Tốc độ xử lý AI quá chậm** | Trung bình | Tích hợp **TensorRT** hoặc **ONNX Runtime** để tăng tốc model. Đồng thời, hiển thị dự đoán thời gian hoàn thành (ETA) rõ ràng để người dùng có kỳ vọng đúng. |
| **Lỗi mất Tracking (Vật thể bị che khuất hoặc rời khỏi khung hình)** | Trung bình | Phát triển cơ chế "Smart Timeline": Cảnh báo người dùng khi độ tin cậy (Confidence Score) của SAM 2 tụt xuống dưới ngưỡng an toàn, tự động tạm dừng AI để người dùng can thiệp bằng tay. |
| **Khó khăn trong việc cài đặt (Người dùng không biết Code)** | Cao | Đóng gói toàn bộ Dependencies, Python, FFmpeg vào trong trình cài đặt duy nhất. Giao diện chạy mượt mà ngay sau khi cài (Plug-and-play). |

---

## 7. TIÊU CHÍ NGHIỆM THU (ACCEPTANCE CRITERIA)

Dự án được đánh giá là thành công và có thể Release nếu đáp ứng toàn bộ các tiêu chí sau:

1. **Về chức năng:**
   * Import thành công các video chuẩn ($1080p, 4K$).
   * Cho phép Click & Track chính xác vật thể với tối thiểu thao tác tay.
   * Xử lý tóc, lông, viền nhòe (Motion Blur) đạt chất lượng cao tương đương với các plugin thương mại (như After Effects Roto Brush 3.0).
   * Khả năng chỉnh sửa Mask giữa chừng (Keyframe Correction) hoạt động trơn tru.
2. **Về hiệu năng:**
   * Không văng/Crash ứng dụng khi chạy trên các dòng Card phổ thông (như RTX 3060 6GB/8GB).
   * Giao diện UI luôn phản hồi (Responsive) không bị treo khi Backend AI đang chạy hết công suất.
3. **Về Đầu ra (Output):**
   * Xuất ra file ProRes 4444 `.mov` có chứa kênh Alpha (Trong suốt hoàn hảo khi thả vào Premiere Pro, DaVinci Resolve).
