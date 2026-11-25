import React, { useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type { AnomalyItem, MaintenanceAssessment, OrgRole } from '../types/solar.ts';

interface PerformanceViewProps {
  role: OrgRole;
}

export default function PerformanceView({ role }: PerformanceViewProps) {
  const [anomalies, setAnomalies] = useState<AnomalyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [assessingId, setAssessingId] = useState<string | null>(null);
  const [selectedAssessment, setSelectedAssessment] = useState<{
    anomaly: AnomalyItem;
    assessment: MaintenanceAssessment;
  } | null>(null);

  const canScan = role === 'Administrator' || role === 'Operations Manager';

  const loadAnomalies = async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<AnomalyItem[]>('/api/v1/anomalies');
      setAnomalies(rows);
      if (rows.length > 0 && rows[0].aiAssessmentJson && !selectedAssessment) {
        setSelectedAssessment({ anomaly: rows[0], assessment: rows[0].aiAssessmentJson });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAnomalies();
  }, []);

  const handleScan = async () => {
    setScanning(true);
    try {
      await apiFetch('/api/v1/anomalies/scan', { method: 'POST' });
      await loadAnomalies();
    } finally {
      setScanning(false);
    }
  };

  const handleAssess = async (anomaly: AnomalyItem) => {
    setAssessingId(anomaly.id);
    try {
      const assessment = await apiFetch<MaintenanceAssessment>(
        `/api/v1/anomalies/${anomaly.id}/assess`,
        { method: 'POST' }
      );
      setSelectedAssessment({ anomaly, assessment });
      await loadAnomalies();
    } finally {
      setAssessingId(null);
    }
  };

  const severityClass = (sev: string) => {
    if (sev === 'Critical') return 'text-red-700 font-semibold';
    if (sev === 'High') return 'text-amber-700 font-semibold';
    if (sev === 'Medium') return 'text-amber-600 font-medium';
    return 'text-slate-600';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Performance Anomaly Detection & AI Maintenance Assessments
          </h2>
          <p className="text-xs text-slate-500">
            Explicitly distinguishes statistical anomalies requiring investigation from confirmed equipment faults
          </p>
        </div>

        {canScan && (
          <button
            type="button"
            onClick={handleScan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{scanning ? 'Scanning Telemetry...' : 'Run Anomaly Detection Scan'}</span>
          </button>
        )}
      </div>

      {/* Classification Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Total Detected Anomalies</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900">
            {anomalies.length}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Confirmed Equipment Faults</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-red-700">
            {anomalies.filter((a) => a.classification === 'CONFIRMED_EQUIPMENT_FAULT').length}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">Backed by fault code or offline state</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Statistical Anomalies</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-amber-700">
            {anomalies.filter((a) => a.classification === 'STATISTICAL_ANOMALY').length}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">Requires qualified site investigation</div>
        </div>
      </div>

      {/* Anomaly Table */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="py-2.5 px-3 font-medium">Installation / Equipment</th>
                <th className="py-2.5 px-3 font-medium">Category & Classification</th>
                <th className="py-2.5 px-3 font-medium">Observed vs Baseline</th>
                <th className="py-2.5 px-3 font-medium">Severity</th>
                <th className="py-2.5 px-3 font-medium">Detected</th>
                <th className="py-2.5 px-3 font-medium text-right">Assessment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    Loading anomalies...
                  </td>
                </tr>
              ) : anomalies.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    No anomalies detected across current telemetry.
                  </td>
                </tr>
              ) : (
                anomalies.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-900">{a.installationName}</div>
                      <div className="font-mono text-slate-500">
                        {a.inverterCode || 'Site-Level Aggregate'}
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-800">
                        {a.category.replace(/_/g, ' ')}
                      </div>
                      <div className="text-slate-500">
                        {a.classification === 'CONFIRMED_EQUIPMENT_FAULT'
                          ? 'Confirmed Equipment Fault'
                          : 'Statistical Anomaly (Investigation Required)'}
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-mono text-slate-900">{a.observedValue}</div>
                      <div className="text-slate-500">Baseline: {a.expectedBaseline}</div>
                    </td>
                    <td className={`py-3 px-3 ${severityClass(a.severity)}`}>{a.severity}</td>
                    <td className="py-3 px-3 font-mono text-slate-500 tabular-nums">
                      {new Date(a.detectedAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-3 text-right">
                      <button
                        type="button"
                        disabled={assessingId === a.id}
                        onClick={() => handleAssess(a)}
                        className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 whitespace-nowrap"
                      >
                        {assessingId === a.id
                          ? 'Generating...'
                          : a.aiAssessmentJson
                            ? 'View / Refresh Assessment'
                            : 'Generate Assessment'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Structured 6-Section Maintenance Assessment Panel */}
      {selectedAssessment && (
        <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900">
                Maintenance Assessment — {selectedAssessment.anomaly.installationName}{' '}
                {selectedAssessment.anomaly.inverterCode
                  ? `(${selectedAssessment.anomaly.inverterCode})`
                  : ''}
              </h3>
              <p className="text-xs text-slate-500">
                Generated by: <strong className="text-slate-700">{selectedAssessment.assessment.generatedBy}</strong> · Priority:{' '}
                <strong className="text-slate-900">{selectedAssessment.assessment.priority}</strong> · Confidence:{' '}
                <strong className="text-slate-900">{selectedAssessment.assessment.confidence}</strong>
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
            <div className="space-y-2">
              <h4 className="font-semibold text-slate-900">1. Problem Summary</h4>
              <p className="text-slate-700 leading-relaxed">
                {selectedAssessment.assessment.problemSummary}
              </p>

              <h4 className="font-semibold text-slate-900 pt-2">2. Supporting Evidence</h4>
              <ul className="list-disc pl-4 space-y-1 text-slate-700">
                {selectedAssessment.assessment.supportingEvidence.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <h4 className="font-semibold text-slate-900">3. Possible Explanations</h4>
              <ul className="list-disc pl-4 space-y-1 text-slate-700">
                {selectedAssessment.assessment.possibleExplanations.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>

              <h4 className="font-semibold text-slate-900 pt-2">4. Recommended Investigation</h4>
              <ul className="list-disc pl-4 space-y-1 text-slate-700">
                {selectedAssessment.assessment.recommendedInvestigation.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 flex items-start gap-2.5 text-xs text-slate-700">
            <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <span>{selectedAssessment.assessment.safetyDisclaimer}</span>
          </div>
        </div>
      )}
    </div>
  );
}
