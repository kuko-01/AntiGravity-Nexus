import sys
import cv2
import os

def smooth_image(image_path):
    if not os.path.exists(image_path):
        print(f"Error: File not found {image_path}")
        sys.exit(1)

    try:
        # Enable reading paths with utf-8 chars if possible, but cv2.imread has issues with Windows paths sometimes.
        # Use numpy fromfile workaround if needed?
        # For now, standard imread.
        img = cv2.imread(image_path)
        if img is None:
            # Fallback for unicode paths on Windows:
            import numpy as np
            with open(image_path, "rb") as f:
                bytes = bytearray(f.read())
                numpyarray = np.asarray(bytes, dtype=np.uint8)
                img = cv2.imdecode(numpyarray, cv2.IMREAD_UNCHANGED)
            
            if img is None:
                print("Error: Failed to load image")
                sys.exit(1)

        # Bilateral Filter for Anime Edge Smoothing
        # Keeps edges sharp while smoothing textures.
        # Arguments: src, d, sigmaColor, sigmaSpace
        # d: Diameter of pixel neighborhood (e.g. 9)
        # sigmaColor: Filter sigma in the color space (larger = mixing farther colors)
        # sigmaSpace: Filter sigma in the coordinate space (larger = influencing farther pixels)
        
        # Anime settings: standard d=9, sigmaColor=75, sigmaSpace=75
        smoothed = cv2.bilateralFilter(img, 9, 75, 75)

        # Output path
        dir_name = os.path.dirname(image_path)
        base_name = os.path.basename(image_path)
        name, ext = os.path.splitext(base_name)
        output_path = os.path.join(dir_name, f"{name}_smooth{ext}")

        # Save with unicode support check
        is_success = cv2.imwrite(output_path, smoothed)
        if not is_success:
             # Try imencode workaround for Windows paths
             ext_formatted = ext.lower() if ext else '.png'
             result, n = cv2.imencode(ext_formatted, smoothed)
             if result:
                 with open(output_path, "wb") as f:
                     n.tofile(f)
             else:
                 print("Error: Failed to save image")
                 sys.exit(1)

        print(f"OUTPUT:{output_path}")

    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python edge_smooth.py <image_path>")
        sys.exit(1)
    
    smooth_image(sys.argv[1])
