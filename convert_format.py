import sys
import os
from PIL import Image

def convert_image(input_path, output_format, distinct_quality=None, depth=8):
    if not os.path.exists(input_path):
        print(f"Error: Not found {input_path}")
        sys.exit(1)

    try:
        # Handle TIFF 32-bit Float
        if output_format.lower() == 'tiff32' or (output_format.lower() == 'tiff' and int(depth) == 32):
            try:
                import cv2
                import numpy as np
                
                # Use OpenCV for 32-bit Float
                img = cv2.imread(input_path) # Reads as BGR 8-bit
                if img is None:
                    # Fallback
                     with open(input_path, "rb") as f:
                        bytes = bytearray(f.read())
                        numpyarray = np.asarray(bytes, dtype=np.uint8)
                        img = cv2.imdecode(numpyarray, cv2.IMREAD_UNCHANGED)
                
                if img is None:
                     raise Exception("Failed to load image with OpenCV")

                # Convert to Float32 (0.0 - 1.0)
                img_float = img.astype(np.float32) / 255.0
                
                # Construct path
                dir_name = os.path.dirname(input_path)
                base_name = os.path.basename(input_path)
                name, _ = os.path.splitext(base_name)
                output_path = os.path.join(dir_name, f"{name}_32bit.tiff")
                
                # Save
                # cv2.imwrite determines exact format by extension, but for 32-bit need flags?
                # Usually passing float32 array to imwrite with .tiff extension saves as 32-bit float or 32-bit int?
                # It usually saves as 32-bit float (TIFF, HDR).
                success = cv2.imwrite(output_path, img_float)
                if not success:
                    raise Exception("cv2.imwrite failed")
                
                print(f"OUTPUT:{output_path}")
                return

            except ImportError:
                 print("Error: OpenCV/Numpy not found for 32-bit conversion")
                 sys.exit(1)

        # Standard formats (Pillow)
        img = Image.open(input_path)
        
        # Determine output filename
        dir_name = os.path.dirname(input_path)
        base_name = os.path.basename(input_path)
        name, _ = os.path.splitext(base_name)
        
        ext_map = {
            'png': '.png',
            'jpeg': '.jpg',
            'jpg': '.jpg',
            'webp': '.webp',
            'tiff': '.tiff'
        }
        ext = ext_map.get(output_format.lower().replace('32', ''), '.png')
        output_path = os.path.join(dir_name, f"{name}_fmt{ext}")

        save_kwargs = {}
        if output_format.lower() in ['jpeg', 'jpg']:
            save_kwargs['quality'] = int(distinct_quality) if distinct_quality and distinct_quality != 'None' else 90
            if img.mode == 'RGBA':
                img = img.convert('RGB')
        
        elif output_format.lower() == 'webp':
            save_kwargs['quality'] = int(distinct_quality) if distinct_quality and distinct_quality != 'None' else 90
            save_kwargs['method'] = 6 # Max compression effort
        
        elif output_format.lower() == 'png':
             save_kwargs['compress_level'] = 9 
        
        elif output_format.lower() == 'tiff':
             save_kwargs['compression'] = 'tiff_lzw'

        img.save(output_path, **save_kwargs)
        print(f"OUTPUT:{output_path}")

    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    # convert_format.py <input> <format> [quality] [depth]
    if len(sys.argv) < 3:
        print("Usage: python convert_format.py <input> <format> [quality] [depth]")
        sys.exit(1)

    input_path = sys.argv[1]
    fmt = sys.argv[2]
    quality = sys.argv[3] if len(sys.argv) > 3 else None
    depth = sys.argv[4] if len(sys.argv) > 4 else 8
    
    convert_image(input_path, fmt, quality, depth)
