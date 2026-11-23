#!/usr/bin/env node
"use strict";

/**
 * Tiny static file server + optional keyed image-generation proxy.
 * No dependencies. Default page still talks to Pollinations from the browser;
 * this proxy is only used when the UI provider is set to "Local proxy".
 *
 * Env:
 *   PORT                 listen port (default 8787)
 *   PROVIDER             huggingface | cloudflare   (auto-detected from env if unset)
 *   HF_TOKEN             Hugging Face token (or HUGGINGFACE_HUB_TOKEN)
 *   HF_MODEL             default: black-forest-labs/FLUX.1-schnell
 *   CF_ACCOUNT_ID        Cloudflare account id
 *   CF_API_TOKEN         Cloudflare API token with Workers AI permissions
 *   CF_MODEL             default: @cf/black-forest-labs/flux-1-schnell
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8787;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function inferredProvider() {
  const raw = (process.env.PROVIDER || "").toLowerCase().trim();
  if (raw === "hf" || raw === "huggingface") return "huggingface";
  if (raw === "cf" || raw === "cloudflare") return "cloudflare";
  if (process.env.CF_API_TOKEN && process.env.CF_ACCOUNT_ID) return "cloudflare";
  if (process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN) return "huggingface";
  return "";
}

function hfToken() {
  return process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN || "";
}

function proxyConfigured() {
  const p = inferredProvider();
  if (p === "huggingface") return Boolean(hfToken());
  if (p === "cloudflare") return Boolean(process.env.CF_API_TOKEN && process.env.CF_ACCOUNT_ID);
  return false;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }, JSON.stringify(obj));
}

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split("?")[0]);
  const clean = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = path.resolve(root, "." + clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function serveStatic(req, res) {
  let reqPath = new URL(req.url, "http://127.0.0.1").pathname;
  if (reqPath === "/") reqPath = "/index.html";
  const file = safeJoin(ROOT, reqPath);
  if (!file) return sendJson(res, 400, { error: "Bad path." });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: "Not found." });
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function composePrompt(body) {
  let text = String(body.prompt || "").trim();
  if (!text) return "";
  const negative = String(body.negative || "").trim();
  if (negative && !/avoid:/i.test(text)) text += ". Avoid: " + negative;
  return text;
}

function clampDim(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(64, Math.min(2048, Math.round(v)));
}

async function generateHuggingFace(body) {
  const token = hfToken();
  const model = process.env.HF_MODEL || "black-forest-labs/FLUX.1-schnell";
  const prompt = composePrompt(body);
  const payload = {
    inputs: prompt,
    parameters: {
      width: clampDim(body.width, 768),
      height: clampDim(body.height, 768),
      seed: Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : undefined,
      negative_prompt: String(body.negative || "").trim() || undefined,
      num_inference_steps: 4
    }
  };
  const res = await fetch("https://router.huggingface.co/hf-inference/models/" + encodeURIComponent(model), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "image/png, image/jpeg, application/json"
    },
    body: JSON.stringify(payload)
  });
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || type.includes("application/json")) {
    let message = "Hugging Face returned " + res.status + ".";
    try {
      const data = JSON.parse(buf.toString("utf8"));
      message = data.error || data.message || JSON.stringify(data);
    } catch (err) { /* keep default */ }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return { buffer: buf, type: type.startsWith("image/") ? type : "image/png" };
}

async function generateCloudflare(body) {
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  const model = process.env.CF_MODEL || "@cf/black-forest-labs/flux-1-schnell";
  const prompt = composePrompt(body);
  const payload = {
    prompt,
    width: clampDim(body.width, 768),
    height: clampDim(body.height, 768)
  };
  if (Number.isFinite(Number(body.seed))) payload.seed = Math.floor(Number(body.seed));
  const res = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(account) + "/ai/run/" + model,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (type.startsWith("image/") && res.ok) return { buffer: buf, type };
  let data;
  try { data = JSON.parse(buf.toString("utf8")); } catch (err) { data = null; }
  if (!res.ok || (data && data.success === false)) {
    const message = (data && (data.errors && data.errors[0] && data.errors[0].message || data.error || data.message))
      || ("Cloudflare Workers AI returned " + res.status + ".");
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  const b64 = data && data.result && (data.result.image || data.result);
  if (typeof b64 !== "string" || !b64) {
    const error = new Error("Cloudflare did not return an image. This path was not end-to-end tested.");
    error.status = 502;
    throw error;
  }
  return { buffer: Buffer.from(b64, "base64"), type: "image/jpeg" };
}

async function handleGenerate(req, res) {
  if (!proxyConfigured()) {
    return sendJson(res, 503, {
      error: "Proxy is not configured. Set HF_TOKEN, or CF_ACCOUNT_ID and CF_API_TOKEN, then restart the server."
    });
  }
  let body;
  try { body = await readJson(req); }
  catch (err) { return sendJson(res, 400, { error: "Body must be JSON." }); }
  if (!String(body.prompt || "").trim()) return sendJson(res, 400, { error: "A prompt is required." });
  const provider = inferredProvider();
  try {
    const result = provider === "cloudflare"
      ? await generateCloudflare(body)
      : await generateHuggingFace(body);
    send(res, 200, { "Content-Type": result.type, "Cache-Control": "no-store" }, result.buffer);
  } catch (err) {
    const status = err.status && err.status >= 400 ? err.status : 502;
    sendJson(res, status, { error: err.message || "Generation failed." });
  }
}

function handleHealth(_req, res) {
  sendJson(res, 200, {
    ok: true,
    proxyConfigured: proxyConfigured(),
    provider: inferredProvider() || null
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/health") return handleHealth(req, res);
  if (req.method === "POST" && url.pathname === "/api/generate") {
    handleGenerate(req, res).catch((err) => {
      sendJson(res, 500, { error: err.message || "Server error." });
    });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  sendJson(res, 405, { error: "Method not allowed." });
});

server.listen(PORT, "127.0.0.1", () => {
  const ready = proxyConfigured() ? inferredProvider() : "not configured (Pollinations in the browser still works)";
  console.log("PROOF listening on http://127.0.0.1:" + PORT);
  console.log("Proxy: " + ready);
});
