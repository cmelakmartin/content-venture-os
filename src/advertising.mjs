import crypto from "node:crypto";

function money(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label} must be between €${minimum} and €${maximum}.`);
  return Math.round(number * 100) / 100;
}

export function metaAdsConfiguration(env = process.env) {
  const fields = Object.fromEntries(["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID", "META_PAGE_ID", "META_PIXEL_ID"].map((name) => [name, Boolean(String(env[name] || "").trim())]));
  const missing = Object.entries(fields).filter(([, present]) => !present).map(([name]) => name);
  return { configured: missing.length === 0, fields, missing };
}

export function metaAdsConfigured(env = process.env) {
  return metaAdsConfiguration(env).configured;
}

export function createAdPackage({ venture, funnel, artifact, input = {}, baseUrl }) {
  if (!funnel?.slug || !artifact?.storedUri) throw new Error("A live funnel and generated visual are required before preparing ads.");
  const dailyBudget = money(input.dailyBudget ?? 10, 1, 1000, "Daily budget");
  const durationDays = Math.round(money(input.durationDays ?? 7, 1, 30, "Duration"));
  const lifetimeBudget = money(input.lifetimeBudget ?? dailyBudget * durationDays, dailyBudget, 10_000, "Lifetime budget");
  const countries = String(input.countries || "CZ").toUpperCase().split(/[,\s]+/).filter(Boolean);
  if (!countries.length || countries.some((country) => !/^[A-Z]{2}$/.test(country))) throw new Error("Target countries must use two-letter country codes, such as CZ or DE.");
  const content = funnel.content || {};
  const id = crypto.randomUUID();
  const landingUrl = `${String(baseUrl || "").replace(/\/$/, "")}/v/${encodeURIComponent(funnel.slug)}`;
  const variants = [
    { angle: "Outcome", headline: content.headline || venture.promise, primaryText: content.subheadline || venture.promise, description: "Start with the free diagnostic." },
    { angle: "Problem", headline: "Where is your content workflow leaking time?", primaryText: `For ${venture.audience}. Identify the first bottleneck before adding more tools.`, description: content.leadMagnet || "Get the free diagnostic." },
    { angle: "Method", headline: venture.name, primaryText: `${venture.promise} Start with one measured, reversible improvement.`, description: "Audit. Improve. Measure." }
  ];
  return {
    id, version: "1", status: "awaiting_approval", provider: "meta", objective: "OUTCOME_SALES",
    name: `${venture.name} · supervised validation · ${id.slice(0, 8)}`, createdAt: new Date().toISOString(), landingUrl,
    budget: { daily: dailyBudget, lifetime: lifetimeBudget, durationDays, currency: "EUR" },
    targeting: { countries, ageMin: 25, ageMax: 65 },
    transparency: { beneficiary: String(venture.adTransparency?.beneficiary || "").trim(), payor: String(venture.adTransparency?.payor || "").trim() },
    asset: { artifactId: artifact.artifactId, storedUri: artifact.storedUri, contentType: artifact.contentType },
    variants,
    guardrails: { createPausedOnly: true, activationRequiresSeparateApproval: true, budgetIncreaseRequiresApproval: true, newClaimsRequireApproval: true },
    approval: null, receipt: null
  };
}

export function approveAdPackage(adPackage, expectedVersion, actor = "owner") {
  if (!adPackage || adPackage.status !== "awaiting_approval") throw new Error("This ad package is not awaiting approval.");
  if (String(expectedVersion) !== adPackage.version) throw new Error("The approved ad package version does not match the current version.");
  adPackage.status = "approved_for_paused_draft";
  adPackage.approval = { id: crypto.randomUUID(), actor, approvedVersion: adPackage.version, approvedAt: new Date().toISOString(), scope: "create_paused_meta_objects" };
  return adPackage;
}

function envValue(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is required for the Meta Ads connector.`);
  return value;
}

const DSA_COUNTRIES = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO"]);

function dsaValue(env, name) {
  const value = String(env[name] || "").trim();
  if (value) return value;
  const error = new Error(`${name} is required for ads targeting the EU/EEA. Enter the real person or organisation name that Meta should disclose.`);
  error.meta = { step: "local DSA validation", code: null, subcode: null, traceId: null };
  throw error;
}

function metaApiError(step, response, result) {
  const source = result?.error || {};
  const detail = source.error_user_msg || source.error_user_title || source.message || `Meta returned HTTP ${response.status}.`;
  const identifiers = [source.code != null ? `code ${source.code}` : "", source.error_subcode != null ? `subcode ${source.error_subcode}` : ""].filter(Boolean).join(", ");
  const error = new Error(`Meta ${step} failed: ${detail}${identifiers ? ` (${identifiers})` : ""}.`);
  error.meta = {
    step,
    httpStatus: response.status,
    type: source.type || null,
    code: source.code ?? null,
    subcode: source.error_subcode ?? null,
    userTitle: source.error_user_title || null,
    userMessage: source.error_user_msg || null,
    traceId: source.fbtrace_id || null
  };
  return error;
}

