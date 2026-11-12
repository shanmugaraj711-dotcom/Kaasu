# Kaasu — AI billing & collections agent for freelancers

**PayPal AI Hackathon entry (Devpost).** A Chennai freelancer speaks or types in Tamil or English — *"Ravi, website work, $500, due Friday"* — and Kaasu parses it into a structured invoice, shows a confirm card, creates and sends a **real PayPal invoice (sandbox)** with a QR code, and chases late payers with reminders on a tone ladder. Every agent action is written to an audit log with its reasoning.

## The problem

Freelancers and tiny shops in India who bill US clients lose money to late payments: invoices live in scattered chats, follow-ups are awkward, and nobody chases. Kaasu closes the loop — intake → invoice → payment → collections — in one place, in Tamil or English.

## How it works

1. **Intake** — type or speak (Web Speech API, ta-IN / en-IN). AI parses the note into client, work, amount (USD), due date. A deterministic rules parser is the fallback, and the UI says which one ran.
2. **Confirm card** — the freelancer approves the structured invoice before anything is sent.
3. **PayPal invoice** — created and sent through the PayPal Invoicing API (sandbox). The buyer gets the real PayPal invoice email and a QR code for the pay link.
4. **Paid, live** — a PayPal webhook (`INVOICING.INVOICE.PAID`, signature-verified) flips the invoice to Paid. A polling fallback covers webhook lag.
5. **Collections agent** — finds overdue invoices and drafts reminders on a tone ladder: 1 friendly (0–3 days), 2 polite-firm (4–7), 3 firm (8–14), 4 final notice (15+). Drafts wait in an approval queue. Autopilot (off by default) auto-sends tone-1 only. Cap: 3 reminders per invoice, 24h apart.
6. **Guardrails** — prompt injection in client names/notes is scanned and blocks the action; refunds and cancellations always need human confirmation; every agent action lands in the audit log with its reasoning.
7. **Dashboard** — AG Grid receivables table with status, aging, late-risk score and next action.

## Stack

- Next.js 16 + TypeScript (App Router), Tailwind CSS 4
- PayPal Invoicing API (sandbox): `@paypal/agent-toolkit` tools execute send/reminder operations (direct REST fallback + REST for create/get/list/cancel/record-payment/webhook-verify)
- AI: OpenRouter free tier (`nvidia/nemotron-3-ultra-550b-a55b:free`) first, Groq free tier (`openai/gpt-oss-120b`) second, via the Vercel AI SDK. Daily budget guard: 40 AI calls/day (OpenRouter account cap is 50; Groq free tier is ~1,000/day). No paid keys anywhere.
- AG Grid for the receivables dashboard
- Hosting: Vercel (must stay live through judging, Dec 15)

## Run it

```bash
npm install
cp .env.local.example .env.local   # fill in keys (see below)
npm run dev                          # http://localhost:3000
```

Without keys the app runs in clearly-labelled **Demo mode**: PayPal calls return sandbox-shaped mock data and AI parsing uses the rules fallback. Nothing is ever presented as a real PayPal invoice when it is not.

## Environment variables

| Variable | What it is |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter free-tier key. Without it: Groq is tried next, then rules/template fallback. |
| `GROQ_API_KEY` | Groq free-tier key (free, no card). Second try when OpenRouter fails or is unset. |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | PayPal Developer REST app (sandbox). Without them: mock mode. |
| `PAYPAL_ENVIRONMENT` | `SANDBOX` (default) |
| `PAYPAL_MERCHANT_EMAIL` | Email shown as the invoicer (sandbox business account). |
| `PAYPAL_WEBHOOK_ID` | Webhook ID for signature verification. Until set, polling covers payment status. |

## API routes

| Route | What it does |
| --- | --- |
| `GET /api/health` | App + PayPal/AI mode + AI budget left |
| `POST /api/parse` | Parse a billing note into a structured invoice |
| `GET /api/invoices` | List + stats (polls PayPal for SENT invoices in live mode) |
| `POST /api/invoices` | Create + send a PayPal invoice (confirm: true) |
| `POST /api/invoices/[id]` | Actions: send, refresh, remind, draft-reminder, cancel (human confirm), record-payment (human confirm) |
| `POST /api/webhooks/paypal` | PayPal webhook receiver (signature-verified) |
| `GET/POST /api/reminders` | Approval queue / run the collections agent |
| `POST /api/reminders/[id]` | Approve & send, or reject a draft |
| `GET /api/audit` | Audit log |
| `GET/POST /api/settings` | Autopilot toggle |

## Known limitations (honest)

- **No provisioned Postgres yet.** State lives in memory per server instance and re-seeds deterministically on boot; PayPal sandbox is the source of truth for invoices. A `DATABASE_URL` Postgres adapter is the next step.
- **50 free OpenRouter requests/day** on the account. The in-app budget guard caps AI use at 40/day; if OpenRouter fails, Groq (free, ~1,000/day) is tried before falling back to rules/templates.
- **USD only.** PayPal sandbox INR support is uncertain; the product is framed for cross-border billing, which is also the honest story for Indian freelancers.

## Demo script (under 3 minutes)

0:00 Hook — a Chennai freelancer chasing dollar invoices.
0:15 Tamil voice note becomes an invoice card; approve it; PayPal invoice + QR appear.
0:50 Sandbox buyer pays; the feed and grid flip to Paid live.
1:20 Time machine +10 days; the agent picks a different tone per client, shows its reasoning, and queues reminders.
2:00 Guardrails — a prompt-injection attempt and a refund request are both blocked; the audit log shows why.
2:25 Architecture + impact line + URL.

## License

MIT
