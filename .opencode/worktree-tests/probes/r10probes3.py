#!/usr/bin/env python3
import os
import subprocess

BASE = "/tmp/user/1000/opencode/typecheck/r10probes3"
os.makedirs(BASE, exist_ok=True)
NL = chr(10).encode()
BS = chr(92).encode()
SQ = chr(39).encode()
DQ = chr(34).encode()
BT = chr(96).encode()
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
    print(
        f"{name}: rc={r.returncode} marker={'LIVE' if os.path.exists(marker) else 'DEAD'}"
        f" stderr={r.stderr.decode(errors='replace').strip()[:80]!r}"
    )


C = b"cat it's" + NL
for tag, raw in (("01", C1), ("7f", DEL)):
    single = b"E" + raw + b"OF"
    esc = b"E" + C1 + raw + b"OF"
    # single-quoted chunk
    w = b"cat <<" + SQ + b"E" + raw + b"OF" + SQ + NL + C
    probe(f"sq{tag}-esc", w + esc + NL + payload(f"sq{tag}-esc"))
    probe(f"sq{tag}-single", w + single + NL + payload(f"sq{tag}-single"))
    # backslash-escaped raw char in plain word
    w = b"cat <<E" + BS + raw + b"OF" + NL + C
    probe(f"esc{tag}-esc", w + esc + NL + payload(f"esc{tag}-esc"))
    probe(f"esc{tag}-single", w + single + NL + payload(f"esc{tag}-single"))
    # raw char inside a $(...) span in the word
    w = b"cat <<$(echo E" + raw + b"OF)" + NL + C
    probe(f"span{tag}-esc", w + b"$(echo " + esc + b")" + NL + payload(f"span{tag}-esc"))
    probe(f"span{tag}-single", w + b"$(echo " + single + b")" + NL + payload(f"span{tag}-single"))
    # raw char inside a backtick span in the word
    w = b"cat <<" + BT + b"echo E" + raw + b"OF" + BT + NL + C
    probe(f"bt{tag}-esc", w + BT + b"echo " + esc + BT + NL + payload(f"bt{tag}-esc"))
    probe(f"bt{tag}-single", w + BT + b"echo " + single + BT + NL + payload(f"bt{tag}-single"))

# --- \c\n : literal-target model predicts 0x1c + 'n'; recursion model predicts 0x0a
w = b"cat <<$" + SQ + b"E" + BS + b"c" + BS + b"nOF" + SQ + NL + C
probe("cn-1cn", w + b"E" + ESC + b"nOF" + NL + payload("cn-1cn"))
probe("cn-0a", w + b"E" + chr(10).encode() + b"OF" + NL + payload("cn-0a"))
