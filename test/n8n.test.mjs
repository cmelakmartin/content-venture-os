import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("n8n adapter authenticates callbacks and dispatches a capability manifest", async () => {
  const secret = "test-n8n-shared-secret-long-enough";
  let received;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    received = { authorization: req.headers.authorization, idempotencyKey: req.headers["idempotency-key"], body: JSON.parse(raw) };
    res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ executionId: "n8n-exec-1" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const previousUrl = process.env.N8N_WEBHOOK_BASE_URL; const previousSecret = process.env.N8N_SHARED_SECRET;
  process.env.N8N_WEBHOOK_BASE_URL = `http://127.0.0.1:${address.port}`; process.env.N8N_SHARED_SECRET = secret;
  try {
    const adapter = await import(`../src/n8n-client.mjs?test=${Date.now()}`);
    adapter.requireN8nAuthorization({ headers: { authorization: `Bearer ${secret}` } });
    assert.throws(() => adapter.requireN8nAuthorization({ headers: { authorization: "Bearer wrong" } }), /Invalid n8n/);
    const receipt = await adapter.dispatchN8n("webhook/test", "venture.optimize", { ventureId: "venture-1" }, "idem-1");
    assert.equal(receipt.status, "accepted");
    assert.equal(receipt.externalExecutionId, "n8n-exec-1");
    assert.equal(received.authorization, `Bearer ${secret}`);
    assert.equal(received.idempotencyKey, "idem-1");
    assert.equal(received.body.capability, "venture.optimize");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousUrl) process.env.N8N_WEBHOOK_BASE_URL = previousUrl; else delete process.env.N8N_WEBHOOK_BASE_URL;
    if (previousSecret) process.env.N8N_SHARED_SECRET = previousSecret; else delete process.env.N8N_SHARED_SECRET;
  }
});
