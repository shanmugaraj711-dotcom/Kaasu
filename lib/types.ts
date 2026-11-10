// Kaasu — shared types. Currency is USD only (PayPal sandbox INR support is uncertain).

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED';

export interface Client {
  id: string;
  name: string;
  email: string;
  language: 'en' | 'ta';
  notes?: string;
}

export interface Invoice {
  id: string; // local id, e.g. INV-1001
  paypalId?: string; // PayPal invoice id (INV2-...) when created in PayPal
  number: string; // human invoice number, e.g. KAASU-0001
  clientId: string;
  clientName: string;
  clientEmail: string;
  description: string;
  amount: number; // USD
  currency: 'USD';
  dueDate: string; // yyyy-MM-dd
  status: InvoiceStatus;
  createdAt: string; // ISO
  paidAt?: string; // ISO
  payLink?: string; // PayPal payer-view URL
  qrDataUrl?: string; // QR code (PNG data URL) encoding the pay link
  reminderCount: number;
  lastReminderAt?: string; // ISO
  riskScore: number; // 0-100 late-risk score
}

export interface AuditEntry {
  id: string;
  ts: string; // ISO
  actor: 'user' | 'agent' | 'system' | 'paypal';
  action: string;
  detail: string;
  reasoning?: string;
}

export interface ReminderDraft {
  id: string;
  invoiceId: string;
  tone: 1 | 2 | 3 | 4; // 1 friendly, 2 polite-firm, 3 firm, 4 final notice
  text: string;
  language: 'en' | 'ta';
  status: 'pending' | 'approved' | 'sent' | 'rejected';
  createdAt: string;
  sentAt?: string;
  reasoning?: string;
}

export interface ParsedInvoice {
  client: string;
  clientEmail?: string;
  description: string;
  amount_usd: number;
  currency: 'USD';
  due: string; // human due text, e.g. "Friday" or "2026-11-20"
  dueDate?: string; // resolved yyyy-MM-dd
  language?: 'en' | 'ta';
}

export interface Settings {
  autopilot: boolean; // when on, tone-1 reminders send automatically; higher tones still need approval
}

export function daysOverdue(dueDate: string, now = new Date()): number {
  const due = new Date(dueDate + 'T23:59:59');
  const diffMs = now.getTime() - due.getTime();
  return Math.floor(diffMs / 86400000);
}

export function riskScoreFor(inv: Pick<Invoice, 'amount' | 'dueDate' | 'reminderCount' | 'status'>, now = new Date()): number {
  if (inv.status === 'PAID' || inv.status === 'CANCELLED') return 0;
  const overdue = daysOverdue(inv.dueDate, now);
  if (overdue <= 0) {
    // due soon: risk grows as the due date approaches
    const daysLeft = -overdue;
    return Math.max(5, Math.min(40, 40 - daysLeft * 5));
  }
  let score = Math.min(70, overdue * 8);
  if (inv.amount >= 500) score += 15;
  score += Math.min(15, inv.reminderCount * 5);
  return Math.min(100, score);
}

export function toneForOverdueDays(overdue: number): 1 | 2 | 3 | 4 {
  if (overdue <= 3) return 1;
  if (overdue <= 7) return 2;
  if (overdue <= 14) return 3;
  return 4;
}
