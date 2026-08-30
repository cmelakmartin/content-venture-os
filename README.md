# Content Venture OS — CrewAI reasoning + n8n execution

This is an executable, Podman-first reference implementation for an agentic digital-product business.

```text
Content Venture OS → policy, approvals, business state and evidence
CrewAI             → specialist reasoning and structured proposals
n8n                → schedules, retries and credentialed external actions
Providers          → OpenAI, Stripe, Resend, advertising and deployment
```

n8n is deliberately not the source of truth. Every durable business object—lead, order, entitlement, recommendation, funnel version and execution receipt—returns to the OS database.

## Implemented

- PDF, DOCX, TXT and Markdown product upload with real text extraction;
- a dedicated CrewAI service with Product Analyst, Rights Reviewer and Venture Architect specialists;
- schema-validated CrewAI product packages and evidence-bound optimizer proposals;
- live local funnel, consented lead capture and measured events;
- verified Stripe webhook ingestion;
- n8n capability dispatch with a scoped shared secret and idempotency key;
- importable n8n workflows for welcome email, protected fulfillment, daily/manual optimization and approved funnel publishing;
- signed, expiring product links with enforced download limits;
- an optimizer that proposes an exact headline/subheadline patch;
- owner approval before the patch is applied to the live funnel;
- normalized execution receipts returned from n8n to the OS audit history;
- approval, version, cost-ceiling and idempotency policy for private image generation.

## Honest limitations

- You must import, configure and activate the workflows in your n8n instance.
- The OS must be reachable from n8n. A hosted n8n instance cannot call `localhost`; use a secured deployment, VPN or temporary HTTPS tunnel.
- Live OpenAI, Resend and Stripe calls require your credentials. The repository does not contain them.
- CrewAI 1.15.18 requires Python 3.10–3.13; the Podman service uses Python 3.12.
- Advertising execution and budget optimization are still explicitly marked `not_implemented`.
- The no-product trend-discovery path still uses the reference venture.
- This is a single-operator PoC without login, tenant isolation or an encrypted customer credential vault.
- Payment Links remain Stripe test links until you deliberately replace them.

## Start the OS

Copy `.env.example` to `.env`, configure the secrets, then run:

```powershell
podman compose up --build
```

Open [http://localhost:4173](http://localhost:4173). CrewAI health is visible at [http://localhost:8001/health](http://localhost:8001/health). The stack contains the OS, CrewAI reasoning service and PostgreSQL source of truth; it connects to your existing n8n instance.

## Owner authentication

Local development defaults to `AUTH_MODE=disabled`. Never publish the service in that mode. Before putting it behind a public HTTPS domain, configure:

```dotenv
AUTH_MODE=password
OWNER_USERNAME=owner@your-domain.example
OWNER_PASSWORD=use-a-unique-password-of-at-least-14-characters
AUTH_SECRET=use-an-independent-random-secret-of-at-least-32-characters
AUTH_SESSION_HOURS=12
AUTH_COOKIE_SECURE=true
```

The server issues a signed, expiring, HTTP-only, `SameSite=Strict` session cookie and throttles repeated failed logins. The owner dashboard, state, uploads, approvals, generated assets and operator actions require the session. These narrowly scoped routes remain public by design:

- buyer funnel pages and lead capture;
- signed, expiring fulfillment downloads;
- Stripe and Resend webhooks, which verify provider signatures;
- n8n action callbacks, which require `N8N_SHARED_SECRET` bearer authentication.

If password mode is selected but its required secrets are missing or too short, private routes fail closed with a setup error.

## Connect n8n

1. Follow [`n8n-workflows/README.md`](n8n-workflows/README.md).
2. Import all four workflow JSON files.
3. Configure the OS and Resend header credentials.
4. Replace the placeholder OS URL in every HTTP Request node.
5. Activate the workflows.
6. Put your n8n production webhook base URL and the same shared secret in `.env`.
7. Restart the OS and verify **Execution setup → n8n** reports `ready`.

The OS dispatches these stable capabilities:

```text
email.send_welcome
stripe.fulfill_product
venture.optimize
funnel.publish_approved_revision
```

The owner can edit offer names, EUR prices and Stripe Payment Links under **Business input**. Checkout URLs are restricted to `https://buy.stripe.com/`. A changed paid link is read by the public funnel immediately; use a test Payment Link until the fulfillment workflow has passed end to end.

## Required environment

```dotenv
N8N_WEBHOOK_BASE_URL=https://n8n.example.com
N8N_SHARED_SECRET=use-a-long-random-secret
PUBLIC_BASE_URL=https://the-buyer-reachable-os.example
DELIVERY_SIGNING_SECRET=use-another-long-random-secret
```

For agent execution:

```dotenv
OPENAI_API_KEY=...
AGENT_PROVIDER=crewai
CREWAI_MODEL=openai/gpt-5-mini
CREWAI_SHARED_SECRET=use-a-different-long-random-secret
```

The OpenAI key is passed only to the server-side CrewAI container. It is never returned through the browser API. Set `AGENT_PROVIDER=openai_agents` to compare the earlier OpenAI Agents SDK implementation through the same output contract.

For email bodies sent by the imported Resend workflow:

```dotenv
RESEND_FROM="Your Venture <hello@your-domain.example>"
```

The Resend API key belongs in n8n's **Resend API** Header Auth credential, not in the workflow JSON.

For verified Stripe events:

```dotenv
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Send Stripe test events to `https://your-os.example/api/webhooks/stripe`. The OS verifies Stripe before dispatching the fulfillment capability to n8n.

## Execution lifecycle

```text
Stripe event or owner request
  → OS verifies policy and emits an Action Manifest
  → CrewAI produces a schema-validated analysis or proposal when reasoning is required
  → authenticated n8n webhook accepts it
  → n8n calls the narrowly scoped OS action endpoint
  → n8n performs the external connector action
  → n8n returns a normalized receipt
  → OS records evidence, metrics and the next decision
```

Repeated fulfillment actions use the external Stripe session ID as the business idempotency key. Repeated publishing actions use the recommendation ID. The OS database remains authoritative even if n8n execution history is later pruned.

## Tests

```powershell
npm test
```

Tests cover approval/version policy, cost ceilings, idempotency, persistent funnel/lead events, document extraction, Stripe signatures, delivery-token tampering, atomic optimizer publishing, CrewAI adapter authentication/schema validation, n8n authentication and capability dispatch.

## Important files

- `src/server.mjs` — control-plane API, funnel renderer and n8n action routes
- `src/n8n-client.mjs` — authenticated capability dispatcher
- `src/business-actions.mjs` — protected fulfillment, optimizer and approved publishing
- `src/agent-runtime.mjs` — provider boundary for CrewAI and the comparison OpenAI Agents SDK path
- `crew-runtime/service.py` — CrewAI agents, sequential tasks and Pydantic output contracts
- `crew-runtime/Containerfile` — isolated Python 3.12 CrewAI service
- `src/runtime-store.mjs` — PostgreSQL/JSON business state and audit events
- `src/delivery-token.mjs` — signed, expiring download entitlements
- `n8n-workflows/` — importable execution workflows and setup guide
- `public/` — non-technical operator experience

The next product milestone is guided connector onboarding: encrypted per-customer credentials, automated workflow provisioning, connection tests and permission summaries inside the OS UI.
