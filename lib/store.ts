// Kaasu — in-memory store with demo seed data.
//
// Persistence note (honest limitation): this demo runs without a provisioned
// Postgres yet (Neon/Supabase signup needs a browser). State lives in memory
// per server instance and re-seeds deterministically on boot. Invoices created
// in live PayPal sandbox mode are the source of truth in PayPal itself and are
// re-listed from PayPal on boot. When DATABASE_URL is configured, swap this
// store for the Postgres adapter (see README).

import type { AuditEntry, Client, Invoice, ReminderDraft, Settings } from './types';
import { riskScoreFor } from './types';

const NOW = new Date();
const iso = (d: Date) => d.toISOString();
const day = (offset: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

export const SEED_CLIENTS: Client[] = [
  { id: 'c-ravi', name: 'Ravi Kumar', email: 'ravi.kumar@example.com', language: 'en', notes: 'Website client, Chennai' },
  { id: 'c-priya', name: 'Priya Nair', email: 'priya.nair@example.com', language: 'en', notes: 'Brand design client' },
  { id: 'c-arjun', name: 'Arjun Mehta', email: 'arjun.mehta@example.com', language: 'en', notes: 'SEO client' },
  { id: 'c-meera', name: 'Meera Iyer', email: 'meera.iyer@example.com', language: 'ta', notes: 'Tamil voiceover client — reminders in Tamil' },
  { id: 'c-karthik', name: 'Karthik Rajan', email: 'karthik.rajan@example.com', language: 'en', notes: 'App UI client' },
];

function seedInvoices(): Invoice[] {
  const list: Invoice[] = [
    {
      id: 'INV-1001', number: 'KAASU-0001', paypalId: 'MOCK-KAASU-0001', payLink: 'https://www.sandbox.paypal.com/invoice/p/MOCK-KAASU-0001', clientId: 'c-ravi', clientName: 'Ravi Kumar',
      clientEmail: 'ravi.kumar@example.com', description: 'Website redesign — homepage + 5 pages',
      amount: 500, currency: 'USD', dueDate: day(-7), status: 'OVERDUE',
      createdAt: iso(new Date(NOW.getTime() - 12 * 86400000)), reminderCount: 2,
      lastReminderAt: iso(new Date(NOW.getTime() - 2 * 86400000)), riskScore: 0,
    },
    {
      id: 'INV-1002', number: 'KAASU-0002', paypalId: 'MOCK-KAASU-0002', payLink: 'https://www.sandbox.paypal.com/invoice/p/MOCK-KAASU-0002', clientId: 'c-priya', clientName: 'Priya Nair',
      clientEmail: 'priya.nair@example.com', description: 'Logo & brand kit',
      amount: 350, currency: 'USD', dueDate: day(-4), status: 'OVERDUE',
      createdAt: iso(new Date(NOW.getTime() - 9 * 86400000)), reminderCount: 1,
      lastReminderAt: iso(new Date(NOW.getTime() - 1 * 86400000)), riskScore: 0,
    },
    {
      id: 'INV-1003', number: 'KAASU-0003', paypalId: 'MOCK-KAASU-0003', payLink: 'https://www.sandbox.paypal.com/invoice/p/MOCK-KAASU-0003', clientId: 'c-arjun', clientName: 'Arjun Mehta',
      clientEmail: 'arjun.mehta@example.com', description: 'SEO setup — keywords + on-page',
      amount: 800, currency: 'USD', dueDate: day(2), status: 'SENT',
      createdAt: iso(new Date(NOW.getTime() - 5 * 86400000)), reminderCount: 0, riskScore: 0,
    },
    {
      id: 'INV-1004', number: 'KAASU-0004', paypalId: 'MOCK-KAASU-0004', payLink: 'https://www.sandbox.paypal.com/invoice/p/MOCK-KAASU-0004', clientId: 'c-meera', clientName: 'Meera Iyer',
      clientEmail: 'meera.iyer@example.com', description: 'Tamil voiceover — 4 videos',
      amount: 200, currency: 'USD', dueDate: day(5), status: 'SENT',
      createdAt: iso(new Date(NOW.getTime() - 3 * 86400000)), reminderCount: 0, riskScore: 0,
    },
    {
      id: 'INV-1005', number: 'KAASU-0005', paypalId: 'MOCK-KAASU-0005', payLink: 'https://www.sandbox.paypal.com/invoice/p/MOCK-KAASU-0005', clientId: 'c-karthik', clientName: 'Karthik Rajan',
      clientEmail: 'karthik.rajan@example.com', description: 'App UI design — 8 screens',
      amount: 1200, currency: 'USD', dueDate: day(-13), status: 'PAID',
      createdAt: iso(new Date(NOW.getTime() - 20 * 86400000)),
      paidAt: iso(new Date(NOW.getTime() - 8 * 86400000)), reminderCount: 0, riskScore: 0,
    },
    {
      id: 'INV-1006', number: 'KAASU-0006', paypalId: 'MOCK-KAASU-0006', payLink: 'https://www.sandbox.paypal.com/invoice/p/MOCK-KAASU-0006', clientId: 'c-ravi', clientName: 'Ravi Kumar',
      clientEmail: 'ravi.kumar@example.com', description: 'Monthly maintenance retainer',
      amount: 150, currency: 'USD', dueDate: day(10), status: 'DRAFT',
      createdAt: iso(new Date(NOW.getTime() - 1 * 86400000)), reminderCount: 0, riskScore: 0,
    },
  ];
  for (const inv of list) inv.riskScore = riskScoreFor(inv);
  return list;
}

function seedAudit(): AuditEntry[] {
  const t = (daysAgo: number, h = 10) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };
  return [
    { id: 'a1', ts: t(8, 11), actor: 'agent', action: 'Invoice paid', detail: 'KAASU-0005 (Karthik Rajan, $1,200) marked PAID via PayPal webhook INVOICING.INVOICE.PAID.', reasoning: 'Webhook signature verified; invoice status flipped to PAID automatically.' },
    { id: 'a2', ts: t(2, 15), actor: 'agent', action: 'Reminder sent', detail: 'Tone 2 reminder sent to Ravi Kumar for KAASU-0001 ($500, 5 days overdue).', reasoning: 'Overdue 5 days → tone 2 (polite-firm). Reminder 2 of 3 allowed.' },
    { id: 'a3', ts: t(1, 9), actor: 'agent', action: 'Reminder sent', detail: 'Tone 1 reminder sent to Priya Nair for KAASU-0002 ($350, 3 days overdue).', reasoning: 'Overdue 3 days → tone 1 (friendly). First reminder.' },
    { id: 'a4', ts: t(1, 9), actor: 'system', action: 'Guardrail check passed', detail: 'All client names and notes scanned for prompt injection before the reminder run. No issues found.' },
    { id: 'a5', ts: t(0, 9), actor: 'user', action: 'Draft invoice created', detail: 'KAASU-0006 (Ravi Kumar, $150 maintenance retainer) saved as DRAFT.', reasoning: 'User asked to hold it until the 15th.' },
  ];
}

// Module-level singleton. On serverless this lives per instance; seed is deterministic.
class Store {
  clients: Client[] = [...SEED_CLIENTS];
  invoices: Invoice[] = seedInvoices();
  audit: AuditEntry[] = seedAudit();
  reminders: ReminderDraft[] = [];
  settings: Settings = { autopilot: false };
  invoiceSeq = 1007;
  auditSeq = 100;
  reminderSeq = 1;

  log(actor: AuditEntry['actor'], action: string, detail: string, reasoning?: string) {
    const entry: AuditEntry = {
      id: `a${this.auditSeq++}`,
      ts: new Date().toISOString(),
      actor,
      action,
      detail,
      reasoning,
    };
    this.audit.unshift(entry);
    if (this.audit.length > 200) this.audit.length = 200;
    return entry;
  }

  refreshRisk() {
    for (const inv of this.invoices) inv.riskScore = riskScoreFor(inv);
  }
}

export const store = new Store();
