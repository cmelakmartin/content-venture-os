import { Agent, run, setDefaultOpenAIKey } from "@openai/agents";
import { z } from "zod";

const VenturePackage = z.object({
  productSummary: z.string(),
  audience: z.string(),
  problem: z.string(),
  promise: z.string(),
  offerName: z.string(),
  priceHypothesisEur: z.number(),
  headline: z.string(),
  subheadline: z.string(),
  benefits: z.array(z.string()).min(3).max(6),
  leadMagnet: z.string(),
  welcomeEmailSubject: z.string(),
  welcomeEmailBody: z.string(),
  rightsAndClaimsFlags: z.array(z.string()),
  firstExperiment: z.string()
});

const Recommendation = z.object({
  observation: z.string(),
  proposedChange: z.string(),
  targetMetric: z.string(),
  evidence: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
  requiresApproval: z.literal(true),
  funnelPatch: z.object({
    headline: z.string().optional(),
    subheadline: z.string().optional()
  })
});

export function agentProviderName() {
  return String(process.env.AGENT_PROVIDER || "openai_agents").toLowerCase();
}

export function agentModelLabel() {
  return agentProviderName() === "crewai" ? process.env.CREWAI_MODEL || "openai/gpt-5-mini" : process.env.OPENAI_AGENT_MODEL || "gpt-5-mini";
}

export function agentRuntimeConfigured() {
  if (!process.env.OPENAI_API_KEY) return false;
  if (agentProviderName() === "crewai") return Boolean(process.env.CREWAI_BASE_URL && process.env.CREWAI_SHARED_SECRET?.length >= 24);
  return true;
}

async function callCrewAI(path, payload, schema) {
  if (!agentRuntimeConfigured()) throw new Error("CrewAI requires OPENAI_API_KEY, CREWAI_BASE_URL and a 24+ character CREWAI_SHARED_SECRET.");
  const response = await fetch(`${String(process.env.CREWAI_BASE_URL).replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CREWAI_SHARED_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(process.env.CREWAI_REQUEST_TIMEOUT_MS || 600_000))
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `CrewAI returned ${response.status}.`);
  return { provider: "crewai", model: result.model || agentModelLabel(), output: schema.parse(result.output), itemCount: Number(result.trace?.taskCount || 0), trace: result.trace || null };
}

function configure() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured; no agent was started.");
  setDefaultOpenAIKey(process.env.OPENAI_API_KEY);
  return process.env.OPENAI_AGENT_MODEL || "gpt-5-mini";
}

async function analyzeProductWithOpenAIAgents(productText, metadata = {}) {
  const model = configure();
  const analyst = new Agent({ name: "Product Analyst", model, instructions: "Analyze the supplied digital product. Identify what it genuinely teaches, its most credible audience and the practical outcome. Do not invent capabilities or guarantees." });
  const rights = new Agent({ name: "Rights and Claims Reviewer", model, instructions: "Review the supplied product summary and source-rights context. Flag unsupported claims, resale-rights concerns, legal promises and anything requiring human judgment. Be conservative." });
  const growth = new Agent({ name: "Venture Architect", model, instructions: "Turn the supplied product analysis into a narrow EUR-priced validation offer, landing-page message, lead magnet, welcome email and one measurable first experiment. Avoid guaranteed outcomes." });
  const manager = new Agent({
    name: "Venture Runtime Manager",
    model,
    instructions: "You operate a supervised digital-product venture. You must call all three specialist tools, reconcile their findings and return the structured venture package. Never claim a deployment or external action occurred.",
    tools: [
      analyst.asTool({ toolName: "analyze_product", toolDescription: "Analyze the actual product content and audience." }),
      rights.asTool({ toolName: "review_rights_and_claims", toolDescription: "Identify rights and claims risks requiring review." }),
      growth.asTool({ toolName: "design_venture", toolDescription: "Design the offer, funnel message, email and first experiment." })
    ],
    outputType: VenturePackage
  });
  const input = `Product filename: ${metadata.name || "uploaded product"}\nSource-rights note: ${metadata.sourceRights || "Customer asserts they own or licensed the source."}\n\nExtracted product content:\n${productText}`;
  const result = await run(manager, input, { maxTurns: 12 });
  if (!result.finalOutput) throw new Error("The agent run returned no venture package.");
  return { provider: "openai_agents", model, output: result.finalOutput, itemCount: result.newItems?.length || 0, trace: null };
}

async function recommendWithOpenAIAgents(metrics) {
  const model = configure();
  const optimizer = new Agent({
    name: "Evidence-bound Venture Optimizer",
    model,
    instructions: "Use only the provided observed metrics. Recommend exactly one reversible landing-page improvement. Return the exact headline and/or subheadline patch that could be applied after owner approval. Always set requiresApproval true. If evidence is insufficient, propose a conservative message experiment that collects more data. Never invent conversions, revenue or attribution.",
    outputType: Recommendation
  });
  const result = await run(optimizer, JSON.stringify(metrics), { maxTurns: 4 });
  if (!result.finalOutput) throw new Error("The optimizer returned no recommendation.");
  return { provider: "openai_agents", model, output: result.finalOutput, itemCount: result.newItems?.length || 0, trace: null };
}

export async function analyzeProductWithAgents(productText, metadata = {}) {
  if (agentProviderName() === "crewai") return callCrewAI("/v1/analyze-product", { productText, metadata }, VenturePackage);
  return analyzeProductWithOpenAIAgents(productText, metadata);
}

export async function recommendFromMetrics(metrics) {
  if (agentProviderName() === "crewai") return callCrewAI("/v1/optimize", { metrics }, Recommendation);
  return recommendWithOpenAIAgents(metrics);
}
