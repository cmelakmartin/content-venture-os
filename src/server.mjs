import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { initialState, createRun, decideApproval, validateExecution, completeExecution, updateVenture, completeOnboarding, registerProduct, activateProduct } from "./domain.mjs";
import { createRuntimeStore } from "./runtime-store.mjs";
import { extractProduct } from "./product-ingestion.mjs";
import { agentModelLabel, agentProviderName, agentRuntimeConfigured, analyzeProductWithAgents, cleanAgentText } from "./agent-runtime.mjs";
import { sendWelcomeEmail, verifyStripeEvent, verifyResendEvent } from "./connectors.mjs";
import { tokenHash, verifyDeliveryToken } from "./delivery-token.mjs";
import { dispatchN8n, n8nConfigured, requireN8nAuthorization } from "./n8n-client.mjs";
import { createBusinessActions } from "./business-actions.mjs";
import { createOwnerAuth, requiresOwnerSession } from "./owner-auth.mjs";
import { createLeadMagnetPdf, createLeadMagnetToken, verifyLeadMagnetToken } from "./lead-magnet.mjs";
import { approveAdPackage, createAdPackage, createPausedMetaDraft, metaAdsConfiguration, metaAdsConfigured } from "./advertising.mjs";
import { createProductUploadStore } from "./product-upload.mjs";

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const assetsDir = path.join(dataDir, "assets");
const uploadsDir = path.join(dataDir, "uploads");
const stateFile = path.join(dataDir, "state.json");
const publicDir = path.resolve("public");
const ownerAuth = createOwnerAuth();

await fs.mkdir(assetsDir, { recursive: true });
await fs.mkdir(uploadsDir, { recursive: true });
const productUploads = await createProductUploadStore(dataDir);
let state = await loadState();
const ventureDefaults = initialState().venture;
state.venture.audience = cleanAgentText(state.venture.audience, ventureDefaults.audience);
state.venture.promise = cleanAgentText(state.venture.promise, ventureDefaults.promise);
const runtime = await createRuntimeStore(dataDir);
const actions = createBusinessActions({ runtime, getState: async () => state });
let n8nConnectionStatus = n8nConfigured() ? "configured" : "needs_setup";
refreshConnections();

function refreshConnections() {
  delete state.connections.openai;
  state.connections.auth = ownerAuth.connection;
  state.connections.agents = { status: agentRuntimeConfigured() ? "ready" : "needs_setup", mode: agentRuntimeConfigured() ? agentProviderName() : "unavailable" };
  state.connections.images = { status: process.env.EXECUTION_MODE === "openai" && process.env.OPENAI_API_KEY ? "ready" : "mock_ready", mode: process.env.EXECUTION_MODE || "mock" };
  state.connections.n8n = { status: n8nConnectionStatus, mode: "execution_gateway" };
  delete state.connections.temporal;
  const paidCheckoutUrls = state.venture.offers.filter((offer) => offer.price > 0).map((offer) => offer.paymentUrl).filter(Boolean);
  const hasLiveCheckout = paidCheckoutUrls.some((paymentUrl) => paymentUrl.startsWith("https://buy.stripe.com/") && !paymentUrl.startsWith("https://buy.stripe.com/test_"));
  state.connections.stripe = {
    status: process.env.STRIPE_WEBHOOK_SECRET ? (hasLiveCheckout ? "live_checkout_configured" : "webhook_ready") : (hasLiveCheckout ? "checkout_configured" : "test_links_ready"),
    mode: hasLiveCheckout ? "live_payment_link" : "test_links_only"
  };
  state.connections.email = { status: process.env.RESEND_API_KEY && process.env.RESEND_FROM ? "ready" : "needs_setup", mode: process.env.RESEND_API_KEY ? "resend" : "unavailable" };
  const meta = metaAdsConfiguration();
  state.connections.ads = { status: meta.configured ? (state.advertising?.connectionVerifiedAt ? "ready" : "configured_unverified") : "needs_setup", mode: "meta_paused_drafts", setup: { present: meta.fields, missing: meta.missing } };
  state.connections.scheduler = { status: n8nConfigured() ? "delegated" : "disabled", mode: "n8n_schedule" };
}

async function dispatchCapability(pathname, capability, payload, idempotencyKey) {
  try {
    const receipt = await dispatchN8n(pathname, capability, payload, idempotencyKey);
    n8nConnectionStatus = "ready";
    return receipt;
  } catch (error) {
    n8nConnectionStatus = n8nConfigured() ? "unavailable" : "needs_setup";
    throw error;
  }
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, "utf8"));
    parsed.onboarding ||= { completed: false, path: null, autopilot: true, product: null, runtimeStatus: "idle", runtimeRunId: null, runtimeError: null, completedAt: null };
    parsed.onboarding.runtimeStatus ||= parsed.onboarding.completed ? "completed" : "idle";
    parsed.onboarding.runtimeRunId ||= null;
    parsed.onboarding.runtimeError ||= null;
    parsed.onboarding.products ||= parsed.onboarding.product ? [parsed.onboarding.product] : [];
    parsed.onboarding.activeProductId ||= parsed.onboarding.product?.id || null;
    parsed.venture.adTransparency ||= { beneficiary: "", payor: "" };
    parsed.advertising ||= { packages: [] };
    parsed.reviewQueue ||= [];
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("State recovery:", error.message);
    const seeded = initialState();
    await persist(seeded);
    return seeded;
  }
}

