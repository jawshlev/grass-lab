# Grass Lab

Stylized, flat-shaded grass in three.js TSL, ported from a Blender material.

```
npm run dev   # serves on http://localhost:5173 (no install or build needed)
```

- `index.html`: the lab (Tuned preset loads by default; `#webgl` forces WebGL 2)
- `v1/index.html`: the first shader, frozen
- `js/grassMaterial.js`: the material to reuse in an R3F project
- `CLAUDE.md`: full context, decisions and gotchas (read this first)

## Deploy to GitHub Pages

The site is static, with no build step: three.js loads from jsDelivr, and every local
path is relative, so it works at `https://<user>.github.io/<repo>/`.

1. Create a GitHub repo and push this folder to its `main` branch:
   ```
   git init -b main
   git add .
   git commit -m "Grass Lab"
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
2. On GitHub, open **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Each push to `main` runs `.github/workflows/pages.yml`, which publishes the lab.
   It ships only the runtime files (`index.html`, `js/`, `presets/`, `v1/`,
   `assets/grass_normal.png`). The Blender sources and reference images stay in the
   repo but aren't deployed.

Live URLs once deployed:

- `https://<user>.github.io/<repo>/`: the lab
- `https://<user>.github.io/<repo>/#webgl`: forced WebGL 2
- `https://<user>.github.io/<repo>/v1/`: the frozen first version

If you'd rather not use Actions, set **Source** to **Deploy from a branch** (`main`, `/ (root)`)
instead. That works too (`.nojekyll` is already there), but it also publishes `assets/source/`
and `reference/`, about 11 MB that the page never loads.

WebGPU needs a secure context, which Pages provides over HTTPS. Browsers without WebGPU
fall back to WebGL 2 automatically.
