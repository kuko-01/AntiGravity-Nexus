import sys
import os

def upscale_image(input_path, scale_factor=2):
    if not os.path.exists(input_path):
        print(f"Error: File not found at {input_path}")
        sys.exit(1)

    try:
        # Try OpenCV first (Better quality control + smoothing)
        try:
            import cv2
            import numpy as np
            
            # Read
            img = cv2.imread(input_path)
            if img is None:
                 # Fallback
                 with open(input_path, "rb") as f:
                    bytes = bytearray(f.read())
                    numpyarray = np.asarray(bytes, dtype=np.uint8)
                    img = cv2.imdecode(numpyarray, cv2.IMREAD_UNCHANGED)
            
            if img is not None:
                # Upscale (Bicubic is often better for illustration than Lanczos which can ring/jaggy on hard edges)
                # Or LANCZOS4. Let's try Cubic for smoother edges.
                height, width = img.shape[:2]
                new_dim = (int(width * scale_factor), int(height * scale_factor))
                
                upscaled = cv2.resize(img, new_dim, interpolation=cv2.INTER_CUBIC)
                
                # Apply Bilateral Filter (Edge Preserving Smoothing) to reduce jaggies/noise from scaling
                # d=5 (small neighborhood), sigmaColor=50, sigmaSpace=50
                if scale_factor >= 2:
                    upscaled = cv2.bilateralFilter(upscaled, 5, 50, 50)
                
                # Output
                dir_name, file_name = os.path.split(input_path)
                name, ext = os.path.splitext(file_name)
                output_filename = f"{name}_upscaled{ext}"
                output_path = os.path.join(dir_name, output_filename)
                
                cv2.imwrite(output_path, upscaled)
                print(f"OUTPUT:{output_path}")
                return

        except ImportError:
            pass # Fallback to Pillow

        # Standard Pillow
        from PIL import Image
        img = Image.open(input_path)
        
        original_size = img.size
        new_size = (int(original_size[0] * scale_factor), int(original_size[1] * scale_factor))
        
        # Bicubic might be safer for "jaggies" than Lanczos
        upscaled_img = img.resize(new_size, resample=Image.Resampling.BICUBIC)
        
        dir_name, file_name = os.path.split(input_path)
        name, ext = os.path.splitext(file_name)
        output_filename = f"{name}_upscaled{ext}"
        output_path = os.path.join(dir_name, output_filename)
        
        upscaled_img.save(output_path)
        print(f"OUTPUT:{output_path}")

    except Exception as e:
        print(f"Error upscaling image: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python upscale_image.py <input_path> [scale_factor]")
        sys.exit(1)
        
    input_file = sys.argv[1]
    scale = 2
    if len(sys.argv) > 2:
        try:
            scale = int(sys.argv[2])
        except ValueError:
            pass
            
    upscale_image(input_file, scale)
