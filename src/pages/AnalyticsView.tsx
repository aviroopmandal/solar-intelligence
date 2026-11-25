import React, { useEffect, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  Bar,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiFetch } from '../lib/api.ts';
import type { InverterItem, SolarInstallation } from '../types/solar.ts';

interface AnalyticsPayload {
  summary: {
    totalActualKwh: number;
    totalExpectedKwh: number;
    installedCapacityKwp: number;
    capacityFactorPct: number | null;
    missingIntervalsCount: number;
  };
  series: Array<{
    label: string;
    actualKwh: number;
    expectedKwh: number;
    forecastKwh: number | null;
  }>;
}

export default function AnalyticsView() {
  const [installations, setInstallations] = useState<SolarInstallation[]>([]);
  const [inverters, setInverters] = useState<InverterItem[]>([]);
  const [installationId, setInstallationId] = useState<string>('ALL');
  const [inverterId, setInverterId] = useState<string>('ALL');
  const [granularity, setGranularity] = useState<string>('daily');
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch<SolarInstallation[]>('/api/v1/installations'),
      apiFetch<InverterItem[]>('/api/v1/inverters'),
    ]).then(([insts, invs]) => {
      setInstallations(insts);
      setInverters(invs);
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      installationId,
      inverterId,
      granularity,
      days: String(days),
    });
    apiFetch<AnalyticsPayload>(`/api/v1/analytics?${params.toString()}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [installationId, inverterId, granularity, days]);

  const filteredInverters =
    installationId === 'ALL'
      ? inverters
      : inverters.filter((i) => i.installationId === installationId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Energy Generation Analytics
          </h2>
          <p className="text-xs text-slate-500">
            Compare actual, weather-adjusted expected, and forecast energy generation · Missing intervals tracked separately from zero generation
          </p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-2">
          <span className="font-medium text-slate-600">Installation:</span>
          <select
            value={installationId}
            onChange={(e) => {
              setInstallationId(e.target.value);
              setInverterId('ALL');
            }}
            className="rounded-md border border-slate-200 px-2.5 py-1.5"
          >
            <option value="ALL">All Portfolio Installations</option>
            {installations.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.installedCapacityKwp} kWp)
              </option>
            ))}
          </select>
        </label>

        {granularity === 'hourly' && (
          <label className="flex items-center gap-2">
            <span className="font-medium text-slate-600">Inverter:</span>
            <select
              value={inverterId}
              onChange={(e) => setInverterId(e.target.value)}
              className="rounded-md border border-slate-200 px-2.5 py-1.5"
            >
              <option value="ALL">All Inverters</option>
              {filteredInverters.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.inverterCode}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex items-center gap-2">
          <span className="font-medium text-slate-600">Range:</span>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-md border border-slate-200 px-2.5 py-1.5"
          >
            <option value={7}>Last 7 Days</option>
            <option value={30}>Last 30 Days</option>
            <option value={90}>Last 90 Days</option>
            <option value={365}>Last 365 Days</option>
          </select>
        </label>

        <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1 ml-auto">
          {['hourly', 'daily', 'weekly', 'monthly', 'annual'].map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => {
                setGranularity(g);
                if (g !== 'hourly') setInverterId('ALL');
              }}
              className={`rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                granularity === g
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Strip */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Total Energy Generated</div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-900">
              {data.summary.totalActualKwh.toLocaleString()} kWh
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Installed Capacity</div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-900">
              {data.summary.installedCapacityKwp.toLocaleString()} kWp
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Capacity Factor</div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-emerald-700">
              {data.summary.capacityFactorPct !== null
                ? `${data.summary.capacityFactorPct}%`
                : 'N/A'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">Incomplete / Missing Periods</div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-amber-700">
              {data.summary.missingIntervalsCount}
            </div>
          </div>
        </div>
      )}

      {/* Main Comparison Chart */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="font-display text-sm font-semibold text-slate-900 mb-3">
          Actual vs Expected vs Forecast Generation ({granularity.toUpperCase()})
        </h3>
        <div className="h-80 w-full">
          {loading ? (
            <div className="h-full bg-slate-50 animate-pulse rounded" />
          ) : !data || data.series.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              No generation records found for the selected filters.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.series} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748B' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} unit=" kWh" width={76} />
                <Tooltip contentStyle={{ fontSize: '12px' }} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar
                  dataKey="actualKwh"
                  name="Actual / Simulated (kWh)"
                  fill="#15803D"
                  radius={[3, 3, 0, 0]}
                />
                <Line
                  type="monotone"
                  dataKey="expectedKwh"
                  name="Weather-Adjusted Expected (kWh)"
                  stroke="#64748B"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="forecastKwh"
                  name="Forecast (kWh)"
                  stroke="#0284C7"
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
