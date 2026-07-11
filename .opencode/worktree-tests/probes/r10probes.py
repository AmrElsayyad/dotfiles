#!/usr/bin/env python3
"""Round-9v/10 clean-room bash ground-truth probes (marker technique)."""
import os
import subprocess

BASE = "/tmp/user/1000/opencode/typecheck/r10probes"
os.makedirs(BASE, exist_ok=True)

C1 = b"\x01"
DEL = b"\x7f"
BEL = b"\x07"


def payload(name: str) -> bytes:
    return b"touch " + BASE.encode() + b"/marker-" + name.encode() + b' && echo "EXEC-' + name.encode() + b'"\n'


def probe(name: str, body: bytes) -> None:
    path = os.path.join(BASE, name + ".sh")
    with open(path, "wb") as f:
        f.write(body)
    marker = os.path.join(BASE, "marker-" + name)
    if os.path.exists(marker):
        os.unlink(marker)
    r = subprocess.run(["bash", name + ".sh"], cwd=BASE, capture_output=True)
    marker_exists = os.path.exists(marker)
    print(
        f"{name}: rc={r.returncode} marker={'LIVE' if marker_exists else 'DEAD'}"
        f" stderr={r.stderr.decode(errors='replace').strip()[:100]!r}"
    )


# ---------- Family A: substitution-newline early heredoc trigger ----------
probe("r9x", b'cat <<"cat x)" $(echo\ncat x)\ncat it\'s\ncat x)\n' + payload("r9x"))
probe("r9xbt", b'cat <<"cat x)" `echo\ncat x`\ncat it\'s\ncat x)\n' + payload("r9xbt"))
probe("r9x2", b'cat <<"pwd)" $(echo\npwd)\ncat it\'s\npwd)\n' + payload("r9x2"))
probe("r9xctl", b'cat <<"cat x)" x\ncat x)\ncat it\'s\ncat x)\n' + payload("r9xctl"))

# ---------- Family B: bare \c at chunk end ----------
probe("c1", b"cat <<$'\\c'\ncat it's\n\\c\n" + payload("c1"))
probe("c1x", b"cat <<$'\\c'X\ncat it's\n\\cX\n" + payload("c1x"))
probe("c1-neg-bel", b"cat <<$'\\c'\ncat it's\n" + BEL + b"\n" + payload("c1-neg-bel"))
probe("c1-neg-c", b"cat <<$'\\c'\ncat it's\nc\n" + payload("c1-neg-c"))
probe("c1-neg-empty", b"cat <<$'\\c'\ncat it's\n\n" + payload("c1-neg-empty"))
probe("c-mid", b"cat <<$'a\\c'\ncat it's\na\\c\n" + payload("c-mid"))

# ---------- Family C: CTLESC/CTLNUL meta-quoting ----------
probe("ca-double", b"cat <<$'E\\cAOF'\ncat it's\nE" + C1 + C1 + b"OF\n" + payload("ca-double"))
probe("ca-single", b"cat <<$'E\\cAOF'\ncat it's\nE" + C1 + b"OF\n" + payload("ca-single"))
probe("cb-single", b"cat <<$'E\\cBOF'\ncat it's\nE\x02OF\n" + payload("cb-single"))
probe("cb-double", b"cat <<$'E\\cBOF'\ncat it's\nE\x02\x02OF\n" + payload("cb-double"))
probe("cz-single", b"cat <<$'E\\czOF'\ncat it's\nE\x1aOF\n" + payload("cz-single"))
probe("x01-double", b"cat <<$'E\\x01OF'\ncat it's\nE" + C1 + C1 + b"OF\n" + payload("x01-double"))
probe("x01-single", b"cat <<$'E\\x01OF'\ncat it's\nE" + C1 + b"OF\n" + payload("x01-single"))
probe("x7f-esc", b"cat <<$'E\\x7fOF'\ncat it's\nE" + C1 + DEL + b"OF\n" + payload("x7f-esc"))
probe("x7f-single", b"cat <<$'E\\x7fOF'\ncat it's\nE" + DEL + b"OF\n" + payload("x7f-single"))
probe("x7f-double", b"cat <<$'E\\x7fOF'\ncat it's\nE" + DEL + DEL + b"OF\n" + payload("x7f-double"))
probe("oct01-double", b"cat <<$'E\\001OF'\ncat it's\nE" + C1 + C1 + b"OF\n" + payload("oct01-double"))
probe("raw01-double", b"cat <<$'E" + C1 + b"OF'\ncat it's\nE" + C1 + C1 + b"OF\n" + payload("raw01-double"))
probe("raw01-single", b"cat <<$'E" + C1 + b"OF'\ncat it's\nE" + C1 + b"OF\n" + payload("raw01-single"))
probe("raw7f-esc", b"cat <<$'E" + DEL + b"OF'\ncat it's\nE" + C1 + DEL + b"OF\n" + payload("raw7f-esc"))
probe("raw7f-single", b"cat <<$'E" + DEL + b"OF'\ncat it's\nE" + DEL + b"OF\n" + payload("raw7f-single"))
probe("u01-double", b"cat <<$'E\\u0001OF'\ncat it's\nE" + C1 + C1 + b"OF\n" + payload("u01-double"))
probe("u7f-esc", b"cat <<$'E\\u007fOF'\ncat it's\nE" + C1 + DEL + b"OF\n" + payload("u7f-esc"))
probe("lit-001", b"cat <<$'E\\cAOF'\ncat it's\nE\\001OF\n" + payload("lit-001"))

# ---------- accepted bash-dead residuals (re-confirm) ----------
probe("a7e", b"cat <<$'E\\0OF'Y\ncat it's\nE\n" + payload("a7e"))
probe("a7ey", b"cat <<$'E\\0OF'Y\ncat it's\nEY\n" + payload("a7ey"))
probe("nulab0", b"cat <<$'\\0A'B\ncat it's\n\n" + payload("nulab0"))
probe("subnl", b"cat <<$(echo\nEOF)\ncat it's\n" + payload("subnl"))
probe("innerredir", b"cat <<$(echo x <<Y)\ncat it's\n" + payload("innerredir"))
probe("r8c", b"cat <<$(echo <<Y )\ncat it's\n$(echo <<Y )\n" + payload("r8c"))
probe("v400", b"cat <<$'E\\400OF'\ncat it's\nE\n" + payload("v400"))
probe("u-nodigits", b"cat <<$'\\u'\ncat it's\n\\u\n" + payload("u-nodigits"))
probe("u8-nodigits", b"cat <<$'\\U'\ncat it's\n\\U\n" + payload("u8-nodigits"))
probe("b9", b"cat <<EOF\r\ncat it's\nEOF\n" + payload("b9"))
