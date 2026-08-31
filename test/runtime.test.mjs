import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Stripe from "stripe";
import { createRuntimeStore } from "../src/runtime-store.mjs";
import { extractProduct } from "../src/product-ingestion.mjs";
import { verifyStripeEvent } from "../src/connectors.mjs";
import { createDeliveryToken, tokenHash, verifyDeliveryToken } from "../src/delivery-token.mjs";
import { createLeadMagnetPdf, createLeadMagnetToken, verifyLeadMagnetToken } from "../src/lead-magnet.mjs";

test("local runtime persists funnel, lead and measured events", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "venture-runtime-"));
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const store = await createRuntimeStore(directory);
    await store.funnel("venture-1", "test-offer", { headline: "Test" });
    await store.event("venture-1", "funnel.view", "test");
    await store.lead("venture-1", "buyer@example.com", true, "test-offer");
    const snapshot = await store.snapshot("venture-1");
    assert.equal(snapshot.funnel.status, "live");
    assert.equal(snapshot.events[0].type, "funnel.view");
    assert.equal(snapshot.leads[0].email, "buyer@example.com");
  } finally {
    if (previous) process.env.DATABASE_URL = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("text product ingestion reads actual content", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "venture-ingestion-"));
  try {
    const storedName = "product.md";
    await fs.writeFile(path.join(directory, storedName), "A sufficiently detailed product about operational audits, controlled automation and weekly review cycles for independent consultants.");
    const result = await extractProduct(directory, { storedName });
    assert.match(result.text, /controlled automation/);
    assert.ok(result.characters > 40);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Stripe adapter verifies signed webhook payloads", () => {
  const previous = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_runtime_test";
  try {
    const payload = JSON.stringify({ id: "evt_test", type: "checkout.session.completed", data: { object: { id: "cs_test" } } });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    assert.equal(verifyStripeEvent(payload, signature).id, "evt_test");
  } finally {
    if (previous) process.env.STRIPE_WEBHOOK_SECRET = previous; else delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test("delivery links are signed, expiring and tamper evident", () => {
  const previous = process.env.DELIVERY_SIGNING_SECRET;
  process.env.DELIVERY_SIGNING_SECRET = "a-test-secret-with-more-than-24-characters";
  try {
    const token = createDeliveryToken("entitlement-1", new Date(Date.now() + 60_000));
    assert.equal(verifyDeliveryToken(token).entitlementId, "entitlement-1");
    assert.equal(tokenHash(token).length, 64);
    assert.throws(() => verifyDeliveryToken(`${token}x`), /Invalid delivery link/);
  } finally {
    if (previous) process.env.DELIVERY_SIGNING_SECRET = previous; else delete process.env.DELIVERY_SIGNING_SECRET;
  }
});

test("lead magnets are real PDFs behind signed expiring links", () => {
  const previous = process.env.DELIVERY_SIGNING_SECRET;
  process.env.DELIVERY_SIGNING_SECRET = "a-test-secret-with-more-than-24-characters";
  try {
    const token = createLeadMagnetToken("lead-1", "content-checklist", new Date(Date.now() + 60_000));
    assert.equal(verifyLeadMagnetToken(token, "content-checklist").leadId, "lead-1");
    assert.throws(() => verifyLeadMagnetToken(token, "another-checklist"), /Invalid|expired/);
    const pdf = createLeadMagnetPdf({ leadMagnet: "21 Signs Checklist", subheadline: "Find the bottleneck." });
    assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
    assert.ok(pdf.length > 2_000);
  } finally {
    if (previous) process.env.DELIVERY_SIGNING_SECRET = previous; else delete process.env.DELIVERY_SIGNING_SECRET;
  }
});

test("an approved optimizer patch atomically increments the live funnel", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "venture-optimizer-"));
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const store = await createRuntimeStore(directory);
    await store.funnel("venture-2", "offer", { headline: "Old", subheadline: "Keep" });
    const recommendation = await store.recommendation("venture-2", { proposedChange: "Test clearer value", funnelPatch: { headline: "New" } });
    await store.applyRecommendation(recommendation.id, "owner");
    const snapshot = await store.snapshot("venture-2");
    assert.equal(snapshot.funnel.version, 2);
    assert.equal(snapshot.funnel.content.headline, "New");
    assert.equal(snapshot.funnel.content.subheadline, "Keep");
    assert.equal(snapshot.recommendations[0].status, "applied");
  } finally {
    if (previous) process.env.DATABASE_URL = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
