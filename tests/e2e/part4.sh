#!/bin/bash
export AGENT_BROWSER_SESSION=nl-qa
export AGENT_BROWSER_DOWNLOAD_PATH="$1/e2e/dl"
ab() { agent-browser "$@"; }
ab eval '(async()=>{ document.querySelector("#tabs [data-view=export]").click(); await new Promise(r=>setTimeout(r,300)); return [...document.querySelectorAll("main button, main label.btn")].map(b=>b.innerText) })()'
for k in docx epub txt zip bi; do ab download "[data-kind=$k]" "$1/e2e/dl/out-$k" 2>&1 | tail -1; done
ab download "[data-action=backup]" "$1/e2e/dl/backup.json" 2>&1 | tail -1
