import crypto from "node:crypto";

const COOKIE_NAME = "venture_owner_session";
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function safeEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
  }));
}

function clientAddress(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

export function requiresOwnerSession(method, pathname) {
  if (method === "GET" && ["/login", "/login.js", "/styles.css"].includes(pathname)) return false;
  if (pathname.startsWith("/api/auth/")) return false;
  if (method === "GET" && /^\/v\/[a-z0-9-]+$/.test(pathname)) return false;
  if (method === "GET" && /^\/public-assets\/[a-f0-9-]+\.(?:png|svg)$/.test(pathname)) return false;
  if (method === "GET" && /^\/lead-magnet\/[a-z0-9-]+\.pdf$/.test(pathname)) return false;
  if (method === "POST" && /^\/api\/funnel\/[a-z0-9-]+\/(?:view|lead)$/.test(pathname)) return false;
  if (method === "POST" && ["/api/webhooks/stripe", "/api/webhooks/resend"].includes(pathname)) return false;
  if (method === "GET" && pathname.startsWith("/download/")) return false;
  if (method === "POST" && pathname.startsWith("/api/n8n/")) return false;
  return true;
}

export function createOwnerAuth(env = process.env, clock = () => Date.now()) {
  const mode = String(env.AUTH_MODE || "disabled").toLowerCase();
  const username = String(env.OWNER_USERNAME || "owner").trim().toLowerCase();
  const password = String(env.OWNER_PASSWORD || "");
  const secret = String(env.AUTH_SECRET || "");
  const ttlSeconds = Math.max(900, Number(env.AUTH_SESSION_HOURS || 12) * 60 * 60);
  const secureCookie = env.AUTH_COOKIE_SECURE === "true" || String(env.PUBLIC_BASE_URL || "").startsWith("https://");
  const failures = new Map();
  const configured = mode === "password" && username.length > 0 && password.length >= 14 && secret.length >= 32;

  function sign(value) {
    return crypto.createHmac("sha256", secret).update(value).digest("base64url");
  }

  function issueSession() {
    if (!configured) throw new Error("Owner authentication is not configured.");
    const payload = Buffer.from(JSON.stringify({ username, expiresAt: clock() + ttlSeconds * 1000, nonce: crypto.randomBytes(16).toString("hex") })).toString("base64url");
    return `${payload}.${sign(payload)}`;
  }

  function verifySession(token) {
    if (mode === "disabled") return { username: "local-owner", mode };
    if (!configured || !token) return null;
    const [payload, signature, extra] = String(token).split(".");
    if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (claims.username !== username || Number(claims.expiresAt) <= clock()) return null;
      return claims;
    } catch {
      return null;
    }
  }

  function authenticate(req) {
    return verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  }

  function login(req, suppliedUsername, suppliedPassword) {
    if (!configured) return { ok: false, status: 503, error: mode === "disabled" ? "Password authentication is disabled." : "Set OWNER_USERNAME, OWNER_PASSWORD (14+ characters) and AUTH_SECRET (32+ characters)." };
    const address = clientAddress(req);
    const current = failures.get(address);
    if (current && current.resetAt > clock() && current.count >= MAX_FAILURES) return { ok: false, status: 429, error: "Too many login attempts. Try again later." };
    if (!safeEqual(String(suppliedUsername || "").trim().toLowerCase(), username) || !safeEqual(suppliedPassword, password)) {
      const next = current && current.resetAt > clock() ? { count: current.count + 1, resetAt: current.resetAt } : { count: 1, resetAt: clock() + FAILURE_WINDOW_MS };
      failures.set(address, next);
      return { ok: false, status: 401, error: "Invalid owner credentials." };
    }
    failures.delete(address);
    return { ok: true, status: 200, username, token: issueSession() };
  }

  function sessionCookie(token) {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlSeconds}${secureCookie ? "; Secure" : ""}`;
  }

  function clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? "; Secure" : ""}`;
  }

  return {
    mode,
    configured,
    username,
    connection: mode === "disabled" ? { status: "disabled", mode } : configured ? { status: "ready", mode } : { status: "needs_setup", mode },
    authenticate,
    login,
    sessionCookie,
    clearCookie,
    verifySession
  };
}
