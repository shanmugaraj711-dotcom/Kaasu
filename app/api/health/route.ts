import { NextResponse } from 'next/server';
import { AI_MODE, aiBudgetLeft } from '@/lib/ai';
import { PAYPAL_MODE, paypalConfigured } from '@/lib/paypal';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    app: 'kaasu',
    time: new Date().toISOString(),
    paypal: { mode: PAYPAL_MODE, configured: paypalConfigured(), environment: process.env.PAYPAL_ENVIRONMENT || 'SANDBOX' },
    ai: { mode: AI_MODE, model: 'nvidia/nemotron-3-ultra-550b-a55b:free', budgetLeft: aiBudgetLeft() },
    currency: 'USD',
  });
}
