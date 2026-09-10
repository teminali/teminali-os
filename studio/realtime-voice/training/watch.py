#!/usr/bin/env python3
"""Live view of a training run: parse `runs/<name>.log`, serve it on localhost.

Stdlib only, no notebook, no deps. `train.py` prints everything needed already;
this just reads the log it is writing and draws it.

    python watch.py --name r1 --port 8765     -> http://localhost:8765
"""

# The same shadowing trap `train.py` documents, and http.server walks straight
# into it: http.server -> socket -> selectors -> `select`, which in this
# directory is `training/select.py`. Drop our own directory and step out of it.
import sys as _sys, os as _os
_here = _os.path.dirname(_os.path.abspath(__file__))
_sys.path = [p for p in _sys.path if _os.path.abspath(p or ".") != _here]
_os.chdir(_os.path.dirname(_here))

import argparse
import json
import re
from collections import Counter
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

R = Path(_here)

TRAIN_RE = re.compile(
    r"Iter (\d+): Train loss ([\d.]+), Learning Rate ([\d.e+-]+), "
    r"It/sec ([\d.]+), Tokens/sec ([\d.]+), Trained Tokens (\d+), Peak mem ([\d.]+)")
VAL_RE = re.compile(r"Iter (\d+): Val loss ([\d.]+), Val took ([\d.]+)s")
ITERS_RE = re.compile(r"Starting training\.\.\., iters: (\d+)")
DONE_RE = re.compile(r"Saved final weights to (.+)")


def _modal_delta(xs):
    """The most common gap between consecutive values, or 0 if there is no gap yet.

    Modal and not mean, because a run's first and last reports are often off the
    cadence -- the final iteration reports whether or not it lands on the interval.
    """
    deltas = [b - a for a, b in zip(xs, xs[1:]) if b > a]
    return Counter(deltas).most_common(1)[0][0] if deltas else 0


def parse(log, name):
    now = time.time()
    out = {"name": name, "train": [], "val": [], "iters": 0, "done": None,
           "exists": log.exists(), "mtime": 0, "since": 0.0, "size": 0}
    if not log.exists():
        return out
    st = log.stat()
    out["mtime"] = st.st_mtime
    out["size"] = st.st_size
    # seconds since the log last grew -- the client extrapolates from this, so the
    # bar moves at the measured rate instead of standing still for a whole report
    # interval. Sent from the server so a clock skew in the browser cannot show a
    # negative age.
    out["since"] = max(0.0, now - st.st_mtime)
    text = log.read_text(errors="replace")
    if m := ITERS_RE.search(text):
        out["iters"] = int(m.group(1))
    for m in TRAIN_RE.finditer(text):
        out["train"].append({
            "it": int(m.group(1)), "loss": float(m.group(2)), "lr": float(m.group(3)),
            "it_s": float(m.group(4)), "tok_s": float(m.group(5)),
            "tokens": int(m.group(6)), "mem": float(m.group(7))})
    for m in VAL_RE.finditer(text):
        out["val"].append({"it": int(m.group(1)), "loss": float(m.group(2)),
                           "took": float(m.group(3))})

    # What the client needs to say when the next log line is due, measured rather
    # than assumed. The old estimate hardcoded a 10-iteration report interval and
    # ignored validation entirely, so under `--steps-per-report 1` it was wrong by
    # 10x and a validation pause drove it to a stuck "next in 0s".
    #
    #   step        iterations between train reports -- `--steps-per-report`, read
    #               off the log rather than the flag, so it is right even if the
    #               run was launched by hand with something else.
    #   eval_every  iterations between validation passes, from the val lines, and
    #               ignoring BOTH the pass at iteration 1 and the one at the final
    #               iteration -- every run does those whatever the interval is, and
    #               including them reads r2's [1, 25, 32] as an interval of 7. A
    #               short run is then left with too few points to say, which reports
    #               0 and drops the validation term: unknown, rather than wrong.
    #   val_took    the last measured validation pause, in seconds. This is the
    #               term the old estimate was missing.
    out["step"] = _modal_delta([r["it"] for r in out["train"]]) or 1
    out["eval_every"] = _modal_delta(
        [r["it"] for r in out["val"] if 1 < r["it"] < out["iters"]])
    out["val_took"] = out["val"][-1]["took"] if out["val"] else 0.0
    if m := DONE_RE.search(text):
        out["done"] = m.group(1)
    # the run.json train.py writes when it finishes
    rj = R / "runs" / name / "run.json"
    if rj.exists():
        try:
            meta = json.loads(rj.read_text())
            out["meta"] = {k: meta.get(k) for k in
                           ("iters", "batch_size", "layers", "rank", "lr", "optimizer",
                            "n_train", "n_valid", "max_seq_length", "wall_seconds")}
        except Exception:                                   # noqa: BLE001
            pass
    return out