async function persist(next = state) {
  const temporary = `${stateFile}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(temporary, stateFile);
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

async function body(req, limit = 100_000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error("Request is too large.");
  }
  return raw ? JSON.parse(raw) : {};
}

async function serveFile(res, file, type) {
  try {
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(await fs.readFile(file));
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

async function executeImage(run) {
  const mode = process.env.EXECUTION_MODE || "mock";
  const startedAt = new Date().toISOString();
  const artifactId = crypto.randomUUID();
  const filename = `${artifactId}.png`;
  const storedPath = path.join(assetsDir, filename);
  const brief = run.artifacts.find((item) => item.id === run.action.subject.artifactId);
  if (mode === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing. Switch to mock mode or add a server-side key.");
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2", prompt: brief.content, size: "1024x1024", quality: "low" })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || `OpenAI returned ${response.status}.`);
    if (!result.data?.[0]?.b64_json) throw new Error("The image provider returned no image data.");
    await fs.writeFile(storedPath, Buffer.from(result.data[0].b64_json, "base64"), { mode: 0o600 });
    return receipt({ run, artifactId, filename, startedAt, provider: "openai", operationId: response.headers.get("x-request-id") || crypto.randomUUID(), cost: Number(process.env.IMAGE_ESTIMATED_COST_EUR || 0.02), model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2" });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#f3ede2"/><circle cx="512" cy="380" r="154" fill="#b95f39" opacity=".14"/><path d="M210 660H814" stroke="#201f1c" stroke-width="4"/><text x="512" y="340" text-anchor="middle" font-family="sans-serif" font-size="38" fill="#201f1c">AI TIME-BACK SYSTEM</text><text x="512" y="710" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#201f1c">AUDIT  →  AUTOMATE  →  PROTECT</text><text x="512" y="910" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#6f6b63">PRIVATE MOCK · NO EXTERNAL ACTION</text></svg>`;
  const svgName = `${artifactId}.svg`;
  await fs.writeFile(path.join(assetsDir, svgName), svg, { mode: 0o600 });
  return receipt({ run, artifactId, filename: svgName, startedAt, provider: "mock", operationId: crypto.randomUUID(), cost: 0, model: "deterministic-mock" });
}

function receipt({ run, artifactId, filename, startedAt, provider, operationId, cost, model }) {
  return {
    schemaVersion: "1.0", status: "succeeded", capability: "image.generate_asset", actionId: run.action.id,
    idempotencyKey: run.action.idempotencyKey, provider, providerOperationId: operationId, attempts: 1,
    startedAt, completedAt: new Date().toISOString(), cost: { amount: cost, currency: "EUR", estimated: provider !== "mock" },
    outputArtifacts: [{ artifactId, version: "1", contentType: filename.endsWith(".png") ? "image/png" : "image/svg+xml", dimensions: "1024x1024", visibility: "private", storedUri: `/api/assets/${filename}`, provenance: { model, promptArtifactId: run.action.subject.artifactId, promptArtifactVersion: run.action.subject.version } }]
  };
}

function latestImageArtifact() {
  return state.runs.flatMap((run) => run.receipt?.outputArtifacts || []).find((artifact) => artifact.contentType?.startsWith("image/")) || null;
}

