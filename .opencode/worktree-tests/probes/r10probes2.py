#!/usr/bin/env python3
import os
import subprocess

BASE = "/tmp/user/1000/opencode/typecheck/r10probes2"
os.makedirs(BASE, exist_ok=True)
NL = chr(10).encode()
BS = chr(92).encode()
SQ = chr(39).encode()
DQ = chr(34).encode()
C1 = chr(1).encode()
DEL = chr(127).encode()
BEL = chr(7).encode()
ESC = chr(28).encode()


def payload(name: str) -> bytes:
    return (
        b"touch "
        + BASE.encode()
        + b"/marker-"
        + name.encode()
        + b' && echo "EXEC-'
        + name.encode()
        + DQ
        + NL
    )


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
        f" stderr={r.stderr.decode(errors='replace').strip()[:90]!r}"
    )


C = b"cat it's" + NL
# --- \c\c' : candidates BEL vs 0x1c+c vs 0x1c
w = b"cat <<$" + SQ + b"E" + BS + b"c" + BS + b"c" + SQ + NL + C
probe("cc-bel", w + b"E" + BEL + NL + payload("cc-bel"))
probe("cc-1cc", w + b"E" + ESC + b"c" + NL + payload("cc-1cc"))
probe("cc-1c", w + b"E" + ESC + NL + payload("cc-1c"))
# --- \c\' : candidates BEL vs 0x1c vs 0x1c'
w = b"cat <<$" + SQ + b"E" + BS + b"c" + BS + SQ + SQ + NL + C
probe("cq-bel", w + b"E" + BEL + NL + payload("cq-bel"))
probe("cq-1c", w + b"E" + ESC + NL + payload("cq-1c"))
probe("cq-1cq", w + b"E" + ESC + SQ + NL + payload("cq-1cq"))
# --- raw 0x01/0x7f in plain (unquoted) and dq word parts
for tag, raw, line_esc, line_single in (
    ("01", C1, lambda: b"E" + C1 + C1 + b"OF", lambda: b"E" + C1 + b"OF"),
    ("7f", DEL, lambda: b"E" + C1 + DEL + b"OF", lambda: b"E" + DEL + b"OF"),
):
    w_plain = b"cat <<E" + raw + b"OF" + NL + C
    w_dq = b"cat <<" + DQ + b"E" + raw + b"OF" + DQ + NL + C
    probe(f"plain{tag}-esc", w_plain + line_esc() + NL + payload(f"plain{tag}-esc"))
    probe(f"plain{tag}-single", w_plain + line_single() + NL + payload(f"plain{tag}-single"))
    probe(f"dq{tag}-esc", w_dq + line_esc() + NL + payload(f"dq{tag}-esc"))
    probe(f"dq{tag}-single", w_dq + line_single() + NL + payload(f"dq{tag}-single"))
