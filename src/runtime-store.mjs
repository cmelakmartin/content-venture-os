import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

export async function createRuntimeStore(dataDir) {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        await pool.query("select 1");
        await migrate(pool);
        return postgresStore(pool);
      } catch (error) {
        if (attempt === 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  return jsonStore(path.join(dataDir, "runtime.json"));
}

async function migrate(pool) {
  await pool.query(`
    create table if not exists venture_events (
      id uuid primary key, venture_id text not null, type text not null,
      source text not null, payload jsonb not null default '{}', created_at timestamptz not null default now()
    );
    create table if not exists leads (
      id uuid primary key, venture_id text not null, email text not null,
      consent boolean not null, source text not null, created_at timestamptz not null default now(),
      unique (venture_id, email)
    );
    create table if not exists agent_runs (
      id uuid primary key, venture_id text not null, workflow text not null,
      status text not null, model text, input_summary text, output jsonb,
      error text, started_at timestamptz not null default now(), completed_at timestamptz
    );
    create table if not exists funnels (
      venture_id text primary key, slug text unique not null, version integer not null,
      status text not null, content jsonb not null, published_at timestamptz not null default now()
    );
    create table if not exists orders (
      id uuid primary key, venture_id text not null, provider text not null,
      external_id text unique not null, email text, amount numeric, currency text,
      status text not null, created_at timestamptz not null default now()
    );
    create table if not exists recommendations (
      id uuid primary key, venture_id text not null, status text not null,
      recommendation jsonb not null, approved_at timestamptz, applied_at timestamptz,
      approved_by text, created_at timestamptz not null default now()
    );
    create table if not exists delivery_entitlements (
      id uuid primary key, venture_id text not null, order_id uuid not null,
      external_order_id text unique not null, email text, product_stored_name text not null,
      token_hash text not null, expires_at timestamptz not null, max_downloads integer not null default 5,
      download_count integer not null default 0, revoked boolean not null default false,
      delivery_url text not null, email_status text, created_at timestamptz not null default now()
    );
    alter table recommendations add column if not exists approved_at timestamptz;
    alter table recommendations add column if not exists applied_at timestamptz;
    alter table recommendations add column if not exists approved_by text;
  `);
}

function postgresStore(pool) {
  return {
    mode: "postgres",
    async event(ventureId, type, source, payload = {}) {
      const id = crypto.randomUUID();
      await pool.query("insert into venture_events(id,venture_id,type,source,payload) values($1,$2,$3,$4,$5)", [id, ventureId, type, source, payload]);
      return id;
    },
    async lead(ventureId, email, consent, source) {
      const id = crypto.randomUUID();
      const result = await pool.query(`insert into leads(id,venture_id,email,consent,source) values($1,$2,$3,$4,$5)
        on conflict(venture_id,email) do update set consent=excluded.consent, source=excluded.source returning *`, [id, ventureId, email.toLowerCase(), consent, source]);
      return row(result.rows[0]);
    },
    async startAgent(ventureId, workflow, model, inputSummary) {
      const id = crypto.randomUUID();
      await pool.query("insert into agent_runs(id,venture_id,workflow,status,model,input_summary) values($1,$2,$3,'running',$4,$5)", [id, ventureId, workflow, model, inputSummary]);
      return id;
    },
    async finishAgent(id, status, output, error = null) {
      await pool.query("update agent_runs set status=$2, output=$3, error=$4, completed_at=now() where id=$1", [id, status, output, error]);
    },
    async funnel(ventureId, slug, content) {
      const result = await pool.query(`insert into funnels(venture_id,slug,version,status,content) values($1,$2,1,'live',$3)
        on conflict(venture_id) do update set slug=excluded.slug,version=funnels.version+1,status='live',content=excluded.content,published_at=now() returning *`, [ventureId, slug, content]);
      return row(result.rows[0]);
    },
    async getFunnel(slug) { const result = await pool.query("select * from funnels where slug=$1 and status='live'", [slug]); return result.rows[0] ? row(result.rows[0]) : null; },
    async order(ventureId, externalId, email, amount, currency, status) {
      const id = crypto.randomUUID();
      const result = await pool.query(`insert into orders(id,venture_id,provider,external_id,email,amount,currency,status) values($1,$2,'stripe',$3,$4,$5,$6,$7)
        on conflict(external_id) do update set status=excluded.status returning *`, [id, ventureId, externalId, email, amount, currency, status]);
      return row(result.rows[0]);
    },
    async recommendation(ventureId, recommendation) {
      const record = { id: crypto.randomUUID(), ventureId, status: "proposed", recommendation, createdAt: new Date().toISOString() };
      await pool.query("insert into recommendations(id,venture_id,status,recommendation) values($1,$2,$3,$4)", [record.id, ventureId, record.status, recommendation]);
      return record;
    },
    async getRecommendation(id) { const result = await pool.query("select * from recommendations where id=$1", [id]); return result.rows[0] ? row(result.rows[0]) : null; },
    async applyRecommendation(id, approvedBy = "owner") {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query("select * from recommendations where id=$1 for update", [id]);
        if (!found.rows[0]) throw new Error("Recommendation not found.");
        const item = row(found.rows[0]);
        if (item.status === "applied") { await client.query("commit"); return item; }
        if (item.status !== "proposed") throw new Error("Recommendation is not awaiting approval.");
        const patch = item.recommendation.funnelPatch;
        if (!patch || (!patch.headline && !patch.subheadline)) throw new Error("Recommendation has no safe funnel patch.");
        const funnel = await client.query("select * from funnels where venture_id=$1 for update", [item.ventureId]);
        if (!funnel.rows[0]) throw new Error("No live funnel exists.");
        const nextContent = { ...funnel.rows[0].content, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => typeof value === "string" && value.trim())) };
        await client.query("update funnels set content=$2,version=version+1,published_at=now() where venture_id=$1", [item.ventureId, nextContent]);
        const updated = await client.query("update recommendations set status='applied',approved_at=now(),applied_at=now(),approved_by=$2 where id=$1 returning *", [id, approvedBy]);
        await client.query("commit"); return row(updated.rows[0]);
      } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    },
    async entitlement(input) {
      const result = await pool.query(`insert into delivery_entitlements(id,venture_id,order_id,external_order_id,email,product_stored_name,token_hash,expires_at,max_downloads,delivery_url,email_status)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(external_order_id) do update set email_status=coalesce(delivery_entitlements.email_status,excluded.email_status) returning *`,
        [input.id, input.ventureId, input.orderId, input.externalOrderId, input.email, input.productStoredName, input.tokenHash, input.expiresAt, input.maxDownloads, input.deliveryUrl, input.emailStatus || null]);
      return row(result.rows[0]);
    },
    async getEntitlement(id) { const result = await pool.query("select * from delivery_entitlements where id=$1", [id]); return result.rows[0] ? row(result.rows[0]) : null; },
    async updateEntitlementEmail(id, status) { const result = await pool.query("update delivery_entitlements set email_status=$2 where id=$1 returning *", [id, status]); return result.rows[0] ? row(result.rows[0]) : null; },
    async consumeEntitlement(id, tokenHash) {
      const result = await pool.query(`update delivery_entitlements set download_count=download_count+1 where id=$1 and token_hash=$2 and revoked=false and expires_at>now() and download_count<max_downloads returning *`, [id, tokenHash]);
      return result.rows[0] ? row(result.rows[0]) : null;
    },
    async snapshot(ventureId) {
      const [events, leads, agents, funnel, orders, recommendations, entitlements] = await Promise.all([
        pool.query("select * from venture_events where venture_id=$1 order by created_at desc limit 100", [ventureId]),
        pool.query("select * from leads where venture_id=$1 order by created_at desc", [ventureId]),
        pool.query("select * from agent_runs where venture_id=$1 order by started_at desc limit 30", [ventureId]),
        pool.query("select * from funnels where venture_id=$1", [ventureId]),
        pool.query("select * from orders where venture_id=$1 order by created_at desc", [ventureId]),
        pool.query("select * from recommendations where venture_id=$1 order by created_at desc", [ventureId]),
        pool.query("select * from delivery_entitlements where venture_id=$1 order by created_at desc", [ventureId])
      ]);
      return { mode: "postgres", events: events.rows.map(row), leads: leads.rows.map(row), agentRuns: agents.rows.map(row), funnel: funnel.rows[0] ? row(funnel.rows[0]) : null, orders: orders.rows.map(row), recommendations: recommendations.rows.map(row), entitlements: entitlements.rows.map(row) };
    }
  };
}

