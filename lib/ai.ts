// Kaasu — AI layer (OpenRouter free tier first, Groq free tier second) + guardrails.
// Provider 1: nvidia/nemotron-3-ultra-550b-a55b:free via OpenRouter — verified working 2026-11-10
//   with maxTokens >= 800 (the model spends ~200 tokens reasoning; or.py's
//   max_tokens=60 returns empty). Cost $0, 50 free requests/day on the account.
// Provider 2: openai/gpt-oss-120b via Groq — free, no card, ~30 req/min,
//   ~1,000 req/day. Added 2026-11-12 after OpenRouter returned empty
//   ("No object generated") at the 2026-11-11 19:40 check; Groq is tried
//   whenever OpenRouter fails or has no key, before the rules fallback.
// Every AI call has a deterministic fallback (regex parse / template draft)
// so the product keeps working if the models are busy or the daily cap is hit.

import { generateObject, generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';
import type { Invoice, ParsedInvoice } from './types';

export const AI_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
export const GROQ_MODEL = 'openai/gpt-oss-120b';
export const groqConfigured = () => Boolean(process.env.GROQ_API_KEY);
export const AI_MODE = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY ? 'live' : 'rules';

const openrouter = () =>
  createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY || 'missing' });

const groq = () =>
  createGroq({ apiKey: process.env.GROQ_API_KEY || 'missing' });

// ---- daily AI budget guard (account cap is 50/day; stay under it) ----
let aiCallsToday = 0;
let aiCallsDay = new Date().toISOString().slice(0, 10);
const AI_DAILY_CAP = 40;

export function aiBudgetLeft(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== aiCallsDay) {
    aiCallsDay = today;
    aiCallsToday = 0;
  }
  return Math.max(0, AI_DAILY_CAP - aiCallsToday);
}

function spendAiCall() {
  aiCallsToday += 1;
}

// ---- guardrails ----
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /\b(system|developer)\s*:\s/i,
  /\[SYSTEM\]/i,
  /send\s+(a\s+)?refund/i,
  /cancel\s+(this\s+)?invoice/i,
  /transfer\s+(money|funds|payment)/i,
  /new\s+instructions\s*:/i,
  /jailbreak/i,
  /override\s+(the\s+)?(rules|instructions|safety)/i,
  /you\s+are\s+now\s+/i,
  /pretend\s+(you|to\s+be)/i,
];

export function scanForInjection(text: string): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) reasons.push(`matched guardrail pattern ${re.source}`);
  }
  return { blocked: reasons.length > 0, reasons };
}

// ---- due-date resolution ----
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

