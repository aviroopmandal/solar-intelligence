import React, { useEffect, useState } from 'react';
import { Download, Pause, Play, RotateCcw, Square, Upload, Zap } from 'lucide-react';
import { apiFetch, downloadAuthorizedFile } from '../lib/api.ts';
import type { InverterItem, OrgRole, SolarInstallation } from '../types/solar.ts';

interface IntegrationsViewProps {
  role: OrgRole;
  onDataChanged: () => void;
}

export default function IntegrationsView({ role, onDataChanged }: IntegrationsViewProps) {
  const [tab, setTab] = useState<'simulator' | 'csv' | 'connectors'>('simulator');
  const [installations, setInstallations] = useState<SolarInstallation[]>([]);
  const [inverters, setInverters] = useState<InverterItem[]>([]);

  // Simulator state
  const [simState, setSimState] = useState<{
    session: any;
    events: any[];
    jobs: any[];
  } | null>(null);
  const [weatherMode, setWeatherMode] = useState('Clear');
  const [ambientTempC, setAmbientTempC] = useState('31');
  const [intervalSec, setIntervalSec] = useState('60');
  const [targetInstId, setTargetInstId] = useState('');
  const [targetInvId, setTargetInvId] = useState('');
  const [solarHourTest, setSolarHourTest] = useState<string>('');
  const [simBusy, setSimBusy] = useState(false);

  // CSV Import state
  const [templateType, setTemplateType] = useState<'INVERTER_TELEMETRY' | 'DAILY_ENERGY' | 'WEATHER'>('INVERTER_TELEMETRY');
  const [csvInstallationFilter, setCsvInstallationFilter] = useState('ALL');
  const [csvFilename, setCsvFilename] = useState('');
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [importBatches, setImportBatches] = useState<any[]>([]);
  const [selectedBatchErrors, setSelectedBatchErrors] = useState<any[] | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);

  // Data Sources & Connectors state
  const [sourcesData, setSourcesData] = useState<any>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const canOperate = role === 'Administrator' || role === 'Operations Manager';

  const loadAll = async () => {
    const [insts, invs, sim, batches, ds] = await Promise.all([
      apiFetch<SolarInstallation[]>('/api/v1/installations'),
      apiFetch<InverterItem[]>('/api/v1/inverters'),
      apiFetch<any>('/api/v1/simulator'),
      apiFetch<any[]>('/api/v1/imports'),
      apiFetch<any>('/api/v1/data-sources'),
    ]);
    setInstallations(insts);
    setInverters(invs);
    setSimState(sim);
    setWeatherMode(sim.session.weatherMode);
    setAmbientTempC(String(sim.session.ambientTempC));
    setIntervalSec(String(sim.session.intervalSeconds));
    if (insts.length > 0 && !targetInstId) setTargetInstId(insts[0].id);
    setImportBatches(batches);
    setSourcesData(ds);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const runSimAction = async (path: string, body?: Record<string, unknown>) => {
    setSimBusy(true);
    try {
      await apiFetch(path, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      await loadAll();
      onDataChanged();
    } finally {
      setSimBusy(false);
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvFilename(file.name);
    const text = await file.text();
    setCsvText(text);
    setPreview(null);
    setCsvError(null);
  };

  const handleCsvRun = async (commit: boolean) => {
    if (!csvText.trim()) return;
    setCsvBusy(true);
    setCsvError(null);
    try {
      const res = await apiFetch<any>('/api/v1/imports/csv', {
        method: 'POST',
        body: JSON.stringify({
          templateType,
          filename: csvFilename || 'upload.csv',
          csvText,
          installationIdFilter: csvInstallationFilter,
          commit,
        }),
      });
      setPreview(res);
      if (commit) {
        await loadAll();
        onDataChanged();
      }
    } catch (err: any) {
      setCsvError(err.message);
    } finally {
      setCsvBusy(false);
    }
  };

  const loadBatchErrors = async (batchId: string) => {
    const errs = await apiFetch<any[]>(`/api/v1/imports/${batchId}/errors`);
    setSelectedBatchErrors(errs);
  };

  const handleTestConnector = async (dataSourceId: string) => {
    const res = await apiFetch<{ message: string }>('/api/v1/data-sources/test', {
      method: 'POST',
      body: JSON.stringify({ dataSourceId }),
    });
    setTestResult(res.message);
    await loadAll();
  };

  const siteInvs = inverters.filter((i) => i.installationId === targetInstId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Data Sources, Demonstration Simulator & CSV Ingestion
          </h2>
          <p className="text-xs text-slate-500">
            Control simulated telemetry, import historical CSV archives, and inspect manufacturer connector readiness
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1">
          <button
            type="button"
            onClick={() => setTab('simulator')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === 'simulator' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Demonstration Simulator
          </button>
          <button
            type="button"
            onClick={() => setTab('csv')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === 'csv' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Historical CSV Import
          </button>
          <button
            type="button"
            onClick={() => setTab('connectors')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === 'connectors' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Manufacturer & Gateway Architecture
          </button>
        </div>
      </div>

      {/* TAB 1: DEMONSTRATION SIMULATOR */}
      {tab === 'simulator' && simState && (
        <div className="space-y-6">
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-900">
                  Physics Telemetry Simulator Controls (SIMULATED DATA)
                </h3>
                <p className="text-xs text-slate-500 font-mono">
                  Status: <strong className="text-slate-900">{simState.session.status}</strong> ·
                  Last Tick:{' '}
                  {simState.session.lastTickAt
                    ? new Date(simState.session.lastTickAt).toLocaleString()
                    : '—'}{' '}
                  · Seed: {simState.session.randomSeed}
                </p>
              </div>

              {canOperate && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={simBusy || simState.session.status === 'RUNNING'}
                    onClick={() =>
                      runSimAction('/api/v1/simulator/start', {
                        intervalSeconds: Number(intervalSec),
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>Start</span>
                  </button>
                  <button
                    type="button"
                    disabled={simBusy || simState.session.status === 'PAUSED'}
                    onClick={() => runSimAction('/api/v1/simulator/pause')}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Pause className="h-3.5 w-3.5" />
                    <span>Pause</span>
                  </button>
                  <button
                    type="button"
                    disabled={simBusy || simState.session.status === 'STOPPED'}
                    onClick={() => runSimAction('/api/v1/simulator/stop')}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Square className="h-3.5 w-3.5" />
                    <span>Stop</span>
                  </button>
                  <button
                    type="button"
                    disabled={simBusy}
                    onClick={() =>
                      runSimAction('/api/v1/simulator/generate', {
                        ...(solarHourTest ? { solarHourOverride: Number(solarHourTest) } : {}),
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-700 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    <span>Generate Reading Now</span>
                  </button>
                </div>
              )}
            </div>

            {/* Weather & Interval Config */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs items-end">
              <label className="space-y-1">
                <span className="font-medium text-slate-700">Simulated Weather</span>
                <select
                  value={weatherMode}
                  onChange={(e) => setWeatherMode(e.target.value)}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                >
                  <option>Clear</option>
                  <option>Partly cloudy</option>
                  <option>Cloudy</option>
                  <option>Overcast</option>
                  <option>Heavy rain</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="font-medium text-slate-700">Ambient Temp (°C)</span>
                <input
                  type="number"
                  value={ambientTempC}
                  onChange={(e) => setAmbientTempC(e.target.value)}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
                />
              </label>
              <label className="space-y-1">
                <span className="font-medium text-slate-700">Interval (seconds)</span>
                <input
                  type="number"
                  min="15"
                  max="3600"
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(e.target.value)}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
                />
              </label>
              <button
                type="button"
                disabled={simBusy || !canOperate}
                onClick={() =>
                  runSimAction('/api/v1/simulator/config', {
                    weatherMode,
                    ambientTempC: Number(ambientTempC),
                    intervalSeconds: Number(intervalSec),
                  })
                }
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Apply Weather & Interval
              </button>
            </div>

            <div className="text-xs text-slate-500 flex flex-wrap items-center gap-2 pt-1">
              <span>Optional Solar Hour Override for Daytime Testing:</span>
              <select
                value={solarHourTest}
                onChange={(e) => setSolarHourTest(e.target.value)}
                className="rounded border border-slate-200 px-2 py-1 text-xs"
              >
                <option value="">Use Real Local Solar Clock</option>
                <option value="9">09:00 Local Solar Time</option>
                <option value="12">12:00 Solar Noon Peak</option>
                <option value="15">15:00 Afternoon</option>
                <option value="23">23:00 Nighttime (Zero Irradiance)</option>
              </select>
            </div>
          </div>

          {/* Fault & Abnormal Event Injection Panel */}
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <h3 className="font-display text-sm font-semibold text-slate-900">
              Demonstration Fault & Anomaly Injection
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <label className="space-y-1">
                <span className="font-medium text-slate-700">Target Installation</span>
                <select
                  value={targetInstId}
                  onChange={(e) => {
                    setTargetInstId(e.target.value);
                    setTargetInvId('');
                  }}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                >
                  {installations.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="font-medium text-slate-700">Target Inverter (Optional)</span>
                <select
                  value={targetInvId}
                  onChange={(e) => setTargetInvId(e.target.value)}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                >
                  <option value="">All Inverters at Site</option>
                  {siteInvs.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.inverterCode} ({inv.operatingStatus})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {canOperate && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={simBusy}
                  onClick={() =>
                    runSimAction('/api/v1/simulator/fault', {
                      action: 'UNDERPERFORMANCE',
                      installationId: targetInstId,
                      inverterId: targetInvId || undefined,
                    })
                  }
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
                >
                  Trigger Underperformance (-48%)
                </button>
                <button
                  type="button"
                  disabled={simBusy}
                  onClick={() =>
                    runSimAction('/api/v1/simulator/fault', {
                      action: 'OVERHEATING',
                      installationId: targetInstId,
                      inverterId: targetInvId || siteInvs[0]?.id,
                    })
                  }
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
                >
                  Trigger Inverter Overheating
                </button>
                <button
                  type="button"
                  disabled={simBusy}
                  onClick={() =>
                    runSimAction('/api/v1/simulator/fault', {
                      action: 'OFFLINE',
                      installationId: targetInstId,
                      inverterId: targetInvId || siteInvs[0]?.id,
                    })
                  }
                  className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-900 hover:bg-red-100"
                >
                  Simulate Inverter Offline
                </button>
                <button
                  type="button"
                  disabled={simBusy}
                  onClick={() =>
                    runSimAction('/api/v1/simulator/fault', {
                      action: 'ABNORMAL_VOLTAGE',
                      installationId: targetInstId,
                      inverterId: targetInvId || siteInvs[0]?.id,
                    })
                  }
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
                >
                  Trigger Abnormal Voltage (488V)
                </button>
                <button
                  type="button"
                  disabled={simBusy}
                  onClick={() =>
                    runSimAction('/api/v1/simulator/fault', {
                      action: 'MISSING_TELEMETRY',
                      installationId: targetInstId,
                      inverterId: targetInvId || siteInvs[0]?.id,
                    })
                  }
                  className="rounded-md border border-slate-300 bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-200"
                >
                  Simulate Missing Telemetry
                </button>
                <button
                  type="button"
                  disabled={simBusy}
                  onClick={() => runSimAction('/api/v1/simulator/restore')}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 ml-auto"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Restore Normal Operation</span>
                </button>
              </div>
            )}

            <div className="border-t border-slate-100 pt-3">
              <div className="text-xs font-medium text-slate-700 mb-2">
                Recent Simulator Events
              </div>
              <div className="space-y-1 text-xs text-slate-500 font-mono">
                {simState.events.slice(0, 6).map((ev: any) => (
                  <div key={ev.id}>
                    {new Date(ev.occurredAt).toLocaleString()} · {ev.eventType}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: HISTORICAL CSV IMPORT */}
      {tab === 'csv' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-900">
                  Historical CSV Data Import (UTF-8, max 10 MB / 100,000 rows)
                </h3>
                <p className="text-xs text-slate-500">
                  Strict schema validation, duplicate idempotency checks, and row-level error reporting
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  downloadAuthorizedFile(
                    `/api/v1/imports/templates/${templateType}`,
                    `template_${templateType.toLowerCase()}.csv`
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Download {templateType} Template</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <label className="space-y-1">
                <span className="font-medium text-slate-700">CSV Template Schema</span>
                <select
                  value={templateType}
                  onChange={(e) => {
                    setTemplateType(e.target.value as any);
                    setPreview(null);
                  }}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                >
                  <option value="INVERTER_TELEMETRY">Inverter Telemetry Template</option>
                  <option value="DAILY_ENERGY">Daily Energy Template</option>
                  <option value="WEATHER">Weather & Irradiance Template</option>
                </select>
              </label>

              <label className="space-y-1">
                <span className="font-medium text-slate-700">Target Installation Scope</span>
                <select
                  value={csvInstallationFilter}
                  onChange={(e) => setCsvInstallationFilter(e.target.value)}
                  className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                >
                  <option value="ALL">Portfolio (Use installation_id column)</option>
                  {installations.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.id.slice(0, 8)}...)
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="font-medium text-slate-700">Select UTF-8 CSV File</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileSelected}
                  className="w-full rounded-md border border-slate-200 px-2 py-1 text-xs"
                />
              </label>
            </div>

            <div className="space-y-1 text-xs">
              <span className="font-medium text-slate-700">Or Paste CSV Content Directly:</span>
              <textarea
                rows={5}
                value={csvText}
                onChange={(e) => {
                  setCsvText(e.target.value);
                  setPreview(null);
                }}
                placeholder="Paste CSV rows matching the selected template headers..."
                className="w-full rounded-md border border-slate-200 p-2.5 font-mono text-xs"
              />
            </div>

            {csvError && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                {csvError}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={csvBusy || !csvText.trim() || !canOperate}
                onClick={() => handleCsvRun(false)}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{csvBusy ? 'Validating...' : 'Validate & Preview'}</span>
              </button>
              {preview && preview.headersValid && preview.validCount > 0 && canOperate && (
                <button
                  type="button"
                  disabled={csvBusy}
                  onClick={() => handleCsvRun(true)}
                  className="rounded-md bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  Confirm & Commit {preview.validCount} Valid Rows
                </button>
              )}
            </div>

            {preview && (
              <div className="border-t border-slate-200 pt-4 space-y-3 text-xs">
                <div className="flex flex-wrap gap-4 font-mono">
                  <span>Total Rows: {preview.totalRows}</span>
                  <span className="text-emerald-700 font-semibold">
                    Valid: {preview.validCount}
                  </span>
                  <span className="text-red-700 font-semibold">
                    Invalid / Conflicting: {preview.invalidCount}
                  </span>
                  <span className="text-slate-500">Duplicates Skipped: {preview.duplicateCount}</span>
                </div>
                {preview.headerError && (
                  <div className="text-red-700 font-medium">{preview.headerError}</div>
                )}
                {preview.errors.length > 0 && (
                  <div className="rounded border border-red-200 bg-red-50 p-3 space-y-1 max-h-40 overflow-y-auto font-mono">
                    {preview.errors.slice(0, 20).map((err: any, i: number) => (
                      <div key={i} className="text-red-800">
                        Row {err.rowNumber}: {err.errorMessage}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Import History */}
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
            <h3 className="font-display text-sm font-semibold text-slate-900">
              CSV Import History
            </h3>
            {importBatches.length === 0 ? (
              <p className="text-xs text-slate-500">No CSV imports recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 text-slate-500">
                    <tr>
                      <th className="py-2 pr-3 font-medium">File</th>
                      <th className="py-2 pr-3 font-medium">Template</th>
                      <th className="py-2 pr-3 font-medium text-right">Accepted</th>
                      <th className="py-2 pr-3 font-medium text-right">Rejected</th>
                      <th className="py-2 pr-3 font-medium text-right">Duplicates</th>
                      <th className="py-2 font-medium text-right">Errors</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {importBatches.map((b) => (
                      <tr key={b.id}>
                        <td className="py-2 pr-3 font-mono">{b.filename}</td>
                        <td className="py-2 pr-3">{b.templateType}</td>
                        <td className="py-2 pr-3 text-right font-mono text-emerald-700">
                          {b.acceptedRows}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-red-700">
                          {b.rejectedRows}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-slate-500">
                          {b.duplicateRows}
                        </td>
                        <td className="py-2 text-right">
                          {b.rejectedRows > 0 && (
                            <button
                              type="button"
                              onClick={() => loadBatchErrors(b.id)}
                              className="text-emerald-700 hover:underline"
                            >
                              View Error Report
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {selectedBatchErrors && (
              <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs font-mono space-y-1">
                <div className="font-semibold text-slate-800">Rejected Row Details:</div>
                {selectedBatchErrors.map((e) => (
                  <div key={e.id} className="text-red-700">
                    Row {e.rowNumber}: {e.errorMessage}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: MANUFACTURER APIs & MODBUS GATEWAYS */}
      {tab === 'connectors' && sourcesData && (
        <div className="space-y-6">
          {testResult && (
            <div className="rounded-md border border-slate-200 bg-slate-100 px-4 py-3 text-xs text-slate-800">
              Connection Verification Result: <strong>{testResult}</strong>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="font-display text-sm font-semibold text-slate-900">
                Configured Data Sources & Manufacturer API Connectors
              </h3>
              <p className="text-xs text-slate-500">
                Manufacturer integrations remain marked <strong>Not Yet Connected</strong> until verified credentials and provider endpoints are configured on the backend.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">Data Source</th>
                    <th className="py-2.5 px-4 font-medium">Type</th>
                    <th className="py-2.5 px-4 font-medium">Connection Status</th>
                    <th className="py-2.5 px-4 font-medium">Polling Interval</th>
                    <th className="py-2.5 px-4 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sourcesData.sources.map((s: any) => (
                    <tr key={s.id}>
                      <td className="py-3 px-4 font-medium text-slate-900">{s.name}</td>
                      <td className="py-3 px-4 font-mono text-slate-600">{s.sourceType}</td>
                      <td className="py-3 px-4">
                        <span
                          className={`font-mono font-medium ${
                            s.connectionStatus === 'OPERATIONAL'
                              ? 'text-emerald-700'
                              : 'text-amber-700'
                          }`}
                        >
                          {s.connectionStatus === 'NOT_YET_CONNECTED'
                            ? 'Not yet connected'
                            : s.connectionStatus}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-500">
                        {s.pollingIntervalSec > 0 ? `${s.pollingIntervalSec}s` : 'Manual'}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {role === 'Administrator' && (
                          <button
                            type="button"
                            onClick={() => handleTestConnector(s.id)}
                            className="rounded border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Test Connection
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Local Modbus Gateway Architectural Registry */}
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
            <h3 className="font-display text-sm font-semibold text-slate-900">
              Local Gateway & SunSpec Modbus Architecture (Prepared, Not Connected)
            </h3>
            <p className="text-xs text-slate-500">
              Gateways initiate outbound encrypted HTTPS communication to the backend ingestion pipeline; direct physical Modbus TCP/RTU polling is disabled in the initial release.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Gateway</th>
                    <th className="py-2 pr-4 font-medium">Protocol</th>
                    <th className="py-2 pr-4 font-medium">Register Profile</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sourcesData.gateways.map((g: any) => (
                    <tr key={g.id}>
                      <td className="py-2 pr-4 font-medium text-slate-900">{g.name}</td>
                      <td className="py-2 pr-4 font-mono text-slate-600">{g.protocol}</td>
                      <td className="py-2 pr-4 text-slate-600">{g.registerProfile}</td>
                      <td className="py-2 font-mono text-amber-700">Not yet connected</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
