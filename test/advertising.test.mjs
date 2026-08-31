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
    if (body.execution_options) return { ok: true, status: 200, json: async () => ({ success: true }) };
    if (url.endsWith("/adimages")) return { ok: true, status: 200, json: async () => ({ images: { approved: { hash: "image-hash" } } }) };
    return { ok: true, status: 200, json: async () => ({ id: `meta-${sequence}` }) };
  };
  const env = { META_ACCESS_TOKEN: "token", META_AD_ACCOUNT_ID: "act_123", META_PAGE_ID: "page", META_PIXEL_ID: "pixel", META_DSA_BENEFICIARY: "Primebridge Digital", META_DSA_PAYOR: "Martin Example", META_API_VERSION: "v25.0" };
  assert.equal(metaAdsConfigured(env), true);
  const receipt = await createPausedMetaDraft(item, Buffer.from("png-bytes"), { env, fetchImpl });
  assert.equal(receipt.externalStatus, "PAUSED");
  assert.equal(receipt.ads.length, 3);
  assert.equal(calls.length, 10);
  assert.equal(calls[0].body.execution_options, '["validate_only"]');
  assert.equal(calls[0].body.is_adset_budget_sharing_enabled, "false");
  assert.equal(calls[1].body.status, "PAUSED");
  assert.equal(calls[1].body.is_adset_budget_sharing_enabled, "false");
  assert.equal(calls[2].body.status, "PAUSED");
  assert.equal(calls[2].body.lifetime_budget, "7000");
  assert.equal(calls[2].body.dsa_beneficiary, "Primebridge Digital");
  assert.equal(calls[2].body.dsa_payor, "Martin Example");
  assert.equal(calls.filter((call) => call.url.endsWith("/ads")).every((call) => call.body.status === "PAUSED"), true);
  assert.equal(calls.some((call) => Object.values(call.body).includes("ACTIVE")), false);
});

test("EU targeting requires explicit truthful DSA transparency names before contacting Meta", async () => {
  const item = fixture(); approveAdPackage(item, "1"); let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("should not contact Meta"); };
  await assert.rejects(() => createPausedMetaDraft(item, Buffer.from("png"), { env: { META_ACCESS_TOKEN: "secret", META_AD_ACCOUNT_ID: "act_1", META_PAGE_ID: "2", META_PIXEL_ID: "3" }, fetchImpl }), (error) => {
    assert.match(error.message, /META_DSA_BENEFICIARY/);
    assert.equal(error.meta.step, "local DSA validation");
    return true;
  });
  assert.equal(calls, 0);
});

test("Meta validation exposes safe actionable diagnostics before mutation", async () => {
  const item = fixture(); approveAdPackage(item, "1");
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Invalid parameter", code: 100, error_subcode: 18157520, error_user_title: "Ad account setup incomplete", error_user_msg: "Choose an account currency first.", fbtrace_id: "trace-safe" } }) });
  await assert.rejects(() => createPausedMetaDraft(item, Buffer.from("png"), { env: { META_ACCESS_TOKEN: "secret", META_AD_ACCOUNT_ID: "act_1", META_PAGE_ID: "2", META_PIXEL_ID: "3", META_DSA_BENEFICIARY: "Business", META_DSA_PAYOR: "Business" }, fetchImpl }), (error) => {
    assert.match(error.message, /campaign validation failed: Choose an account currency first/);
    assert.equal(error.meta.subcode, 18157520);
    assert.equal(error.meta.traceId, "trace-safe");
    assert.equal(JSON.stringify(error.meta).includes("secret"), false);
    return true;
  });
});
