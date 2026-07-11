#!/usr/bin/env python3
import os
import subprocess

BASE = "/tmp/user/1000/opencode/typecheck/r10probes4"
os.makedirs(BASE, exist_ok=True)
NL = chr(10).encode()
BS = chr(92).encode()
SQ = chr(39).encode()
DQ = chr(34).encode()
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
        f" stderr={r.stderr.decode(errors='replace').strip()[:90]!r}"
    )


# cq2: word `$'cat \c\''` -> bash delimiter `cat` + 0x1c + `'`; terminator line starts `cat `.
# If LIVE, the stock-silent merge shape derived from it is a real bypass.
probe(
    "cq2",
    b"cat <<$" + SQ + b"cat " + BS + b"c" + BS + SQ + SQ + NL
    + b"x" + NL
    + b"cat " + ESC + SQ + NL
    + payload("cq2"),
)
# ccx: `\c\cX` variant — literal-target model predicts 0x1c + `cX`.
probe(
    "ccx-1ccx",
    b"cat <<$" + SQ + b"E" + BS + b"c" + BS + b"cX" + SQ + NL + b"cat it's" + NL
    + b"E" + ESC + b"cX" + NL + payload("ccx-1ccx"),
)
probe(
    "ccx-18",
    b"cat <<$" + SQ + b"E" + BS + b"c" + BS + b"cX" + SQ + NL + b"cat it's" + NL
    + b"E" + chr(24).encode() + NL + payload("ccx-18"),
)
