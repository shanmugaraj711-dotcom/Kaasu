import { NextRequest, NextResponse } from 'next/server';
import { parseInvoiceText } from '@/lib/ai';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { text } = (await req.json()) as { text?: string };
    if (!text || !text.trim()) {
      return NextResponse.json({ error: 'No text provided. Type or speak an invoice note.' }, { status: 400 });
    }
    const { parsed, via, note } = await parseInvoiceText(text.trim());
    if (!parsed.amount_usd || parsed.amount_usd <= 0) {
      return NextResponse.json(
        { error: 'I could not find an amount in that note. Try: "Ravi, website work, $500, due Friday".', parsed, via },
        { status: 422 },
      );
    }
    store.log('agent', 'Invoice parsed', `"${text.trim().slice(0, 80)}" → ${parsed.client}, $${parsed.amount_usd}, due ${parsed.dueDate}.`, via === 'ai' ? (note || 'Parsed by AI.') : `Parsed by rules fallback. ${note || ''}`);
    return NextResponse.json({ parsed, via, note });
  } catch (err) {
    const message = (err as Error).message;
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
