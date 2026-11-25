import React, { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowLeft, Plus } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type {
  AlertItem,
  AnomalyItem,
  ForecastRow,
  InverterItem,
  MaintenanceRecordItem,
  OrgRole,
  SolarInstallation,
} from '../types/solar.ts';

interface InstallationsViewProps {
  role: OrgRole;
  selectedId: string | null;
  onSelectId: (id: string | null) => void;
  onChanged: () => void;
}

interface InstallationProfilePayload {
  installation: SolarInstallation;
  inverters: InverterItem[];
  dailyEnergy: Array<{ localDate: string; energyKwh: number; expectedEnergyKwh: number | null }>;
  forecasts: ForecastRow[];
  alerts: AlertItem[];
  anomalies: AnomalyItem[];
  maintenanceRecords: MaintenanceRecordItem[];
}

export default function InstallationsView({
  role,
  selectedId,
  onSelectId,
  onChanged,
}: InstallationsViewProps) {
  const [installations, setInstallations] = useState<SolarInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Profile state
  const [profile, setProfile] = useState<InstallationProfilePayload | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [editingStatus, setEditingStatus] = useState<string>('');
  const [editingPr, setEditingPr] = useState<string>('');

  // Create form fields
  const [form, setForm] = useState({
    name: '',
    installationCode: '',
    siteAddress: '',
    cityState: '',
    latitude: '22.57',
    longitude: '88.36',
    timezone: 'Asia/Kolkata',
    installationType: 'Commercial Rooftop',
    installedCapacityKwp: '100',
    commissioningDate: new Date().toISOString().slice(0, 10),
    panelManufacturer: 'Waaree Energies',
    panelModel: '545W Mono PERC',
    inverterManufacturer: 'Sungrow',
    inverterModel: 'SG50CX-P2',
    inverterCount: '2',
    panelOrientation: 'South (180°)',
    panelTiltDeg: '20',
    shadingFactor: '0.98',
    shadingNotes: 'Minimal shading',
    performanceRatio: '0.82',
    operationalGroup: 'Default Portfolio',
    operationalStatus: 'Operational',
  });
  const [saving, setSaving] = useState(false);

  const canManage = role === 'Administrator' || role === 'Operations Manager';

  const loadList = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await apiFetch<SolarInstallation[]>('/api/v1/installations');
      setInstallations(rows);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadList();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setProfile(null);
      return;
    }
    let active = true;
    setProfileLoading(true);
    apiFetch<InstallationProfilePayload>(`/api/v1/installations/${selectedId}`)
      .then((data) => {
        if (!active) return;
        setProfile(data);
        setEditingStatus(data.installation.operationalStatus);
        setEditingPr(String(data.installation.performanceRatio));
      })
      .catch((e: any) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setProfileLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/v1/installations', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setShowCreateForm(false);
      await loadList();
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateInstallation = async (patch: Record<string, unknown>) => {
    if (!profile) return;
    setSaving(true);
    try {
      await apiFetch(`/api/v1/installations/${profile.installation.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const updated = await apiFetch<InstallationProfilePayload>(
        `/api/v1/installations/${profile.installation.id}`
      );
      setProfile(updated);
      await loadList();
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (selectedId) {
    if (profileLoading || !profile) {
      return (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => onSelectId(null)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back to Installations</span>
          </button>
          <div className="h-64 rounded-lg border border-slate-200 bg-white animate-pulse" />
        </div>
      );
    }

    const inst = profile.installation;

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onSelectId(null)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>All Installations</span>
            </button>
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-900">
                {inst.name}
              </h2>
              <p className="text-xs text-slate-500 font-mono">
                {inst.installationCode} · {inst.cityState} · {inst.installedCapacityKwp} kWp · {inst.timezone}
              </p>
            </div>
          </div>

          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={editingStatus}
                onChange={(e) => setEditingStatus(e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
              >
                <option value="Operational">Operational</option>
                <option value="Underperforming">Underperforming</option>
                <option value="Offline">Offline</option>
                <option value="Requires Investigation">Requires Investigation</option>
                <option value="Deactivated">Deactivated</option>
              </select>
              <input
                type="number"
                step="0.01"
                min="0.4"
                max="1.0"
                value={editingPr}
                onChange={(e) => setEditingPr(e.target.value)}
                className="w-20 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-mono"
                title="Performance Ratio"
              />
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  handleUpdateInstallation({
                    operationalStatus: editingStatus,
                    performanceRatio: Number(editingPr),
                    isActive: editingStatus !== 'Deactivated',
                  })
                }
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                Save Changes
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  handleUpdateInstallation({
                    isActive: !inst.isActive,
                    operationalStatus: inst.isActive ? 'Deactivated' : 'Operational',
                  })
                }
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {inst.isActive ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          )}
        </div>

        {/* Site Specifications Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-1.5 text-xs">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-2">
              Site Details
            </h3>
            <div className="flex justify-between">
              <span className="text-slate-500">Type</span>
              <span className="font-medium text-slate-800">{inst.installationType}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Address</span>
              <span className="font-medium text-slate-800 text-right max-w-[200px]">
                {inst.siteAddress}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Coordinates</span>
              <span className="font-mono text-slate-800">
                {inst.latitude ?? '—'}, {inst.longitude ?? '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Commissioned</span>
              <span className="font-mono text-slate-800">{inst.commissioningDate}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Group</span>
              <span className="font-medium text-slate-800">{inst.operationalGroup}</span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-1.5 text-xs">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-2">
              Array & Equipment Specs
            </h3>
            <div className="flex justify-between">
              <span className="text-slate-500">Panels</span>
              <span className="font-medium text-slate-800">
                {inst.panelManufacturer} {inst.panelModel}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Inverters</span>
              <span className="font-medium text-slate-800">
                {inst.inverterCount}× {inst.inverterManufacturer} {inst.inverterModel}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Orientation / Tilt</span>
              <span className="font-mono text-slate-800">
                {inst.panelOrientation} · {inst.panelTiltDeg}°
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Nominal PR / Shading</span>
              <span className="font-mono text-slate-800">
                {inst.performanceRatio} / {inst.shadingFactor}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Shading Conditions</span>
              <span className="text-slate-700 text-right max-w-[190px]">{inst.shadingNotes}</span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-1.5 text-xs">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-2">
              Operational Summary
            </h3>
            <div className="flex justify-between">
              <span className="text-slate-500">Current Status</span>
              <span className="font-semibold text-slate-900">{inst.operationalStatus}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Inverters Online</span>
              <span className="font-mono text-slate-900">
                {profile.inverters.filter((i) => i.operatingStatus === 'ONLINE').length} /{' '}
                {profile.inverters.length}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Open Alerts</span>
              <span className="font-mono text-slate-900">
                {
                  profile.alerts.filter(
                    (a) => a.status !== 'Resolved' && a.status !== 'Dismissed'
                  ).length
                }
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Recorded Anomalies</span>
              <span className="font-mono text-slate-900">{profile.anomalies.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Maintenance Records</span>
              <span className="font-mono text-slate-900">{profile.maintenanceRecords.length}</span>
            </div>
          </div>
        </div>

        {/* Historical Energy Chart */}
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="font-display text-sm font-semibold text-slate-900 mb-3">
            Historical Daily Generation vs Expected Baseline
          </h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={profile.dailyEnergy.slice(-30)}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis
                  dataKey="localDate"
                  tick={{ fontSize: 11, fill: '#64748B' }}
                  tickFormatter={(v) => String(v).slice(5)}
                />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} unit=" kWh" width={72} />
                <Tooltip contentStyle={{ fontSize: '12px' }} />
                <Area
                  type="monotone"
                  dataKey="expectedEnergyKwh"
                  name="Expected (kWh)"
                  stroke="#94A3B8"
                  fill="#F1F5F9"
                />
                <Area
                  type="monotone"
                  dataKey="energyKwh"
                  name="Actual / Simulated (kWh)"
                  stroke="#15803D"
                  fill="#DCFCE7"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Equipment & Maintenance History */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-3">
              Registered Inverters ({profile.inverters.length})
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Code</th>
                    <th className="py-2 pr-3 font-medium">Capacity</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">Fault</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {profile.inverters.map((inv) => (
                    <tr key={inv.id}>
                      <td className="py-2 pr-3 font-mono text-slate-900">{inv.inverterCode}</td>
                      <td className="py-2 pr-3 font-mono tabular-nums">{inv.ratedCapacityKw} kW</td>
                      <td className="py-2 pr-3 font-medium">{inv.operatingStatus}</td>
                      <td className="py-2 font-mono text-slate-500">{inv.faultCode || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-3">
              Maintenance History & Active Alerts
            </h3>
            {profile.maintenanceRecords.length === 0 && profile.alerts.length === 0 ? (
              <p className="text-xs text-slate-500">No alerts or maintenance history on file.</p>
            ) : (
              <div className="space-y-3 text-xs">
                {profile.alerts.slice(0, 4).map((a) => (
                  <div key={a.id} className="border-b border-slate-100 pb-2">
                    <div className="font-medium text-slate-900">
                      [{a.severity}] {a.title} · {a.status}
                    </div>
                    <div className="text-slate-600 mt-0.5">{a.description}</div>
                  </div>
                ))}
                {profile.maintenanceRecords.slice(0, 4).map((m) => (
                  <div key={m.id} className="border-b border-slate-100 pb-2">
                    <div className="font-medium text-slate-800">
                      {new Date(m.performedAt).toISOString().slice(0, 10)} · {m.recordType} ({m.performedByName})
                    </div>
                    <div className="text-slate-600 mt-0.5">{m.workPerformed}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const filtered = installations.filter(
    (i) =>
      i.name.toLowerCase().includes(search.toLowerCase()) ||
      i.installationCode.toLowerCase().includes(search.toLowerCase()) ||
      i.cityState.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Solar Installations Portfolio
          </h2>
          <p className="text-xs text-slate-500">
            Register, configure, and inspect individual solar installation profiles
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Search site, code, city..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs focus:border-emerald-600 focus:outline-none"
          />
          {canManage && (
            <button
              type="button"
              onClick={() => setShowCreateForm((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-800 transition-colors whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{showCreateForm ? 'Close Form' : 'Register Installation'}</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
          {error}
        </div>
      )}

      {showCreateForm && canManage && (
        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-slate-200 bg-white p-5 space-y-4"
        >
          <h3 className="font-display text-sm font-semibold text-slate-900">
            Register New Solar Installation
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Installation Name *</span>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                placeholder="Asansol Logistics Solar"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Installation ID / Code *</span>
              <input
                required
                value={form.installationCode}
                onChange={(e) => setForm({ ...form, installationCode: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
                placeholder="LOG-ASN-006"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Site Address *</span>
              <input
                required
                value={form.siteAddress}
                onChange={(e) => setForm({ ...form, siteAddress: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                placeholder="NH-19 Freight Corridor"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">City and State *</span>
              <input
                required
                value={form.cityState}
                onChange={(e) => setForm({ ...form, cityState: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                placeholder="Asansol, West Bengal"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Latitude</span>
              <input
                type="number"
                step="0.0001"
                value={form.latitude}
                onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Longitude</span>
              <input
                type="number"
                step="0.0001"
                value={form.longitude}
                onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Installation Type</span>
              <select
                value={form.installationType}
                onChange={(e) => setForm({ ...form, installationType: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              >
                <option>Industrial Rooftop</option>
                <option>Commercial Rooftop</option>
                <option>Warehouse Rooftop</option>
                <option>Ground-Mount</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Installed Capacity (kWp) *</span>
              <input
                required
                type="number"
                step="0.1"
                min="1"
                value={form.installedCapacityKwp}
                onChange={(e) => setForm({ ...form, installedCapacityKwp: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Commissioning Date</span>
              <input
                type="date"
                value={form.commissioningDate}
                onChange={(e) => setForm({ ...form, commissioningDate: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Panel Manufacturer</span>
              <input
                value={form.panelManufacturer}
                onChange={(e) => setForm({ ...form, panelManufacturer: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Panel Model</span>
              <input
                value={form.panelModel}
                onChange={(e) => setForm({ ...form, panelModel: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Inverter Manufacturer</span>
              <input
                value={form.inverterManufacturer}
                onChange={(e) => setForm({ ...form, inverterManufacturer: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Inverter Model</span>
              <input
                value={form.inverterModel}
                onChange={(e) => setForm({ ...form, inverterModel: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Number of Inverters</span>
              <input
                type="number"
                min="1"
                max="50"
                value={form.inverterCount}
                onChange={(e) => setForm({ ...form, inverterCount: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Panel Orientation</span>
              <input
                value={form.panelOrientation}
                onChange={(e) => setForm({ ...form, panelOrientation: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Panel Tilt (°)</span>
              <input
                type="number"
                value={form.panelTiltDeg}
                onChange={(e) => setForm({ ...form, panelTiltDeg: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Shading Conditions</span>
              <input
                value={form.shadingNotes}
                onChange={(e) => setForm({ ...form, shadingNotes: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Timezone (IANA)</span>
              <input
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Operational Group</span>
              <input
                value={form.operationalGroup}
                onChange={(e) => setForm({ ...form, operationalGroup: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Initial Status</span>
              <select
                value={form.operationalStatus}
                onChange={(e) => setForm({ ...form, operationalStatus: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              >
                <option value="Operational">Operational</option>
                <option value="Underperforming">Underperforming</option>
                <option value="Offline">Offline</option>
                <option value="Requires Investigation">Requires Investigation</option>
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="rounded-md border border-slate-200 px-4 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-emerald-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {saving ? 'Registering...' : 'Save Installation'}
            </button>
          </div>
        </form>
      )}

      {/* Installations Table */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="py-3 px-4 font-medium">Installation</th>
                <th className="py-3 px-4 font-medium">Location</th>
                <th className="py-3 px-4 font-medium">Type</th>
                <th className="py-3 px-4 font-medium text-right">Capacity</th>
                <th className="py-3 px-4 font-medium text-right">Inverters</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    Loading installations...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    No installations match your filter.
                  </td>
                </tr>
              ) : (
                filtered.map((inst) => (
                  <tr
                    key={inst.id}
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => onSelectId(inst.id)}
                  >
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{inst.name}</div>
                      <div className="font-mono text-slate-400">
                        {inst.installationCode} · {inst.operationalGroup}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-slate-600">{inst.cityState}</td>
                    <td className="py-3 px-4 text-slate-600">{inst.installationType}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                      {inst.installedCapacityKwp} kWp
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                      {inst.inverterCount}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`font-medium ${
                          inst.operationalStatus === 'Operational'
                            ? 'text-emerald-700'
                            : inst.operationalStatus === 'Deactivated'
                              ? 'text-slate-400'
                              : 'text-amber-700'
                        }`}
                      >
                        {inst.operationalStatus}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectId(inst.id);
                        }}
                        className="font-medium text-emerald-700 hover:text-emerald-800"
                      >
                        Open Profile
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
