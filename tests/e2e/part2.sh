#!/bin/bash
export AGENT_BROWSER_SESSION=nl-qa
ab() { agent-browser "$@"; }
ab eval 'document.querySelector("[data-action=cancel-import]").click(); 1' >/dev/null
T0=$(date +%s.%N)
ab upload "#fileIn" "$1/e2e/big-1000.txt" >/dev/null; sleep 2
ab eval 'document.querySelector(".issues")?.innerText.split("\n")[0]'
ab eval '(async()=>{ const t=performance.now(); document.querySelector("[data-action=confirm-import]").click(); await new Promise(r=>setTimeout(r,1500)); return {ms:Math.round(performance.now()-t), rows:document.querySelectorAll("tbody tr").length, todoBtn:document.querySelector("[data-action=translate-todo]")?.innerText} })()'
