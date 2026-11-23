# PROOF — imagined frames

A single-purpose, Perchance-style image generator: type a prompt, get a picture. No signup, no payment, no build step. The page is one `index.html` file with a film-lab look (dark, grain, tungsten accents). An optional `server.js` can proxy a keyed free-tier API so the key never sits in the browser.

## How to run

Zero setup — static file, talks to Pollinations Classic straight from the browser:

```bash
cd imagegen
python3 -m http.server 8787
# or: node server.js
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Type a prompt (or keep the default), hit **Expose** or press Enter. Shift+Enter adds a new line in the prompt.

`node server.js` also serves the same folder and exposes `/api/health` plus `/api/generate` for the optional keyed path. Opening `index.html` as a `file://` URL may fail CORS on some browsers; use a local server.

## Default provider (verified)

[Pollinations Classic](https://image.pollinations.ai) is still a keyless, CORS-open `GET` that returns a JPEG:

```
https://image.pollinations.ai/prompt/{URL-encoded prompt}?width=768&height=768&seed=42
```

Verified live on 23 Nov 2026 (America/New_York) with curl:

- `GET` of a 512×512 seeded apple prompt returned **HTTP 200**, `content-type: image/jpeg`, a real 512×512 JPEG, and `access-control-allow-origin: *`.
- Official docs ([APIDOCS.md](https://github.com/pollinations/pollinations/blob/master/APIDOCS.md)) list `width`, `height`, `seed`, and `safe`. Max area is **768×768**; the free model is currently **sana**; a small Pollinations wordmark is burned into free images.
- Free anonymous use is **one image at a time, at least 45 seconds apart per IP**. Over the limit you get **HTTP 402** with a `Retry-After` header (HEAD requests may get 429). Cached URLs (same prompt + size + seed) can return immediately.
- `nologo=true` is still accepted but is no longer documented; the docs say the logo stays on the free tier. The page sends it anyway and does not depend on it.
- There is no official negative-prompt parameter. The page appends `. Avoid: …` to the prompt text. Style presets work the same way (suffix on the prompt).
- The newer `https://gen.pollinations.ai/image/…` route is **not** used here: uncached calls can require a key.

The UI also handles 402/429 with a plain “try again in N seconds” message.

## Optional keyed proxy (untested end-to-end)

`server.js` is Node-only, no npm packages. Pick one backend with env vars, then choose **Local proxy** in the page footer (the option enables itself when `/api/health` reports the proxy is configured).

Hugging Face Inference (router):

```bash
export HF_TOKEN=hf_your_token
# optional: export HF_MODEL=black-forest-labs/FLUX.1-schnell
# optional: export PROVIDER=huggingface
node server.js
```

Calls `POST https://router.huggingface.co/hf-inference/models/{model}` with `inputs`, `width`, `height`, `seed`, and `negative_prompt`. Default model is `black-forest-labs/FLUX.1-schnell`.

Cloudflare Workers AI:

```bash
export CF_ACCOUNT_ID=your_account_id
export CF_API_TOKEN=your_token
# optional: export CF_MODEL=@cf/black-forest-labs/flux-1-schnell
# optional: export PROVIDER=cloudflare
node server.js
```

If `PROVIDER` is unset, the server uses Cloudflare when both CF vars are set, otherwise Hugging Face when a token is set. Without any key, the proxy returns 503 and the Pollinations browser path still works.

**This keyed path was not tested end-to-end** (no HF or Cloudflare credentials in this environment). Request shapes follow current public docs and may need a small tweak if a provider changes its response (Cloudflare Flux often returns `{ result: { image: base64 } }`; HF is expected to return raw image bytes).

## Features

- Prompt, negative prompt, aspect-ratio presets (sized to the 768×768 free cap), seed with roll + lock, and a few style “stocks”
- Expose button, Enter-to-generate, loading / shutter state
- Session contact sheet: click a frame to view it, download the current frame
- Plain error messages, including Pollinations rate-limit pacing
- Pluggable provider: Pollinations in the browser, or the local proxy

Gallery images live in memory for the tab session only.

## From prototype to something shareable

- **Rate limits / abuse.** The free Pollinations path is one image / 45 s / IP, best-effort, with no uptime promise. A public site will be shared-fate with every other client on the same egress IP (or will burn a paid/keyed quota). Add your own rate limit, maybe a lightweight challenge, and a visible cooldown. Do not put a secret key in the static page.
- **Content filtering.** Pollinations already refuses some prompts (`safe=true` is stricter; this prototype leaves the default). A public app should add its own policy, logging, and a refusal message you control.
- **Hosting.** The static page can sit on GitHub Pages or Cloudflare Pages as-is. The proxy belongs on a tiny Node host, a Cloudflare Worker, or similar — never in Pages as a client-side secret. A Worker is a natural fit if you already use Workers AI.
- **Hiding keys.** Keep HF / Cloudflare / Pollinations Enter keys on the server. If you move to [enter.pollinations.ai](https://enter.pollinations.ai) you get more models, no per-IP cap, and no wordmark, but that key must stay server-side.
- **Provider ToS / attribution.** Use is subject to the [Pollinations Terms](https://pollinations.ai/terms) and [Privacy Policy](https://pollinations.ai/privacy). The UI already credits Pollinations Classic. Keep attribution, and check HF / Cloudflare model licenses before shipping a proxy default.
- **Caching.** Identical Pollinations URLs are cached globally and reused by anyone with the URL. That is great for repeats and a privacy/leakage consideration if prompts are sensitive. A production proxy should cache carefully (keyed by prompt/seed/size, short TTL, no logging of prompts you would not want stored).

## Alternative not built: in-browser WebGPU diffusion

You could run a small Stable Diffusion / SD-Turbo style model in the browser with WebGPU (e.g. ONNX Runtime Web, Transformers.js, or diffusers.js). Tradeoffs: a large first-time model download (hundreds of MB), slow or unusable on machines without a WebGPU-capable GPU, uneven browser support, and weaker quality than a hosted flux/sana endpoint — but it can work fully offline and needs no third-party API. Left out of this prototype on purpose.

## What’s in this folder

| File | Role |
|---|---|
| `index.html` | The whole app (inline CSS and JS) |
| `server.js` | Static server + optional keyed proxy |
| `README.md` | This file |
| `screenshot.png` | Local test shot of the page with a generated image |
