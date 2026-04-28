```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = url.pathname.replace(/^\//, "");

    if (!key) return new Response("Not found", { status: 404 });

    // 1. Check Cloudflare Cache first
    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;
    let response = await cache.match(cacheKey);

    if (response) {
      return new Response(response.body, {
        ...response,
        headers: { ...Object.fromEntries(response.headers), "X-Cache": "HIT" },
      });
    }

    // 2. Fetch from R2
    const object = await env.SPLINE_BUCKET.get(key);
    if (!object) return new Response("Asset not found", { status: 404 });

    const headers = new Headers();

    const ext = key.split(".").pop().toLowerCase();
    const mimeTypes = {
      splinecode: "application/octet-stream",
      spline:     "application/octet-stream",
      glb:        "model/gltf-binary",
      gltf:       "model/gltf+json",
      bin:        "application/octet-stream",
      png:        "image/png",
      jpg:        "image/jpeg",
      jpeg:       "image/jpeg",
      webp:       "image/webp",
      ktx2:       "image/ktx2",
      basis:      "application/octet-stream",
    };

    headers.set("Content-Type", mimeTypes[ext] ?? "application/octet-stream");

    // 3. Cache headers (aggressive — models are immutable)
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("CDN-Cache-Control", "max-age=31536000");
    headers.set("Cloudflare-CDN-Cache-Control", "max-age=31536000");

    // CORS
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Vary", "Origin");

    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Cache", "MISS");

    if (object.etag) headers.set("ETag", object.etag);
    object.writeHttpMetadata(headers);

    const responseToCache = new Response(object.body, { headers });
    ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

    return responseToCache;
  },
};
```