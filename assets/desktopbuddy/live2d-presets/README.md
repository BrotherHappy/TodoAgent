# Live2D Presets

This folder contains local Live2D assets referenced by `pets/builtin/*/theme.json`.

The app treats these files as official sample or third-party resources, not project-owned character art. Keep source and license metadata in each theme manifest.

Current preset folders:

- `hiyori`: human companion baseline.
- `wanko`: animal companion baseline.
- `rice`: plant / natural spirit baseline.
- `mark`: special lifeform / mascot baseline.
- `haru`: retained compatibility and rendering verification preset.

Run this from the repo root to refresh the official sample presets:

```powershell
npm run fetch:live2d-presets
```

Before packaging or redistribution, review Live2D Sample Data Terms and Cubism SDK/Core license requirements for the intended product scenario.
