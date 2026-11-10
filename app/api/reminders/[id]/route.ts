import { NextRequest, NextResponse } from 'next/server';
import { sendPayPalReminder } from '@/lib/paypal';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// Approve / reject / send a queued reminder draft.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const reminder = store.reminders.find((r) => r.id === id);
  if (!reminder) return NextResponse.json({ error: 'Reminder not found.' }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  const action = body.action;

  if (action === 'reject') {
    reminder.status = 'rejected';
    store.log('user', 'Reminder rejected', `Draft for invoice ${reminder.invoiceId} (tone ${reminder.tone}) rejected by the user. No message sent.`);
    return NextResponse.json({ reminder });
  }

  if (action === 'approve' || action === 'send') {
    const inv = store.invoices.find((i) => i.id === reminder.invoiceId);
    if (!inv) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
    if (inv.reminderCount >= 3) {
      return NextResponse.json({ error: 'Reminder cap reached (3 per invoice).' }, { status: 400 });
    }
    if (!inv.paypalId) return NextResponse.json({ error: 'No PayPal invoice attached.' }, { status: 400 });
    await sendPayPalReminder(inv.paypalId, `Payment reminder — ${inv.number}`, reminder.text);
    reminder.status = 'sent';
    reminder.sentAt = new Date().toISOString();
    inv.reminderCount += 1;
    inv.lastReminderAt = reminder.sentAt;
    store.log('user', 'Reminder sent', `Tone ${reminder.tone} reminder sent to ${inv.clientName} for ${inv.number} after human approval.`, reminder.reasoning);
    return NextResponse.json({ reminder, invoice: inv });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
