# greenscreencut — browser-based green screen remover (source)

This repository contains the source code for **Greenscreencut**, a free,
in-browser green-screen / chroma-key remover. The live tool runs at
https://greenscreencut.com.

Everything runs client-side: images and videos are processed in the visitor's
own browser. No uploads, no server, no account, no file size limits.

## What it does

- Remove a green or blue screen from an **image** → transparent PNG
- Remove a green or blue screen from a **video** → transparent WebM
  (VP8/VP9 with an alpha channel) or a zipped PNG-sequence
- Adjustable key color (eyedropper + green/blue presets), similarity
  threshold, edge smoothing, and edge shrink

## Run it

Just open `index.html` in a browser. There is no build step and no
dependencies.

## How the chroma key works

See [docs/parameters.md](docs/parameters.md) for the algorithm and a reference
for every slider.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI markup |
| `style.css`  | Styles |
| `app.js`     | Chroma-key engine (image + video), minimal ZIP writer, UI wiring |
| `docs/parameters.md` | Parameter reference |
| `data/competitor-comparison.csv` | Feature comparison across tools (Sept 2026 live-page audit) |

## Known limitation

The engine computes a per-pixel alpha mask but does **not** desaturate
semi-transparent pixels, so a faint green fringe can remain on soft edges.
This is documented, not hidden.

## License

MIT — see [LICENSE](LICENSE).
