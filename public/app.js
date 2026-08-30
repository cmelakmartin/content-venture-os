let state;
const app = document.querySelector("#app");
const notice = document.querySelector("#notice");
const title = document.querySelector("#page-title");

const esc = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const money = (amount) => new Intl.NumberFormat("en", { style: "currency", currency: "EUR" }).format(amount);
const when = (value) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

document.querySelector("#logout")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  location.replace("/login");
});

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

function say(message, error = false) {
  notice.textContent = message;
  notice.className = error ? "error" : "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refresh(message) {
  state = await api("/api/state");
  document.querySelector("#mode-chip").textContent = `${state.connections.agents.mode.toUpperCase()} agents`;
  if (message) say(message);
  render();
}

function page() { return (location.hash.slice(1) || "dashboard").split("/")[0]; }
function render() {
  if (!state.onboarding?.completed) {
    document.body.classList.add("onboarding-mode");
    return renderOnboarding();
  }
  document.body.classList.remove("onboarding-mode");
  const current = page();
  document.querySelectorAll("nav a").forEach((item) => item.classList.toggle("active", item.dataset.page === current));
  const names = { dashboard: "Autopilot", venture: "Business input", runs: "Work & evidence", connections: "Execution setup" };
  title.textContent = names[current] || "Overview";
  app.setAttribute("aria-busy", "false");
  if (current === "venture") return renderVenture();
  if (current === "runs") return renderRuns();
  if (current === "connections") return renderConnections();
  renderDashboard();
}

function renderOnboarding() {
  title.textContent = "Welcome";
  document.querySelectorAll("nav a").forEach((item) => item.classList.remove("active"));
  app.innerHTML = `<div class="onboarding"><div class="onboarding-head"><p class="eyebrow">Build an operating venture</p><h2>Do you already have something to sell?</h2><p>The existing-product path is the implemented vertical slice. Every unavailable capability remains visible and explicitly labelled.</p></div><div class="choice-grid"><button class="choice" id="have-product"><span class="choice-icon">01</span><h3>Yes, I have a product</h3><p>Extract the real document, run the configured specialist agents, publish a working funnel and begin collecting measured events.</p><strong>Upload and start runtime →</strong></button><button class="choice" id="discover"><span class="choice-icon">02</span><h3>No—show me the reference venture</h3><p>Publish the reference funnel and event infrastructure. Trend discovery and autonomous product creation are not implemented yet.</p><strong>Start reference infrastructure →</strong></button></div><p class="muted" style="text-align:center;margin-top:22px">No domain purchase, public internet deployment, email send or ad spend happens without a configured connector and policy.</p></div>`;
  document.querySelector("#discover").onclick = () => beginOnboarding("discover_for_me");
  document.querySelector("#have-product").onclick = renderUpload;
}

