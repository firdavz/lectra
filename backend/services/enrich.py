"""Tavily: add a one-line real-world example/definition to a node."""
import os
from tavily import TavilyClient

client = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))


def enrich_label(label: str) -> str:
    """Return a short explanation string for a diagram node label."""
    res = client.search(query=f"explain simply: {label}", max_results=1)
    if res.get("results"):
        return res["results"][0].get("content", "")[:200]
    return ""
