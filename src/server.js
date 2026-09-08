import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const VBEE_API_BASE = "https://api.vbee.vn/v1";
const VBEE_VOICES_URL = "https://vbee.vn/api/public/v1/voices";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 450_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireBridgeAuth(req, res) {
  const expected = requiredEnv("BRIDGE_API_KEY");
  if (!safeEqual(bearerToken(req), expected)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function publicBaseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`).replace(/\/$/, "");
}

function signAudio(requestId, expires) {
  return crypto
    .createHmac("sha256", requiredEnv("AUDIO_SIGNING_SECRET"))
    .update(`${requestId}.${expires}`)
    .digest("hex");
}

function signedAudioUrl(req, requestId) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const signature = signAudio(requestId, expires);
  return `${publicBaseUrl(req)}/v1/audio/${encodeURIComponent(requestId)}?expires=${expires}&signature=${signature}`;
}

function vbeeHeaders() {
  return {
    Authorization: `Bearer ${requiredEnv("VBEE_TOKEN")}`,
    "App-Id": requiredEnv("VBEE_APP_ID"),
    "Content-Type": "application/json",
  };
}

async function vbeeJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error("Vbee request failed");
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

async function createSpeech(req, res) {
  if (!requireBridgeAuth(req, res)) return;
  const body = await readJson(req);
  const text = String(body.text || "").trim();
  const voiceCode = String(body.voiceCode || "").trim();
  if (!text || !voiceCode) {
    return sendJson(res, 400, { error: "text and voiceCode are required" });
  }
  if (text.length > 100_000) {
    return sendJson(res, 400, { error: "text must not exceed 100,000 characters" });
  }

  const callbackSecret = requiredEnv("CALLBACK_SECRET");
  const payload = {
    text,
    voiceCode,
    mode: "async",
    outputFormat: body.outputFormat === "wav" ? "wav" : "mp3",
    bitrate: [8, 16, 32, 64, 128].includes(Number(body.bitrate)) ? Number(body.bitrate) : 128,
    speed: Math.min(1.9, Math.max(0.25, Number(body.speed) || 1)),
    webhookUrl: `${publicBaseUrl(req)}/v1/callback/${encodeURIComponent(callbackSecret)}`,
  };
  if (body.sampleRate) payload.sampleRate = Number(body.sampleRate);
  if (body.emphasisIntensity !== undefined) payload.emphasisIntensity = Number(body.emphasisIntensity);
  if (body.clientPause && typeof body.clientPause === "object") payload.clientPause = body.clientPause;

  const result = await vbeeJson(`${VBEE_API_BASE}/tts`, {
    method: "POST",
    headers: vbeeHeaders(),
    body: JSON.stringify(payload),
  });
  sendJson(res, 202, {
    requestId: result.requestId,
    status: result.status || "PROCESSING",
    statusUrl: `${publicBaseUrl(req)}/v1/speech/${encodeURIComponent(result.requestId)}`,
  });
}

async function getSpeech(req, res, requestId) {
  if (!requireBridgeAuth(req, res)) return;
  const result = await vbeeJson(`${VBEE_API_BASE}/tts/requests/${encodeURIComponent(requestId)}`, {
    headers: vbeeHeaders(),
  });
  const response = { requestId: result.requestId || requestId, status: result.status };
  if (result.status === "COMPLETED") response.audioUrl = signedAudioUrl(req, requestId);
  if (result.error_code || result.error) response.error = result.error_message || result.error;
  sendJson(res, 200, response);
}

async function streamAudio(req, res, requestId, url) {
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") || "";
  const valid = Number.isFinite(expires) && expires >= Math.floor(Date.now() / 1000)
    && safeEqual(signature, signAudio(requestId, expires));
  if (!valid) return sendJson(res, 401, { error: "Invalid or expired audio link" });

  const status = await vbeeJson(`${VBEE_API_BASE}/tts/requests/${encodeURIComponent(requestId)}`, {
    headers: vbeeHeaders(),
  });
  if (status.status !== "COMPLETED" || !status.audioLink) {
    return sendJson(res, 409, { error: "Audio is not ready", status: status.status });
  }
  const audio = await fetch(status.audioLink);
  if (!audio.ok || !audio.body) return sendJson(res, 502, { error: "Unable to download Vbee audio" });
  res.writeHead(200, {
    "content-type": audio.headers.get("content-type") || "audio/mpeg",
    "content-disposition": `attachment; filename="vbee-${requestId}.mp3"`,
    "cache-control": "private, max-age=300",
  });
  for await (const chunk of audio.body) res.write(chunk);
  res.end();
}

async function listVoices(req, res, url) {
  if (!requireBridgeAuth(req, res)) return;
  const upstream = new URL(VBEE_VOICES_URL);
  for (const key of ["voiceOwnership", "languageCode", "gender", "limit", "cursor"]) {
    if (url.searchParams.has(key)) upstream.searchParams.set(key, url.searchParams.get(key));
  }
  if (!upstream.searchParams.has("languageCode")) upstream.searchParams.set("languageCode", "vi-VN");
  if (!upstream.searchParams.has("limit")) upstream.searchParams.set("limit", "100");
  const result = await vbeeJson(upstream, { headers: vbeeHeaders() });
  sendJson(res, 200, result);
}

async function callback(req, res, callbackSecret) {
  if (!safeEqual(callbackSecret, requiredEnv("CALLBACK_SECRET"))) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }
  await readJson(req);
  sendJson(res, 200, { received: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    if (req.method === "GET" && path === "/health") return sendJson(res, 200, { ok: true });
    if (req.method === "POST" && path === "/v1/speech") return await createSpeech(req, res);
    if (req.method === "GET" && path === "/v1/voices") return await listVoices(req, res, url);

    let match = path.match(/^\/v1\/speech\/([^/]+)$/);
    if (req.method === "GET" && match) return await getSpeech(req, res, decodeURIComponent(match[1]));
    match = path.match(/^\/v1\/audio\/([^/]+)$/);
    if (req.method === "GET" && match) return await streamAudio(req, res, decodeURIComponent(match[1]), url);
    match = path.match(/^\/v1\/callback\/([^/]+)$/);
    if (req.method === "POST" && match) return await callback(req, res, decodeURIComponent(match[1]));

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, {
      error: error.message || "Internal server error",
      details: error.details,
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Vbee bridge listening on port ${PORT}`);
});
