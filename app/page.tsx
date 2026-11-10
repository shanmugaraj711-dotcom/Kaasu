'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type { ColDef } from 'ag-grid-community';
import type { Invoice, ParsedInvoice, ReminderDraft, AuditEntry } from '@/lib/types';

ModuleRegistry.registerModules([AllCommunityModule]);

interface Stats { outstanding: number; overdue: number; paid: number; count: number; atRisk: number }

const TONE_NAMES: Record<number, string> = { 1: 'Friendly', 2: 'Polite-firm', 3: 'Firm', 4: 'Final notice' };

export default function Home() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [paypalMode, setPaypalMode] = useState('mock');
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [reminders, setReminders] = useState<ReminderDraft[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [autopilot, setAutopilot] = useState(false);
  const [note, setNote] = useState('');
  const [lang, setLang] = useState<'en' | 'ta'>('en');
  const [listening, setListening] = useState(false);
  const [parsed, setParsed] = useState<ParsedInvoice | null>(null);
  const [parseVia, setParseVia] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const recogRef = useRef<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [invRes, remRes, audRes] = await Promise.all([
        fetch('/api/invoices'),
        fetch('/api/reminders'),
        fetch('/api/audit'),
      ]);
      const invData = await invRes.json();
      setInvoices(invData.invoices || []);
      setStats(invData.stats || null);
      setPaypalMode(invData.paypalMode || 'mock');
      const remData = await remRes.json();
      setReminders(remData.reminders || []);
      setAutopilot(!!remData.autopilot);
      const audData = await audRes.json();
      setAudit(audData.audit || []);
    } catch {
      // offline / first load — leave state as-is
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  async function parseNote() {
    if (!note.trim()) return;
    setBusy('parse');
    setMsg('');
    setParsed(null);
    try {
      const res = await fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: note }) });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error || 'Could not parse that note.'); return; }
      setParsed(data.parsed);
      setParseVia(data.via);
      if (data.note) setMsg(data.note);
    } catch (e) {
      setMsg(`Parse failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  async function createInvoice() {
    if (!parsed) return;
    setBusy('create');
    try {
      const res = await fetch('/api/invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parsed, confirm: true }) });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error || 'Could not create the invoice.'); return; }
      setMsg(`Invoice ${data.invoice.number} sent to ${data.invoice.clientName} — pay link ready.`);
      setParsed(null);
      setNote('');
      setSelected(data.invoice);
      load();
    } catch (e) {
      setMsg(`Create failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  async function invoiceAction(id: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(`${action}-${id}`);
    try {
      const res = await fetch(`/api/invoices/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error || 'Action failed.'); return; }
      setSelected(data.invoice);
      load();
    } catch (e) {
      setMsg(`Action failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  async function runCollections() {
    setBusy('collections');
    try {
      const res = await fetch('/api/reminders', { method: 'POST' });
      const data = await res.json();
      setMsg(`${data.created?.length || 0} reminder draft(s) created. ${data.skipped?.length ? `Skipped: ${data.skipped.join('; ')}` : ''}`);
      load();
    } catch (e) {
      setMsg(`Collections run failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  async function reminderAction(id: string, action: string) {
    setBusy(`${action}-${id}`);
    try {
      const res = await fetch(`/api/reminders/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error || 'Reminder action failed.'); return; }
      load();
    } catch (e) {
      setMsg(`Reminder action failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  async function toggleAutopilot() {
    const next = !autopilot;
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autopilot: next }) });
    setAutopilot(next);
    load();
  }

  function startListening() {
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) { setMsg('Voice input is not supported in this browser. Type the note instead.'); return; }
    const rec = new SR() as unknown as {
      lang: string; interimResults: boolean; continuous: boolean;
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onend: (() => void) | null; onerror: (() => void) | null; start: () => void; stop: () => void;
    };
    rec.lang = lang === 'ta' ? 'ta-IN' : 'en-IN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0]?.transcript || '').join(' ');
      setNote(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recogRef.current = rec;
    setListening(true);
    rec.start();
  }

  const colDefs: ColDef<Invoice>[] = [
    { field: 'number', headerName: 'Invoice', width: 120 },
    { field: 'clientName', headerName: 'Client', width: 150 },
    { field: 'description', headerName: 'Work', flex: 1, minWidth: 180 },
    { field: 'amount', headerName: 'Amount', width: 110, valueFormatter: (p) => money(p.value ?? 0) },
    { field: 'dueDate', headerName: 'Due', width: 115 },
    { field: 'status', headerName: 'Status', width: 110 },
    { field: 'riskScore', headerName: 'Late risk', width: 100, cellStyle: (p) => ({ color: (p.value ?? 0) >= 60 ? '#b91c1c' : (p.value ?? 0) >= 30 ? '#b45309' : '#166534', fontWeight: 700 }) },
    { field: 'reminderCount', headerName: 'Reminders', width: 105, valueFormatter: (p) => `${p.value ?? 0}/3` },
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 text-zinc-900">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Kaasu <span className="text-emerald-700">காசு</span></h1>
          <p className="text-sm text-zinc-600">AI billing agent for freelancers — speak it, send it, get paid. USD only.</p>
        </div>
        <div className="flex gap-2 text-xs font-semibold">
          <span className={`rounded-full px-3 py-1 ${paypalMode === 'live' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
            PayPal: {paypalMode === 'live' ? 'Sandbox — live' : 'Demo mode'}
          </span>
          <span className="rounded-full bg-sky-100 px-3 py-1 text-sky-800">AI: OpenRouter free</span>
        </div>
      </header>

      {msg && <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm">{msg}</div>}

      {/* Intake */}
      <section className="mt-6 rounded-2xl border bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold">New invoice — just say it</h2>
        <p className="text-sm text-zinc-600">Example: &ldquo;Ravi, website work, $500, due Friday&rdquo; — Tamil or English.</p>
        <div className="mt-3 flex gap-2">
          <button onClick={() => setLang('en')} className={`rounded-full px-3 py-1 text-sm font-semibold ${lang === 'en' ? 'bg-zinc-900 text-white' : 'bg-zinc-100'}`}>English</button>
          <button onClick={() => setLang('ta')} className={`rounded-full px-3 py-1 text-sm font-semibold ${lang === 'ta' ? 'bg-zinc-900 text-white' : 'bg-zinc-100'}`}>தமிழ்</button>
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Ravi, website work, $500, due Friday"
          className="mt-3 w-full rounded-xl border px-3 py-2 text-base outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={startListening} disabled={listening} className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {listening ? 'Listening…' : '🎙️ Speak'}
          </button>
          <button onClick={parseNote} disabled={busy === 'parse' || !note.trim()} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {busy === 'parse' ? 'Parsing…' : 'Parse with AI'}
          </button>
        </div>

        {parsed && (
          <div className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50 p-4">
            <p className="text-sm font-bold">Confirm this invoice <span className="font-normal text-zinc-500">(parsed by {parseVia === 'ai' ? 'AI' : 'rules fallback'})</span></p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div><span className="text-zinc-500">Client</span><br /><b>{parsed.client}</b></div>
              <div><span className="text-zinc-500">Work</span><br /><b>{parsed.description}</b></div>
              <div><span className="text-zinc-500">Amount</span><br /><b>{money(parsed.amount_usd)}</b></div>
              <div><span className="text-zinc-500">Due</span><br /><b>{parsed.dueDate}</b></div>
            </div>
            <button onClick={createInvoice} disabled={busy === 'create'} className="mt-3 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              {busy === 'create' ? 'Creating…' : 'Create & send PayPal invoice'}
            </button>
          </div>
        )}
      </section>

      {/* Stats */}
      {stats && (
        <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Outstanding', money(stats.outstanding), 'text-zinc-900'],
            ['Overdue', money(stats.overdue), 'text-red-700'],
            ['Paid', money(stats.paid), 'text-emerald-700'],
            ['At risk (score 60+)', String(stats.atRisk), 'text-amber-700'],
          ].map(([label, value, color]) => (
            <div key={label} className="rounded-2xl border bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
              <p className={`mt-1 text-2xl font-extrabold ${color}`}>{value}</p>
            </div>
          ))}
        </section>
      )}

      {/* Dashboard grid */}
      <section className="mt-6 rounded-2xl border bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold">Receivables</h2>
        <div className="ag-theme-quartz mt-3" style={{ height: 320, width: '100%' }}>
          <AgGridReact
            rowData={invoices}
            columnDefs={colDefs}
            onRowClicked={(e) => setSelected(e.data || null)}
            rowSelection="single"
            pagination
            paginationPageSize={8}
          />
        </div>
        <p className="mt-2 text-xs text-zinc-500">Click a row to see the invoice, pay link and QR code. Demo data is seeded; new invoices you create appear here too.</p>
      </section>

      {/* Selected invoice */}
      {selected && (
        <section className="mt-6 rounded-2xl border bg-white p-5 shadow-sm">
          <div className="flex flex-wrap justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold">{selected.number} — {selected.clientName}</h3>
              <p className="text-sm text-zinc-600">{selected.description} · {money(selected.amount)} · due {selected.dueDate} · <b>{selected.status}</b> · reminders {selected.reminderCount}/3</p>
              {selected.payLink && (
                <p className="mt-1 text-sm">Pay link: <a className="text-emerald-700 underline" href={selected.payLink} target="_blank" rel="noreferrer">{selected.payLink}</a></p>
              )}
              {selected.paidAt && <p className="mt-1 text-sm text-emerald-700 font-semibold">Paid on {new Date(selected.paidAt).toLocaleString()}</p>}
            </div>
            {selected.qrDataUrl && (
              <div className="text-center">
                <img src={selected.qrDataUrl} alt="PayPal invoice QR code" width={120} height={120} />
                <p className="text-xs text-zinc-500">Scan to pay</p>
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => invoiceAction(selected.id, 'refresh')} disabled={busy.startsWith('refresh')} className="rounded-xl bg-zinc-100 px-3 py-2 text-sm font-bold">Check payment status</button>
            <button onClick={() => invoiceAction(selected.id, 'draft-reminder')} disabled={busy.startsWith('draft-reminder')} className="rounded-xl bg-sky-100 px-3 py-2 text-sm font-bold">Draft a reminder</button>
            <button onClick={() => invoiceAction(selected.id, 'record-payment', { confirmedByHuman: true })} disabled={selected.status === 'PAID' || busy.startsWith('record-payment')} className="rounded-xl bg-emerald-100 px-3 py-2 text-sm font-bold">Record offline payment</button>
            <button onClick={() => { if (window.confirm(`Cancel ${selected.number}? This needs your confirmation.`)) invoiceAction(selected.id, 'cancel', { confirmedByHuman: true }); }} disabled={selected.status === 'PAID' || selected.status === 'CANCELLED' || busy.startsWith('cancel')} className="rounded-xl bg-red-100 px-3 py-2 text-sm font-bold">Cancel invoice</button>
          </div>
        </section>
      )}

      {/* Collections */}
      <section className="mt-6 rounded-2xl border bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Collections agent</h2>
            <p className="text-sm text-zinc-600">Drafts reminders on a tone ladder — friendly → polite-firm → firm → final notice. Cap: 3 per invoice, 24h apart.</p>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={autopilot} onChange={toggleAutopilot} className="h-4 w-4" />
            Autopilot (friendly reminders auto-send)
          </label>
        </div>
        <button onClick={runCollections} disabled={busy === 'collections'} className="mt-3 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
          {busy === 'collections' ? 'Running…' : 'Run collections agent'}
        </button>
        <div className="mt-4 space-y-3">
          {reminders.filter((r) => r.status === 'pending').length === 0 && (
            <p className="text-sm text-zinc-500">No drafts waiting for approval.</p>
          )}
          {reminders.filter((r) => r.status === 'pending').map((r) => {
            const inv = invoices.find((i) => i.id === r.invoiceId);
            return (
              <div key={r.id} className="rounded-xl border p-3">
                <p className="text-sm"><b>{inv ? `${inv.number} — ${inv.clientName}` : r.invoiceId}</b> · tone {r.tone} ({TONE_NAMES[r.tone]}) · {r.language === 'ta' ? 'Tamil' : 'English'}</p>
                <p className="mt-1 text-sm text-zinc-700">{r.text}</p>
                {r.reasoning && <p className="mt-1 text-xs text-zinc-500">Agent reasoning: {r.reasoning}</p>}
                <div className="mt-2 flex gap-2">
                  <button onClick={() => reminderAction(r.id, 'send')} disabled={busy === `send-${r.id}`} className="rounded-lg bg-emerald-600 px-3 py-1 text-sm font-bold text-white">Approve & send</button>
                  <button onClick={() => reminderAction(r.id, 'reject')} disabled={busy === `reject-${r.id}`} className="rounded-lg bg-zinc-100 px-3 py-1 text-sm font-bold">Reject</button>
                </div>
              </div>
            );
          })}
          {reminders.filter((r) => r.status === 'sent').length > 0 && (
            <p className="text-xs text-zinc-500">{reminders.filter((r) => r.status === 'sent').length} reminder(s) already sent.</p>
          )}
        </div>
      </section>

      {/* Audit log */}
      <section className="mt-6 rounded-2xl border bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold">Audit log — every agent action, with its reasoning</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {audit.slice(0, 12).map((a) => (
            <li key={a.id} className="border-b pb-2">
              <span className="font-semibold">{a.action}</span>{' '}
              <span className="text-zinc-500">· {a.actor} · {new Date(a.ts).toLocaleString()}</span>
              <br />{a.detail}
              {a.reasoning && <><br /><span className="text-xs text-zinc-500">Why: {a.reasoning}</span></>}
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-6 text-center text-xs text-zinc-500">
        Kaasu — PayPal AI Hackathon entry. Built with Next.js, PayPal Invoicing API (sandbox), OpenRouter free tier, AG Grid.
        Dashboard shows seeded demo clients; invoices you create are real sandbox invoices when PayPal credentials are connected.
      </footer>
    </main>
  );
}
