import crypto from "node:crypto";

export const STAGES = [
  "Intake & rights",
  "Offer architecture",
  "Sales package",
  "Creative brief",
  "Approval gate",
  "Image execution",
  "Launch package",
  "Results & next run"
];

export function initialState() {
  return {
    schemaVersion: "1.0",
    onboarding: {
      completed: false,
      path: null,
      autopilot: true,
      product: null,
      completedAt: null
    },
    venture: {
      id: "reference-ai-time-back",
      name: "AI Time-Back System",
      audience: "English-speaking solo consultants, coaches and boutique agency owners",
      promise: "A practical path to reducing repetitive admin and marketing work with controlled AI automation.",
      sourceRights: "Purchased source content; adapt and reframe. Do not transfer resale rights or distribute as a raw library.",
      currency: "EUR",
      offers: [
        { name: "AI Time-Leak Diagnostic", price: 0, role: "Lead magnet", paymentUrl: "" },
        { name: "Time-Back Starter Kit", price: 19, role: "Entry offer", paymentUrl: "https://buy.stripe.com/test_6oU5kxaTI8sM8sM5qq9AA00" },
        { name: "AI Time-Back System", price: 79, role: "Core offer", paymentUrl: "https://buy.stripe.com/test_aFafZb8LA4cwgZi2ee9AA01" }
      ]
    },
    connections: {
      agents: { status: "needs_setup", mode: "unavailable" },
      images: { status: "mock_ready", mode: process.env.EXECUTION_MODE || "mock" },
      n8n: { status: "needs_setup", mode: "execution_gateway" },
      stripe: { status: "test_links_ready", mode: "test_only" },
      email: { status: "manual", mode: "external_action" },
      ads: { status: "manual", mode: "approval_gated" }
    },
    runs: [],
    reviewQueue: [],
    audit: [{ at: new Date().toISOString(), event: "workspace.seeded", actor: "system" }]
  };
}

export function createRun(state) {
  const now = new Date().toISOString();
  const run = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "awaiting_approval",
    currentStage: 5,
    budget: { ceiling: 1, currency: "EUR", spent: 0 },
    stageLog: STAGES.slice(0, 4).map((name, index) => ({ number: index + 1, name, status: "completed", at: now })),
    artifacts: buildArtifacts(state.venture, now),
    action: null,
    receipt: null
  };
  const brief = run.artifacts.find((item) => item.type === "creative_brief");
  run.action = {
    id: crypto.randomUUID(),
    capability: "image.generate_asset",
    status: "pending_approval",
    subject: { artifactId: brief.id, version: brief.version },
    constraints: {
      environment: "sandbox",
      visibility: "private",
      outputCount: 1,
      maxCost: 1,
      currency: "EUR",
      allowedProviders: ["mock", "openai"]
    },
    approval: null,
    idempotencyKey: `${state.venture.id}:image.generate_asset:${brief.id}:v${brief.version}`
  };
  state.runs.unshift(run);
  state.audit.unshift({ at: now, event: "run.prepared", actor: "system", runId: run.id });
  return run;
}

