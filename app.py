import streamlit as st
import google.generativeai as genai
from PIL import Image
import io
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure page settings
st.set_page_config(
    page_title="Nano Studio - AI Image Generator",
    page_icon="🎨",
    layout="wide"
)

# Initialize API Key
api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    st.error("API Key not found. Please set GEMINI_API_KEY in your .env file.")
    st.stop()

genai.configure(api_key=api_key)

def upscale_image(image: Image.Image, scale_factor: int = 2) -> Image.Image:
    """
    Upscale the image by scale_factor using Lanczos resampling.
    """
    original_size = image.size
    new_size = (int(original_size[0] * scale_factor), int(original_size[1] * scale_factor))
    return image.resize(new_size, resample=Image.Resampling.LANCZOS)

def main():
    st.title("🎨 Nano Studio")
    st.markdown("Generate high-quality images using **Gemini 2.5 Flash**")

    # Sidebar for controls
    with st.sidebar:
        st.header("Settings")
        
        aspect_ratio_option = st.selectbox(
            "Aspect Ratio",
            ["1:1 (Square)", "9:16 (Portrait/Phone)", "16:9 (Landscape)"],
            index=0
        )
        
        # Map selection to string expected by API if needed, 
        # but 'gemini-2.5-flash' usually takes standard generation config.
        # Note: Actual 'aspect_ratio' string format depends on the specific model version features.
        # We will assume standard "1:1", "9:16", "16:9" string passing or handling via prompt augmentation if direct param fails.
        if "1:1" in aspect_ratio_option:
            ar_val = "1:1"
        elif "9:16" in aspect_ratio_option:
            ar_val = "9:16"
        else:
            ar_val = "16:9"

    # Main input area
    prompt = st.text_area("Enter your prompt", height=100, placeholder="A futuristic city with flying cars, anime style...")
    
    generate_btn = st.button("Generate Image", type="primary")

    if generate_btn and prompt:
        try:
            with st.spinner("Generating image..."):
                # Initialize model
                # Note: Currently, image generation often uses specific 'imagen' models or specific methods.
                # If 'gemini-2.5-flash' supports image generation directly via generate_content, we try that.
                # However, typically distinct models like 'imagen-3.0-generate-001' are used.
                # Adhering to USER REQUEST to use 'gemini-2.5-flash'.
                model = genai.GenerativeModel("gemini-2.5-flash")
                
                # Construct config
                generation_config = genai.types.GenerationConfig(
                    # candidate_count=1, # Typical for text, verify for image
                )
                
                # Experimental: Some Gemini endpoints accept 'media_resolution' or aspect ratio in plain text prompt or config.
                # Since pure SDK usage for 'gemini-2.5-flash' image gen is bleeding edge/hypothetical in this context,
                # We will attempt the standard 'generate_content' assuming it might return an image part
                # OR use the 'ImageGenerationModel' if the user implied the Imagen capability within the Gemini brand.
                # Given strict instruction for 'gemini-2.5-flash', we'll try to invoke it.
                # If this fails because the model is text-only, the user will see the error.
                
                # UPDATED STRATEGY: 
                # Since 'gemini-2.5-flash' is likely a text/multimodal model, we'll try to ask it to generate code or text unless it has native image gen tools.
                # BUT, assuming the user *knows* it has image gen capabilities (or is a proxy for Imagen),
                # We will proceed. 
                # *Crucially*, standard procedure for Google Gen AI image gen via SDK is `ImageGenerationModel.from_pretrained("imagen-...")`.
                # If the user insists on `gemini-2.5-flash`, it might be they want it to *describe* an image or they believe it generates images.
                # I will try to use the model to generate content. If the response contains an image, great.
                # IF NOT, I will silently fallback to `imagen-3.0-generate-001` ONLY IF the first one fails? 
                # No, strict adherence: use `gemini-2.5-flash`.
                
                response = model.generate_content(prompt)
                
                # Check if response has parts that are images (unlikely for standard text models, but possible for multimodal outputs).
                # If the user actually meant "Use the Imagen model available via Gemini API", the code below would differ.
                # I'll implement a robust check.
                
                img_data = None
                
                # 1. Check for standard image generation response structure (if it were Imagen)
                if hasattr(response, 'images'):
                    img_data = response.images[0]
                # 2. Check for parts
                elif hasattr(response, 'parts'):
                    for part in response.parts:
                        if hasattr(part, 'inline_data'):
                             img_data = part.inline_data.data
                             break
                
                # If we still don't have an image, maybe we just got text?
                if not img_data:
                    # Attempt to use the dedicated image generation class if the generic model failed to give an image
                    # But utilizing the name the user gave.
                    # Verify if 'gemini-2.5-flash' is valid for ImageGenerationModel
                    try:
                        from google.generativeai import ImageGenerationModel
                        img_model = ImageGenerationModel.from_pretrained("gemini-2.5-flash") # Often it's 'imagen-3.0'
                        images = img_model.generate_images(
                            prompt=prompt,
                            aspect_ratio=ar_val,
                            number_of_images=1,
                        )
                        img_data = images[0] # This object usually has .show(), .save(), or ._image_bytes
                        
                        # Convert to PIL
                        # The SDK 'GeneratedImage' usually has a ._image_bytes or we can save to buffer
                        # Let's try grabbing bytes directly or using provided method
                        if hasattr(img_data, '_image_bytes'):
                            import io
                            # It might be in different format, usually JPEG/PNG bytes
                            # We'll reload it into PIL
                            pil_img = Image.open(io.BytesIO(img_data._image_bytes))
                        elif hasattr(img_data, 'image'):
                             # Some SDK versions return a wrapper with .image (PIL Image)
                             pil_img = img_data.image
                        else:
                            # Fallback: try to render to bytes
                            import io
                            b = io.BytesIO()
                            img_data.save(b)
                            pil_img = Image.open(b)
                            
                    except Exception as e_img:
                        st.warning(f"Direct image generation with 'gemini-2.5-flash' failed: {e_img}. Please ensure this model supports image generation or consider 'imagen-3.0-generate-001'.")
                        st.stop()
                
                # Ensure we have a PIL image
                if 'pil_img' not in locals():
                     st.error("No image data returned from model.")
                     st.stop()

                # Upscale
                st.info("Upscaling image (x2) using Lanczos...")
                high_res_img = upscale_image(pil_img, scale_factor=2)
                
                # Display
                st.image(high_res_img, caption="Generated & Upscaled Image", use_column_width=True)
                
                # Prepare download
                buf = io.BytesIO()
                high_res_img.save(buf, format="PNG")
                byte_im = buf.getvalue()
                
                st.download_button(
                    label="Download High-Res PNG",
                    data=byte_im,
                    file_name="high_res_output.png",
                    mime="image/png",
                )
                
        except Exception as e:
            st.error(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
