#!/usr/bin/env python
"""Export an MLX LoRA adapter as a GGUF adapter Ollama can apply to a GGUF base.

    python export_adapter_gguf.py --run runs/r2 --out runs/r2/temi-r2-lora.gguf

Why this exists: the trained artefact is fp16 MLX, but production serves a
quantised GGUF through Ollama. The obvious route -- `mlx_lm.fuse --dequantize`
into fp16 safetensors, then llama.cpp's convert_hf_to_gguf.py, then quantise --
needs ~25GB of scratch for an 8B model and llama.cpp tooling that is not
installed. This route needs neither: the adapter is 19MB, and llama.cpp applies
`(alpha/rank) * B @ A` to the base weights at runtime, so the base blob Ollama
already has is reused untouched.

The arithmetic is the same arithmetic. mlx_lm/tuner/lora.py:52 fuses with

    delta = (scale * lora_b.T) @ lora_a.T          # [out, in]

and llama.cpp's build_lora_mm adds `(alpha/rank) * lora_b @ lora_a`, where GGUF
`lora_a` is [rank, in] and `lora_b` is [out, rank]. So the transposes below are
the whole conversion, and alpha is pinned to `scale * rank` to make
`alpha/rank == scale`. Anything that changes MLX's `scale` must change here too.
"""

# `training/select.py` shadows the stdlib `select` module; see train.py's note.
# Nothing here imports a sibling module, so dropping sys.path[0] is the fix.
import sys as _sys, os as _os
_here = _os.path.dirname(_os.path.abspath(__file__))
_sys.path = [p for p in _sys.path if _os.path.abspath(p or ".") != _here]
_os.chdir(_os.path.dirname(_here))

import argparse
import json
from pathlib import Path

import gguf
import numpy as np
from safetensors import safe_open

R = Path(__file__).resolve().parent


def base_config(repo: str) -> dict:
    """config.json for the base the adapter was trained against, from cache."""
    p = Path(repo) / "config.json"
    if p.exists():
        return json.loads(p.read_text())
    from huggingface_hub import hf_hub_download  # offline: resolves the cache

    return json.loads(Path(hf_hub_download(repo, "config.json")).read_text())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run", required=True, help="an MLX adapter dir, e.g. runs/r2")
    ap.add_argument("--out", default=None, help="output .gguf (default: <run>/adapter.gguf)")
    ap.add_argument("--weights", default="adapters.safetensors", help="which checkpoint in --run")
    args = ap.parse_args()

    run = (R / args.run) if not _os.path.isabs(args.run) else Path(args.run)
    cfg = json.loads((run / "adapter_config.json").read_text())
    lp = cfg["lora_parameters"]
    rank, scale = int(lp["rank"]), float(lp["scale"])
    alpha = scale * rank  # llama.cpp divides by rank; this makes it agree with MLX

    bc = base_config(cfg["model"])
    arch = gguf.MODEL_ARCH_NAMES and bc["model_type"]
    arch_enum = next(k for k, v in gguf.MODEL_ARCH_NAMES.items() if v == arch)
    n_layers = int(bc["num_hidden_layers"])
    names = gguf.get_tensor_name_map(arch_enum, n_layers)

    # the guard above chdir'd out of training/, so resolve like --run did
    out = run / "adapter.gguf"
    if args.out:
        out = Path(args.out) if _os.path.isabs(args.out) else R / args.out
    w = gguf.GGUFWriter(path=None, arch=arch)
    w.add_type(gguf.GGUFType.ADAPTER)
    w.add_string(gguf.Keys.Adapter.TYPE, "lora")
    w.add_float32(gguf.Keys.Adapter.LORA_ALPHA, alpha)

    n = 0
    with safe_open(str(run / args.weights), "numpy") as f:
        for k in sorted(f.keys()):
            if k.endswith(".lora_a"):
                stem, suffix = k[: -len(".lora_a")], "lora_a"  # [in, r] -> [r, in]
            elif k.endswith(".lora_b"):
                stem, suffix = k[: -len(".lora_b")], "lora_b"  # [r, out] -> [out, r]
            else:
                raise SystemExit(f"not a LoRA tensor: {k}")
            dest = names.get_name(stem + ".weight", try_suffixes=(".weight",))
            if dest is None:
                raise SystemExit(f"no GGUF name for {stem} under arch {arch}")
            t = np.ascontiguousarray(f.get_tensor(k).T.astype(np.float32))
            w.add_tensor(f"{dest}.{suffix}", t)  # dest already ends in .weight
            n += 1

    w.write_header_to_file(path=out)
    w.write_kv_data_to_file()
    w.write_tensors_to_file(progress=False)
    w.close()
    print(f"{out}  arch={arch} layers={n_layers} tensors={n} rank={rank} alpha={alpha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