function buildArtifacts(venture, at) {
  const offer = venture.offers.find((item) => item.price > 0) || venture.offers[0];
  return [
    {
      id: crypto.randomUUID(), version: "1", type: "offer_plan", title: `${offer.name} — validation offer`, createdAt: at,
      content: `Audience: ${venture.audience}\nOffer: ${offer.name} (€${offer.price})\nPromise: ${venture.promise}\nValidation: organic demand before domain purchase or paid ads.`
    },
    {
      id: crypto.randomUUID(), version: "1", type: "sales_package", title: "Sales page outline", createdAt: at,
      content: `Headline: Get your week back—one workflow at a time.\nSections: problem diagnostic; Audit → Automate → Protect; what is included; honest limitations; test checkout.\nClaims rule: no guaranteed time, revenue or ROI claims.`
    },
    {
      id: crypto.randomUUID(), version: "1", type: "funnel", title: "Autonomous funnel map", createdAt: at,
      content: `LinkedIn diagnostic content → free AI Time-Leak Diagnostic → result-specific email → €19 Starter Kit → €79 core offer.\nTracking: visit, diagnostic complete, opt-in, checkout start, purchase and first-action completion.\nDeployment: prepared in mock mode; public publishing remains gated.`
    },
    {
      id: crypto.randomUUID(), version: "1", type: "email_sequence", title: "Five-email nurture sequence", createdAt: at,
      content: `1. Deliver the diagnostic result.\n2. One practical audit win.\n3. How to choose the first workflow.\n4. Why tools alone do not save time.\n5. Invite the reader to the €19 Starter Kit.\nStatus: drafted, not sent.`
    },
    {
      id: crypto.randomUUID(), version: "1", type: "ad_campaign", title: "Paid validation draft", createdAt: at,
      content: `Objective: diagnostic completions.\nBudget proposal: €10/day for seven days.\nConcepts: “Where does your week leak?” and “Audit → Automate → Protect.”\nActivation: blocked until organic validation and explicit budget approval.`
    },
    {
      id: crypto.randomUUID(), version: "1", type: "creative_brief", title: "Private launch visual brief", createdAt: at,
      content: `Create one square editorial visual for ${venture.name}. Show a calm solo business owner moving through three clearly separated stages: Audit, Automate, Protect. Warm ivory background, obsidian typography, one restrained copper accent, generous whitespace, premium editorial feel. No logos, testimonials, public figures, income claims, time-saving guarantees, or misleading product screenshots. The output is a private draft, not a final or published asset.`
    },
    {
      id: crypto.randomUUID(), version: "1", type: "operations_plan", title: "Recurring operations plan", createdAt: at,
      content: `Daily: capture funnel health and exceptions.\nWeekly: summarize traffic, opt-ins, sales, refunds and objections; propose one experiment.\nMonthly: review offer economics, content themes and connector spend.\nEscalate only: claim changes, spend increases, public activation, payment failures and customer complaints.`
    }
  ];
}

