import { NextRequest, NextResponse } from 'next/server';
import { draftReminder, scanForInjection } from '@/lib/ai';
import {
  cancelPayPalInvoice,
  getPayPalInvoice,
  recordPayPalPayment,
  sendPayPalInvoice,
  sendPayPalReminder,
} from '@/lib/paypal';
import { store } from '@/lib/store';
import { riskScoreFor } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const inv = store.invoices.find((i) => i.id === id);
  if (!inv) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
  return NextResponse.json({ invoice: inv });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const inv = store.invoices.find((i) => i.id === id);
  if (!inv) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    confirmedByHuman?: boolean;
    subject?: string;
    note?: string;
  };
  const action = body.action;

  try {
    if (action === 'send') {
      if (!inv.paypalId) return NextResponse.json({ error: 'No PayPal invoice attached.' }, { status: 400 });
      await sendPayPalInvoice(inv.paypalId);
      inv.status = 'SENT';
      inv.riskScore = riskScoreFor(inv);
      store.log('user', 'Invoice sent', `${inv.number} sent to ${inv.clientName} (${inv.clientEmail}).`);
      return NextResponse.json({ invoice: inv });
    }

    if (action === 'refresh') {
      if (!inv.paypalId) return NextResponse.json({ invoice: inv });
      const live = await getPayPalInvoice(inv.paypalId);
      if (live.status === 'PAID' || live.status === 'MARKED_AS_PAID') {
        inv.status = 'PAID';
        inv.paidAt = live.paidAt || new Date().toISOString();
        inv.riskScore = 0;
        store.log('paypal', 'Invoice paid', `${inv.number} (${inv.clientName}, $${inv.amount}) marked PAID after status check.`);
      }
      return NextResponse.json({ invoice: inv });
    }

    if (action === 'remind') {
      // Reminders go through the approval queue by default; this direct action
      // is only used when the user explicitly sends one from the UI.
      if (inv.reminderCount >= 3) {
        return NextResponse.json({ error: 'Reminder cap reached (3 per invoice). No more reminders for this invoice.' }, { status: 400 });
      }
      const injection = scanForInjection(`${body.subject || ''} ${body.note || ''}`);
      if (injection.blocked) {
        store.log('system', 'Guardrail blocked reminder', `Blocked reminder for ${inv.number}: ${injection.reasons.join('; ')}`);
        return NextResponse.json({ error: `Blocked by guardrail: ${injection.reasons.join('; ')}` }, { status: 400 });
      }
      if (!inv.paypalId) return NextResponse.json({ error: 'No PayPal invoice attached.' }, { status: 400 });
      await sendPayPalReminder(inv.paypalId, body.subject || `Payment reminder — ${inv.number}`, body.note || `Hi ${inv.clientName.split(' ')[0]}, a friendly reminder that your $${inv.amount} invoice for "${inv.description}" is due ${inv.dueDate}.`);
      inv.reminderCount += 1;
      inv.lastReminderAt = new Date().toISOString();
      inv.riskScore = riskScoreFor(inv);
      store.log('user', 'Reminder sent', `Reminder ${inv.reminderCount}/3 sent to ${inv.clientName} for ${inv.number}.`);
      return NextResponse.json({ invoice: inv });
    }

    if (action === 'cancel') {
      // Cancellations always need explicit human confirmation — the agent never
      // cancels on its own.
      if (!body.confirmedByHuman) {
        return NextResponse.json({ error: 'Cancellation needs human confirmation (confirmedByHuman: true).' }, { status: 400 });
      }
      if (inv.paypalId) await cancelPayPalInvoice(inv.paypalId);
      inv.status = 'CANCELLED';
      inv.riskScore = 0;
      store.log('user', 'Invoice cancelled', `${inv.number} (${inv.clientName}, $${inv.amount}) cancelled by the user.`);
      return NextResponse.json({ invoice: inv });
    }

    if (action === 'record-payment') {
      if (!body.confirmedByHuman) {
        return NextResponse.json({ error: 'Recording a payment needs human confirmation (confirmedByHuman: true).' }, { status: 400 });
      }
      if (inv.paypalId) await recordPayPalPayment(inv.paypalId, inv.amount, new Date().toISOString().slice(0, 10));
      inv.status = 'PAID';
      inv.paidAt = new Date().toISOString();
      inv.riskScore = 0;
      store.log('user', 'Payment recorded', `${inv.number} (${inv.clientName}, $${inv.amount}) recorded as paid (offline payment).`);
      return NextResponse.json({ invoice: inv });
    }

    if (action === 'draft-reminder') {
      const client = store.clients.find((c) => c.id === inv.clientId);
      const language = client?.language || 'en';
      const overdueDays = Math.max(0, Math.floor((Date.now() - new Date(inv.dueDate + 'T23:59:59').getTime()) / 86400000));
      const tone = overdueDays <= 3 ? 1 : overdueDays <= 7 ? 2 : overdueDays <= 14 ? 3 : 4;
      const draft = await draftReminder(inv, tone as 1 | 2 | 3 | 4, language);
      return NextResponse.json({ draft: { text: draft.text, tone, via: draft.via, reasoning: draft.reasoning } });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
