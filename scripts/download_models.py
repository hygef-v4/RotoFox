import urllib.request
import os
import sys

def download_file(url, dest_path):
    print(f"Downloading {url} to {dest_path}...")
    try:
        urllib.request.urlretrieve(url, dest_path, reporthook=progress_bar)
        print(f"\nSuccessfully downloaded {dest_path}")
    except Exception as e:
        print(f"\nError downloading {url}: {e}")
        sys.exit(1)

def progress_bar(count, block_size, total_size):
    if total_size == -1:
        return
    percent = int(count * block_size * 100 / total_size)
    sys.stdout.write(f"\rProgress: {percent}%")
    sys.stdout.flush()

if __name__ == "__main__":
    CHECKPOINT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend", "checkpoints")
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    
    # 1. SAM 2.1 Tiny Checkpoint
    sam2_url = "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt"
    sam2_dest = os.path.join(CHECKPOINT_DIR, "sam2.1_hiera_tiny.pt")
    
    if not os.path.exists(sam2_dest):
        download_file(sam2_url, sam2_dest)
    else:
        print(f"{sam2_dest} already exists.")
        
    # 2. MatAnyone2 Checkpoint
    matanyone2_url = "https://github.com/pq-yang/MatAnyone2/releases/download/v1.0.0/matanyone2.pth"
    matanyone2_dest = os.path.join(CHECKPOINT_DIR, "matanyone2.pth")
    
    if not os.path.exists(matanyone2_dest):
        download_file(matanyone2_url, matanyone2_dest)
    else:
        print(f"{matanyone2_dest} already exists.")
        
    print("All initial downloads completed.")
