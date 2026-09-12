#!/usr/bin/env python
"""Bake a GGUF LoRA adapter into a GGUF base, in place, tensor by tensor.

    python merge_gguf_lora.py --base <base.gguf> --adapter runs/r2/temi-r2-lora.gguf \
                              --out runs/r2/temi-r2-q8ovr.gguf

Why not the standard tooling: Ollama 0.17.4 refuses a runtime LoRA outright
("failed to initialize model: loras are not yet implemented"), so the delta has
to be merged offline. llama.cpp's `llama-export-lora` can read a quantised base
but *forces F16 output* (tools/export-lora/export-lora.cpp:190) -- 16.4GB for an
8B model, plus another 5.2GB to quantise it back down. This machine had ~14GB
free. So this does the merge directly:

  * the tensors the adapter touches (56 of 399: q,k,v,o,gate,up,down on the top
    8 blocks) are dequantised to F32, get `(alpha/rank) * B @ A` added, and are
    re-emitted as Q8_0 -- 0.5% relative RMS error, against Q4_K's 8.7%;
  * every other tensor is copied BYTE-IDENTICALLY, never dequantised.

The result is a mixed-type GGUF, which is normal -- Q4_K_M is itself a mix. It
is also a cleaner experiment than the canonical route: the base cells and the
adapter cells then share bit-identical base weights and differ only by the
delta, instead of differing by a whole extra round of quantisation.

Peak disk is one output file (~6GB) and peak RAM is the re-quantised tensors
(~1.7GB). Note gguf-py can only *dequantise* K-quants; Q8_0 is the best type it
can actually write (see quants.py, `quantize_blocks` raises NotImplementedError
for Q4_K), which is why the touched tensors land at Q8_0 rather than Q4_K.
"""

# `training/select.py` shadows the stdlib `select` module; see train.py's note.
import sys as _sys, os as _os
_here = _os.path.dirname(_os.path.abspath(__file__))
_sys.path = [p for p in _sys.path if _os.path.abspath(p or ".") != _here]
_os.chdir(_os.path.dirname(_here))

import argparse
import time
from pathlib import Path

import gguf
import numpy as np
from gguf import quants

R = Path(__file__).resolve().parent
OVERRIDE = gguf.GGMLQuantizationType.Q8_0


def _resolve(p: str) -> Path:
    return Path(p) if _os.path.isabs(p) else R / p


def read_adapter(path: Path):
    """-> {base tensor name: (A[r,in], B[out,r])}, alpha, rank."""
    r = gguf.GGUFReader(str(path))
    kv = {f.name: f for f in r.fields.values()}
    alpha = float(kv["adapter.lora.alpha"].parts[kv["adapter.lora.alpha"].data[0]][0])
    parts: dict[str, dict[str, np.ndarray]] = {}
    for t in r.tensors:
        if t.name.endswith(".lora_a"):
            parts.setdefault(t.name[: -len(".lora_a")], {})["A"] = np.array(t.data)
        elif t.name.endswith(".lora_b"):
            parts.setdefault(t.name[: -len(".lora_b")], {})["B"] = np.array(t.data)
        else:
            raise SystemExit(f"unexpected adapter tensor {t.name}")
    ranks = {p["A"].shape[0] for p in parts.values()}
    if len(ranks) != 1:
        raise SystemExit(f"mixed ranks in adapter: {ranks}")
    return {k: (v["A"], v["B"]) for k, v in parts.items()}, alpha, ranks.pop()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", required=True, help="base .gguf (e.g. an Ollama blob)")
    ap.add_argument("--adapter", required=True, help="adapter .gguf from export_adapter_gguf.py")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    lora, alpha, rank = read_adapter(_resolve(args.adapter))
    scale = alpha / rank
    base = gguf.GGUFReader(args.base if _os.path.isabs(args.base) else str(_resolve(args.base)))
    arch_f = base.fields[gguf.Keys.General.ARCHITECTURE]
    arch = arch_f.parts[arch_f.data[0]].tobytes().decode()
    print(f"base arch={arch} tensors={len(base.tensors)} | adapter targets={len(lora)} "
          f"alpha={alpha} rank={rank} scale={scale}")

    missing = [k for k in lora if not any(t.name == k for t in base.tensors)]
    if missing:
        raise SystemExit(f"adapter targets absent from base: {missing[:3]}")

    out = _resolve(args.out)
    w = gguf.GGUFWriter(str(out), arch, use_temp_file=False)
    for f in base.fields.values():
        if f.name == gguf.Keys.General.ARCHITECTURE or f.name.startswith("GGUF."):
            continue  # written by GGUFWriter itself
        vt = f.types[0]
        sub = f.types[-1] if vt == gguf.GGUFValueType.ARRAY else None
        w.add_key_value(f.name, f.contents(), vt, sub_type=sub)

    merged: dict[str, np.ndarray] = {}
    t0 = time.time()
    for i, name in enumerate(sorted(lora), 1):
        t = next(x for x in base.tensors if x.name == name)
        A, B = lora[name]
        deq = quants.dequantize(np.array(t.data), t.tensor_type).astype(np.float32)
        delta = (scale * B.astype(np.float32)) @ A.astype(np.float32)
        if delta.shape != deq.shape:
            raise SystemExit(f"{name}: delta {delta.shape} != weight {deq.shape}")
        rel = float(np.linalg.norm(delta) / max(np.linalg.norm(deq), 1e-9))
        merged[name] = quants.quantize(deq + delta, OVERRIDE)
        print(f"  [{i:3d}/{len(lora)}] {name:30s} {t.tensor_type.name:5s}->{OVERRIDE.name} "
              f"|delta|/|W|={rel:.4f}  {time.time()-t0:6.1f}s", flush=True)

    for t in base.tensors:
        if t.name in merged:
            d = merged[t.name]
            w.add_tensor_info(t.name, d.shape, d.dtype, d.nbytes, OVERRIDE)
        else:
            w.add_tensor_info(t.name, t.data.shape, t.data.dtype, t.data.nbytes, t.tensor_type)

    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_ti_data_to_file()
    total = 0
    for t in base.tensors:
        d = merged.get(t.name)
        d = d if d is not None else t.data
        w.write_tensor_data(d, tensor_endianess=base.endianess)
        total += d.nbytes
    w.close()
    print(f"wrote {out}  {total/1e9:.2f}GB  ({time.time()-t0:.0f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
