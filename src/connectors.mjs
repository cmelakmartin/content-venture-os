import Stripe from "stripe";
import { Webhook } from "svix";

export async function sendWelcomeEmail({ to, subject, html }) {
  return sendEmail({ to, subject, html, idempotencyKey: `welcome/${to}` });
}

export async function sendEmail({ to, subject, html, idempotencyKey }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) return { status: "not_configured", provider: "resend" };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ from: process.env.RESEND_FROM, to: [to], subject, html })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || `Resend returned ${response.status}.`);
  return { status: "sent", provider: "resend", externalId: result.id };
}

export function verifyStripeEvent(rawBody, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

export function verifyResendEvent(rawBody, headers) {
  if (!process.env.RESEND_WEBHOOK_SECRET) throw new Error("RESEND_WEBHOOK_SECRET is not configured.");
  const webhook = new Webhook(process.env.RESEND_WEBHOOK_SECRET);
  return webhook.verify(rawBody, {
    "svix-id": headers["svix-id"],
    "svix-timestamp": headers["svix-timestamp"],
    "svix-signature": headers["svix-signature"]
  });
}
