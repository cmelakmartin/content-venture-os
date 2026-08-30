import crypto from "node:crypto";
import { createDeliveryToken, tokenHash } from "./delivery-token.mjs";
import { agentModelLabel, agentProviderName, agentRuntimeConfigured, recommendFromMetrics } from "./agent-runtime.mjs";

export function createBusinessActions({ runtime, getState }) {
  return {
    async prepareFulfillment(input) {
      const current = await getState();
      const product = current.onboarding?.product;
      if (!product?.storedName) throw new Error("No uploaded product is available for fulfillment.");
      const ventureId = current.venture.id;
      const order = await runtime.order(ventureId, input.externalOrderId, input.email || null, input.amount || 0, input.currency || "EUR", "paid");
      const entitlementId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + Number(process.env.DELIVERY_LINK_HOURS || 168) * 3_600_000).toISOString();
      const token = createDeliveryToken(entitlementId, expiresAt);
      const baseUrl = String(process.env.PUBLIC_BASE_URL || "http://localhost:4173").replace(/\/$/, "");
      const deliveryUrl = `${baseUrl}/download/${token}`;
      const entitlement = await runtime.entitlement({ id: entitlementId, ventureId, orderId: order.id, externalOrderId: input.externalOrderId, email: input.email || null, productStoredName: product.storedName, tokenHash: tokenHash(token), expiresAt, maxDownloads: Number(process.env.DELIVERY_MAX_DOWNLOADS || 5), deliveryUrl, emailStatus: "delegated_to_n8n" });
      await runtime.event(ventureId, "order.paid", input.source || "stripe", { orderId: order.id, externalId: input.externalOrderId });
      await runtime.event(ventureId, "fulfillment.prepared", "control_plane", { orderId: order.id, entitlementId: entitlement.id, executor: "n8n" });
      return {
        orderId: order.id,
        entitlementId: entitlement.id,
        deliveryUrl: entitlement.deliveryUrl,
        expiresAt: entitlement.expiresAt,
        email: input.email ? {
          from: process.env.RESEND_FROM || "",
          to: input.email,
          subject: `Your ${current.venture.name} download`,
          html: `<p>Thank you for your purchase.</p><p><a href="${entitlement.deliveryUrl}">Download your product</a></p><p>This protected link expires in ${process.env.DELIVERY_LINK_HOURS || 168} hours and permits up to ${process.env.DELIVERY_MAX_DOWNLOADS || 5} downloads.</p>`
        } : null
      };
    },

    async optimize(input = {}) {
      const current = await getState(); const ventureId = current.venture.id;
      if (!agentRuntimeConfigured()) throw new Error(`${agentProviderName()} is not configured for a real optimizer agent.`);
      const snapshot = await runtime.snapshot(ventureId);
      const metrics = { views: snapshot.events.filter((event) => event.type === "funnel.view").length, leads: snapshot.leads.length, paidOrders: snapshot.orders.filter((order) => order.status === "paid").length, emailEvents: snapshot.events.filter((event) => event.type.startsWith("email.")).map((event) => event.type), recentEvents: snapshot.events.slice(0, 20) };
      const runId = await runtime.startAgent(ventureId, "evidence_optimizer", agentModelLabel(), JSON.stringify(metrics));
      try {
        const result = await recommendFromMetrics(metrics);
        await runtime.finishAgent(runId, "completed", { ...result.output, provider: result.provider, taskCount: result.itemCount, trace: result.trace });
        const recommendation = await runtime.recommendation(ventureId, result.output);
        await runtime.event(ventureId, "recommendation.proposed", result.provider, { recommendationId: recommendation.id, orchestrator: "n8n", trigger: input.trigger || "manual", model: result.model });
        return recommendation;
      } catch (error) {
        await runtime.finishAgent(runId, "failed", null, error.message);
        await runtime.event(ventureId, "optimizer.failed", "n8n", { error: error.message });
        throw error;
      }
    },

    async applyRecommendation(input) {
      const current = await getState();
      const recommendation = await runtime.getRecommendation(input.recommendationId);
      if (!recommendation || recommendation.ventureId !== current.venture.id) throw new Error("Recommendation not found.");
      const applied = await runtime.applyRecommendation(input.recommendationId, input.approvedBy || "owner");
      await runtime.event(current.venture.id, "recommendation.applied", "n8n", { recommendationId: applied.id, approvedBy: input.approvedBy || "owner" });
      return applied;
    }
  };
}
