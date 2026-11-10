import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ settings: store.settings });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { autopilot?: boolean };
  if (typeof body.autopilot === 'boolean') {
    store.settings.autopilot = body.autopilot;
    store.log(
      'user',
      `Autopilot ${body.autopilot ? 'ON' : 'OFF'}`,
      body.autopilot
        ? 'Autopilot on: friendly (tone 1) reminders send automatically. Tones 2–4 still wait for approval.'
        : 'Autopilot off: every reminder waits for human approval.',
    );
  }
  return NextResponse.json({ settings: store.settings });
}
