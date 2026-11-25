import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { apiFetch, downloadAuthorizedFile } from '../lib/api.ts';
import type { SolarInstallation } from '../types/solar.ts';

interface ReportPreview {
  organisationName: string;
  reportType: string;
  scopeName: string;
  reportingPeriod: { start: string; end: string; days: number };
  generatedAt: string;
  summary: {
    installationsCount: number;
    totalCapacityKwp: number;
    totalEnergyKwh: number;
    totalExpectedKwh: number;
    performanceIndexPct: number | null;
    invertersTotal: number;
    invertersOnline: number;
    anomaliesCount: number;
    openTasksCount: number;
    completedRecordsCount: number;
  };
  dailyEnergy: Array<{
    id: string;
    localDate: string;
    installationId: string;
    energyKwh: number;
    expectedEnergyKwh: number | null;
    measurementType: string;
  }>;
  inverters: Array<{
    id: string;
    inverterCode: string;
    name: string;
    ratedCapacityKw: number;
    operatingStatus: string;
    faultCode: string | null;
  }>;
  anomalies: Array<{
    id: string;
    severity: string;
    category: string;
    observedValue: string;
    expectedBaseline: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    priority: string;
    status: string;
    dueDate: string;
  }>;
}

export default function ReportsView() {
  const [reportType, setReportType] = useState<'ENERGY' | 'PERFORMANCE' | 'EQUIPMENT' | 'MAINTENANCE'>('ENERGY');
  const [installationId, setInstallationId] = useState<string>('ALL');
  const [days, setDays] = useState<number>(30);
  const [installations, setInstallations] = useState<SolarInstallation[]>([]);
  const [report, setReport] = useState<ReportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    apiFetch<SolarInstallation[]>('/api/v1/installations').then(setInstallations);
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      type: reportType,
      installationId,
      days: String(days),
    });
    apiFetch<ReportPreview>(`/api/v1/reports/data?${params.toString()}`)
      .then(setReport)
      .finally(() => setLoading(false));
  }, [reportType, installationId, days]);

  const handleExportPdf = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({
        type: reportType,
        installationId,
        days: String(days),
      });
      await downloadAuthorizedFile(
        `/api/v1/reports/pdf?${params.toString()}`,
        `solar_${reportType.toLowerCase()}_report_${days}d.pdf`
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Operational & Historical Reports
          </h2>
          <p className="text-xs text-slate-500">
            Reproducible reports compiled directly from stored PostgreSQL records with PDF export
          </p>
        </div>

        <button
          type="button"
          onClick={handleExportPdf}
          disabled={exporting || loading}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          <span>{exporting ? 'Generating PDF...' : 'Export PDF Report'}</span>
        </button>
      </div>

      {/* Report Configuration */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 flex flex-wrap items-center gap-4 text-xs">
        <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1">
          {(['ENERGY', 'PERFORMANCE', 'EQUIPMENT', 'MAINTENANCE'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setReportType(t)}
              className={`rounded px-3 py-1 font-medium ${
                reportType === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              {t === 'ENERGY'
                ? 'Energy Generation'
                : t === 'PERFORMANCE'
                  ? 'Performance'
                  : t === 'EQUIPMENT'
                    ? 'Equipment'
                    : 'Maintenance'}
            </button>
          ))}
        </div>

        <select
          value={installationId}
          onChange={(e) => setInstallationId(e.target.value)}
          className="rounded-md border border-slate-200 px-2.5 py-1.5"
        >
          <option value="ALL">Entire Organisation Portfolio</option>
          {installations.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>

        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-md border border-slate-200 px-2.5 py-1.5"
        >
          <option value={7}>Last 7 Days</option>
          <option value={30}>Last 30 Days</option>
          <option value={90}>Last 90 Days</option>
        </select>
      </div>

      {loading || !report ? (
        <div className="h-64 rounded-lg border border-slate-200 bg-white animate-pulse" />
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white p-6 space-y-6">
          <div className="border-b border-slate-200 pb-4 flex flex-wrap justify-between gap-2">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900">
                {report.organisationName} — {report.reportType} REPORT
              </h3>
              <p className="text-xs text-slate-500">
                Scope: {report.scopeName} · Period: {report.reportingPeriod.start} to{' '}
                {report.reportingPeriod.end}
              </p>
            </div>
            <div className="text-xs font-mono text-slate-400">
              Generated {new Date(report.generatedAt).toLocaleString()}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div className="border border-slate-100 rounded p-3 bg-slate-50">
              <div className="text-slate-500">Total Energy Produced</div>
              <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
                {report.summary.totalEnergyKwh.toLocaleString()} kWh
              </div>
            </div>
            <div className="border border-slate-100 rounded p-3 bg-slate-50">
              <div className="text-slate-500">Expected Baseline</div>
              <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
                {report.summary.totalExpectedKwh.toLocaleString()} kWh
              </div>
            </div>
            <div className="border border-slate-100 rounded p-3 bg-slate-50">
              <div className="text-slate-500">Inverters Online</div>
              <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
                {report.summary.invertersOnline} / {report.summary.invertersTotal}
              </div>
            </div>
            <div className="border border-slate-100 rounded p-3 bg-slate-50">
              <div className="text-slate-500">Anomalies / Open Tasks</div>
              <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
                {report.summary.anomaliesCount} / {report.summary.openTasksCount}
              </div>
            </div>
          </div>

          {reportType === 'ENERGY' && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Local Date</th>
                    <th className="py-2 pr-4 font-medium text-right">Actual (kWh)</th>
                    <th className="py-2 pr-4 font-medium text-right">Expected (kWh)</th>
                    <th className="py-2 font-medium">Measurement Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.dailyEnergy.slice(0, 20).map((d) => (
                    <tr key={d.id}>
                      <td className="py-2 pr-4 font-mono">{d.localDate}</td>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums">
                        {d.energyKwh.toFixed(1)}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums text-slate-500">
                        {d.expectedEnergyKwh !== null ? d.expectedEnergyKwh.toFixed(1) : '—'}
                      </td>
                      <td className="py-2 font-mono text-slate-600">{d.measurementType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {reportType === 'PERFORMANCE' && (
            <div className="space-y-2 text-xs">
              <h4 className="font-semibold text-slate-900">Recorded Anomalies</h4>
              {report.anomalies.map((a) => (
                <div key={a.id} className="border-b border-slate-100 py-2">
                  <span className="font-semibold">{a.severity}</span> · {a.category} · Observed:{' '}
                  <span className="font-mono">{a.observedValue}</span> vs{' '}
                  <span className="font-mono">{a.expectedBaseline}</span>
                </div>
              ))}
            </div>
          )}

          {reportType === 'EQUIPMENT' && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Code</th>
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium text-right">Capacity</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">Fault Code</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.inverters.map((inv) => (
                    <tr key={inv.id}>
                      <td className="py-2 pr-4 font-mono">{inv.inverterCode}</td>
                      <td className="py-2 pr-4">{inv.name}</td>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums">
                        {inv.ratedCapacityKw} kW
                      </td>
                      <td className="py-2 pr-4 font-medium">{inv.operatingStatus}</td>
                      <td className="py-2 font-mono text-slate-500">{inv.faultCode || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {reportType === 'MAINTENANCE' && (
            <div className="space-y-2 text-xs">
              <h4 className="font-semibold text-slate-900">Maintenance Tasks</h4>
              {report.tasks.map((t) => (
                <div key={t.id} className="border-b border-slate-100 py-2 flex justify-between">
                  <span>
                    [{t.priority}] {t.title}
                  </span>
                  <span className="font-mono text-slate-500">
                    {t.status} · Due {t.dueDate}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