PAGE = """<!doctype html><meta charset=utf-8><title>Temi LoRA — __NAME__</title>
<style>
:root{--bg:#0d0f0e;--fg:#d7e3dc;--dim:#6d7d75;--line:#1d2320;--green:#5fd39a;--teal:#4fb3c4;--amber:#d8a657}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:28px}
h1{font-size:15px;font-weight:600;margin:0 0 2px;letter-spacing:.02em}
.sub{color:var(--dim);font-size:12px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin-bottom:22px}
.card{background:#121614;border:1px solid var(--line);border-radius:7px;padding:11px 13px}
.k{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.09em}
.v{font-size:19px;margin-top:3px;font-variant-numeric:tabular-nums}
.bar{height:5px;background:var(--line);border-radius:3px;overflow:hidden;margin:14px 0 22px}
.fill{height:100%;background:linear-gradient(90deg,var(--teal),var(--green));transition:width .4s}
svg{width:100%;height:300px;background:#121614;border:1px solid var(--line);border-radius:7px}
.legend{color:var(--dim);font-size:11px;margin-top:9px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle;margin-right:5px}
.done{color:var(--green)} .live{color:var(--amber)}
table{border-collapse:collapse;margin-top:22px;font-size:12px;width:100%}
td,th{padding:4px 12px 4px 0;text-align:right;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:400;font-size:10px;text-transform:uppercase;letter-spacing:.08em}
td:first-child,th:first-child{text-align:left}
</style>
<h1>Temi LoRA &mdash; run __NAME__</h1>
<div class=sub id=sub>connecting&hellip;</div>
<div class=grid id=cards></div>
<div class=bar><div class=fill id=fill style="width:0%"></div></div>
<svg id=chart viewBox="0 0 800 300" preserveAspectRatio=none></svg>
<div class=legend><span class=dot style="background:var(--green)"></span>train loss
&nbsp;&nbsp;<span class=dot style="background:var(--teal)"></span>val loss</div>
<table id=tbl></table>
<script>
const NS='http://www.w3.org/2000/svg';
function el(n,a){const e=document.createElementNS(NS,n);for(const k in a)e.setAttribute(k,a[k]);return e}
function draw(d){
  const c=document.getElementById('chart');c.innerHTML='';
  const pts=d.train,vs=d.val;if(!pts.length)return;
  const W=800,H=300,P=38;
  const xs=[...pts.map(p=>p.it),...vs.map(p=>p.it)],ys=[...pts.map(p=>p.loss),...vs.map(p=>p.loss)];
  const x0=0,x1=Math.max(d.iters||1,...xs),y0=0,y1=Math.max(...ys)*1.08;
  const X=v=>P+(v-x0)/(x1-x0||1)*(W-P-14), Y=v=>H-P-(v-y0)/(y1-y0||1)*(H-P-16);
  for(let i=0;i<=4;i++){const v=y1*i/4,y=Y(v);
    c.appendChild(el('line',{x1:P,x2:W-14,y1:y,y2:y,stroke:'#1d2320'}));
    const t=el('text',{x:4,y:y+4,fill:'#6d7d75','font-size':10});t.textContent=v.toFixed(1);c.appendChild(t)}
  const path=pts.map((p,i)=>(i?'L':'M')+X(p.it)+' '+Y(p.loss)).join(' ');
  c.appendChild(el('path',{d:path,fill:'none',stroke:'#5fd39a','stroke-width':2}));
  pts.forEach(p=>c.appendChild(el('circle',{cx:X(p.it),cy:Y(p.loss),r:2.5,fill:'#5fd39a'})));
  vs.forEach(p=>c.appendChild(el('circle',{cx:X(p.it),cy:Y(p.loss),r:4,fill:'#4fb3c4'})));
  if(vs.length>1){const vp=vs.map((p,i)=>(i?'L':'M')+X(p.it)+' '+Y(p.loss)).join(' ');
    c.appendChild(el('path',{d:vp,fill:'none',stroke:'#4fb3c4','stroke-width':1.5,'stroke-dasharray':'4 3'}))}
  [0,x1].forEach(v=>{const t=el('text',{x:X(v),y:H-16,fill:'#6d7d75','font-size':10,
    'text-anchor':v?'end':'start'});t.textContent=v;c.appendChild(t)});
}
function card(k,v){return `<div class=card><div class=k>${k}</div><div class=v>${v}</div></div>`}
async function tick(){
  let d;try{d=await(await fetch('/data')).json()}catch(e){return}
  if(!d.exists){document.getElementById('sub').textContent='no log yet at runs/'+d.name+'.log';return}
  const last=d.train[d.train.length-1],lastv=d.val[d.val.length-1];
  const it=last?last.it:0,pct=d.iters?100*it/d.iters:0;
  d.elapsed_total=(last?last.it/(last.it_s||0.15):0)+d.since;
  D=d;T=performance.now();                                 // hand it to the ticker
  document.getElementById('cards').innerHTML=
     card('train loss',last?last.loss.toFixed(3):'&mdash;')
    +card('val loss',lastv?lastv.loss.toFixed(3):'&mdash;')
    +card('progress','<span id=pctcard>'+pct.toFixed(1)+'%</span>')
    +card('elapsed','<span id=elapsed>&mdash;</span>')
    +card('it/sec',last?last.it_s.toFixed(3):'&mdash;')
    +card('tok/sec',last?last.tok_s.toFixed(1):'&mdash;')
    +card('peak mem',last?last.mem.toFixed(2)+' GB':'&mdash;')
    +card('trained tokens',last?last.tokens.toLocaleString():'&mdash;')
    +card('lr',last?last.lr.toExponential(0):'&mdash;');
  draw(d);
  const rows=d.train.slice().reverse().slice(0,12);
  document.getElementById('tbl').innerHTML=
    '<tr><th>iter</th><th>train loss</th><th>it/s</th><th>tok/s</th><th>peak GB</th></tr>'
    +rows.map(p=>`<tr><td>${p.it}</td><td>${p.loss.toFixed(3)}</td><td>${p.it_s.toFixed(3)}</td>`
    +`<td>${p.tok_s.toFixed(1)}</td><td>${p.mem.toFixed(2)}</td></tr>`).join('');
}
let D=null,T=0;
function fmt(x){const m=Math.floor(x/60),sec=Math.floor(x%60);return m+'m '+String(sec).padStart(2,'0')+'s'}
function frame(){
  if(!D||!D.train.length){requestAnimationFrame(frame);return}
  const last=D.train[D.train.length-1];
  const age=D.since+(performance.now()-T)/1000;          // seconds since last log line
  const rate=last.it_s||0.15;
  const est=D.done?D.iters:Math.min(D.iters,last.it+age*rate);
  const pct=D.iters?100*est/D.iters:0;
  document.getElementById('fill').style.width=pct.toFixed(2)+'%';
  const left=Math.max(0,(D.iters-est)/rate);
  // When the next log line is due: one report interval at the measured rate, plus
  // the validation pause if a validation pass falls inside that interval. Without
  // the second term this sticks at zero every time validation runs.
  function nextIn(){
    const step=D.step||1;
    let gap=step/rate;
    const ev=D.eval_every||0;
    if(ev && Math.floor(last.it/ev) < Math.floor((last.it+step)/ev)) gap+=D.val_took||0;
    return gap;
  }
  document.getElementById('sub').innerHTML=D.done
    ? '<span class=done>&#9679; finished</span> &mdash; adapter at '+D.done
    : '<span class=live>&#9679; training</span> &mdash; iteration <b>'+est.toFixed(1)
      +'</b> of '+D.iters+' &nbsp;&middot;&nbsp; '+fmt(left)+' left'
      +' &nbsp;&middot;&nbsp; <span style="color:var(--dim)">last log line '
      +age.toFixed(0)+'s ago, next in '+Math.max(0,nextIn()-age).toFixed(0)+'s</span>';
  document.getElementById('pctcard').innerHTML=pct.toFixed(1)+'%';
  document.getElementById('elapsed').innerHTML=fmt(D.elapsed_total+(performance.now()-T)/1000);
  requestAnimationFrame(frame);
}
tick();setInterval(tick,1000);requestAnimationFrame(frame);
</script>"""


class Handler(BaseHTTPRequestHandler):
    name = "r1"

    def _send(self, body, ctype):
        body = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/data"):
            self._send(json.dumps(parse(R / "runs" / f"{self.name}.log", self.name)),
                       "application/json")
        else:
            self._send(PAGE.replace("__NAME__", self.name), "text/html; charset=utf-8")

    def log_message(self, *a):
        pass


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--name", default="r1")
    p.add_argument("--port", type=int, default=8765)
    a = p.parse_args()
    Handler.name = a.name
    log = R / "runs" / f"{a.name}.log"
    print(f"  watching {log}")
    print(f"  http://localhost:{a.port}\n")
    HTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
