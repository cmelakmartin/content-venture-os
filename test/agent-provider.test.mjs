import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { analyzeProductWithAgents, recommendFromMetrics } from "../src/agent-runtime.mjs";

test("CrewAI provider adapter authenticates and validates structured outputs", async () => {
  const secret = "test-crewai-shared-secret-long-enough";
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    const output = req.url === "/v1/analyze-product" ? {
      productSummary: "A practical automation guide", audience: "Independent consultants", problem: "Repetitive operational work", promise: "Identify one safe workflow improvement", offerName: "Time-Back Starter", priceHypothesisEur: 19,
      headline: "Recover time safely", subheadline: "A measured first automation", benefits: ["Audit work", "Choose safely", "Measure results"], leadMagnet: "Time audit", welcomeEmailSubject: "Your audit", welcomeEmailBody: "Start with one workflow.", rightsAndClaimsFlags: ["Verify adaptation rights"], firstExperiment: "Measure opt-ins"
    } : {
      observation: "Traffic is limited", proposedChange: "Test a concrete headline", targetMetric: "lead conversion rate", evidence: ["3 observed visits"], confidence: "low", requiresApproval: true, funnelPatch: { headline: "Automate one bottleneck safely" }
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ provider: "crewai", model: "openai/gpt-5-mini", output, trace: { process: "sequential", taskCount: req.url.includes("analyze") ? 3 : 1 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = { provider: process.env.AGENT_PROVIDER, url: process.env.CREWAI_BASE_URL, secret: process.env.CREWAI_SHARED_SECRET, key: process.env.OPENAI_API_KEY };
  process.env.AGENT_PROVIDER = "crewai"; process.env.CREWAI_BASE_URL = `http://127.0.0.1:${server.address().port}`; process.env.CREWAI_SHARED_SECRET = secret; process.env.OPENAI_API_KEY = "test-key";
  try {
    const analysis = await analyzeProductWithAgents("A sufficiently detailed product about safe workflow automation and measurement for independent consultants.", { name: "product.md" });
    const recommendation = await recommendFromMetrics({ views: 3, leads: 0 });
    assert.equal(analysis.provider, "crewai");
    assert.equal(analysis.itemCount, 3);
    assert.equal(analysis.output.offerName, "Time-Back Starter");
    assert.equal(recommendation.output.requiresApproval, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.authorization === `Bearer ${secret}`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries({ AGENT_PROVIDER: previous.provider, CREWAI_BASE_URL: previous.url, CREWAI_SHARED_SECRET: previous.secret, OPENAI_API_KEY: previous.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