export function completeOnboarding(state, input) {
  if (state.onboarding.completed) throw new Error("Onboarding is already complete for this workspace.");
  if (!["existing_product", "discover_for_me"].includes(input.path)) throw new Error("Choose whether you already have something to sell.");
  if (input.path === "existing_product" && !state.onboarding.product) throw new Error("Upload your product or source package first.");
  const at = new Date().toISOString();
  state.onboarding = { ...state.onboarding, completed: true, path: input.path, completedAt: at };
  if (input.path === "existing_product" && state.onboarding.product?.originalName) {
    const simpleName = state.onboarding.product.originalName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
    if (simpleName) state.venture.name = simpleName.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  const run = createRun(state);
  run.origin = input.path;
  run.autopilot = true;
  run.specialists = input.path === "discover_for_me"
    ? ["Trend Scout", "Audience Researcher", "Offer Architect", "Content Strategist", "Funnel Builder", "Lifecycle Marketer", "Ad Planner", "Operations Agent"]
    : ["Product Analyst", "Rights Reviewer", "Offer Architect", "Funnel Builder", "Page Builder", "Lifecycle Marketer", "Ad Planner", "Operations Agent"];
  state.reviewQueue = [
    { id: crypto.randomUUID(), type: "visual_direction", title: "Approve the private visual direction", status: "ready", runId: run.id, reason: "A visual will be generated from creative brief v1." },
    { id: crypto.randomUUID(), type: "domain_registration", title: "Approve domain registration", status: "waiting", runId: run.id, reason: "The system will first rank available names and validate organic demand." },
    { id: crypto.randomUUID(), type: "campaign_activation", title: "Approve launch and ad budget", status: "waiting", runId: run.id, reason: "Email sending, public publishing and paid media remain inactive." }
  ];
  state.audit.unshift({ at, event: `onboarding.${input.path}`, actor: "owner", runId: run.id });
  return run;
}

export function registerProduct(state, product) {
  state.onboarding.product = product;
  state.audit.unshift({ at: new Date().toISOString(), event: "product.uploaded", actor: "owner", filename: product.originalName });
  return product;
}

export function decideApproval(state, runId, decision, expectedVersion, actor = "owner") {
  const run = requireRun(state, runId);
  if (run.status !== "awaiting_approval") throw new Error("This run is not awaiting approval.");
  if (run.action.subject.version !== String(expectedVersion)) throw new Error("The approved artifact version does not match the current version.");
  const at = new Date().toISOString();
  run.action.approval = { id: crypto.randomUUID(), decision, approvedVersion: String(expectedVersion), actor, at };
  run.action.status = decision === "approved" ? "approved" : "rejected";
  run.status = decision === "approved" ? "ready_to_execute" : "stopped";
  run.updatedAt = at;
  run.stageLog.push({ number: 5, name: STAGES[4], status: decision, at });
  state.audit.unshift({ at, event: `approval.${decision}`, actor, runId, actionId: run.action.id });
  const queueItem = state.reviewQueue?.find((item) => item.runId === runId && item.type === "visual_direction");
  if (queueItem) queueItem.status = decision === "approved" ? "approved" : "rejected";
  return run;
}

export function validateExecution(state, runId, estimatedCost = 0) {
  const run = requireRun(state, runId);
  if (run.status === "completed" && run.receipt?.status === "succeeded") return { run, replay: true };
  if (run.status !== "ready_to_execute" || run.action.status !== "approved") throw new Error("Exact-version approval is required before execution.");
  if (run.action.approval.approvedVersion !== run.action.subject.version) throw new Error("Approval version mismatch.");
  if (run.action.constraints.environment !== "sandbox" || run.action.constraints.visibility !== "private") throw new Error("Only private sandbox execution is allowed in this PoC.");
  if (estimatedCost > run.action.constraints.maxCost) throw new Error("Estimated cost exceeds the approved ceiling.");
  const completed = state.runs.find((candidate) => candidate.receipt?.idempotencyKey === run.action.idempotencyKey && candidate.receipt.status === "succeeded");
  if (completed) return { run: completed, replay: true };
  return { run, replay: false };
}

export function completeExecution(state, runId, receipt) {
  const run = requireRun(state, runId);
  const at = new Date().toISOString();
  run.receipt = receipt;
  run.action.status = receipt.status;
  run.status = receipt.status === "succeeded" ? "completed" : "needs_attention";
  run.currentStage = receipt.status === "succeeded" ? 8 : 6;
  run.updatedAt = at;
  run.budget.spent = receipt.cost.amount;
  run.stageLog.push({ number: 6, name: STAGES[5], status: receipt.status, at });
  if (receipt.status === "succeeded") {
    run.stageLog.push({ number: 7, name: STAGES[6], status: "completed", at });
    run.stageLog.push({ number: 8, name: STAGES[7], status: "completed", at });
  }
  state.audit.unshift({ at, event: `execution.${receipt.status}`, actor: "adapter", runId, actionId: run.action.id });
  const queueItem = state.reviewQueue?.find((item) => item.runId === runId && item.type === "visual_direction");
  if (queueItem && receipt.status === "succeeded") queueItem.status = "completed";
  return run;
}

export function updateVenture(state, input) {
  for (const key of ["name", "audience", "promise", "sourceRights"]) {
    if (typeof input[key] === "string" && input[key].trim()) state.venture[key] = input[key].trim();
  }
  if (Array.isArray(input.offers)) {
    input.offers.forEach((candidate, index) => {
      const offer = state.venture.offers[index];
      if (!offer || !candidate || typeof candidate !== "object") return;
      if (typeof candidate.name === "string" && candidate.name.trim()) offer.name = candidate.name.trim().slice(0, 120);
      const price = Number(candidate.price);
      if (Number.isFinite(price) && price >= 0 && price <= 10_000) offer.price = Math.round(price * 100) / 100;
      if (typeof candidate.paymentUrl === "string") {
        const paymentUrl = candidate.paymentUrl.trim();
        if (paymentUrl) {
          let parsed;
          try { parsed = new URL(paymentUrl); } catch { throw new Error("Checkout URLs must be valid HTTPS Stripe Payment Links."); }
          if (parsed.protocol !== "https:" || parsed.hostname !== "buy.stripe.com") throw new Error("Checkout URLs must use https://buy.stripe.com/.");
        }
        offer.paymentUrl = paymentUrl;
      }
    });
  }
  state.audit.unshift({ at: new Date().toISOString(), event: "venture.updated", actor: "owner" });
  return state.venture;
}

function requireRun(state, runId) {
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error("Run not found.");
  return run;
}
