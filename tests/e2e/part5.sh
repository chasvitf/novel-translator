#!/bin/bash
export AGENT_BROWSER_SESSION=nl-qa
ab() { agent-browser "$@"; }
echo "--- restore on home"; ab eval '(async()=>{ document.querySelector("#tabs [data-view=home]").click(); await new Promise(r=>setTimeout(r,300)); return !!document.querySelector("#restoreIn") })()'
ab upload "#restoreIn" "$1/e2e/dl/backup.json" >/dev/null; sleep 2.5
ab eval '({hash:location.hash, toast:document.querySelector("#toast").innerText, rows:document.querySelectorAll("tbody tr").length})'
echo "--- phone"; ab set viewport 390 844 >/dev/null; ab eval '(async()=>{ const r={}; for (const v of ["home","chapters","book","settings","export","ai"]) { document.querySelector(`#tabs [data-view=${v}]`).click(); await new Promise(r=>setTimeout(r,300)); r[v]=document.documentElement.scrollWidth>innerWidth ? "OVERFLOW "+document.documentElement.scrollWidth : "ok"; } return {w:innerWidth, r} })()'
ab eval '(async()=>{ document.querySelector("#tabs [data-view=home]").click(); await new Promise(r=>setTimeout(r,300)); return 1 })()' >/dev/null; ab screenshot "$1/e2e/phone-home.png" >/dev/null
ab eval '(async()=>{ document.querySelector("#tabs [data-view=book]").click(); await new Promise(r=>setTimeout(r,300)); return 1 })()' >/dev/null; ab screenshot "$1/e2e/phone-book.png" >/dev/null
ab eval '(async()=>{ document.querySelector("#tabs [data-view=chapters]").click(); await new Promise(r=>setTimeout(r,300)); return 1 })()' >/dev/null; ab screenshot "$1/e2e/phone-chapters.png" >/dev/null
echo "--- errors"; ab errors
