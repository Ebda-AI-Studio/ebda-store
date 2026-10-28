# Photoreal product stills via Gemini image generation, using our own procedural renders as the reference so the
# product design stays the same (shape, label, colourway). No people are generated.
#   GEMINI_API_KEY=... uv run --with google-genai --with pillow python apps/marketing/scripts/3d/gen-photoreal.py <ref.png> <out.png> <aspect> "<prompt>"
# Image models have no "-latest" alias (404), so the stable id without a preview suffix is used.
import os, sys
from google import genai
from google.genai import types
from PIL import Image

MODEL = 'gemini-3.1-flash-image'  # also tried gemini-3-pro-image, gemini-2.5-flash-image, gemini-3.1-flash-lite-image: all 429 on a free-tier key
ref, out, aspect, prompt = sys.argv[1:5]
client = genai.Client(api_key=os.environ['GEMINI_API_KEY'])
r = client.models.generate_content(
    model=MODEL,
    contents=[prompt, Image.open(ref)],
    config=types.GenerateContentConfig(response_modalities=['IMAGE'], image_config=types.ImageConfig(aspect_ratio=aspect)),
)
for p in r.candidates[0].content.parts:
    if p.inline_data:
        open(out, 'wb').write(p.inline_data.data)
        print('wrote', out)
        break
else:
    print('NO IMAGE', r.candidates[0].finish_reason, [getattr(p, 'text', None) for p in r.candidates[0].content.parts])
    sys.exit(1)
