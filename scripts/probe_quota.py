import json, os, sys, urllib.request
key = os.environ["GEMINI_API_KEY"]
for m in sys.argv[1:]:
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent",
        data=json.dumps({"contents": [{"role": "user", "parts": [{"text": "say ok"}]}]}).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        urllib.request.urlopen(req, timeout=90); print(m, "OK")
    except urllib.error.HTTPError as e:
        d = json.load(e)["error"]; print(m, d["code"], d["message"][:90])
        for x in d.get("details", []):
            for v in x.get("violations", []): print("   ", v.get("quotaId"), v.get("quotaValue"))
