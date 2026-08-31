import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerAuth, requiresOwnerSession } from "../src/owner-auth.mjs";

const env = {
  AUTH_MODE: "password",
  OWNER_USERNAME: "owner@primebridge.digital",
  OWNER_PASSWORD: "correct-horse-battery-staple",
  AUTH_SECRET: "a-unique-authentication-secret-that-is-long-enough",
  AUTH_SESSION_HOURS: "1",
  PUBLIC_BASE_URL: "https://venture.primebridge.digital"
};

function request(cookie = "", address = "203.0.113.10") {
  return { headers: { cookie, "x-forwarded-for": address }, socket: { remoteAddress: address } };
}

test("owner auth issues a secure signed session and rejects tampering", () => {
  let now = Date.parse("2026-08-30T10:00:00Z");
  const auth = createOwnerAuth(env, () => now);
  const login = auth.login(request(), env.OWNER_USERNAME, env.OWNER_PASSWORD);
  assert.equal(login.ok, true);
  const cookie = auth.sessionCookie(login.token);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(auth.authenticate(request(`venture_owner_session=${login.token}`)).username, env.OWNER_USERNAME);
  assert.equal(auth.verifySession(`${login.token}tampered`), null);
  now += 61 * 60 * 1000;
  assert.equal(auth.verifySession(login.token), null);
});

test("owner auth throttles repeated invalid credentials", () => {
  const auth = createOwnerAuth(env);
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(auth.login(request(), env.OWNER_USERNAME, "wrong").status, 401);
  assert.equal(auth.login(request(), env.OWNER_USERNAME, env.OWNER_PASSWORD).status, 429);
});

test("route boundary leaves only buyer and independently authenticated integration routes public", () => {
  const publicRoutes = [
    ["GET", "/login"], ["GET", "/login.js"], ["GET", "/styles.css"],
    ["GET", "/v/my-product"], ["POST", "/api/funnel/my-product/view"], ["POST", "/api/funnel/my-product/lead"],
    ["POST", "/api/webhooks/stripe"], ["POST", "/api/webhooks/resend"], ["GET", "/download/signed-token"],
    ["GET", "/lead-magnet/content-checklist.pdf"], ["GET", "/public-assets/123e4567-e89b-12d3-a456-426614174000.png"],
    ["POST", "/api/n8n/actions/prepare-fulfillment"], ["POST", "/api/auth/login"]
  ];
  for (const [method, pathname] of publicRoutes) assert.equal(requiresOwnerSession(method, pathname), false, `${method} ${pathname}`);
  const privateRoutes = [
    ["GET", "/"], ["GET", "/app.js"], ["GET", "/api/state"], ["GET", "/api/assets/private.png"], ["GET", "/api/funnel/my-product/preview"],
    ["POST", "/api/product-upload"], ["POST", "/api/runs"], ["POST", "/api/runtime/optimize"]
  ];
  for (const [method, pathname] of privateRoutes) assert.equal(requiresOwnerSession(method, pathname), true, `${method} ${pathname}`);
});
