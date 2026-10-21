#!/bin/bash
export AGENT_BROWSER_SESSION=nl-qa
export AGENT_BROWSER_DOWNLOAD_PATH="$1/e2e/dl"
ab() { agent-browser "$@"; }
ab open http://localhost:8765/ >/dev/null; ab wait --load networkidle >/dev/null
echo "--- fresh home"; ab eval '({tabs:[...document.querySelectorAll("#tabs button")].map(b=>b.innerText+(b.disabled?"(off)":"")), hash:location.hash, h1:document.querySelector(".hero h1")?.innerText, footer:document.querySelector(".foot").innerText})'
echo "--- AI setup"; ab eval 'localStorage.setItem("nl:ai", JSON.stringify({provider:"custom",model:"mock",keys:{},base:"http://localhost:8788/v1",fallback:false,models:{},parallel:2,paid:false})); location.reload(); 1' >/dev/null; sleep 1
ab eval '(async()=>{ document.querySelector("#tabs [data-view=ai]").click(); await new Promise(r=>setTimeout(r,200)); document.querySelector("[data-action=test-ai]").click(); await new Promise(r=>setTimeout(r,2500)); return document.querySelector("#aiTest").innerText })()'
echo "--- new project"; ab eval '(async()=>{ window.prompt=()=> "ราโชมอน ทดสอบ"; document.querySelector("#tabs [data-view=home]").click(); await new Promise(r=>setTimeout(r,200)); document.querySelector("[data-action=new-project]").click(); await new Promise(r=>setTimeout(r,500)); return ({hash:location.hash, disabledTabs:[...document.querySelectorAll("#tabs button")].filter(b=>b.disabled).length}) })()'
echo "--- import real files"; ab upload "#fileIn" "$HOME/Projects/novel-translator/corpus/ja-rashomon.txt" "$HOME/Projects/novel-translator/corpus/zh-xiyouji-01.txt" "$HOME/Projects/novel-translator/corpus/zh-xiyouji-02.txt" >/dev/null; sleep 2
ab eval 'document.querySelector(".issues")?.innerText.slice(0,300)'
