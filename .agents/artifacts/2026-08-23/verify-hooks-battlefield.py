#!/usr/bin/env python3
"""Verify-only: every figure label matches its table, and no identifiers leak.

Split out of the regeneration scripts because those consume their anchors and
cannot be re-run. This one is idempotent, so it can gate every future edit.
"""
import json
import re
import sys

MD, SNAP_PATH = sys.argv[1], sys.argv[2]
SNAP = json.load(open(SNAP_PATH))
text = open(MD).read()
fail = 0

G = {k: v["fires"] for k, v in SNAP["guards"].items()}
SHORT = {"pr-description-reminder": "pr-desc-reminder", "artifacts-confidential-guard": "artifacts-conf.",
         "large-file-add-guard": "large-file-add", "git-require-clean-tree": "clean-tree",
         "user-message-guard": "user-msg-guard", "teams-roster-guard": "teams-roster"}

# --- Figure 1 -------------------------------------------------------------
for name, fires in G.items():
    if name == "verify-work-complete" or fires == 0:
        continue
    lab = SHORT.get(name, name)
    m = re.search(rf'<text fill="#ffd7dd">{re.escape(lab)}</text>.*?>(\d+)</text>', text)
    if not m or int(m.group(1)) != fires:
        print(f"FIG1 {name}: table={fires} figure={m.group(1) if m else 'ABSENT'}")
        fail = 1

# --- Figure 2: titles AND the visible labels the last pass forgot ---------
H = SNAP["harness"]
for h in ("claude", "codex", "grok", "kimi"):
    hb, dn = H[h]["blocked_sessions"], H[h]["denials"]
    for kind, want in (("hard blocks", hb), ("permission denials", dn)):
        m = re.search(rf"<title>{h} {kind}: (\d+)", text)
        if not m or int(m.group(1)) != want:
            print(f"FIG2 title {h} {kind}: want={want} got={m.group(1) if m else 'ABSENT'}")
            fail = 1
    grp = re.search(rf"<title>{h} hard blocks.*?</g>", text, re.S)
    vis = [int(v) for v in re.findall(r'font-size="11">(\d+)</text>', grp.group(0))] if grp else []
    if vis != [hb, dn]:
        print(f"FIG2 visible {h}: want={[hb, dn]} got={vis}")
        fail = 1

# --- Data table -----------------------------------------------------------
for name, fires in G.items():
    if f"| {name} |" not in text:
        print(f"TABLE row missing: {name}")
        fail = 1

# --- Confidentiality ------------------------------------------------------
LEAK = re.compile(r"Muqsit|muqsit|yosemite|mac-mini|\bzion\b|winbox|win-mini|pinnacles"
                  r"|/Users/|/home/[a-z]|100\.\d+\.\d+\.\d+|@(?:gmail|icloud|swarmify|prix|getrush)")
for i, line in enumerate(text.splitlines(), 1):
    if LEAK.search(line):
        print(f"LEAK {MD}:{i}: {line.strip()[:90]}")
        fail = 1

# Prose numbers: drift landed in sentences twice after the figures were generated, so the
# recognizer reads prose too. Each entry is a claim the page makes in words and the snapshot value
# it must equal.
PRE = sum(v["fires"] for k, v in SNAP["guards"].items() if k != "verify-work-complete")
STOP = SNAP["guards"]["verify-work-complete"]
CLAIMS = [
    (rf"13 guards · {PRE:,} fires", f"PreToolUse lane header must read {PRE:,}"),
    (rf"13 guards that fired {SNAP['total_hook_fires']:,} times", "story total"),
    (rf"denied {SNAP['classifier_total']:,} tool calls", "classifier total in prose"),
    (rf"all 13 PreToolUse guards combined \({PRE:,}\)", "classifier-vs-guards comparison"),
    (rf"{STOP['fires']} fires over just {STOP['sessions']} sessions", "stop-gate headline"),
    (r"Three of them are peaceful", "3 of 5 lifecycle moments are peaceful"),
]
for pat, why in CLAIMS:
    if not re.search(pat, text):
        print(f"PROSE: {why} — no match for /{pat}/")
        fail = 1

# A claim of the form "<n> ms" in the latency section must equal the summed bars.
fig5 = re.search(r"Figure 5.*?</svg>", text, re.S)
if fig5:
    bars = [int(x) for x in re.findall(r">(\d+) ms</text>", fig5.group(0))]
    if bars:
        total = sum(bars)
        if not re.search(rf"pays {total} ms", text):
            print(f"PROSE: bars sum to {total} ms but no 'pays {total} ms' claim found")
            fail = 1
        if re.search(rf"\b{total - 1} ms added|\b{total + 1} ms added", text):
            print(f"PROSE: an off-by-one 'ms added' claim survives next to a {total} ms sum")
            fail = 1

print("VERIFY FAILED" if fail else "figures, tables AND prose agree; no identifiers leak")
sys.exit(fail)
