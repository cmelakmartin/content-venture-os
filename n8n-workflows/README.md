# Import and connect the n8n execution pack

Import these workflows into one dedicated n8n project:

1. `01-fulfillment.json`
2. `02-welcome-email.json`
3. `03-optimizer.json`
4. `04-approved-publish.json`

They import inactive so nothing can send email or change a funnel before you finish configuration.

## 1. Create two Header Auth credentials

**Content Venture OS API**

- Header name: `Authorization`
- Header value: `Bearer <the exact N8N_SHARED_SECRET from the OS .env>`

Use this credential on every webhook and every request back to the OS. A minimum 24-character random secret is enforced.

**Resend API**

- Header name: `Authorization`
- Header value: `Bearer re_...`

Use this credential only on the two Resend HTTP Request nodes.

## 2. Replace the OS URL

In every HTTP Request node, replace:

```text
https://REPLACE-WITH-OS-URL.example
```

with the HTTPS origin that your n8n instance can reach. Do not include a trailing slash.

For an n8n instance running beside the OS on the same private container network, the URL can be `http://venture-os:3000`. For a remote instance, expose the OS only through HTTPS, a private VPN or a carefully controlled tunnel.

## 3. Activate and copy webhook URLs

Activate the workflows. Their production paths are:

```text
/webhook/content-venture-fulfillment
/webhook/content-venture-welcome
/webhook/content-venture-optimize
/webhook/content-venture-publish
```

Set the OS `N8N_WEBHOOK_BASE_URL` to the origin immediately before those paths, normally `https://n8n.example.com`.

## 4. Verify safely

- Confirm the OS dashboard reports n8n `ready`.
- Upload a small test product.
- Submit a lead and confirm a successful `email.send_welcome` receipt.
- Use the local test-fulfillment endpoint only with test data.
- Open the generated protected link and verify its download counter increments.
- Run the optimizer, inspect the exact patch, and approve it.
- Confirm the funnel version increments only after approval.

## Security boundaries

- Never paste credentials into workflow fields or exported JSON.
- Restrict the OS API credential to this project and rotate it if an export leaks.
- Keep the webhook Header Auth credential attached to all four triggers.
- Do not expose the internal `/api/n8n/actions/*` endpoints without HTTPS.
- Keep `ALLOW_TEST_ACTIONS=false` outside local PoC verification.
- Run n8n's security audit and review unprotected webhooks before public use.
