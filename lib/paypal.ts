// Kaasu — PayPal client (sandbox). Two execution paths, one contract:
//  - Live mode: the PayPal Agent Toolkit's tools (send_invoice,
//    send_invoice_reminder) execute the operation; direct REST is the fallback
//    if a toolkit call throws, and REST handles create/get/list/cancel/
//    record-payment/webhook-verify.
//  - Mock mode (no credentials): every call returns sandbox-shaped demo data
//    clearly labelled as demo. The UI shows a "Demo mode" badge in mock mode
//    so nothing is ever presented as a real PayPal invoice when it is not.

import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';

export const PAYPAL_MODE = (() => {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  return id && secret ? 'live' : 'mock';
})();

const ENV = (process.env.PAYPAL_ENVIRONMENT || 'SANDBOX').toUpperCase();
export const PAYPAL_BASE =
  ENV === 'PRODUCTION' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

export function paypalConfigured() {
  return PAYPAL_MODE === 'live';
}

// Toolkit instance (live mode only). The toolkit wraps the same PayPal
// Invoicing API; its tools are executed directly (no LLM) for determinism.
let toolkit: PayPalAgentToolkit | null = null;
function getToolkit(): PayPalAgentToolkit {
  if (!toolkit) {
    toolkit = new PayPalAgentToolkit({
      clientId: process.env.PAYPAL_CLIENT_ID!,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
      configuration: {
        actions: {
          invoices: {
            create: true,
            list: true,
            send: true,
            sendReminder: true,
            generateQRC: true,
            cancel: true,
            recordPayment: true,
          },
        },
        context: { sandbox: ENV !== 'PRODUCTION' },
      },
    });
  }
  return toolkit;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID!;
  const secret = process.env.PAYPAL_CLIENT_SECRET!;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function paypalFetch(path: string, init: RequestInit = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { message?: string })?.message || `PayPal ${path} failed: ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export interface CreateInvoiceInput {
  number: string;
  clientName: string;
  clientEmail: string;
  description: string;
  amount: number; // USD
  dueDate: string; // yyyy-MM-dd
  memo?: string;
}

export interface PayPalInvoiceResult {
  paypalId: string;
  payLink: string;
  status: string;
}

function splitName(full: string): { given_name: string; surname: string } {
  const parts = full.trim().split(/\s+/);
  return { given_name: parts[0] || 'Client', surname: parts.slice(1).join(' ') || '—' };
}

export async function createPayPalInvoice(input: CreateInvoiceInput): Promise<PayPalInvoiceResult> {
  if (PAYPAL_MODE === 'mock') {
    const mockId = `MOCK-${input.number}`;
    return {
      paypalId: mockId,
      payLink: `https://www.sandbox.paypal.com/invoice/p/${mockId}`,
      status: 'DRAFT',
    };
  }
  const { given_name, surname } = splitName(input.clientName);
  const body = {
    detail: {
      currency_code: 'USD',
      invoice_number: input.number,
      payment_term: { term_type: 'NET_10', due_date: input.dueDate },
      memo: input.memo || 'Created by Kaasu — AI billing agent',
    },
    invoicer: {
      name: { given_name: 'Shanmugaraj', surname: 'S' },
      email_address: process.env.PAYPAL_MERCHANT_EMAIL || 'support@promptstudioai.in',
    },
    primary_recipients: [
      { billing_info: { name: { given_name, surname }, email_address: input.clientEmail } },
    ],
    items: [
      {
        name: input.description.slice(0, 100),
        quantity: '1',
        unit_amount: { currency_code: 'USD', value: input.amount.toFixed(2) },
      },
    ],
    configuration: {
      allow_tip: false,
      partial_payment: { allow_partial_payment: false },
      tax_calculated_after_discount: false,
    },
  };
  const data = (await paypalFetch('/v2/invoicing/invoices', {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { id: string; links?: { rel: string; href: string }[] };
  const payerLink = data.links?.find((l) => l.rel === 'payer-view')?.href;
  return {
    paypalId: data.id,
    payLink: payerLink || `https://www.sandbox.paypal.com/invoice/p/${data.id}`,
    status: 'DRAFT',
  };
}

// AI-SDK Tool.execute takes (input, options). Call it directly with a
// synthetic tool-call id; the toolkit tools are pure PayPal API calls.
async function executeTool(tool: unknown, input: Record<string, unknown>): Promise<unknown> {
  const t = tool as {
    execute?: (input: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown>;
  };
  if (typeof t.execute !== 'function') throw new Error('PayPal tool has no execute function');
  return t.execute(input, { toolCallId: `kaasu-${Date.now()}`, messages: [] });
}

export async function sendPayPalInvoice(paypalId: string): Promise<void> {
  if (PAYPAL_MODE === 'mock') return;
  try {
    const tools = getToolkit().getTools();
    await executeTool(tools['send_invoice'], { invoice_id: paypalId, send_to_recipient: true });
  } catch {
    // Toolkit path failed — fall back to direct REST for the same operation.
    await paypalFetch(`/v2/invoicing/invoices/${paypalId}/send`, {
      method: 'POST',
      body: JSON.stringify({ send_to_recipient: true }),
    });
  }
}

export async function getPayPalInvoice(paypalId: string): Promise<{ status: string; paidAt?: string }> {
  if (PAYPAL_MODE === 'mock') return { status: 'SENT' };
  const data = (await paypalFetch(`/v2/invoicing/invoices/${paypalId}`)) as {
    status?: string;
    payments?: { transactions?: { payment_date?: string }[] };
  };
  const paidAt = data.payments?.transactions?.[0]?.payment_date;
  return { status: (data.status || 'SENT').toUpperCase(), paidAt };
}

export async function listPayPalInvoices(): Promise<{ id: string; status: string }[]> {
  if (PAYPAL_MODE === 'mock') return [];
  const data = (await paypalFetch('/v2/invoicing/search-invoices', {
    method: 'POST',
    body: JSON.stringify({ page: 1, page_size: 20, total_required: true }),
  })) as { items?: { id: string; status: string }[] };
  return (data.items || []).map((i) => ({ id: i.id, status: (i.status || '').toUpperCase() }));
}

export async function sendPayPalReminder(
  paypalId: string,
  subject: string,
  note: string,
): Promise<void> {
  if (PAYPAL_MODE === 'mock') return;
  try {
    const tools = getToolkit().getTools();
    await executeTool(tools['send_invoice_reminder'], { invoice_id: paypalId, subject, note });
  } catch {
    await paypalFetch(`/v2/invoicing/invoices/${paypalId}/remind`, {
      method: 'POST',
      body: JSON.stringify({ subject, note, send_to_recipient: true }),
    });
  }
}

export async function cancelPayPalInvoice(paypalId: string, reason = 'Cancelled by merchant'): Promise<void> {
  if (PAYPAL_MODE === 'mock') return;
  await paypalFetch(`/v2/invoicing/invoices/${paypalId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ subject: 'Invoice cancelled', note: reason, send_to_recipient: true }),
  });
}

export async function recordPayPalPayment(paypalId: string, amount: number, date: string): Promise<void> {
  if (PAYPAL_MODE === 'mock') return;
  await paypalFetch(`/v2/invoicing/invoices/${paypalId}/payments`, {
    method: 'POST',
    body: JSON.stringify({
      method: 'OTHER',
      payment_date: date,
      amount: { currency_code: 'USD', value: amount.toFixed(2) },
    }),
  });
}

export async function verifyWebhookSignature(
  headers: Record<string, string | undefined>,
  body: unknown,
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId || PAYPAL_MODE === 'mock') return false;
  try {
    const data = (await paypalFetch('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: JSON.stringify({
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: body,
      }),
    })) as { verification_status?: string };
    return data.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}
