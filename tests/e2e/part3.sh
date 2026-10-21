#!/bin/bash
export AGENT_BROWSER_SESSION=nl-qa
ab() { agent-browser "$@"; }
echo "--- translate one (row 3)"; ab eval '(async()=>{ document.querySelectorAll("[data-action=translate-one]")[2].click(); for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,300)); if(/แปลเสร็จ/.test(document.querySelector("#runner").innerText)) break;} return document.querySelector("#runner").innerText.split("\n")[0] })()'
ab eval 'document.querySelector("[data-action=close-runner]")?.click(); 1' >/dev/null
echo "--- translate all"; ab eval '(async()=>{ document.querySelector("[data-action=translate-todo]").click(); for(let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,300)); if(/เสร็จ [4-9]\//.test(document.querySelector("#runner").innerText)) break;} return document.querySelector("#runner").innerText.split("\n")[0] })()'
echo "--- read mid-run"; ab eval '(async()=>{ document.querySelector("#runner [data-action=read-book]").click(); await new Promise(r=>setTimeout(r,400)); return {hash:location.hash, h1:document.querySelector(".book h1")?.innerText, p:document.querySelector(".book p:not(.book-kicker)")?.innerText.slice(0,40), marks:document.querySelectorAll("main mark").length} })()'
echo "--- next chapter while running"; ab eval '(async()=>{ document.querySelector(".at-bottom [data-action=next]").click(); await new Promise(r=>setTimeout(r,300)); return document.querySelector(".book-kicker").innerText })()'
echo "--- browser back"; ab back >/dev/null; sleep 0.5; ab eval '({hash:location.hash, view:document.querySelector("#tabs [aria-current]")?.dataset.view})'
ab back >/dev/null; sleep 0.5; ab eval '({hash:location.hash, view:document.querySelector("#tabs [aria-current]")?.dataset.view})'
echo "--- stop"; ab eval '(async()=>{ document.querySelector("[data-action=stop]")?.click(); for(let i=0;i<30;i++){ await new Promise(r=>setTimeout(r,300)); if(/แปลเสร็จ/.test(document.querySelector("#runner").innerText)) break;} const s=document.querySelector("#runner").innerText; return s.split("\n").slice(0,1).concat(s.split("\n").slice(-3)) })()'
ab eval '(async()=>{ document.querySelector("#tabs [data-view=chapters]").click(); await new Promise(r=>setTimeout(r,500)); const b=[...document.querySelectorAll("tbody .badge")].map(x=>x.innerText); const c={}; b.forEach(x=>c[x]=(c[x]||0)+1); return c })()'
echo "--- errors"; ab errors
