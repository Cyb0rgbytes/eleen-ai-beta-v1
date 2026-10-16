# infra

Configuration that lives in Cloudflare, kept here for reference.

## `r2-cors.json`

CORS rules for the `spline-assets` R2 bucket, which serves the 3D scene at `assets.eleenai.xyz`.

**This file is not applied automatically and does not match the live bucket.** It allows `http://localhost:8787`, but in practice the scene fails CORS from local dev (see `docs/status/Mid-August.md`). Treat the dashboard as the source of truth. To apply this file deliberately:

```
npx wrangler r2 bucket cors set spline-assets --file infra/r2-cors.json
```

## `../assets/scene/r_4_x_bot.splinecode`

The source copy of the scene. Byte-identical to the object R2 serves as of 2026-10-17. Upload a new version to R2 when it changes; the page loads it from `https://assets.eleenai.xyz/r_4_x_bot.splinecode`.
