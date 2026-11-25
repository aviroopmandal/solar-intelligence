import React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { RefreshCw, Zap } from 'lucide-react';
import type { DashboardPayload, NavSection } from '../types/solar.ts';

interface DashboardViewProps {
  data: DashboardPayload | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onGenerateInterval: () => Promise<void>;
  onNavigate: (nav: NavSection) => void;
  onSelectInstallation: (id: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  Operational: '#16A34A',
  Underperforming: '#D97706',
  Offline: '#DC2626',
  'Requires Investigation': '#EA580C',
};

export default function DashboardView({
  data,
  loading,
  error,
  onRefresh,
  onGenerateInterval,
  onNavigate,
  onSelectInstallation,
}: DashboardViewProps) {
  const [simRunning, setSimRunning] = React.useState(false);

  const handleStepSim = async () => {
    setSimRunning(true);
    try {
      await onGenerateInterval();
    } finally {
      setSimRunning(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg border border-slate-200 bg-white animate-pulse" />
          ))}
        </div>
        <div className="h-80 rounded-lg border border-slate-200 bg-white animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800">
        <p className="font-medium">Unable to load dashboard data</p>
        <p className="mt-1">{error}</p>
        <button
          type="button"
          onClick={onRefresh}
          className="mt-3 rounded-md bg-red-700 px-4 py-2 text-xs font-medium text-white hover:bg-red-800"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { metrics, dailySeries, installationPerformance, statusBreakdown, recentActivity } = data;

  const kpiCards = [
    { label: 'Registered Installations', value: String(metrics.totalInstallations), sub: 'Active portfolio sites' },
    { label: 'Total Installed Capacity', value: `${metrics.totalCapacityKwp.toLocaleString()} kWp`, sub: 'DC nameplate capacity' },
    { label: 'Energy Generated Today', value: `${metrics.energyTodayKwh.toLocaleString()} kWh`, sub: 'Simulated / stored meter sum' },
    { label: 'Energy Generated This Month', value: `${metrics.energyMonthKwh.toLocaleString()} kWh`, sub: 'Month-to-date rollup' },
    {
      label: 'Avg Portfolio Performance',
      value: metrics.avgPortfolioPerformancePct !== null ? `${metrics.avgPortfolioPerformancePct}%` : 'N/A',
      sub: 'Actual vs weather baseline',
    },
    { label: 'Operating Installations', value: `${metrics.operatingCount} / ${metrics.totalInstallations}`, sub: 'Nominal state' },
    {
      label: 'Abnormal Performance Sites',
      value: String(metrics.abnormalCount),
      sub: 'Underperforming or faulted',
      tone: metrics.abnormalCount > 0 ? 'text-amber-700' : 'text-slate-900',
    },
    {
      label: 'Active Maintenance Alerts',
      value: String(metrics.activeAlertsCount),
      sub: 'Open or investigating',
      tone: metrics.activeAlertsCount > 0 ? 'text-red-700' : 'text-slate-900',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Portfolio Operational Overview
          </h2>
          <p className="text-xs text-slate-500">
            All metrics computed from stored PostgreSQL telemetry and energy aggregations · Simulated records tagged
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleStepSim}
            disabled={simRunning}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-700 bg-emerald-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            <Zap className="h-3.5 w-3.5" />
            <span>{simRunning ? 'Generating...' : 'Generate Simulated Reading'}</span>
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* 8 Portfolio KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpiCards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-slate-200 bg-white p-4"
          >
            <div className="text-xs font-medium text-slate-500">{card.label}</div>
            <div
              className={`mt-1.5 font-mono text-2xl font-semibold tabular-nums ${
                card.tone || 'text-slate-900'
              }`}
            >
              {card.value}
            </div>
            <div className="mt-1 text-xs text-slate-400">{card.sub}</div>
          </div>
        ))}
      </div>

      {/* Primary Energy Generation Trend Chart */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900">
              Portfolio Daily Energy Generation vs Weather-Adjusted Baseline (30 Days)
            </h3>
            <p className="text-xs text-slate-500">
              Daily kWh totals aggregated across active installations (Source: SIMULATED / IMPORTED)
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('analytics')}
            className="text-xs font-medium text-emerald-700 hover:text-emerald-800"
          >
            Open Full Analytics
          </button>
        </div>
        <div className="h-72 w-full">
          {dailySeries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              No daily generation records found yet. Generate simulated readings or import CSV history.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dailySeries} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#64748B' }}
                  tickFormatter={(v) => String(v).slice(5)}
                />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} unit=" kWh" width={72} />
                <Tooltip
                  contentStyle={{
                    fontSize: '12px',
                    borderRadius: '6px',
                    borderColor: '#CBD5E1',
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Area
                  type="monotone"
                  dataKey="expectedKwh"
                  name="Expected Baseline (kWh)"
                  stroke="#94A3B8"
                  fill="#F1F5F9"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="actualKwh"
                  name="Actual / Simulated (kWh)"
                  stroke="#15803D"
                  fill="#DCFCE7"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Installation Performance Comparison & Portfolio Status */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-900">
                Installation Performance Comparison (30d Actual vs Expected)
              </h3>
              <p className="text-xs text-slate-500">
                Amber bars indicate sites performing below 80% of weather-adjusted expectations
              </p>
            </div>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={installationPerformance}
                margin={{ top: 10, right: 12, left: 0, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} unit=" kWh" width={76} />
                <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '6px' }} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar dataKey="expectedKwh" name="Expected (kWh)" fill="#CBD5E1" radius={[3, 3, 0, 0]} />
                <Bar dataKey="actualKwh" name="Actual (kWh)" radius={[3, 3, 0, 0]}>
                  {installationPerformance.map((entry) => (
                    <Cell
                      key={entry.id}
                      fill={entry.flaggedUnderperforming ? '#D97706' : '#16A34A'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-display text-sm font-semibold text-slate-900 mb-1">
            Portfolio Status Breakdown
          </h3>
          <p className="text-xs text-slate-500 mb-4">
            Current operational state across registered sites
          </p>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={statusBreakdown}
                margin={{ top: 0, right: 16, left: 10, bottom: 0 }}
              >
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                <YAxis
                  type="category"
                  dataKey="status"
                  width={130}
                  tick={{ fontSize: 11, fill: '#334155' }}
                />
                <Tooltip contentStyle={{ fontSize: '12px' }} />
                <Bar dataKey="count" name="Installations" radius={[0, 4, 4, 0]}>
                  {statusBreakdown.map((item) => (
                    <Cell
                      key={item.status}
                      fill={STATUS_COLORS[item.status] || '#64748B'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-4 border-t border-slate-100 pt-3 space-y-2">
            {installationPerformance.map((site) => (
              <button
                key={site.id}
                type="button"
                onClick={() => onSelectInstallation(site.id)}
                className="w-full flex items-center justify-between text-left text-xs py-1 px-2 rounded hover:bg-slate-50 transition-colors"
              >
                <span className="font-medium text-slate-800 truncate">{site.name}</span>
                <span
                  className={`font-mono tabular-nums shrink-0 ${
                    site.operationalStatus === 'Operational'
                      ? 'text-emerald-700'
                      : 'text-amber-700 font-medium'
                  }`}
                >
                  {site.performancePct !== null ? `${site.performancePct}%` : '—'} · {site.operationalStatus}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-sm font-semibold text-slate-900">
            Recent Operational Activity
          </h3>
          <button
            type="button"
            onClick={() => onNavigate('alerts')}
            className="text-xs font-medium text-emerald-700 hover:text-emerald-800"
          >
            View All Alerts
          </button>
        </div>
        {recentActivity.length === 0 ? (
          <p className="text-sm text-slate-500">No recent events recorded.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {recentActivity.map((item) => (
              <div
                key={item.id}
                className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0">
                  <span className="font-medium text-slate-900">{item.title}</span>
                  <span className="mx-2 text-slate-300" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-slate-600">{item.detail}</span>
                </div>
                <span className="font-mono text-slate-400 tabular-nums shrink-0">
                  {item.type} · {new Date(item.timestamp).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
