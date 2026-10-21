"""Turn the raw public-domain downloads in corpus/raw into plain-text chapters in corpus/*.txt."""
import re, pathlib
RAW = pathlib.Path(__file__).resolve().parent.parent / "corpus" / "raw"
OUT = RAW.parent

def strip_templates(s):
    # keep the text argument of simple inline templates, drop the rest (header blocks etc.)
    s = re.sub(r"\{\{\s*drop ?cap\s*\|([^}|]*)\}\}", r"\1", s, flags=re.I)
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"\{\{(?:[^{}])*\}\}", "", s)
    return s

def wiki(name, min_len=0):
    s = (RAW / name).read_text("utf-8")
    s = re.sub(r"<ref[^>]*>.*?</ref>|<ref[^>]*/>", "", s, flags=re.S)
    s = re.sub(r"\{\{\s*(?:văn|center|c)\s*\|", "{{x}}", s, flags=re.I)  # wrappers: drop the opener, keep the body
    s = strip_templates(s)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"-\{([^}]*)\}-", r"\1", s)  # zh conversion markup
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"<[^>]+>|'''|''|\}\}|__\w+__", "", s)
    s = re.sub(r"\[\[Category:[^\]]*\]\]|^\s*(?:Thể loại|Category|分類):.*$", "", s, flags=re.M)
    return tidy(s)

def aozora(name, start_marker=None, end_marker=None):
    h = (RAW / name).read_bytes().decode("shift_jis", "replace")
    body = re.search(r'<div class="main_text">(.*?)<div class="bibliographical_information">', h, re.S).group(1)
    body = re.sub(r"<rp>.*?</rp>|<rt>.*?</rt>", "", body, flags=re.S)
    body = re.sub(r"<br\s*/?>", "\n", body)
    body = re.sub(r"<[^>]+>", "", body)
    return tidy(body)

def tidy(s):
    lines = [l.strip().lstrip(":").strip().replace("　", "") if not l.startswith("　") else l.strip() for l in s.splitlines()]
    s = "\n\n".join(l for l in lines if l)
    return s.strip() + "\n"

def cut(s, n):
    """Cut at a paragraph boundary at or after n characters."""
    if len(s) <= n:
        return s
    i = s.find("\n\n", n)
    return s if i < 0 else s[:i].strip() + "\n"

out = {
    "zh-xiyouji-01.txt": wiki("zh-xiyouji-001.wiki"),
    "zh-xiyouji-02.txt": wiki("zh-xiyouji-002.wiki"),
    "zh-shuihu-02.txt": cut(wiki("zh-shuihu-002.wiki"), 5000),
    "ja-rashomon.txt": aozora("ja-rashomon.html"),
    "ja-neko-01.txt": cut(aozora("ja-neko.html"), 3500),
    "ko-unsu.txt": cut(wiki("ko-unsu.wiki"), 5000),
    "vi-tatden-01.txt": wiki("vi-tatden-01.wiki"),
}
g = (RAW / "en-holmes.txt").read_text("utf-8")
a = g.index("\nI. A SCANDAL IN BOHEMIA") + 1
body = g[a:g.index("\nII.\n", a)]
paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", body)]
out["en-holmes-scandal.txt"] = cut("\n\n".join(p for p in paras if p), 9000)

for name, text in out.items():
    (OUT / name).write_text(text, "utf-8")
    print(f"{name:24s} {len(text):6d} chars | {text[:60]!r}")
