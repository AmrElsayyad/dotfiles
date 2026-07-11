#!/usr/bin/env python3
import os
import subprocess

BASE = "/tmp/user/1000/opencode/typecheck/r10probes5"
os.makedirs(BASE, exist_ok=True)
NL = chr(10).encode()
BS = chr(92).encode()
SQ = chr(39).encode()


def payload(name: str) -> bytes:
    return b"touch " + BASE.encode() + b"/marker-" + name.encode() + b"\n"


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


# Does a decoded raw high byte 0x80 in a $'…' word get CTLESC-protected?
for hi, label in ((0x80, "80"), (0xFF, "ff")):
    word = b"cat <<$" + SQ + b"E" + BS + b"x" + format(hi, "02x").encode() + b"OF" + SQ + NL
    probe(
        f"v{label}-raw",
        word + b"E" + bytes([hi]) + b"OF" + NL + payload(f"v{label}-raw"),
    )
    probe(
        f"v{label}-dbl",
        word + b"E" + bytes([1, hi]) + b"OF" + NL + payload(f"v{label}-dbl"),
    )
