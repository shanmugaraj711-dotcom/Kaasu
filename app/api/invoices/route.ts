import { NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { scanForInjection } from '@/lib/ai';
import { createPayPalInvoice, getPayPalInvoice, paypalConfigured, PAYPAL_MODE } from '@/lib/paypal';
import { store } from '@/lib/store';
import type { Invoice, ParsedInvoice } from '@/lib/types';
import { riskScoreFor } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  store.refreshRisk();
  // Seed invoices carry a pay link but no QR yet — generate it on demand.
  for (const inv of store.invoices) {
    if (inv.payLink && !inv.qrDataUrl) {
      try {
        inv.qrDataUrl = await QRCode.toDataURL(inv.payLink, { width: 180, margin: 1 });
      } catch {
        // QR is a convenience, not a blocker
      }
    }
  }
  // In live mode, refresh statuses from PayPal (polling fallback for webhooks).
  if (paypalConfigured()) {
    for (const inv of store.invoices) {
      if (inv.paypalId && (inv.status === 'SENT' || inv.status === 'OVERDUE')) {
        try {
          const live = await getPayPalInvoice(inv.paypalId);
          if (live.status === 'PAID' || live.status === 'MARKED_AS_PAID') {
            inv.status = 'PAID';
            inv.paidAt = live.paidAt || new Date().toISOString();
            store.log('paypal', 'Invoice paid', `${inv.number} (${inv.clientName}, $${inv.amount}) marked PAID after PayPal status check.`, 'Polling fallback confirmed payment; webhook may have lagged.');
          }
        } catch {
          // leave status as-is; a failed poll is not a payment
        }
      }
    }
    store.refreshRisk();
  }
  const outstanding = store.invoices
    .filter((i) => i.status === 'SENT' || i.status === 'OVERDUE')
    .reduce((s, i) => s + i.amount, 0);
  const overdue = store.invoices
    .filter((i) => i.status === 'OVERDUE')
    .reduce((s, i) => s + i.amount, 0);
  const paid = store.invoices.filter((i) => i.status === 'PAID').reduce((s, i) => s + i.amount, 0);
  return NextResponse.json({
    invoices: store.invoices,
    clients: store.clients,
    stats: {
      outstanding,
      overdue,
      paid,
      count: store.invoices.length,
      atRisk: store.invoices.filter((i) => i.riskScore >= 60 && i.status !== 'PAID').length,
    },
    paypalMode: PAYPAL_MODE,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { parsed?: ParsedInvoice; confirm?: boolean };
    const parsed = body.parsed;
    if (!parsed || !body.confirm) {
      return NextResponse.json({ error: 'Send the parsed invoice with confirm: true to create it.' }, { status: 400 });
    }
    if (!parsed.amount_usd || parsed.amount_usd <= 0) {
      return NextResponse.json({ error: 'Amount must be greater than $0.' }, { status: 400 });
    }
    // Guardrails: prompt injection in client/description/notes can never create an invoice.
    const injection = scanForInjection(`${parsed.client} ${parsed.description} ${parsed.clientEmail || ''}`);
    if (injection.blocked) {
      store.log('system', 'Guardrail blocked invoice', `Blocked invoice for "${parsed.client}": ${injection.reasons.join('; ')}`, 'Prompt-injection patterns in the intake text. No invoice was created.');
      return NextResponse.json({ error: `Blocked by guardrail: ${injection.reasons.join('; ')}` }, { status: 400 });
    }
    const number = `KAASU-${String(store.invoiceSeq).padStart(4, '0')}`;
    store.invoiceSeq += 1;
    const clientEmail = parsed.clientEmail || `${parsed.client.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
    const dueDate = parsed.dueDate || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    // Create the real PayPal invoice (or a clearly-labelled mock one).
    const pp = await createPayPalInvoice({
      number,
      clientName: parsed.client,
      clientEmail,
      description: parsed.description,
      amount: parsed.amount_usd,
      dueDate,
    });
    const qrDataUrl = await QRCode.toDataURL(pp.payLink, { width: 180, margin: 1 });

    const invoice: Invoice = {
      id: `INV-${store.invoiceSeq - 1}`,
      paypalId: pp.paypalId,
      number,
      clientId: `c-${parsed.client.toLowerCase().replace(/[^a-z]+/g, '-')}`,
      clientName: parsed.client,
      clientEmail,
      description: parsed.description,
      amount: parsed.amount_usd,
      currency: 'USD',
      dueDate,
      status: 'SENT',
      createdAt: new Date().toISOString(),
      payLink: pp.payLink,
      qrDataUrl,
      reminderCount: 0,
      riskScore: 0,
    };
    invoice.riskScore = riskScoreFor(invoice);
    store.invoices.unshift(invoice);
    // Keep the client list in sync.
    if (!store.clients.find((c) => c.name.toLowerCase() === parsed.client.toLowerCase())) {
      store.clients.push({ id: invoice.clientId, name: parsed.client, email: clientEmail, language: parsed.language || 'en' });
    }
    store.log(
      'agent',
      'Invoice created & sent',
      `${number} — ${parsed.client}, $${parsed.amount_usd} for "${parsed.description}", due ${dueDate}. PayPal ${PAYPAL_MODE === 'live' ? 'sandbox' : 'DEMO (mock)'} invoice ${pp.paypalId}.`,
      PAYPAL_MODE === 'live'
        ? 'Created and sent through the PayPal Invoicing API (sandbox). Buyer gets the real PayPal invoice email.'
        : 'PayPal sandbox credentials are not configured yet, so this is a demo invoice. Connect sandbox credentials to send real invoices.',
    );
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
