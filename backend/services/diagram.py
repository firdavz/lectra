"""LLM: turn running transcript into flowchart nodes/edges (the 'hard part' extractor)."""
import os
import json
import google.generativeai as genai

genai.configure(api_key=os.getenv("GEMINI_API_KEY"), transport="rest")

SYSTEM = """You read a running lecture transcript and extract the HARD, confusing
part as a small flowchart. Output STRICT JSON only, no markdown fences:
{"nodes": [{"id": "1", "label": "..."}], "edges": [{"from": "1", "to": "2", "label": "..."}]}
Keep it small (max 6 nodes). If nothing hard/new yet, return {"nodes": [], "edges": []}.
"""

# Different Gemini model names draw from SEPARATE free-tier quota pools.
# gemini-3.6-flash (the "main" one) ran out of daily quota mid-demo, but the
# lite/latest variants still had quota available when checked live. Try them
# in order and stick with whichever one works, so a single model's quota
# running out doesn't take the whole live demo down.
MODEL_FALLBACK_CHAIN = [
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
]

_models = {name: genai.GenerativeModel(name, system_instruction=SYSTEM) for name in MODEL_FALLBACK_CHAIN}
_working_model_index = 0  # sticky: once one works, keep using it (avoid re-probing every call)


def extract_flowchart(transcript_so_far: str) -> dict:
    global _working_model_index
    prompt = transcript_so_far[-4000:]
    last_error = None

    # Try starting from whichever model last worked, then fall through the rest.
    order = list(range(_working_model_index, len(MODEL_FALLBACK_CHAIN))) + list(range(_working_model_index))
    for i in order:
        name = MODEL_FALLBACK_CHAIN[i]
        try:
            response = _models[name].generate_content(prompt, request_options={"timeout": 15})
        except Exception as e:
            last_error = e
            # 429 (quota) -> try the next model in the chain immediately.
            # Anything else (network blip etc.) -> also worth trying the next
            # one rather than failing the whole cycle outright.
            continue

        _working_model_index = i  # remember what worked for next time
        text = (response.text or "").strip().strip("```json").strip("```")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"nodes": [], "edges": []}

    # every model in the chain failed
    raise last_error
