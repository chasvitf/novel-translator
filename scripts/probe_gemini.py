import json, os, sys, time, urllib.request
key = os.environ["GEMINI_API_KEY"]
SYS = "Translate the Chinese novel text into natural Thai novel prose. Glossary (must use exactly): 孫悟空=ซุนหงอคง, 花果山=เขาฮวาก่อซัน, 水簾洞=ถ้ำม่านน้ำ. Output only the translation."
SRC = "那猴在山中，卻會行走跳躍，食草木，飲澗泉，採山花，覓樹果。一朝天氣炎熱，與群猴避暑，都在松陰之下頑耍。"
for m in sys.argv[1:]:
    body = {"systemInstruction": {"parts": [{"text": SYS}]}, "contents": [{"role": "user", "parts": [{"text": SRC}]}]}
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    t = time.time()
    try:
        d = json.load(urllib.request.urlopen(req, timeout=120))
        parts = d["candidates"][0]["content"]["parts"]
        print(f"== {m} {time.time()-t:.1f}s usage={d.get('usageMetadata',{}).get('totalTokenCount')}\n" + "".join(p.get("text","") for p in parts if not p.get("thought"))[:400])
    except urllib.error.HTTPError as e:
        print(f"== {m} HTTP {e.code}: {json.load(e)['error']['message'][:200]}")
