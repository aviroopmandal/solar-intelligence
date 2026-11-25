import React, { useState } from 'react';
import { Send } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';

interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode?: string;
  citedFacts?: Array<{ label: string; value: string }>;
}

const EXAMPLE_QUESTIONS = [
  'How much electricity did our portfolio generate this month?',
  'Which installation is currently underperforming?',
  'Which inverter has the highest average temperature?',
  'What anomalies were detected this week?',
  'Which maintenance tasks remain unresolved?',
  'Compare generation across our installations and advise which site we should investigate first.',
];

export default function AssistantView() {
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Ask any operational question about your registered solar installations, generation totals, inverter temperatures, anomalies, or maintenance tasks. Every response is grounded strictly in stored PostgreSQL records and computed backend metrics.',
      mode: 'Grounded Solar Intelligence Assistant',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const askQuestion = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || loading) return;

    const userMsg: AssistantMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await apiFetch<{
        answer: string;
        mode: string;
        citedFacts: Array<{ label: string; value: string }>;
      }>('/api/v1/assistant/query', {
        method: 'POST',
        body: JSON.stringify({ question: trimmed }),
      });

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: res.answer,
          mode: res.mode,
          citedFacts: res.citedFacts,
        },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: 'assistant',
          content: `Unable to query solar intelligence backend: ${err.message}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Main Conversation */}
      <div className="lg:col-span-2 rounded-lg border border-slate-200 bg-white flex flex-col h-[640px]">
        <div className="border-b border-slate-200 px-5 py-3.5">
          <h2 className="font-display text-sm font-semibold text-slate-900">
            Grounded Solar Operations Assistant
          </h2>
          <p className="text-xs text-slate-500">
            Retrieves live database totals and telemetry before answering · Automatic deterministic fallback if LLM is unavailable
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`rounded-lg p-4 text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'bg-slate-900 text-white ml-10'
                  : 'bg-slate-50 border border-slate-200 text-slate-800 mr-6'
              }`}
            >
              <div className="whitespace-pre-wrap">{m.content}</div>
              {m.citedFacts && m.citedFacts.length > 0 && (
                <div className="mt-3 pt-2.5 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px] text-slate-600">
                  {m.citedFacts.map((f) => (
                    <div key={f.label}>
                      <span className="font-medium text-slate-700">{f.label}:</span>{' '}
                      <span className="font-mono">{f.value}</span>
                    </div>
                  ))}
                </div>
              )}
              {m.mode && (
                <div className="mt-2 text-[11px] text-slate-400">Source Engine: {m.mode}</div>
              )}
            </div>
          ))}
          {loading && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 text-xs text-slate-500 mr-6">
              Querying stored portfolio records and analyzing...
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            askQuestion(input);
          }}
          className="border-t border-slate-200 p-3 flex items-center gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about portfolio generation, underperformance, anomalies, or maintenance..."
            className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-xs focus:border-emerald-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            <span>Ask</span>
          </button>
        </form>
      </div>

      {/* Suggested Queries */}
      <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-3 h-fit">
        <h3 className="font-display text-sm font-semibold text-slate-900">
          Operational Questions
        </h3>
        <p className="text-xs text-slate-500">
          Select a prompt to query live PostgreSQL aggregations for your active organisation:
        </p>
        <div className="space-y-2">
          {EXAMPLE_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              disabled={loading}
              onClick={() => askQuestion(q)}
              className="w-full text-left rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 hover:bg-emerald-50 hover:border-emerald-200 transition-colors"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
