# Cursor reference captures

The four screenshots this design system was measured from: Cursor's agent
window on macOS, captured at 2× on a 1512×950 logical window.

| File | State |
| --- | --- |
| `empty.png` | New chat — pickers, tall composer, outline pills |
| `plan.png` | Mid-turn — "Planning next moves" |
| `think.png` | Mid-turn — tool call running |
| `answer.png` | Settled reply — user bubble, table, follow-up composer |

Every value in `src/styles/tokens.css` marked `measured` came off these files.
To check a change, render the app at the same size and compare pixels rather
than impressions: the differences that matter here are 1–3 values of grey and
1–2px of geometry, and neither survives being eyeballed.

Sampling a colour:

```py
from PIL import Image
im = Image.open("answer.png").convert("RGB")
# logical coords -> physical: x*2, y*2
print("#%02x%02x%02x" % im.getpixel((170*2, 600*2)))   # sidebar -> #181818
```