async function activateVentureRuntime(pathChoice, run) {
  const ventureId = state.venture.id;
  await runtime.event(ventureId, "runtime.activated", "operator", { path: pathChoice, persistence: runtime.mode });
  let content = defaultFunnelContent();
  if (pathChoice === "existing_product") {
    const extraction = await extractProduct(uploadsDir, state.onboarding.product);
    state.onboarding.product.extraction = { characters: extraction.characters, truncated: extraction.truncated, status: "completed" };
    await runtime.event(ventureId, "product.extracted", "ingestion", state.onboarding.product.extraction);
    if (agentRuntimeConfigured()) {
      const agentRunId = await runtime.startAgent(ventureId, "product_to_venture", agentModelLabel(), `${state.onboarding.product.originalName}; ${extraction.characters} characters`);
      try {
        const result = await analyzeProductWithAgents(extraction.text, { name: state.onboarding.product.originalName, sourceRights: state.venture.sourceRights });
        await runtime.finishAgent(agentRunId, "completed", { ...result.output, provider: result.provider, taskCount: result.itemCount, trace: result.trace });
        content = result.output;
        state.venture.name = result.output.offerName;
        state.venture.audience = result.output.audience;
        state.venture.promise = result.output.promise;
        run.mode = `live_${result.provider}`;
        await runtime.event(ventureId, "agent.completed", result.provider, { agentRunId, workflow: "product_to_venture", model: result.model, taskCount: result.itemCount });
      } catch (error) {
        await runtime.finishAgent(agentRunId, "failed", null, error.message);
        await runtime.event(ventureId, "agent.failed", agentProviderName(), { agentRunId, error: error.message });
        run.mode = "agent_failed";
      }
    } else {
      run.mode = "infrastructure_only";
      await runtime.event(ventureId, "agent.not_started", "control_plane", { reason: `${agentProviderName()} runtime is not configured` });
    }
  } else {
    run.mode = "infrastructure_only";
    await runtime.event(ventureId, "discovery.not_started", "control_plane", { reason: agentRuntimeConfigured() ? "Discovery workflow is the next slice" : `${agentProviderName()} runtime is not configured` });
  }
  const slug = slugify(state.venture.name || "venture");
  const funnel = await runtime.funnel(ventureId, slug, content);
  await runtime.event(ventureId, "funnel.published", "funnel_renderer", { slug, version: funnel.version });
  await persist();
  return funnel;
}

let activationTask = null;

function queueVentureActivation(pathChoice, runId) {
  if (activationTask) return;
  activationTask = (async () => {
    try {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run) throw new Error("The queued onboarding run is unavailable.");
      if (state.onboarding.runtimeStatus === "running") {
        const recovered = await runtime.snapshot(state.venture.id);
        if (recovered.funnel?.status === "live") {
          state.onboarding.runtimeStatus = "completed";
          state.onboarding.runtimeCompletedAt = new Date().toISOString();
          state.onboarding.runtimeError = null;
          await persist();
          return;
        }
      }
      state.onboarding.runtimeStatus = "running";
      state.onboarding.runtimeError = null;
      await persist();
      await runtime.event(state.venture.id, "onboarding.runtime_started", "background_runner", { runId, path: pathChoice });
      const funnel = await activateVentureRuntime(pathChoice, run);
      state.onboarding.runtimeStatus = "completed";
      state.onboarding.runtimeCompletedAt = new Date().toISOString();
      state.onboarding.runtimeError = null;
      await persist();
      await runtime.event(state.venture.id, "onboarding.runtime_completed", "background_runner", { runId, slug: funnel.slug, version: funnel.version });
    } catch (error) {
      state.onboarding.runtimeStatus = "needs_attention";
      state.onboarding.runtimeError = { message: error.message, at: new Date().toISOString() };
      try { await persist(); } catch (persistError) { console.error("Background onboarding state:", persistError); }
      try { await runtime.event(state.venture.id, "onboarding.runtime_failed", "background_runner", { runId, error: error.message }); } catch (eventError) { console.error("Background onboarding event:", eventError); }
      console.error("Background onboarding:", error);
    } finally {
      activationTask = null;
    }
  })();
}

function defaultFunnelContent() {
  return {
    offerName: state.venture.name,
    audience: state.venture.audience,
    promise: state.venture.promise,
    headline: "Get your week back—one workflow at a time.",
    subheadline: "A practical, low-hype system for auditing repetitive work, automating the right tasks and protecting your attention.",
    benefits: ["Find the most expensive workflow bottleneck", "Choose one safe automation to implement first", "Build a weekly operating rhythm that compounds"],
    leadMagnet: "Free AI Time-Leak Diagnostic",
    welcomeEmailSubject: "Your AI Time-Leak Diagnostic",
    welcomeEmailBody: "Thanks for joining. Start by listing the three recurring tasks that consume the most attention each week. Your diagnostic and next step are ready in the venture funnel."
  };
}

function slugify(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "venture";
}

function publicUrl(req, pathname) {
  const configured = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (configured) return `${configured}${pathname}`;
  const protocol = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
  return `${protocol}://${req.headers.host}${pathname}`;
}

