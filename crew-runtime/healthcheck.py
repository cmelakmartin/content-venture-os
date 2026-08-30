import json
import urllib.request


with urllib.request.urlopen("http://localhost:8000/health", timeout=3) as response:
    payload = json.load(response)

if payload.get("status") != "ready":
    raise SystemExit(1)
