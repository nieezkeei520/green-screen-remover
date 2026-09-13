# Parameter reference — chroma key engine

All processing is per-pixel in the browser. For every pixel we compute its
**color similarity** to the selected key color, then turn that into an alpha
value. Three user-facing sliders control the result; the key color is set with
the eyedropper or the green/blue presets.

## Color similarity

`colorSimilarity(r, g, b, key)` is the Euclidean distance between the pixel and
the key color in RGB space, normalized to `0..1`:

```
dist   = sqrt((r-key.r)^2 + (g-key.g)^2 + (b-key.b)^2)
similarity = dist / (sqrt(3) * 255)   // ≈ dist / 441.673
```

- `0`  → pixel is identical to the key color (should be removed)
- `1`  → pixel is as far from the key as possible (keep it)

## `threshold` — similarity fraction, `0..1` (default `0.18`)

The core cut line. After computing `sim` for a pixel:

```
if      sim <= threshold            -> alpha = 0     (fully removed)
else if sim >= threshold + SOFT      -> alpha = 255   (fully kept)
else                                 -> alpha = (sim - threshold) / SOFT * 255   (ramp)
```

`SOFT = 0.06` is a built-in anti-alias ramp (in similarity units), so the edge
between kept and removed pixels is gradually transparent instead of a hard 1px
staircase.

- **Lower threshold** → only colors very close to the key are removed (tighter
  key, keeps more of the subject).
- **Higher threshold** → more colors are treated as background (looser key,
  may eat into the subject).

## `smooth` — edge smoothing radius, pixels (default `4`)

A separable box blur applied to the alpha channel after the cut. It softens the
matte edge so hair and fine detail don't look like a hard cut-out. Higher = softer
edge. Implemented as a two-pass running-sum box blur (O(width·height)).

## `shrink` — edge shrink radius, pixels (default `2`)

A separable morphological **erosion** (min-filter) applied to the alpha channel.
It pulls the opaque region inward by `r` pixels, which removes the thin green
halo/fringe that sits just outside the subject. Higher = more aggressive fringe
removal, but very thin subject detail (single-pixel hairs) can be eaten away.

> Note: erosion removes the *fringe* but does not *desaturate* it. Pixels that
> stay semi-transparent still carry their original green channel. A dedicated
> spill-suppression pass is a known future improvement.

## `keyColor` — the chroma key color (default green `{0,255,0}`)

Set with the eyedropper (click the preview to sample a color) or the green/blue
presets. Works for any solid backdrop color, not only green/blue.

## Output

| Mode   | Output | Notes |
|--------|--------|-------|
| image  | transparent PNG | one still frame |
| video  | transparent WebM (VP8/VP9, alpha) | if the browser supports `MediaRecorder` alpha |
| video  | PNG-sequence `.zip` | fallback when transparent WebM is unavailable; one PNG per frame at 30 fps |

## Pipeline order

1. Compute alpha from `threshold` (+ `SOFT` ramp).
2. If `shrink > 0`: erode alpha.
3. If `smooth > 0`: box-blur alpha.
4. Bake alpha into the RGBA output; RGB values are unchanged (no despill).
