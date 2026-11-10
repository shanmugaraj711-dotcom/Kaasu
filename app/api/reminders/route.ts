import { NextRequest, NextResponse } from 'next/server';
import { draftReminder, scanForInjection } from '@/lib/ai';
import { sendPayPalReminder } from '@/lib/paypal';
import { store } from '@/lib/store';
import { daysOverdue, toneForOverdueDays } from '@/lib/types';
import type { ReminderDraft } from '@/lib/types';

export const dynamic = 'force-dynamic';

const REMINDER_CAP = 3;

export async function GET() {
  return NextResponse.json({ reminders: store.reminders, autopilot: store.settings.autopilot });
}

// Run the collections agent: find overdue invoices, draft reminders on the
// tone ladder, put them in the approval queue. Nothing sends without approval
// unless autopilot is on — and even then only tone-1 reminders auto-send.
export async function POST() {
  const now = new Date();
  const created: ReminderDraft[] = [];
  const skipped: string[] = [];

  for (const inv of store.invoices) {
    if (inv.status !== 'SENT' && inv.status !== 'OVERDUE') continue;
    const overdue = daysOverdue(inv.dueDate, now);
    if (overdue < 0) continue; // not due yet
    if (inv.reminderCount >= REMINDER_CAP) {
      skipped.push(`${inv.number}: reminder cap (3) reached`);
      continue;
    }
    if (inv.lastReminderAt && now.getTime() - new Date(inv.lastReminderAt).getTime() < 24 * 3600 * 1000) {
      skipped.push(`${inv.number}: reminded in the last 24h`);
      continue;
    }
    const pending = store.reminders.find((r) => r.invoiceId === inv.id && r.status === 'pending');
    if (pending) {
      skipped.push(`${inv.number}: draft already waiting for approval`);
      continue;
    }
    const client = store.clients.find((c) => c.id === inv.clientId);
    const language = client?.language || 'en';
    const tone = toneForOverdueDays(overdue);
    const draft = await draftReminder(inv, tone, language);
    const injection = scanForInjection(draft.text);
    if (injection.blocked) {
      store.log('system', 'Guardrail blocked reminder draft', `Draft for ${inv.number} blocked: ${injection.reasons.join('; ')}`);
      skipped.push(`${inv.number}: draft blocked by guardrail`);
      continue;
    }
    const reminder: ReminderDraft = {
      id: `r${store.reminderSeq++}`,
      invoiceId: inv.id,
      tone,
      text: draft.text,
      language,
      status: 'pending',
      createdAt: new Date().toISOString(),
      reasoning: draft.reasoning + ` Drafted via ${draft.via}.`,
    };
    store.reminders.unshift(reminder);
    created.push(reminder);

    // Autopilot: only tone-1 (friendly) reminders send automatically.
    if (store.settings.autopilot && tone === 1 && inv.paypalId) {
      try {
        await sendPayPalReminder(inv.paypalId, `Payment reminder — ${inv.number}`, draft.text);
        reminder.status = 'sent';
        reminder.sentAt = new Date().toISOString();
        inv.reminderCount += 1;
        inv.lastReminderAt = reminder.sentAt;
        store.log('agent', 'Reminder auto-sent (autopilot)', `Tone 1 reminder sent to ${inv.clientName} for ${inv.number}.`, 'Autopilot is on; only friendly (tone 1) reminders auto-send. Higher tones always wait for approval.');
      } catch (err) {
        store.log('system', 'Autopilot send failed', `Tone 1 reminder for ${inv.number} failed: ${(err as Error).message}. Draft stays in the queue.`);
      }
    }
  }

  store.log(
    'agent',
    'Collections run finished',
    `${created.length} reminder draft(s) created, ${skipped.length} skipped.`,
    created.length ? 'Tone ladder: 1 friendly (0–3 days overdue), 2 polite-firm (4–7), 3 firm (8–14), 4 final notice (15+). Cap 3 reminders per invoice.' : 'Nothing overdue that needs a reminder right now.',
  );
  return NextResponse.json({ created, skipped });
}