function renderUpload() {
  app.innerHTML = `<div class="onboarding"><div class="onboarding-head"><p class="eyebrow">Bring what you already own</p><h2>Upload your product</h2><p>PDF, DOCX, text or Markdown up to 8 MB. The runtime extracts the actual content before an agent can analyze it.</p></div><div class="card upload-panel"><form id="upload-form"><label class="dropzone">Choose your file<input id="product-file" type="file" accept=".pdf,.docx,.txt,.md" required></label><div class="action-row"><button>Upload and start runtime</button><button class="secondary" type="button" id="back">Back</button></div></form></div></div>`;
  document.querySelector("#back").onclick = renderOnboarding;
  document.querySelector("#upload-form").onsubmit = async (event) => {
    event.preventDefault();
    const file = document.querySelector("#product-file").files[0];
    if (!file) return say("Choose a file first.", true);
    const button = event.submitter;
    button.disabled = true;
    button.textContent = "Extracting and analyzing…";
    try {
      const data = await readFile(file);
      await api("/api/product-upload", { method: "POST", body: JSON.stringify({ name: file.name, data }) });
      await beginOnboarding("existing_product");
    } catch (error) {
      button.disabled = false;
      button.textContent = "Upload and start runtime";
      say(error.message, true);
    }
  };
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

async function beginOnboarding(path) {
  try {
    await api("/api/onboarding", { method: "POST", body: JSON.stringify({ path }) });
    location.hash = "dashboard";
    await refresh(path === "discover_for_me" ? "Reference funnel published. The discovery agent remains explicitly unavailable." : "Product extracted and the configured runtime path completed.");
  } catch (error) {
    say(error.message, true);
  }
}

function renderDashboard() {
  const latest = state.runs[0];
  const runtime = state.runtime || { events: [], leads: [], agentRuns: [], orders: [], recommendations: [], funnel: null, mode: "unknown" };
  const ready = state.reviewQueue.filter((item) => item.status === "ready").length;
  const liveAgents = runtime.agentRuns.filter((run) => run.status === "running").length;
  const completedAgents = runtime.agentRuns.filter((run) => run.status === "completed").length;
  const funnelLive = runtime.funnel?.status === "live";
  const emailLive = state.connections.email.status === "ready";
  const durable = state.connections.n8n?.status === "ready";
  const executionConfigured = state.connections.n8n?.status !== "needs_setup";
  app.innerHTML = `<div class="autopilot-banner"><div><strong>Venture Runtime · ${runtime.mode}</strong><p>${liveAgents} running now · ${completedAgents} completed real agent runs · reasoning: ${esc(state.connections.agents.mode)} · execution: n8n.</p></div><span class="autopilot-state">● ${liveAgents ? "CREW ACTIVE" : durable ? "n8n EXECUTION READY" : "MONITORING"}</span></div><div class="card hero"><p class="eyebrow">Your operating venture</p><h2>${esc(state.venture.name)}</h2><p>${esc(state.venture.promise)}</p><div class="work-summary"><div><strong>Offer</strong><small>${completedAgents ? "crew-produced" : "reference draft"}</small></div><div><strong>Funnel</strong><small>${funnelLive ? `live · v${runtime.funnel.version}` : "not deployed"}</small></div><div><strong>Fulfillment</strong><small>${durable ? "n8n + protected" : executionConfigured ? "configured · unverified" : "not connected"}</small></div><div><strong>Optimization</strong><small>${durable ? "CrewAI proposal + approval" : executionConfigured ? "ready to retry" : "not connected"}</small></div></div>${runtime.funnel ? `<div class="action-row"><a class="button-link" href="/v/${encodeURIComponent(runtime.funnel.slug)}" target="_blank">Open live funnel</a><button class="secondary" id="optimize" ${state.connections.agents.status !== "ready" || !executionConfigured ? "disabled" : ""}>Run CrewAI optimizer</button></div>` : ""}</div>
  <div class="grid three section-head"><div class="card metric"><strong>${runtime.events.filter((event) => event.type === "funnel.view").length}</strong><span>observed visits</span></div><div class="card metric"><strong>${runtime.leads.length}</strong><span>consented leads</span></div><div class="card metric"><strong>${runtime.orders.filter((order) => order.status === "paid").length}</strong><span>test purchases</span></div></div>
  ${runtime.recommendations.length ? `<div class="section-head"><div><p class="eyebrow">Optimizer proposals</p><h2>Evidence first, publishing only after approval</h2></div></div>${runtime.recommendations.slice(0,3).map(recommendationCard).join("")}` : ""}
  ${runtime.entitlements?.length ? `<div class="card" style="margin:18px 0"><h2>Protected fulfillment</h2><p class="muted">n8n executed these delivery workflows; the OS issued and enforces each protected entitlement.</p>${runtime.entitlements.slice(0,5).map((item)=>`<div class="connection"><div><strong>${esc(item.email || "Buyer email unavailable")}</strong><small>${esc(item.externalOrderId)} · ${item.downloadCount}/${item.maxDownloads} downloads · email ${esc(item.emailStatus || "unknown")}</small></div><a class="button-link" href="${esc(item.deliveryUrl)}">Test protected link</a></div>`).join("")}</div>` : ""}
  <div class="grid two"><div><div class="section-head"><div><p class="eyebrow">Exception inbox</p><h2>${ready ? `${ready} decision needs you` : "Nothing urgent"}</h2></div><a class="button-link" href="#runs/${latest?.id || ""}">See all work</a></div>${state.reviewQueue.map((item) => `<div class="card review-card" style="margin-bottom:12px"><div class="run"><div><small>${esc(item.type.replaceAll("_", " "))}</small><h3>${esc(item.title)}</h3><p class="muted">${esc(item.reason)}</p></div>${statusChip(item.status)}</div>${item.status === "ready" ? `<div class="action-row"><a class="button-link" href="#runs/${item.runId}">Review once</a></div>` : ""}</div>`).join("")}</div><div><div class="card"><h2>Crew evidence</h2>${runtime.agentRuns.length ? runtime.agentRuns.slice(0,5).map((run) => `<div class="connection"><div><strong>${esc(run.workflow)}</strong><small>${esc(run.model || "model unavailable")} · ${run.completedAt ? when(run.completedAt) : "running"}</small></div>${statusChip(run.status)}</div>`).join("") : `<p class="muted">No crew has run. Configure the CrewAI runtime and upload a product to create the first traceable run.</p>`}</div><div class="card" style="margin-top:18px"><h3>Recent business events</h3>${runtime.events.slice(0,8).map((event) => `<div class="connection"><div><strong>${esc(event.type)}</strong><small>${esc(event.source)} · ${when(event.createdAt)}</small></div></div>`).join("") || `<p class="muted">No external events recorded yet.</p>`}</div></div></div>`;
  document.querySelector("#optimize")?.addEventListener("click", async (event) => { event.target.disabled = true; event.target.textContent = "Queueing n8n run…"; try { await api("/api/runtime/optimize", { method: "POST", body: "{}" }); await refresh("Optimizer queued in n8n. Its evidence-bound proposal will appear after execution completes."); } catch (error) { await refresh(); say(error.message, true); } });
  document.querySelectorAll("[data-approve-recommendation]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; button.textContent = "Publishing…"; try { await api(`/api/recommendations/${button.dataset.approveRecommendation}/approve`, { method:"POST", body:"{}" }); await refresh("Approval recorded. n8n is applying the exact patch to the live funnel."); } catch(error) { await refresh(); say(error.message, true); } }));
}

function recommendationCard(item) {
  const value = item.recommendation || {};
  const patch = value.funnelPatch || {};
  return `<div class="card review-card" style="margin-bottom:12px"><div class="run"><div><small>${esc(value.targetMetric || "funnel metric")} · ${esc(value.confidence || "unknown")} confidence</small><h3>${esc(value.proposedChange || "Proposed funnel revision")}</h3><p class="muted">${esc(value.observation || "")}</p></div>${statusChip(item.status)}</div><div class="artifact"><small>Exact live-funnel patch</small>${patch.headline ? `<p><strong>Headline:</strong> ${esc(patch.headline)}</p>` : ""}${patch.subheadline ? `<p><strong>Subheadline:</strong> ${esc(patch.subheadline)}</p>` : ""}</div>${item.status === "proposed" ? `<button data-approve-recommendation="${esc(item.id)}">Approve & publish this version</button>` : `<p class="muted">Applied ${item.appliedAt ? when(item.appliedAt) : "by the durable workflow"}.</p>`}</div>`;
}

function renderVenture() {
  const v = state.venture;
  app.innerHTML = `<div class="grid two"><div class="card"><h2>Operating brief</h2><p class="muted">This is the reusable customer input layer. Changes to a paid Stripe link affect the buyer funnel immediately.</p><form id="venture-form"><label>Venture name<input name="name" value="${esc(v.name)}"></label><label>Audience<textarea name="audience">${esc(v.audience)}</textarea></label><label>Promise<textarea name="promise">${esc(v.promise)}</textarea></label><label>Source rights and limits<textarea name="sourceRights">${esc(v.sourceRights)}</textarea></label><h3>Offer ladder and checkout</h3>${v.offers.map((o,index)=>`<fieldset class="offer-editor" data-offer-index="${index}"><legend>${esc(o.role)}</legend><label>Offer name<input name="offer-name-${index}" value="${esc(o.name)}"></label><label>Price in EUR<input name="offer-price-${index}" type="number" min="0" max="10000" step="0.01" value="${Number(o.price)}"></label><label>Stripe Payment Link${o.price ? "" : " (optional)"}<input name="offer-url-${index}" type="url" placeholder="https://buy.stripe.com/..." value="${esc(o.paymentUrl || "")}"></label></fieldset>`).join("")}<button>Save business and checkout</button></form></div><div><div class="card"><h2>Launch readiness</h2><p class="muted">Test links contain <code>/test_</code>. Replace the first paid offer with a live EUR Payment Link only after fulfillment has passed end to end.</p>${v.offers.map(o=>`<div class="offer"><div><strong>${esc(o.name)}</strong><small>${esc(o.role)} · ${o.paymentUrl ? (o.paymentUrl.includes("/test_") ? "test checkout" : "live checkout configured") : "no checkout"}</small></div><span class="price">${o.price ? money(o.price) : "Free"}</span></div>`).join("")}</div><div class="card" style="margin-top:18px"><h3>Permanent launch rule</h3><p class="muted">Validate demand organically before activating ads. Live checkout, public claims and ad spend remain consequential owner decisions.</p></div></div></div>`;
  document.querySelector("#venture-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.target); const input = { name:form.get("name"), audience:form.get("audience"), promise:form.get("promise"), sourceRights:form.get("sourceRights"), offers:v.offers.map((offer,index)=>({name:form.get(`offer-name-${index}`),price:Number(form.get(`offer-price-${index}`)),paymentUrl:form.get(`offer-url-${index}`)})) }; try { await api("/api/venture", { method:"POST", body:JSON.stringify(input) }); await refresh("Business brief and checkout configuration saved."); } catch (error) { say(error.message, true); } };
}

function renderRuns() {
  const selectedId = location.hash.split("/")[1];
  const selected = state.runs.find(r => r.id === selectedId) || state.runs[0];
  if (!selected) {
    app.innerHTML = `<div class="card empty"><h2>No runs yet</h2><p>Prepare a run to generate reviewable artifacts and the first approval gate.</p><button id="start-run">Prepare supervised run</button></div>`;
    document.querySelector("#start-run").onclick = startRun; return;
  }
  app.innerHTML = `<div class="grid two"><div class="card"><div class="section-head" style="margin:0 0 14px"><div><p class="eyebrow">Run ${esc(selected.id.slice(0,8))}</p><h2>${statusLabel(selected.status)}</h2></div>${statusChip(selected.status)}</div><p class="muted">Created ${when(selected.createdAt)} · ceiling ${money(selected.budget.ceiling)} · spent ${money(selected.budget.spent)}</p><div class="timeline">${Array.from({length:8},(_,i)=>`<span class="stage ${i+1<selected.currentStage?'done':i+1===selected.currentStage?'current':''}" title="Stage ${i+1}"></span>`).join("")}</div>${approval(selected)}<div class="section-head"><div><p class="eyebrow">Work completed for you</p><h3>Open only if you want the detail</h3></div></div>${selected.artifacts.map(a=>`<details class="artifact" ${a.type === 'creative_brief' && selected.status === 'awaiting_approval' ? 'open' : ''}><summary><small>${esc(a.type.replaceAll('_',' '))} · v${a.version}</small><strong>${esc(a.title)}</strong></summary><pre>${esc(a.content)}</pre></details>`).join("")}</div><div><div class="card"><h3>Run history</h3>${state.runs.map(r=>`<a class="run" href="#runs/${r.id}"><div><strong>${esc(r.id.slice(0,8))}</strong><small>${when(r.createdAt)}</small></div>${statusChip(r.status)}</a>`).join("")}</div>${receipt(selected)}</div></div>`;
  wireRunActions(selected);
}

function approval(run) {
  if (run.status === "awaiting_approval") return `<div class="approval-box"><p class="eyebrow">One decision needs you</p><h3>Approve creative brief v${run.action.subject.version} and generate one private draft?</h3><p class="muted">Maximum approved cost: ${money(run.action.constraints.maxCost)}. Mock mode costs €0. Approval generates the private visual immediately; it does not publish, send, charge a customer or create an ad.</p><div class="action-row"><button id="approve">Approve & generate</button><button class="danger" id="reject">Reject & stop</button></div></div>`;
  if (run.status === "ready_to_execute") return `<div class="approval-box"><p class="eyebrow">Approved</p><h3>Execution was interrupted</h3><p class="muted">Resume the already approved private action. Repeated requests return the original receipt.</p><div class="action-row"><button id="execute">Resume action</button></div></div>`;
  return "";
}

function receipt(run) {
  if (!run.receipt) return `<div class="card" style="margin-top:18px"><h3>Evidence receipt</h3><p class="muted">No execution has occurred. A normalized receipt will appear here after the approved action.</p></div>`;
  const asset = run.receipt.outputArtifacts?.[0];
  return `<div class="card" style="margin-top:18px"><h3>Evidence receipt</h3><p class="muted">Provider: ${esc(run.receipt.provider)} · ${money(run.receipt.cost.amount)}${run.receipt.cost.estimated ? " estimated" : ""}</p>${asset ? `<img class="asset" src="${asset.storedUri}" alt="Private generated draft for ${esc(state.venture.name)}">` : ""}<pre class="receipt">${esc(JSON.stringify(run.receipt,null,2))}</pre></div>`;
}

function wireRunActions(run) {
  document.querySelector("#approve")?.addEventListener("click", ()=>decision(run,"approved"));
  document.querySelector("#reject")?.addEventListener("click", ()=>decision(run,"rejected"));
  document.querySelector("#execute")?.addEventListener("click", async (event)=>{ event.target.disabled=true; event.target.textContent="Executing…"; try { const result=await api(`/api/runs/${run.id}/execute`,{method:"POST",body:"{}"}); await refresh(result.replay?"Idempotent replay: the original receipt was returned.":"Approved action completed and evidence recorded."); } catch(error){ await refresh(); say(error.message,true); } });
}

async function decision(run, decision) { try { await api(`/api/runs/${run.id}/approval`,{method:"POST",body:JSON.stringify({decision,version:run.action.subject.version})}); if (decision === "approved") { await api(`/api/runs/${run.id}/execute`,{method:"POST",body:"{}"}); await refresh("Approved private visual generated. The system has returned to autopilot."); } else { await refresh("Run rejected and stopped."); } } catch(error){ await refresh(); say(error.message,true); } }
async function startRun() { try { const run=await api("/api/runs",{method:"POST",body:"{}"}); location.hash=`runs/${run.id}`; await refresh("Run prepared. It stopped at the visual approval gate."); } catch(error){ say(error.message,true); } }

function renderConnections() {
  const details = { auth:"Signed, HTTP-only owner sessions protect the control plane", agents:"CrewAI specialist collaboration and schema-validated recommendations", images:"Private OpenAI image action or zero-cost deterministic mock", n8n:"Pluggable execution gateway for retries, schedules and external connectors", stripe:"Verified EUR checkout events dispatch protected fulfillment through n8n", email:"n8n sends through Resend; lead and delivery state stays in the OS", ads:"No advertising connector implemented", scheduler:"n8n schedule invokes CrewAI; owner approval publishes proposals" };
  app.innerHTML = `<div class="grid two"><div class="card"><h2>Capability adapters</h2><p class="muted">The Work System asks for stable capabilities. Providers remain replaceable behind this boundary.</p>${Object.entries(state.connections).map(([key,value])=>`<div class="connection"><div><strong>${key[0].toUpperCase()+key.slice(1)}</strong><small>${details[key]}</small></div>${statusChip(value.status)}</div>`).join("")}</div><div class="card"><h2>How setup works</h2><p class="muted">For this local PoC, credentials are supplied as container environment variables. A customer product would replace this with a guided connection screen, encrypted credential vault, test action and permission summary.</p><div class="artifact"><small>Enabled capability</small><h3>image.generate_asset</h3><p class="muted">Private · one output · one exact-version approval · €1 ceiling · idempotent receipt</p></div><div class="artifact"><small>Stripe boundary</small><h3>Test checkout links only</h3><p class="muted">This project opens your existing EUR test links. It never creates products, moves money or stores Stripe credentials.</p></div></div></div>`;
}

function statusLabel(status){ return ({awaiting_approval:"Awaiting your approval",ready_to_execute:"Approved, ready to execute",completed:"Run completed",stopped:"Run stopped",needs_attention:"Execution needs attention"})[status]||status.replaceAll('_',' '); }
function statusChip(status){ const good=["completed","ready","test_links_ready","approved","applied","webhook_ready","checkout_configured","live_checkout_configured"].includes(status); const stop=["stopped","failed","rejected","unavailable"].includes(status); return `<span class="status ${good?'good':stop?'stop':'wait'}">${esc(statusLabel(status))}</span>`; }
function nextStep(run){ if(run.status==="awaiting_approval") return "Review and approve or reject the exact creative brief version."; if(run.status==="ready_to_execute") return "Execute the approved private image action."; if(run.status==="completed") return "Review the receipt and output before designing the next connector."; return "Inspect the run evidence before retrying."; }

addEventListener("hashchange", render);
refresh().catch(error => say(error.message, true));
