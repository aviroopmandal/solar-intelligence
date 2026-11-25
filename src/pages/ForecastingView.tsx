import React, { useEffect, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type { ForecastRow, OrgRole, SolarInstallation } from '../types/solar.ts';

interface ForecastingViewProps {
  role: OrgRole;
}

export default function ForecastingView({ role }: ForecastingViewProps) {
  const [installations, setInstallations] = useState<SolarInstallation[]>([]);
  const [installationId, setInstallationId] = useState<string>('');
  const [horizon, setHorizon] = useState<'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY'>('DAILY');
  const [forecasts, setForecasts] = useState<ForecastRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const canGenerate = role === 'Administrator' || role === 'Operations Manager';

  useEffect(() => {
    apiFetch<SolarInstallation[]>('/api/v1/installations').then((rows) => {
      setInstallations(rows);
      if (rows.length > 0) setInstallationId(rows[0].id);
    });
  }, []);

  const loadForecasts = async (instId: string) => {
    if (!instId) return;
    setLoading(true);
    try {
      const rows = await apiFetch<ForecastRow[]>(`/api/v1/forecasts?installationId=${instId}`);
      setForecasts(rows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (installationId) loadForecasts(installationId);
  }, [installationId]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await apiFetch('/api/v1/forecasts/generate', {
        method: 'POST',
        body: JSON.stringify({ installationId }),
      });
      await loadForecasts(installationId);
    } finally {
      setGenerating(false);
    }
  };

  const horizonRows = forecasts.filter((f) => f.horizonType === horizon);
  const meta = horizonRows[0] || forecasts[0];

  const chartData = horizonRows.map((r) => ({
    label:
      horizon === 'HOURLY'
        ? new Date(r.targetTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : new Date(r.targetTimestamp).toISOString().slice(0, 10),
    expectedKwh: r.expectedEnergyKwh,
    lowKwh: r.confidenceLowKwh,
    highKwh: r.confidenceHighKwh,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Solar Generation Forecasting
          </h2>
          <p className="text-xs text-slate-500">
            Staged physical baseline + historical residual correction with chronological validation · Estimates only (not guaranteed production)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={installationId}
            onChange={(e) => setInstallationId(e.target.value)}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs"
          >
            {installations.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.installedCapacityKwp} kWp)
              </option>
            ))}
          </select>

          {canGenerate && (
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || !installationId}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{generating ? 'Computing...' : 'Recompute Forecasts'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Preliminary Notice or Model Evaluation Metrics */}
      {meta && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="rounded-lg border border-slate-200 bg-white p-3.5">
            <div className="text-xs text-slate-500">Model Version</div>
            <div className="mt-1 font-mono text-xs font-semibold text-slate-900 truncate">
              {meta.modelVersion}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3.5">
            <div className="text-xs text-slate-500">Training Period</div>
            <div className="mt-1 font-mono text-xs text-slate-800">
              {meta.trainingPeriodStart} → {meta.trainingPeriodEnd}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3.5">
            <div className="text-xs text-slate-500">Validation MAE</div>
            <div className="mt-1 font-mono text-base font-semibold tabular-nums text-slate-900">
              {meta.maeKwh !== null ? `${meta.maeKwh} kWh` : 'Unavailable'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3.5">
            <div className="text-xs text-slate-500">Validation RMSE</div>
            <div className="mt-1 font-mono text-base font-semibold tabular-nums text-slate-900">
              {meta.rmseKwh !== null ? `${meta.rmseKwh} kWh` : 'Unavailable'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3.5">
            <div className="text-xs text-slate-500">Validation MAPE</div>
            <div className="mt-1 font-mono text-base font-semibold tabular-nums text-slate-900">
              {meta.mapePct !== null ? `${meta.mapePct}%` : 'Unavailable'}
            </div>
          </div>
        </div>
      )}

      {meta?.isPreliminary && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <strong>Preliminary Forecast:</strong> Fewer than 7 days of completed historical generation are stored for this installation. Confidence intervals are marked unavailable until sufficient chronological validation data accumulates.
        </div>
      )}

      {/* Horizon Tabs */}
      <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1 w-fit">
        {(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'] as const).map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setHorizon(h)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              horizon === h
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {h === 'HOURLY'
              ? 'Hourly (24h)'
              : h === 'DAILY'
                ? 'Daily (7d)'
                : h === 'WEEKLY'
                  ? 'Weekly (4w)'
                  : 'Monthly (3m)'}
          </button>
        ))}
      </div>

      {/* Forecast Chart */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="font-display text-sm font-semibold text-slate-900 mb-1">
          Expected {horizon.toLowerCase()} Generation & Uncertainty Bounds
        </h3>
        <p className="text-xs text-slate-500 mb-4">
          {meta?.notes || 'Weather-adjusted estimate derived from solar geometry and historical performance residuals.'}
        </p>

        <div className="h-72 w-full">
          {loading ? (
            <div className="h-full bg-slate-50 animate-pulse rounded" />
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              No forecast records available.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748B' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} unit=" kWh" width={76} />
                <Tooltip contentStyle={{ fontSize: '12px' }} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                {meta?.confidenceAvailable && (
                  <Area
                    type="monotone"
                    dataKey="highKwh"
                    name="Upper 95% Bound (kWh)"
                    stroke="#BAE6FD"
                    fill="#E0F2FE"
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="expectedKwh"
                  name="Expected Estimate (kWh)"
                  stroke="#0284C7"
                  strokeWidth={2.2}
                />
                {meta?.confidenceAvailable && (
                  <Line
                    type="monotone"
                    dataKey="lowKwh"
                    name="Lower 95% Bound (kWh)"
                    stroke="#7DD3FC"
                    strokeDasharray="4 4"
                    dot={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Tabular Breakdown */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <tr>
              <th className="py-2.5 px-4 font-medium">Target Period</th>
              <th className="py-2.5 px-4 font-medium text-right">Expected Generation</th>
              <th className="py-2.5 px-4 font-medium text-right">Confidence Range (95%)</th>
              <th className="py-2.5 px-4 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {horizonRows.map((row) => (
              <tr key={row.id}>
                <td className="py-2.5 px-4 font-mono text-slate-800">
                  {horizon === 'HOURLY'
                    ? new Date(row.targetTimestamp).toLocaleString()
                    : new Date(row.targetTimestamp).toISOString().slice(0, 10)}
                </td>
                <td className="py-2.5 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                  {row.expectedEnergyKwh.toLocaleString()} kWh
                </td>
                <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600">
                  {row.confidenceAvailable &&
                  row.confidenceLowKwh !== null &&
                  row.confidenceHighKwh !== null
                    ? `${row.confidenceLowKwh.toLocaleString()} – ${row.confidenceHighKwh.toLocaleString()} kWh`
                    : 'Unavailable'}
                </td>
                <td className="py-2.5 px-4 text-slate-600">
                  {row.isPreliminary ? 'Preliminary Estimate' : 'Calibrated Estimate'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