function funnelPage(funnel, options = {}) {
  const content = funnel.content;
  const checkoutOffer = state.venture.offers.find((offer) => offer.price > 0 && offer.paymentUrl);
  const checkout = checkoutOffer?.paymentUrl || "";
  const checkoutLabel = checkoutOffer ? `${checkout.includes("/test_") ? "Test checkout" : "Buy now"} · €${Number(checkoutOffer.price).toFixed(2)}` : "";
  const visualUri = options.visualUri || state.venture.publicVisualUri;
  const publicVisual = visualUri ? `<img class="hero-art" src="${escapeHtml(visualUri)}" alt="Editorial visual for ${escapeHtml(state.venture.name)}">` : "";
  const previewBar = options.preview ? `<div class="preview-bar"><strong>Owner preview</strong> · This image and page version are not public yet.</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(content.offerName)}</title><style>:root{--ink:#1f201d;--paper:#f5efe6;--accent:#a85232}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,sans-serif}.preview-bar{position:sticky;top:0;z-index:5;padding:11px 20px;background:#20211e;color:#fff;text-align:center}.wrap{max-width:980px;margin:auto;padding:72px 24px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;color:var(--accent);font-size:12px;font-weight:700}h1{font:52px/1.05 Georgia,serif;max-width:780px;margin:16px 0}h2{font:30px Georgia,serif}.lead{font-size:20px;color:#656159;max-width:680px}.hero-art{display:block;width:100%;max-width:760px;max-height:520px;object-fit:cover;border-radius:18px;margin:34px 0;border:1px solid #ded3c6}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:42px 0}.card{background:#fffaf3;border:1px solid #ded3c6;border-radius:14px;padding:22px}.optin{display:grid;grid-template-columns:1fr auto;gap:10px;max-width:680px;background:#fffaf3;padding:18px;border-radius:12px;border:1px solid #ded3c6}input{padding:13px;border:1px solid #cfc2b3;border-radius:7px;font:inherit}button,a.cta{padding:13px 18px;border:0;border-radius:7px;background:var(--ink);color:white;text-decoration:none;font-weight:700;cursor:pointer}.fine{font-size:12px;color:#777}.success{color:#1f6c52;font-weight:700}@media(max-width:700px){h1{font-size:40px}.grid{grid-template-columns:1fr}.optin{grid-template-columns:1fr}}</style></head><body>${previewBar}<main class="wrap"><p class="eyebrow">${escapeHtml(content.leadMagnet || "Practical diagnostic")}</p><h1>${escapeHtml(content.headline)}</h1><p class="lead">${escapeHtml(content.subheadline || content.promise)}</p>${publicVisual}<div class="grid">${(content.benefits || []).slice(0,3).map((benefit) => `<div class="card">${escapeHtml(benefit)}</div>`).join("")}</div><section><h2>Start with the free diagnostic</h2><form class="optin" id="lead-form"><input type="email" name="email" required placeholder="you@example.com" aria-label="Email address"><button>Send my free diagnostic</button><label class="fine" style="grid-column:1/-1"><input type="checkbox" name="consent" required style="width:auto"> I agree to receive this diagnostic and related educational emails. Unsubscribe anytime.</label></form><p id="message" role="status"></p>${checkout ? `<p><a class="cta" href="${escapeHtml(checkout)}">${escapeHtml(checkoutLabel)}</a></p><p class="fine">Successful payment unlocks the complete purchased product, delivered separately by email.</p>` : ""}</section><p class="fine">Educational material. Results vary. This funnel is served by the Venture Runtime.</p></main><script>${options.preview ? "" : `fetch('/api/funnel/${encodeURIComponent(funnel.slug)}/view',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{});`}document.querySelector('#lead-form').addEventListener('submit',async(e)=>{e.preventDefault();const b=e.submitter;b.disabled=true;const f=new FormData(e.target);const r=await fetch('/api/funnel/${encodeURIComponent(funnel.slug)}/lead',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:f.get('email'),consent:f.get('consent')==='on'})});const j=await r.json();document.querySelector('#message').textContent=r.ok?(['sent','queued'].includes(j.emailStatus)?'Check your inbox for the free PDF diagnostic and next steps.':'Your details were saved, but email delivery needs attention.'):(j.error||'Request failed');document.querySelector('#message').className=r.ok?'success':'';b.disabled=false;});</script></body></html>`;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/login") {
      if (ownerAuth.authenticate(req)) return redirect(res, "/");
      return serveFile(res, path.join(publicDir, "login.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/auth/status") {
      const session = ownerAuth.authenticate(req);
      return json(res, 200, { authenticated: Boolean(session), configured: ownerAuth.configured, mode: ownerAuth.mode, username: session?.username || null });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const input = await body(req, 10_000);
      const result = ownerAuth.login(req, input.username, input.password);
      if (!result.ok) return json(res, result.status, { error: result.error });
      return json(res, 200, { authenticated: true, username: result.username }, { "set-cookie": ownerAuth.sessionCookie(result.token) });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      return json(res, 200, { authenticated: false }, { "set-cookie": ownerAuth.clearCookie() });
    }
    if (requiresOwnerSession(req.method, url.pathname) && !ownerAuth.authenticate(req)) {
      if (ownerAuth.mode !== "disabled" && !ownerAuth.configured) return json(res, 503, { error: "Owner authentication needs setup. Configure OWNER_USERNAME, OWNER_PASSWORD and AUTH_SECRET." });
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) return redirect(res, "/login");
      return json(res, 401, { error: "Owner authentication is required." });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      refreshConnections();
      const snapshot = await runtime.snapshot(state.venture.id);
      return json(res, 200, { ...state, runtime: snapshot, agentRuns: snapshot.agentRuns });
    }
    let match = url.pathname.match(/^\/v\/([a-z0-9-]+)$/);
    if (req.method === "GET" && match) {
      const funnel = await runtime.getFunnel(match[1]);
      if (!funnel) return json(res, 404, { error: "Funnel not found" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      return res.end(funnelPage(funnel));
    }
    match = url.pathname.match(/^\/api\/funnel\/([a-z0-9-]+)\/preview$/);
    if (req.method === "GET" && match) {
      const funnel = await runtime.getFunnel(match[1]);
      if (!funnel) return json(res, 404, { error: "Funnel not found" });
      const filename = String(url.searchParams.get("visual") || "");
      const privateUri = `/api/assets/${filename}`;
      const artifact = state.runs.flatMap((run) => run.receipt?.outputArtifacts || []).find((item) => item.storedUri === privateUri && item.contentType?.startsWith("image/"));
      if (!artifact) return json(res, 404, { error: "Preview visual not found." });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" });
      return res.end(funnelPage(funnel, { preview: true, visualUri: privateUri }));
    }
    match = url.pathname.match(/^\/lead-magnet\/([a-z0-9-]+)\.pdf$/);
    if (req.method === "GET" && match) {
      const claims = verifyLeadMagnetToken(url.searchParams.get("token"), match[1]);
      const funnel = await runtime.getFunnel(match[1]);
      if (!funnel) return json(res, 404, { error: "Lead magnet not found" });
      const pdf = createLeadMagnetPdf(funnel.content);
      await runtime.event(funnel.ventureId, "lead_magnet.downloaded", "signed_delivery", { leadId: claims.leadId, slug: match[1] });
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${match[1]}-checklist.pdf"`, "cache-control": "private, no-store" });
      return res.end(pdf);
    }
    match = url.pathname.match(/^\/api\/funnel\/([a-z0-9-]+)\/view$/);
    if (req.method === "POST" && match) {
      const funnel = await runtime.getFunnel(match[1]);
      if (!funnel) return json(res, 404, { error: "Funnel not found" });
      await body(req); await runtime.event(funnel.ventureId, "funnel.view", "public_funnel", { slug: match[1] });
      return json(res, 202, { recorded: true });
    }
    match = url.pathname.match(/^\/api\/funnel\/([a-z0-9-]+)\/lead$/);
    if (req.method === "POST" && match) {
      const funnel = await runtime.getFunnel(match[1]);
      if (!funnel) return json(res, 404, { error: "Funnel not found" });
      const input = await body(req);
      if (!input.consent) throw new Error("Consent is required before email collection.");
      if (!/^\S+@\S+\.\S+$/.test(String(input.email || ""))) throw new Error("Enter a valid email address.");
      const lead = await runtime.lead(funnel.ventureId, String(input.email), true, match[1]);
      await runtime.event(funnel.ventureId, "lead.captured", "public_funnel", { leadId: lead.id, slug: match[1] });
      const magnetExpiresAt = new Date(Date.now() + Number(process.env.LEAD_MAGNET_LINK_HOURS || 168) * 60 * 60 * 1000);
      const magnetToken = createLeadMagnetToken(lead.id, match[1], magnetExpiresAt);
      const magnetUrl = publicUrl(req, `/lead-magnet/${encodeURIComponent(match[1])}.pdf?token=${encodeURIComponent(magnetToken)}`);
      const welcomeHtml = `<p>${escapeHtml(funnel.content.welcomeEmailBody || "Thanks for joining.")}</p><p><a href="${escapeHtml(magnetUrl)}">Download ${escapeHtml(funnel.content.leadMagnet || "your PDF diagnostic")}</a></p><p>This protected link expires in ${Number(process.env.LEAD_MAGNET_LINK_HOURS || 168)} hours.</p>`;
      if (n8nConfigured()) {
        const execution = await dispatchCapability(process.env.N8N_WELCOME_WEBHOOK || "webhook/content-venture-welcome", "email.send_welcome", { ventureId: funnel.ventureId, leadId: lead.id, email: { from: process.env.RESEND_FROM || "", to: lead.email, subject: funnel.content.welcomeEmailSubject || "Your diagnostic", html: welcomeHtml } }, `welcome-${lead.id}`);
        await runtime.event(funnel.ventureId, "email.queued", "n8n", { leadId: lead.id, execution });
        return json(res, 201, { leadId: lead.id, emailStatus: "queued" });
      }
      const email = await sendWelcomeEmail({ to: lead.email, subject: funnel.content.welcomeEmailSubject || "Your diagnostic", html: welcomeHtml });
      await runtime.event(funnel.ventureId, `email.${email.status}`, email.provider, { leadId: lead.id, externalId: email.externalId || null });
      return json(res, 201, { leadId: lead.id, emailStatus: email.status });
    }
    if (req.method === "POST" && url.pathname === "/api/webhooks/stripe") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const event = verifyStripeEvent(raw, req.headers["stripe-signature"]);
      if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
        const session = event.data.object;
        if (session.payment_status !== "unpaid") {
          const execution = await dispatchCapability(process.env.N8N_FULFILLMENT_WEBHOOK || "webhook/content-venture-fulfillment", "stripe.fulfill_product", { ventureId: state.venture.id, externalOrderId: session.id, email: session.customer_details?.email || session.customer_email || null, amount: (session.amount_total || 0) / 100, currency: String(session.currency || "eur").toUpperCase(), source: "stripe" }, `fulfill-${session.id}`);
          await runtime.event(state.venture.id, "fulfillment.queued", "n8n", execution);
        }
      }
      return json(res, 200, { received: true });
    }
    if (req.method === "POST" && url.pathname === "/api/webhooks/resend") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const event = verifyResendEvent(raw, req.headers);
      await runtime.event(state.venture.id, event.type, "resend", { externalId: event.data?.email_id || null, to: event.data?.to || null });
      return json(res, 200, { received: true });
    }
    if (req.method === "POST" && url.pathname === "/api/runtime/optimize") {
      if (!agentRuntimeConfigured()) throw new Error(`${agentProviderName()} is not configured for a real optimizer run.`);
      const idempotencyKey = `optimize-${state.venture.id}-${crypto.randomUUID()}`;
      const execution = await dispatchCapability(process.env.N8N_OPTIMIZER_WEBHOOK || "webhook/content-venture-optimize", "venture.optimize", { ventureId: state.venture.id, trigger: "owner_request" }, idempotencyKey);
      await runtime.event(state.venture.id, "optimizer.queued", "control_plane", execution);
      return json(res, 202, execution);
    }
    if (req.method === "POST" && url.pathname === "/api/runtime/test-fulfillment") {
      if (process.env.ALLOW_TEST_ACTIONS !== "true") throw new Error("Test actions are disabled.");
      const input = await body(req);
      if (!/^\S+@\S+\.\S+$/.test(String(input.email || ""))) throw new Error("Enter a valid test buyer email.");
      const externalOrderId = input.externalOrderId || `test_${crypto.randomUUID()}`;
      const execution = await dispatchCapability(process.env.N8N_FULFILLMENT_WEBHOOK || "webhook/content-venture-fulfillment", "stripe.fulfill_product", { ventureId: state.venture.id, externalOrderId, email: input.email, amount: Number(input.amount || 19), currency: "EUR", source: "operator_test" }, `fulfill-${externalOrderId}`);
      await runtime.event(state.venture.id, "fulfillment.queued", "control_plane", execution);
      return json(res, 202, execution);
    }
    if (req.method === "POST" && url.pathname === "/api/n8n/actions/prepare-fulfillment") {
      requireN8nAuthorization(req);
      n8nConnectionStatus = "ready";
      const result = await actions.prepareFulfillment(await body(req));
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/n8n/actions/compute-optimization") {
      requireN8nAuthorization(req);
      const result = await actions.optimize(await body(req));
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/n8n/actions/apply-recommendation") {
      requireN8nAuthorization(req);
      const result = await actions.applyRecommendation(await body(req));
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/n8n/results") {
      requireN8nAuthorization(req);
      const result = await body(req);
      const allowedStatuses = new Set(["succeeded", "failed", "skipped"]);
      if (!allowedStatuses.has(result.status) || !result.capability || !result.idempotencyKey) throw new Error("Invalid n8n execution receipt.");
      if (result.capability === "stripe.fulfill_product" && result.evidence?.entitlementId) await runtime.updateEntitlementEmail(result.evidence.entitlementId, result.status === "succeeded" ? "sent" : "failed");
      await runtime.event(state.venture.id, `execution.${result.status}`, "n8n", { capability: String(result.capability), idempotencyKey: String(result.idempotencyKey), externalExecutionId: result.externalExecutionId || null, evidence: result.evidence || null, error: result.error || null });
      return json(res, 202, { recorded: true });
    }
    if (req.method === "POST" && url.pathname === "/api/product-uploads") return json(res, 201, await productUploads.start(await body(req)));
    match = url.pathname.match(/^\/api\/product-uploads\/([a-f0-9-]{36})\/chunks$/);
    if (req.method === "POST" && match) return json(res, 200, await productUploads.append(match[1], await body(req, 800_000)));
    match = url.pathname.match(/^\/api\/product-uploads\/([a-f0-9-]{36})\/complete$/);
    if (req.method === "POST" && match) {
      const product = registerProduct(state, await productUploads.complete(match[1]));
      await persist(); return json(res, 201, product);
    }
    match = url.pathname.match(/^\/api\/products\/([a-f0-9-]{36})\/activate$/);
    if (req.method === "POST" && match) {
      const product = activateProduct(state, match[1]); await persist(); return json(res, 200, product);
    }
    if (req.method === "POST" && url.pathname === "/api/onboarding") {
      const input = await body(req);
      const run = completeOnboarding(state, input);
      state.onboarding.runtimeStatus = "queued";
      state.onboarding.runtimeRunId = run.id;
      state.onboarding.runtimeError = null;
      await persist();
      queueVentureActivation(input.path, run.id);
      return json(res, 202, { accepted: true, runId: run.id, runtimeStatus: "queued" });
    }
    if (req.method === "POST" && url.pathname === "/api/venture") {
      updateVenture(state, await body(req)); await persist(); return json(res, 200, state);
    }
    if (req.method === "POST" && url.pathname === "/api/ads/packages") {
      const funnel = await runtime.snapshot(state.venture.id).then((snapshot) => snapshot.funnel);
      const artifact = latestImageArtifact();
      const input = await body(req);
      const adPackage = createAdPackage({ venture: state.venture, funnel, artifact, input, baseUrl: publicUrl(req, "") });
      state.advertising.packages.unshift(adPackage);
      await persist();
      await runtime.event(state.venture.id, "ads.package_prepared", "ad_planner", { packageId: adPackage.id, version: adPackage.version, budget: adPackage.budget, targeting: adPackage.targeting });
      return json(res, 201, adPackage);
    }
    match = url.pathname.match(/^\/api\/ads\/packages\/([a-f0-9-]+)\/approve-draft$/);
    if (req.method === "POST" && match) {
      const input = await body(req);
      const adPackage = state.advertising.packages.find((candidate) => candidate.id === match[1]);
      if (!adPackage) return json(res, 404, { error: "Ad package not found." });
      if (adPackage.status === "draft_created" && adPackage.receipt?.status === "succeeded") return json(res, 200, { ...adPackage, replay: true });
      if (adPackage.status === "awaiting_approval") approveAdPackage(adPackage, input.version);
      if (adPackage.status !== "approved_for_paused_draft" || adPackage.approval?.approvedVersion !== String(input.version)) throw new Error("Exact-version approval is required for this Meta draft.");
      await persist();
      await runtime.event(state.venture.id, "ads.package_approved", "owner", { packageId: adPackage.id, version: adPackage.version, scope: adPackage.approval.scope, budget: adPackage.budget });
      if (!metaAdsConfigured()) throw new Error("Connect Meta Ads before creating the approved paused draft.");
      const filename = path.basename(adPackage.asset.storedUri);
      if (adPackage.asset.storedUri !== `/api/assets/${filename}`) throw new Error("Unsafe ad creative path.");
      try {
        adPackage.receipt = await createPausedMetaDraft(adPackage, await fs.readFile(path.join(assetsDir, filename)));
        adPackage.status = "draft_created";
        state.advertising.connectionVerifiedAt = new Date().toISOString();
        await persist();
        await runtime.event(state.venture.id, "ads.draft_created", "meta", { packageId: adPackage.id, campaignId: adPackage.receipt.campaignId, adSetId: adPackage.receipt.adSetId, adIds: adPackage.receipt.ads.map((item) => item.adId), externalStatus: "PAUSED" });
        return json(res, 201, adPackage);
      } catch (error) {
        const validationFailure = ["campaign validation", "local DSA validation"].includes(error.meta?.step);
        adPackage.error = { message: error.message, meta: error.meta || null, at: new Date().toISOString(), safeToRetry: validationFailure };
        if (validationFailure) {
          adPackage.status = "awaiting_approval";
          adPackage.approval = null;
        }
        await persist();
        await runtime.event(state.venture.id, "ads.draft_failed", "meta", { packageId: adPackage.id, error: error.message, meta: error.meta || null, manualReviewRequired: !validationFailure });
        throw error;
      }
    }
    match = url.pathname.match(/^\/api\/recommendations\/([a-f0-9-]+)\/approve$/);
    if (req.method === "POST" && match) {
      const recommendation = await runtime.getRecommendation(match[1]);
      if (!recommendation || recommendation.ventureId !== state.venture.id) return json(res, 404, { error: "Recommendation not found" });
      const execution = await dispatchCapability(process.env.N8N_PUBLISH_WEBHOOK || "webhook/content-venture-publish", "funnel.publish_approved_revision", { recommendationId: match[1], approvedBy: "owner" }, `apply-recommendation-${match[1]}`);
      await runtime.event(state.venture.id, "recommendation.approved", "owner", { recommendationId: match[1], execution });
      return json(res, 202, execution);
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const run = createRun(state); await persist(); return json(res, 201, run);
    }
    match = url.pathname.match(/^\/api\/runs\/([^/]+)\/approval$/);
    if (req.method === "POST" && match) {
      const input = await body(req);
      const existing = state.runs.find((candidate) => candidate.id === match[1]);
      if (input.decision === "approved" && ["ready_to_execute", "completed"].includes(existing?.status) && existing.action?.approval?.approvedVersion === String(input.version)) return json(res, 200, { ...existing, replay: true });
      const run = decideApproval(state, match[1], input.decision, input.version); await persist(); return json(res, 200, run);
    }
    match = url.pathname.match(/^\/api\/runs\/([^/]+)\/execute$/);
    if (req.method === "POST" && match) {
      const estimate = (process.env.EXECUTION_MODE || "mock") === "openai" ? Number(process.env.IMAGE_ESTIMATED_COST_EUR || 0.02) : 0;
      const check = validateExecution(state, match[1], estimate);
      if (check.replay) return json(res, 200, { run: check.run, replay: true });
      try {
        const result = await executeImage(check.run); completeExecution(state, match[1], result); await persist(); return json(res, 200, { run: check.run, replay: false });
      } catch (error) {
        completeExecution(state, match[1], { schemaVersion: "1.0", status: "failed", capability: "image.generate_asset", actionId: check.run.action.id, idempotencyKey: check.run.action.idempotencyKey, provider: process.env.EXECUTION_MODE || "mock", attempts: 1, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), cost: { amount: 0, currency: "EUR" }, outputArtifacts: [], error: { message: error.message, safeToRetry: true } });
        await persist(); throw error;
      }
    }
    match = url.pathname.match(/^\/api\/assets\/([a-f0-9-]+\.(?:png|svg))$/);
    if (req.method === "GET" && match) return serveFile(res, path.join(assetsDir, match[1]), match[1].endsWith(".png") ? "image/png" : "image/svg+xml");
    match = url.pathname.match(/^\/api\/assets\/([a-f0-9-]+\.(?:png|svg))\/publish$/);
    if (req.method === "POST" && match) {
      const privateUri = `/api/assets/${match[1]}`;
      const artifact = state.runs.flatMap((run) => run.receipt?.outputArtifacts || []).find((item) => item.storedUri === privateUri);
      if (!artifact) return json(res, 404, { error: "Approved visual artifact not found." });
      state.venture.publicVisualUri = `/public-assets/${match[1]}`;
      await persist(); await runtime.event(state.venture.id, "visual.published", "owner", { artifactId: artifact.artifactId, uri: state.venture.publicVisualUri });
      return json(res, 200, { published: true, uri: state.venture.publicVisualUri });
    }
    match = url.pathname.match(/^\/public-assets\/([a-f0-9-]+\.(?:png|svg))$/);
    if (req.method === "GET" && match) {
      if (state.venture.publicVisualUri !== `/public-assets/${match[1]}`) return json(res, 404, { error: "Published visual not found." });
      return serveFile(res, path.join(assetsDir, match[1]), match[1].endsWith(".png") ? "image/png" : "image/svg+xml");
    }
    match = url.pathname.match(/^\/download\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const token = decodeURIComponent(match[1]);
      const claims = verifyDeliveryToken(token);
      const entitlement = await runtime.consumeEntitlement(claims.entitlementId, tokenHash(token));
      if (!entitlement) return json(res, 403, { error: "This delivery link is invalid, expired or has reached its download limit." });
      const storedName = path.basename(entitlement.productStoredName);
      if (storedName !== entitlement.productStoredName) throw new Error("Unsafe product path.");
      const products = state.onboarding?.products || (state.onboarding?.product ? [state.onboarding.product] : []);
      const product = products.find((candidate) => candidate.storedName === storedName);
      if (!product) return json(res, 404, { error: "Product file is unavailable." });
      await runtime.event(state.venture.id, "fulfillment.downloaded", "protected_delivery", { entitlementId: entitlement.id, downloadCount: entitlement.downloadCount });
      const bytes = await fs.readFile(path.join(uploadsDir, storedName));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${String(product.originalName || "product").replace(/["\r\n]/g, "")}"`, "cache-control": "private, no-store" });
      return res.end(bytes);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return serveFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/app.js") return serveFile(res, path.join(publicDir, "app.js"), "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/login.js") return serveFile(res, path.join(publicDir, "login.js"), "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/styles.css") return serveFile(res, path.join(publicDir, "styles.css"), "text/css; charset=utf-8");
    json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    json(res, 400, { error: error.message || "Request failed" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Content Venture OS listening on http://0.0.0.0:${port}`);
  if (["queued", "running"].includes(state.onboarding?.runtimeStatus) && state.onboarding.runtimeRunId) queueVentureActivation(state.onboarding.path, state.onboarding.runtimeRunId);
});
