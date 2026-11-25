import React, { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiFetch } from '../lib/api.ts';
import type { InverterItem, TelemetryReading } from '../types/solar.ts';

export default function EquipmentView() {
  const [inverters, setInverters] = useState<InverterItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [selectedInverter, setSelectedInverter] = useState<InverterItem | null>(null);
  const [history, setHistory] = useState<TelemetryReading[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadFleet = async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<InverterItem[]>('/api/v1/inverters');
      setInverters(rows);
      if (!selectedInverter && rows.length > 0) {
        setSelectedInverter(rows[0]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFleet();
  }, []);

  useEffect(() => {
    if (!selectedInverter) return;
    setHistoryLoading(true);
    apiFetch<{ readings: TelemetryReading[] }>(
      `/api/v1/telemetry?inverterId=${selectedInverter.id}&limit=48`
    )
      .then((res) => setHistory([...res.readings].reverse()))
      .finally(() => setHistoryLoading(false));
  }, [selectedInverter?.id]);

  const filtered = inverters.filter((inv) =>
    statusFilter === 'ALL' ? true : inv.operatingStatus === statusFilter
  );

  const statusColor = (status: string) => {
    switch (status) {
      case 'ONLINE':
        return 'text-emerald-700';
      case 'OFFLINE':
      case 'FAULT':
        return 'text-red-700 font-semibold';
      case 'WARNING':
        return 'text-amber-700 font-semibold';
      default:
        return 'text-slate-500';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Inverter & Equipment Telemetry
          </h2>
          <p className="text-xs text-slate-500">
            Inverter-level operational measurements · Missing fields rendered safely as — (never fabricated)
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1">
          {['ALL', 'ONLINE', 'WARNING', 'FAULT', 'OFFLINE', 'UNKNOWN'].map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                statusFilter === st
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* Inverter Fleet Table */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="py-2.5 px-3 font-medium">Inverter</th>
                <th className="py-2.5 px-3 font-medium">Installation</th>
                <th className="py-2.5 px-3 font-medium">Status</th>
                <th className="py-2.5 px-3 font-medium text-right">AC Power</th>
                <th className="py-2.5 px-3 font-medium text-right">DC Input</th>
                <th className="py-2.5 px-3 font-medium text-right">Daily kWh</th>
                <th className="py-2.5 px-3 font-medium text-right">Voltage</th>
                <th className="py-2.5 px-3 font-medium text-right">Temp</th>
                <th className="py-2.5 px-3 font-medium">Fault Code</th>
                <th className="py-2.5 px-3 font-medium">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-slate-500">
                    Loading equipment telemetry...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-slate-500">
                    No inverters match the selected status filter.
                  </td>
                </tr>
              ) : (
                filtered.map((inv) => {
                  const r = inv.latestReading;
                  const isSelected = selectedInverter?.id === inv.id;
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => setSelectedInverter(inv)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-emerald-50/60' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-2.5 px-3">
                        <div className="font-mono font-medium text-slate-900">
                          {inv.inverterCode}
                        </div>
                        <div className="text-slate-500">
                          {inv.manufacturer} {inv.model} ({inv.ratedCapacityKw} kW)
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-700">{inv.installationName}</td>
                      <td className={`py-2.5 px-3 ${statusColor(inv.operatingStatus)}`}>
                        {inv.operatingStatus}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900">
                        {r?.acPowerKw !== null && r?.acPowerKw !== undefined
                          ? `${r.acPowerKw.toFixed(2)} kW`
                          : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                        {r?.dcPowerKw !== null && r?.dcPowerKw !== undefined
                          ? `${r.dcPowerKw.toFixed(2)} kW`
                          : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-800">
                        {r?.dailyEnergyKwh !== null && r?.dailyEnergyKwh !== undefined
                          ? `${r.dailyEnergyKwh.toFixed(1)} kWh`
                          : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                        {r?.voltageV !== null && r?.voltageV !== undefined
                          ? `${r.voltageV.toFixed(1)} V`
                          : '—'}
                      </td>
                      <td
                        className={`py-2.5 px-3 text-right font-mono tabular-nums ${
                          r?.temperatureC && r.temperatureC >= 72
                            ? 'text-red-700 font-semibold'
                            : 'text-slate-700'
                        }`}
                      >
                        {r?.temperatureC !== null && r?.temperatureC !== undefined
                          ? `${r.temperatureC.toFixed(1)} °C`
                          : '—'}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-600">
                        {inv.faultCode || r?.faultCode || '—'}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-500">
                        {r?.qualityStatus || 'NO_DATA'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Selected Inverter Time-Series Inspection */}
      {selectedInverter && (
        <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-900">
                {selectedInverter.name} ({selectedInverter.inverterCode}) — Telemetry History
              </h3>
              <p className="text-xs text-slate-500">
                Lifetime Counter:{' '}
                <span className="font-mono tabular-nums text-slate-800">
                  {selectedInverter.latestReading?.cumulativeEnergyKwh?.toLocaleString() ?? '—'} kWh
                </span>{' '}
                · Current:{' '}
                <span className="font-mono tabular-nums text-slate-800">
                  {selectedInverter.latestReading?.currentA ?? '—'} A
                </span>{' '}
                · Last Seen:{' '}
                <span className="font-mono text-slate-800">
                  {selectedInverter.lastSeenAt
                    ? new Date(selectedInverter.lastSeenAt).toLocaleString()
                    : '—'}
                </span>
              </p>
            </div>
          </div>

          <div className="h-60 w-full">
            {historyLoading ? (
              <div className="h-full bg-slate-50 animate-pulse rounded" />
            ) : history.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-500">
                No historical telemetry intervals available for this inverter.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis
                    dataKey="measuredAt"
                    tick={{ fontSize: 10, fill: '#64748B' }}
                    tickFormatter={(v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#64748B' }} unit=" kW" width={60} />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11, fill: '#64748B' }}
                    unit=" °C"
                    width={54}
                  />
                  <Tooltip contentStyle={{ fontSize: '12px' }} />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="acPowerKw"
                    name="AC Power (kW)"
                    stroke="#15803D"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="temperatureC"
                    name="Inverter Temp (°C)"
                    stroke="#D97706"
                    strokeWidth={1.75}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
