import test from "node:test";
import assert from "node:assert/strict";
import { approveAdPackage, createAdPackage, createPausedMetaDraft, metaAdsConfiguration, metaAdsConfigured } from "../src/advertising.mjs";

function fixture() {
  return createAdPackage({
    venture: { name: "Workflow Guide", audience: "Independent consultants", promise: "Find one safe workflow improvement." },
    funnel: { slug: "workflow-guide", content: { headline: "Recover focused time", subheadline: "Start with evidence.", leadMagnet: "Workflow diagnostic" } },
    artifact: { artifactId: "asset-1", storedUri: "/api/assets/approved.png", contentType: "image/png" },
    input: { dailyBudget: 10, durationDays: 7, countries: "CZ, DE" }, baseUrl: "https://offers.example"
  });
}

test("ad planning creates an immutable review package with bounded spend", () => {
  const item = fixture();
  assert.equal(item.status, "awaiting_approval");
  assert.deepEqual(item.targeting.countries, ["CZ", "DE"]);
  assert.deepEqual(item.budget, { daily: 10, lifetime: 70, durationDays: 7, currency: "EUR" });
  assert.equal(item.variants.length, 3);
  assert.equal(item.guardrails.createPausedOnly, true);
  assert.equal(item.landingUrl, "https://offers.example/v/workflow-guide");
});

test("Meta execution requires the exact approved package version", async () => {
  const item = fixture();
  assert.throws(() => approveAdPackage(item, "2"), /version/);
  await assert.rejects(() => createPausedMetaDraft(item, Buffer.from("image"), { env: {} }), /approval/);
  approveAdPackage(item, "1");
  assert.equal(item.approval.scope, "create_paused_meta_objects");
  item.landingUrl = "http://localhost/v/workflow-guide";
  await assert.rejects(() => createPausedMetaDraft(item, Buffer.from("image"), { env: {} }), /HTTPS/);
});

test("Meta configuration reports only safe field presence", () => {
  const result = metaAdsConfiguration({ META_ACCESS_TOKEN: "secret", META_AD_ACCOUNT_ID: "act_123" });
  assert.equal(result.configured, false);
  assert.deepEqual(result.missing, ["META_PAGE_ID", "META_PIXEL_ID"]);
  assert.equal(result.fields.META_ACCESS_TOKEN, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("Meta adapter creates only PAUSED objects and returns their evidence", async () => {
  const item = fixture();
  approveAdPackage(item, "1");
  const calls = []; let sequence = 0;
  const fetchImpl = async (url, options) => {
    const body = Object.fromEntries(options.body.entries()); calls.push({ url, body }); sequence += 1;
    if (url.endsWith("/adimages")) return { ok: true, status: 200, json: async () => ({ images: { approved: { hash: "image-hash" } } }) };
    return { ok: true, status: 200, json: async () => ({ id: `meta-${sequence}` }) };
  };
  const env = { META_ACCESS_TOKEN: "token", META_AD_ACCOUNT_ID: "act_123", META_PAGE_ID: "page", META_PIXEL_ID: "pixel", META_API_VERSION: "v25.0" };
  assert.equal(metaAdsConfigured(env), true);
  const receipt = await createPausedMetaDraft(item, Buffer.from("png-bytes"), { env, fetchImpl });
  assert.equal(receipt.externalStatus, "PAUSED");
  assert.equal(receipt.ads.length, 3);
  assert.equal(calls.length, 9);
  assert.equal(calls[0].body.status, "PAUSED");
  assert.equal(calls[1].body.status, "PAUSED");
  assert.equal(calls[1].body.lifetime_budget, "7000");
  assert.equal(calls.filter((call) => call.url.endsWith("/ads")).every((call) => call.body.status === "PAUSED"), true);
  assert.equal(calls.some((call) => Object.values(call.body).includes("ACTIVE")), false);
});
