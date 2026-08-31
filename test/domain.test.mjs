import test from "node:test";
import assert from "node:assert/strict";
import { initialState, createRun, decideApproval, validateExecution, completeExecution, completeOnboarding, registerProduct, activateProduct, updateVenture } from "../src/domain.mjs";

test("onboarding branches to product analysis or autonomous discovery", () => {
  const discovery = initialState();
  assert.equal(discovery.onboarding.runtimeStatus, "idle");
  const discoveryRun = completeOnboarding(discovery, { path: "discover_for_me" });
  assert.equal(discovery.onboarding.completed, true);
  assert.ok(discoveryRun.specialists.includes("Trend Scout"));
  assert.equal(discovery.reviewQueue.length, 3);

  const existing = initialState();
  assert.throws(() => completeOnboarding(existing, { path: "existing_product" }), /Upload/);
  registerProduct(existing, { originalName: "my-product.pdf" });
  const productRun = completeOnboarding(existing, { path: "existing_product" });
  assert.ok(productRun.specialists.includes("Product Analyst"));
});

test("owner can keep multiple products and select the active fulfillment product", () => {
  const state = initialState();
  const first = { id: "first", originalName: "first.pdf", storedName: "first.pdf" };
  const second = { id: "second", originalName: "second.pdf", storedName: "second.pdf" };
  registerProduct(state, first);
  registerProduct(state, second);
  assert.deepEqual(state.onboarding.products.map((item) => item.id), ["second", "first"]);
  assert.equal(state.onboarding.product.id, "second");
  activateProduct(state, "first");
  assert.equal(state.onboarding.activeProductId, "first");
  assert.equal(state.onboarding.product.originalName, "first.pdf");
});

test("a run stops at an exact-version approval gate", () => {
  const state = initialState();
  const run = createRun(state);
  assert.equal(run.status, "awaiting_approval");
  assert.equal(run.action.status, "pending_approval");
  assert.equal(run.action.constraints.maxCost, 1);
});

test("a mismatched artifact version cannot be approved", () => {
  const state = initialState();
  const run = createRun(state);
  assert.throws(() => decideApproval(state, run.id, "approved", "2"), /version does not match/);
});

test("execution requires approval and enforces the cost ceiling", () => {
  const state = initialState();
  const run = createRun(state);
  assert.throws(() => validateExecution(state, run.id, 0), /approval is required/);
  decideApproval(state, run.id, "approved", "1");
  assert.throws(() => validateExecution(state, run.id, 1.01), /exceeds the approved ceiling/);
  assert.equal(validateExecution(state, run.id, 0.02).replay, false);
});

test("completed actions are idempotent", () => {
  const state = initialState();
  const run = createRun(state);
  decideApproval(state, run.id, "approved", "1");
  completeExecution(state, run.id, { status: "succeeded", idempotencyKey: run.action.idempotencyKey, cost: { amount: 0, currency: "EUR" }, outputArtifacts: [] });
  assert.equal(validateExecution(state, run.id, 0).replay, true);
});

test("owner can update paid offer checkout while non-Stripe URLs are rejected", () => {
  const state = initialState();
  updateVenture(state, { adTransparency: { beneficiary: "Primebridge Legal", payor: "Martin Legal" }, offers: [state.venture.offers[0], { ...state.venture.offers[1], name: "Validation Kit", price: 29, paymentUrl: "https://buy.stripe.com/live_example" }] });
  assert.equal(state.venture.offers[1].name, "Validation Kit");
  assert.equal(state.venture.offers[1].price, 29);
  assert.equal(state.venture.offers[1].paymentUrl, "https://buy.stripe.com/live_example");
  assert.deepEqual(state.venture.adTransparency, { beneficiary: "Primebridge Legal", payor: "Martin Legal" });
  assert.throws(() => updateVenture(state, { offers: [state.venture.offers[0], { ...state.venture.offers[1], paymentUrl: "https://example.com/pay" }] }), /buy\.stripe\.com/);
});
