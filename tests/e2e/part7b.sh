#!/bin/bash
export AGENT_BROWSER_SESSION=nl-quota2
ab() { agent-browser "$@"; }
SHIM='window.__dead=new Set(); window.__calls=[]; const rf=window.fetch.bind(window); window.fetch=async(u,o)=>{ const s=String(u); if(!s.includes("generativelanguage")) return rf(u,o); const m=s.match(/models\/([^:]+)/)[1]; window.__calls.push(m); await new Promise(r=>setTimeout(r,150)); if(window.__dead.has(m)||window.__dead.has("*")) return new Response(JSON.stringify({error:{code:429,message:"You exceeded your current quota",details:[{violations:[{quotaId:"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}),{status:429}); const wantsJson=String(o.body).includes("JSON"); const text=wantsJson?JSON.stringify({title:"ตอนจริง",summary:"สรุป",terms:[]}):"คำแปลทดสอบ"; return new Response(JSON.stringify({candidates:[{content:{parts:[{text}]},finishReason:"STOP"}],usageMetadata:{totalTokenCount:10}}),{status:200}); };'
setup() {
  # The browser daemon sometimes drops the first command after a close: retry until the page is really open.
  for i in 1 2 3; do ab open http://localhost:8765/ >/dev/null 2>&1; ab wait --load networkidle >/dev/null 2>&1; [ "$(ab eval 'location.origin' 2>/dev/null)" = '"http://localhost:8765"' ] && break; sleep 1; done
  ab eval 'localStorage.clear(); indexedDB.deleteDatabase("novel-lock"); localStorage.setItem("nl:ai", JSON.stringify({provider:"gemini",model:"gemini-3.5-flash",keys:{gemini:"test-key-fake"},base:"",fallback:true,models:{},parallel:1,paid:false})); location.reload(); 1' >/dev/null; sleep 1.5
  ab eval "(async()=>{ $SHIM window.prompt=()=>'โควต้า'; document.querySelector('[data-action=new-project]').click(); await new Promise(r=>setTimeout(r,400)); const t=document.querySelector('#pasteIn'); t.value=[1,2,3,4,5,6].map(i=>'Chapter '+i+'\nText '+i+'.').join('\n\n'); document.querySelector('[data-action=paste-import]').click(); await new Promise(r=>setTimeout(r,300)); document.querySelector('[data-action=confirm-import]').click(); await new Promise(r=>setTimeout(r,300)); return document.querySelectorAll('tbody tr').length })()" >/dev/null
}
wait_done() { for i in $(seq 1 120); do h=$(ab eval 'document.querySelector("#runner").innerText.split("\n")[0]'); case "$h" in *แปลเสร็จ*) echo "$h"; return;; esac; sleep 0.5; done; echo "TIMEOUT $h"; }
summary() { ab eval '(()=>{ const log=document.querySelector("#runner").innerText; const b={}; [...document.querySelectorAll("tbody .badge")].forEach(x=>b[x.innerText]=(b[x.innerText]||0)+1); return {badges:b, models:[...new Set(window.__calls)], tail:log.split("\n").slice(-3)} })()'; }

echo "=== A: first model's quota runs out after 2 chapters"
setup
ab eval 'document.querySelector("[data-action=translate-todo]").click(); 1' >/dev/null
for i in $(seq 1 60); do h=$(ab eval 'document.querySelector("#runner").innerText.split("\n")[0]'); case "$h" in *"เสร็จ 2/"*|*"เสร็จ 3/"*) break;; esac; sleep 0.3; done
ab eval 'window.__dead.add("gemini-3.5-flash"); 1' >/dev/null
wait_done; summary

echo "=== B: every model's quota runs out"
ab close >/dev/null
setup
ab eval 'window.__dead.add("*"); document.querySelector("[data-action=translate-todo]").click(); 1' >/dev/null
wait_done; summary
ab eval '(async()=>{ document.querySelector("#tabs [data-view=ai]").click(); await new Promise(r=>setTimeout(r,300)); return [...document.querySelectorAll("main p")].find(x=>x.innerText.includes("โควตาฟรีวันนี้หมด"))?.innerText.slice(0,80) })()'
echo "=== B2: quota back (user presses reset) then continue"
ab eval '(async()=>{ window.__dead.clear(); document.querySelector("[data-action=reset-quota]").click(); await new Promise(r=>setTimeout(r,200)); document.querySelector("#tabs [data-view=chapters]").click(); await new Promise(r=>setTimeout(r,300)); document.querySelector("[data-action=close-runner]")?.click(); document.querySelector("[data-action=translate-todo]").click(); return 1 })()' >/dev/null
wait_done; summary
ab errors; ab close >/dev/null
