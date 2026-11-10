import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/paypal';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';

// PayPal webhook receiver. Verifies the signature when PAYPAL_WEBHOOK_ID is
// configured; until then it logs unverified events and never flips an invoice
// to PAID on an unverified event (polling in GET /api/invoices covers it).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const eventType = (body as { event_type?: string }).event_type || 'unknown';
    const resource = (body as { resource?: { invoice_id?: string; id?: string } }).resource || {};
    const invoiceId = resource.invoice_id || resource.id;

    const headers: Record<string, string | undefined> = {
      'paypal-auth-algo': req.headers.get('paypal-auth-algo') || undefined,
      'paypal-cert-url': req.headers.get('paypal-cert-url') || undefined,
      'paypal-transmission-id': req.headers.get('paypal-transmission-id') || undefined,
      'paypal-transmission-sig': req.headers.get('paypal-transmission-sig') || undefined,
      'paypal-transmission-time': req.headers.get('paypal-transmission-time') || undefined,
    };
    const verified = await verifyWebhookSignature(headers, body);

    if (!verified) {
      store.log('system', 'Webhook received (unverified)', `Event ${eventType} for invoice ${invoiceId || 'unknown'} — signature NOT verified (no webhook ID configured yet). No status changed.`, 'Unverified webhooks never change invoice state; the polling fallback in GET /api/invoices is the safety net.');
      return NextResponse.json({ received: true, verified: false });
    }

    if (eventType === 'INVOICING.INVOICE.PAID' && invoiceId) {
      const inv = store.invoices.find((i) => i.paypalId === invoiceId);
      if (inv && inv.status !== 'PAID') {
        inv.status = 'PAID';
        inv.paidAt = new Date().toISOString();
        inv.riskScore = 0;
        store.log('paypal', 'Invoice paid', `${inv.number} (${inv.clientName}, $${inv.amount}) marked PAID via webhook ${eventType}.`, 'Webhook signature verified; invoice flipped to Paid live.');
      }
    } else {
      store.log('paypal', 'Webhook received', `Event ${eventType} for invoice ${invoiceId || 'unknown'} (verified). No action needed.`);
    }
    return NextResponse.json({ received: true, verified: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
