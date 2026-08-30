import crypto from "node:crypto";

const baseUrl = String(process.env.N8N_WEBHOOK_BASE_URL || "").replace(/\/$/, "");
const sharedSecret = process.env.N8N_SHARED_SECRET || "";

export function n8nConfigured() {
  return Boolean(baseUrl && sharedSecret.length >= 24);
}

export function requireN8nAuthorization(req) {
  if (!n8nConfigured()) throw new Error("The n8n adapter is not configured.");
  const provided = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const left = Buffer.from(provided); const right = Buffer.from(sharedSecret);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new Error("Invalid n8n adapter credentials.");
}

export async function dispatchN8n(pathname, capability, payload, idempotencyKey) {
  if (!n8nConfigured()) throw new Error("Set N8N_WEBHOOK_BASE_URL and a 24+ character N8N_SHARED_SECRET first.");
  const response = await fetch(`${baseUrl}/${String(pathname).replace(/^\//, "")}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sharedSecret}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify({ schemaVersion: "1.0", capability, idempotencyKey, requestedAt: new Date().toISOString(), ...payload }),
    signal: AbortSignal.timeout(Number(process.env.N8N_DISPATCH_TIMEOUT_MS || 10_000))
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n rejected ${capability}: ${response.status} ${text.slice(0, 300)}`);
  let output = {}; try { output = text ? JSON.parse(text) : {}; } catch { output = { response: text.slice(0, 300) }; }
  return { provider: "n8n", capability, status: "accepted", idempotencyKey, externalExecutionId: output.executionId || output.id || null };
}
