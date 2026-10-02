import os
import sys
import re

# Ensure UTF-8 output encoding on Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Support PIL / Pillow safely for CI/CD environments
try:
    from PIL import Image, ImageOps
    PIL_SUPPORTED = True
except ImportError:
    PIL_SUPPORTED = False
    print("Warning: Pillow not installed. Install with 'pip install Pillow' to process club photos.")

# Support HEIC format if pillow_heif is available
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    HEIF_SUPPORTED = True
except ImportError:
    HEIF_SUPPORTED = False

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST_BASE = os.path.join(PROJECT_ROOT, "public", "images", "clubs")

# Known folder name to standard club slug mapping
CLUB_SLUG_MAP = {
    "chakravyuha": "chakravyuha",
    "relu": "relu",
    "robotics": "robotics",
    "nritya sparsh": "nrityasparsh",
    "nrityasparsh": "nrityasparsh",
    "nritya_sparsh": "nrityasparsh",
    "advika": "advika",
    "avinya": "avinya",
    "prachurya": "prachurya",
    "saptaswara": "saptaswara",
    "spataswara": "saptaswara",
    "drsya": "drsya",
}

VALID_EXTENSIONS = {".heic", ".jpg", ".jpeg", ".png", ".webp"}

def process_club_folder(folder_path, slug):
    if not PIL_SUPPORTED:
        return []
    dest_dir = os.path.join(DEST_BASE, slug)
    os.makedirs(dest_dir, exist_ok=True)
    
    files = sorted(os.listdir(folder_path))
    image_files = [f for f in files if os.path.splitext(f)[1].lower() in VALID_EXTENSIONS]
    
    if not image_files:
        return []
    
    # Clean up old converted files exceeding current source count
    for f in os.listdir(dest_dir):
        if f.startswith(f"{slug}-photo-") and f.endswith(".jpg"):
            m = re.search(rf"{slug}-photo-(\d+)\.jpg", f)
            if m and int(m.group(1)) > len(image_files):
                try:
                    os.remove(os.path.join(dest_dir, f))
                    print(f"  [CLEAN] Removed old surplus file: {f}")
                except Exception:
                    pass

    print(f"\n--> Processing club '{slug}' ({len(image_files)} source files found in '{os.path.basename(folder_path)}')...")
    converted_photos = []
    
    for idx, fname in enumerate(image_files, start=1):
        src_file = os.path.join(folder_path, fname)
        dst_name = f"{slug}-photo-{idx}.jpg"
        dst_path = os.path.join(dest_dir, dst_name)
        
        try:
            img = Image.open(src_file)
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")
            
            # Keep max dimension at 1600 for high quality & fast loading
            max_dim = 1600
            if max(img.size) > max_dim:
                img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
                
            img.save(dst_path, "JPEG", quality=92, optimize=True)
            web_url = f"/images/clubs/{slug}/{dst_name}"
            converted_photos.append(web_url)
            print(f"  [OK] [{idx}/{len(image_files)}] {fname} -> {dst_name} ({img.size[0]}x{img.size[1]})")
        except Exception as e:
            print(f"  [FAIL] Failed to convert {fname}: {e}")
            
    return converted_photos

IGNORED_DIRS = {".git", ".github", ".next", "node_modules", "public", "src", "scripts", "logos"}

def sync_all_clubs():
    print("=" * 60)
    print("PARINAAM TECHFEST -- UNIVERSAL CLUB PHOTO SYNC")
    print("=" * 60)
    print(f"Scanning project root: {PROJECT_ROOT}\n")
    
    all_results = {}
    
    for entry in sorted(os.listdir(PROJECT_ROOT)):
        full_path = os.path.join(PROJECT_ROOT, entry)
        if not os.path.isdir(full_path):
            continue
        if entry in IGNORED_DIRS or entry.startswith("."):
            continue
            
        clean_name = entry.strip().lower()
        slug = CLUB_SLUG_MAP.get(clean_name, re.sub(r'[^a-z0-9]', '', clean_name))
        photos = process_club_folder(full_path, slug)
        if photos:
            all_results[slug] = photos

    print("\n" + "=" * 60)
    print("SUMMARY OF CONVERTED CLUBS:")
    print("=" * 60)
    for slug, photos in all_results.items():
        print(f"  * {slug.upper()}: {len(photos)} photos ready in /images/clubs/{slug}/")
    print(f"\nAll assets saved into: {DEST_BASE}")
    print("=" * 60)

if __name__ == "__main__":
    sync_all_clubs()