export async function createPausedMetaDraft(adPackage, imageBytes, options = {}) {
  if (adPackage?.status !== "approved_for_paused_draft" || adPackage.approval?.approvedVersion !== adPackage.version) throw new Error("Exact-version owner approval is required before creating a Meta draft.");
  if (!adPackage.guardrails?.createPausedOnly) throw new Error("The Meta adapter accepts PAUSED draft creation only.");
  if (!Buffer.isBuffer(imageBytes) || !imageBytes.length) throw new Error("The approved creative image is unavailable.");
  if (!/^image\/(?:png|jpeg)$/.test(adPackage.asset.contentType || "")) throw new Error("Meta draft creation requires an approved PNG or JPEG visual.");
  let landing;
  try { landing = new URL(adPackage.landingUrl); } catch { throw new Error("The approved ad landing URL is invalid."); }
  if (landing.protocol !== "https:") throw new Error("Meta draft creation requires a public HTTPS landing URL.");
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const token = envValue(env, "META_ACCESS_TOKEN");
  const account = envValue(env, "META_AD_ACCOUNT_ID").replace(/^act_/, "");
  const pageId = envValue(env, "META_PAGE_ID");
  const pixelId = envValue(env, "META_PIXEL_ID");
  const dsaRequired = adPackage.targeting.countries.some((country) => DSA_COUNTRIES.has(country));
  const configuredBeneficiary = String(adPackage.transparency?.beneficiary || env.META_DSA_BENEFICIARY || "").trim();
  const configuredPayor = String(adPackage.transparency?.payor || env.META_DSA_PAYOR || "").trim();
  const dsaBeneficiary = dsaRequired && !configuredBeneficiary ? dsaValue({}, "META_DSA_BENEFICIARY") : configuredBeneficiary;
  const dsaPayor = dsaRequired && !configuredPayor ? dsaValue({}, "META_DSA_PAYOR") : configuredPayor;
  const apiVersion = String(env.META_API_VERSION || "v25.0");
  const endpoint = `https://graph.facebook.com/${apiVersion}`;
  const call = async (step, path, values, expected = "id") => {
    const form = new URLSearchParams({ ...values, access_token: token });
    const response = await fetchImpl(`${endpoint}/${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    const result = await response.json();
    if (!response.ok || (expected === "id" ? !result.id : result.success !== true)) throw metaApiError(step, response, result);
    return expected === "id" ? result.id : result;
  };
  const startedAt = new Date().toISOString();
  const campaignValues = { name: adPackage.name, objective: adPackage.objective, buying_type: "AUCTION", status: "PAUSED", special_ad_categories: "[]", is_adset_budget_sharing_enabled: "false" };
  await call("campaign validation", `act_${account}/campaigns`, { ...campaignValues, execution_options: JSON.stringify(["validate_only"]) }, "success");
  const creativeValues = (variant) => ({
    name: `${adPackage.name} · ${variant.angle}`,
    object_story_spec: JSON.stringify({ page_id: pageId, link_data: { image_hash: imageHash, link: adPackage.landingUrl, message: variant.primaryText, name: variant.headline, description: variant.description, call_to_action: { type: "LEARN_MORE", value: { link: adPackage.landingUrl } } } })
  });
  const uploadResponse = await fetchImpl(`${endpoint}/act_${account}/adimages`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ bytes: imageBytes.toString("base64"), access_token: token })
  });
  const upload = await uploadResponse.json();
  const imageHash = Object.values(upload.images || {})[0]?.hash;
  if (!uploadResponse.ok || !imageHash) throw metaApiError("image upload", uploadResponse, upload);
  for (const variant of adPackage.variants) await call(`${variant.angle} creative validation`, `act_${account}/adcreatives`, { ...creativeValues(variant), execution_options: JSON.stringify(["validate_only"]) }, "success");
  const campaignId = await call("campaign creation", `act_${account}/campaigns`, campaignValues);
  const start = new Date(Date.now() + 10 * 60_000);
  const end = new Date(start.getTime() + adPackage.budget.durationDays * 86_400_000);
  const adSetId = await call("ad set creation", `act_${account}/adsets`, {
    name: `${adPackage.name} · ${adPackage.targeting.countries.join("+")}`, campaign_id: campaignId,
    lifetime_budget: String(Math.round(adPackage.budget.lifetime * 100)), start_time: start.toISOString(), end_time: end.toISOString(),
    billing_event: "IMPRESSIONS", optimization_goal: "OFFSITE_CONVERSIONS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", destination_type: "WEBSITE",
    promoted_object: JSON.stringify({ pixel_id: pixelId, custom_event_type: "PURCHASE" }),
    ...(dsaBeneficiary ? { dsa_beneficiary: dsaBeneficiary } : {}), ...(dsaPayor ? { dsa_payor: dsaPayor } : {}),
    targeting: JSON.stringify({ geo_locations: { countries: adPackage.targeting.countries }, age_min: adPackage.targeting.ageMin, age_max: adPackage.targeting.ageMax }), status: "PAUSED"
  });
  const ads = [];
  for (const variant of adPackage.variants) {
    const creativeId = await call(`${variant.angle} creative creation`, `act_${account}/adcreatives`, creativeValues(variant));
    const adId = await call(`${variant.angle} ad creation`, `act_${account}/ads`, { name: `${adPackage.name} · ${variant.angle}`, adset_id: adSetId, creative: JSON.stringify({ creative_id: creativeId }), status: "PAUSED" });
    ads.push({ angle: variant.angle, creativeId, adId, status: "PAUSED" });
  }
  return { status: "succeeded", capability: "ads.create_draft_campaign", provider: "meta", campaignId, adSetId, ads, imageHash, externalStatus: "PAUSED", startedAt, completedAt: new Date().toISOString(), cost: { amount: 0, currency: "EUR" } };
}
