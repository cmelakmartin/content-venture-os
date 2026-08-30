import crypto from "node:crypto";

function secret() {
  const value = process.env.DELIVERY_SIGNING_SECRET;
  if (!value || value.length < 24) throw new Error("DELIVERY_SIGNING_SECRET must contain at least 24 characters.");
  return value;
}

export function createDeliveryToken(entitlementId, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ entitlementId, exp: new Date(expiresAt).getTime(), nonce: crypto.randomBytes(12).toString("base64url") })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyDeliveryToken(token) {
  const [payload, provided] = String(token || "").split(".");
  if (!payload || !provided) throw new Error("Invalid delivery link.");
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const left = Buffer.from(provided); const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new Error("Invalid delivery link.");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!decoded.entitlementId || Number(decoded.exp) <= Date.now()) throw new Error("This delivery link has expired.");
  return decoded;
}

export function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
