"""ElevenLabs speech-to-text wrapper."""
import os
from elevenlabs.client import ElevenLabs

client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))


def transcribe_chunk(audio_bytes: bytes) -> str:
    """Send one audio chunk to ElevenLabs Scribe, return text."""
    result = client.speech_to_text.convert(
        file=audio_bytes,
        model_id="scribe_v1",
    )
    return result.text or ""