async function jsonStore(file) {
  let data;
  try { data = JSON.parse(await fs.readFile(file, "utf8")); } catch { data = { events: [], leads: [], agentRuns: [], funnels: [], orders: [], recommendations: [], entitlements: [] }; }
  data.entitlements ||= [];
  async function save() { await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 }); }
  return {
    mode: "local-json",
    async event(ventureId, type, source, payload = {}) { const id = crypto.randomUUID(); data.events.unshift({ id, ventureId, type, source, payload, createdAt: new Date().toISOString() }); await save(); return id; },
    async lead(ventureId, email, consent, source) { let item = data.leads.find((lead) => lead.ventureId === ventureId && lead.email === email.toLowerCase()); if (!item) { item = { id: crypto.randomUUID(), ventureId, email: email.toLowerCase(), consent, source, createdAt: new Date().toISOString() }; data.leads.unshift(item); } else { item.consent = consent; item.source = source; } await save(); return item; },
    async startAgent(ventureId, workflow, model, inputSummary) { const id = crypto.randomUUID(); data.agentRuns.unshift({ id, ventureId, workflow, model, inputSummary, status: "running", startedAt: new Date().toISOString() }); await save(); return id; },
    async finishAgent(id, status, output, error = null) { const item = data.agentRuns.find((run) => run.id === id); Object.assign(item, { status, output, error, completedAt: new Date().toISOString() }); await save(); },
    async funnel(ventureId, slug, content) { let item = data.funnels.find((funnel) => funnel.ventureId === ventureId); if (!item) { item = { ventureId, slug, version: 0 }; data.funnels.push(item); } Object.assign(item, { slug, version: item.version + 1, status: "live", content, publishedAt: new Date().toISOString() }); await save(); return item; },
    async getFunnel(slug) { return data.funnels.find((funnel) => funnel.slug === slug && funnel.status === "live") || null; },
    async order(ventureId, externalId, email, amount, currency, status) { let item = data.orders.find((order) => order.externalId === externalId); if (!item) { item = { id: crypto.randomUUID(), ventureId, provider: "stripe", externalId, email, amount, currency, createdAt: new Date().toISOString() }; data.orders.unshift(item); } item.status = status; await save(); return item; },
    async recommendation(ventureId, recommendation) { const item = { id: crypto.randomUUID(), ventureId, status: "proposed", recommendation, createdAt: new Date().toISOString() }; data.recommendations.unshift(item); await save(); return item; },
    async getRecommendation(id) { return data.recommendations.find((item) => item.id === id) || null; },
    async applyRecommendation(id, approvedBy = "owner") { const item = data.recommendations.find((candidate) => candidate.id === id); if (!item) throw new Error("Recommendation not found."); if (item.status === "applied") return item; if (item.status !== "proposed") throw new Error("Recommendation is not awaiting approval."); const funnel = data.funnels.find((candidate) => candidate.ventureId === item.ventureId); if (!funnel) throw new Error("No live funnel exists."); const patch = item.recommendation.funnelPatch; if (!patch) throw new Error("Recommendation has no safe funnel patch."); funnel.content = { ...funnel.content, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => typeof value === "string" && value.trim())) }; funnel.version += 1; funnel.publishedAt = new Date().toISOString(); Object.assign(item, { status: "applied", approvedBy, approvedAt: new Date().toISOString(), appliedAt: new Date().toISOString() }); await save(); return item; },
    async entitlement(input) { let item = data.entitlements.find((candidate) => candidate.externalOrderId === input.externalOrderId); if (!item) { item = { ...input, downloadCount: 0, revoked: false, createdAt: new Date().toISOString() }; data.entitlements.unshift(item); await save(); } return item; },
    async getEntitlement(id) { return data.entitlements.find((item) => item.id === id) || null; },
    async updateEntitlementEmail(id, status) { const item = data.entitlements.find((candidate) => candidate.id === id); if (item) { item.emailStatus = status; await save(); } return item || null; },
    async consumeEntitlement(id, tokenHash) { const item = data.entitlements.find((candidate) => candidate.id === id && candidate.tokenHash === tokenHash); if (!item || item.revoked || new Date(item.expiresAt) <= new Date() || item.downloadCount >= item.maxDownloads) return null; item.downloadCount += 1; await save(); return item; },
    async snapshot(ventureId) { const matches = (items) => items.filter((item) => item.ventureId === ventureId); return { mode: "local-json", events: matches(data.events), leads: matches(data.leads), agentRuns: matches(data.agentRuns), funnel: data.funnels.find((item) => item.ventureId === ventureId) || null, orders: matches(data.orders), recommendations: matches(data.recommendations), entitlements: matches(data.entitlements) }; }
  };
}

function row(value) {
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = item;
  return result;
}