export function resolveDueDate(dueText: string, from = new Date()): string {
  const t = dueText.trim().toLowerCase();
  const iso = /^\d{4}-\d{2}-\d{2}$/.exec(t);
  if (iso) return iso[0];
  const addDays = (n: number) => {
    const d = new Date(from);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  if (t === 'today') return addDays(0);
  if (t === 'tomorrow') return addDays(1);
  if (t === 'next week') return addDays(7);
  if (/^in\s+(\d+)\s+days?$/.test(t)) return addDays(parseInt(t.match(/\d+/)![0], 10));
  const wd = WEEKDAYS[t];
  if (wd !== undefined) {
    const d = new Date(from);
    let diff = (wd - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7; // "Friday" on a Friday means next Friday
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }
  const m = t.match(/^(\d{1,2})(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)?/);
  if (m) {
    const dayNum = parseInt(m[1], 10);
    const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const month = m[3] ? months[m[3]] : from.getMonth();
    const d = new Date(from.getFullYear(), month, dayNum);
    if (d < from) d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  }
  return addDays(7); // default: net 7
}

// ---- deterministic fallback parser (no AI) ----
export function rulesParse(text: string): ParsedInvoice {
  const t = text.trim();
  const amountMatch = t.match(/\$?\s?(\d[\d,]*\.?\d*)\s?(dollars|usd|\$)?/i);
  const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;
  // client: first capitalised word(s) before a comma or "for"
  const clientMatch = t.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  const client = clientMatch ? clientMatch[1] : 'Client';
  // description: text between client and amount
  let description = t
    .replace(/^[^,]+,?\s*/, '')
    .replace(/\$?\s?\d[\d,]*\.?\d*\s?(dollars|usd|\$)?/gi, '')
    .replace(/due\s+.*$/i, '')
    .replace(/,/g, ' ')
    .trim();
  if (!description) description = 'Freelance work';
  const dueMatch = t.match(/due\s+([a-z0-9\s]+)$/i);
  const due = dueMatch ? dueMatch[1].trim() : 'in 7 days';
  const isTamil = /[\u0B80-\u0BFF]/.test(t);
  return {
    client,
    description: description.charAt(0).toUpperCase() + description.slice(1),
    amount_usd: amount,
    currency: 'USD',
    due,
    dueDate: resolveDueDate(due),
    language: isTamil ? 'ta' : 'en',
  };
}

const ParseSchema = z.object({
  client: z.string(),
  description: z.string(),
  amount_usd: z.number(),
  currency: z.literal('USD'),
  due: z.string(),
  clientEmail: z.string().optional(),
  language: z.enum(['en', 'ta']).optional(),
});

function toParsed(object: z.infer<typeof ParseSchema>, text: string): ParsedInvoice {
  return {
    ...object,
    dueDate: resolveDueDate(object.due),
    language: object.language || (/[\u0B80-\u0BFF]/.test(text) ? 'ta' : 'en'),
  };
}

export async function parseInvoiceText(text: string): Promise<{ parsed: ParsedInvoice; via: 'ai' | 'rules'; note?: string }> {
  const injection = scanForInjection(text);
  if (injection.blocked) {
    throw new Error(`Guardrail blocked this input: ${injection.reasons.join('; ')}`);
  }
  const prompt = `Parse this freelancer billing note into a structured invoice. The note may be in Tamil, English, or Tanglish (Tamil written in Latin letters). Amounts are in USD. If no due date is given, use "in 7 days". Reply with the object only.\n\nNote: "${text}"\n\nToday is ${new Date().toISOString().slice(0, 10)}.`;
  if (AI_MODE === 'live' && aiBudgetLeft() > 0) {
    // Provider 1: OpenRouter (free tier)
    if (process.env.OPENROUTER_API_KEY) {
      try {
        spendAiCall();
        const { object } = await generateObject({
          model: openrouter()(AI_MODEL),
          schema: ParseSchema,
          prompt,
          maxOutputTokens: 1200,
        });
        return { parsed: toParsed(object, text), via: 'ai', note: 'Parsed by AI (OpenRouter free model).' };
      } catch {
        // fall through to Groq
      }
    }
    // Provider 2: Groq (free tier) — second try when OpenRouter fails or has no key
    if (groqConfigured()) {
      try {
        spendAiCall();
        const { object } = await generateObject({
          model: groq()(GROQ_MODEL),
          schema: ParseSchema,
          prompt,
          maxOutputTokens: 1200,
        });
        return { parsed: toParsed(object, text), via: 'ai', note: 'Parsed by AI (Groq fallback).' };
      } catch {
        // fall through to rules
      }
    }
    const parsed = rulesParse(text);
    return { parsed, via: 'rules', note: 'AI parse failed on all configured providers; used rules parser.' };
  }
  return { parsed: rulesParse(text), via: 'rules', note: AI_MODE === 'live' ? 'AI daily budget used up; used rules parser.' : 'AI key not configured; used rules parser.' };
}

// ---- reminder drafting ----
const TONE_LABELS: Record<number, string> = {
  1: 'friendly',
  2: 'polite but firm',
  3: 'firm',
  4: 'final notice',
};

export function templateReminder(inv: Invoice, tone: 1 | 2 | 3 | 4, language: 'en' | 'ta' = 'en'): string {
  const name = inv.clientName.split(' ')[0];
  const link = inv.payLink ? ` Pay here: ${inv.payLink}` : '';
  if (language === 'ta') {
    // Tamil template for Tamil-speaking clients
    if (tone === 1) return `வணக்கம் ${name}! Kaasu-விலிருந்து ஒரு சின்ன நினைவூட்டல் — $${inv.amount} இன்வாய்ஸ் (${inv.description}) இன்னும் கட்டவில்லை. எளிதாக கட்டலாம்:${link}`;
    if (tone === 2) return `வணக்கம் ${name}, $${inv.amount} இன்வாய்ஸ் (${inv.description}) தேதி கடந்துவிட்டது. தயவுசெய்து விரைவில் கட்டுங்கள்.${link}`;
    if (tone === 3) return `${name}, $${inv.amount} இன்வாய்ஸ் (${inv.description}) நீண்ட நாட்களாக கட்டப்படவில்லை. உடனடியாக கட்ட வேண்டும்.${link}`;
    return `${name}, இது இறுதி நினைவூட்டல். $${inv.amount} இன்வாய்ஸ் (${inv.description}) உடனே கட்டுங்கள், இல்லையெனில் மேல் நடவடிக்கை எடுக்கப்படும்.${link}`;
  }
  if (tone === 1) return `Hi ${name}! Quick friendly nudge from Kaasu — your $${inv.amount} invoice for "${inv.description}" is still open. You can pay in one tap:${link}`;
  if (tone === 2) return `Hi ${name}, your $${inv.amount} invoice for "${inv.description}" is now past its due date. Could you please pay it this week?${link}`;
  if (tone === 3) return `${name}, your $${inv.amount} invoice for "${inv.description}" is overdue. Please pay it right away to avoid late fees.${link}`;
  return `${name}, this is a final notice. Your $${inv.amount} invoice for "${inv.description}" must be paid immediately, or we will have to escalate.${link}`;
}

export async function draftReminder(
  inv: Invoice,
  tone: 1 | 2 | 3 | 4,
  clientLanguage: 'en' | 'ta',
): Promise<{ text: string; via: 'ai' | 'template'; reasoning: string }> {
  const langNote = clientLanguage === 'ta' ? 'Write the reminder in Tamil (Tamil script).' : 'Write the reminder in English.';
  const reasoning = `Invoice ${inv.number} is ${tone === 1 ? 'just overdue' : `overdue (tone ${tone} on the ladder)`}; client language ${clientLanguage}.`;
  if (AI_MODE === 'live' && aiBudgetLeft() > 0) {
    try {
      spendAiCall();
      const { text } = await generateText({
        model: openrouter()(AI_MODEL),
        prompt: `You are Kaasu, a billing assistant for a Chennai freelancer. Draft a ${TONE_LABELS[tone]} payment reminder for this invoice. Keep it under 60 words. ${langNote} Never threaten legal action. Include the amount and what it was for. Do not invent a due date or a late fee.\n\nClient: ${inv.clientName}\nAmount: $${inv.amount} USD\nWork: ${inv.description}\nDue date: ${inv.dueDate}\nPay link: ${inv.payLink || 'link will be attached'}`,
        maxOutputTokens: 800,
      });
      return { text: text.trim(), via: 'ai', reasoning };
    } catch {
      // fall through to template
    }
  }
  const text = templateReminder(inv, tone, clientLanguage);
  return { text, via: 'template', reasoning: reasoning + ' Template used (AI unavailable or budget used).' };
}
