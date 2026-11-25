import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api.ts';
import type { AlertItem, NavSection } from '../types/solar.ts';

interface AlertsViewProps {
  onAlertsUpdated: () => void;
  onNavigate: (nav: NavSection) => void;
}

export default function AlertsView({ onAlertsUpdated, onNavigate }: AlertsViewProps) {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('ACTIVE');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const loadAlerts = async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<AlertItem[]>('/api/v1/alerts');
      setAlerts(rows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAlerts();
  }, []);

  const updateAlertStatus = async (
    id: string,
    status: AlertItem['status'],
    assignToSelf = false
  ) => {
    setUpdatingId(id);
    try {
      await apiFetch(`/api/v1/alerts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, assignToSelf }),
      });
      await loadAlerts();
      onAlertsUpdated();
    } finally {
      setUpdatingId(null);
    }
  };

  const createTaskFromAlert = async (alert: AlertItem) => {
    setUpdatingId(alert.id);
    try {
      const due = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      await apiFetch('/api/v1/maintenance/tasks', {
        method: 'POST',
        body: JSON.stringify({
          installationId: alert.installationId,
          inverterId: alert.inverterId,
          alertId: alert.id,
          anomalyId: alert.anomalyId,
          title: `Investigate ${alert.alertCode}: ${alert.title}`,
          description: `${alert.description} Recommended action: ${alert.recommendedAction}`,
          priority: alert.severity === 'Critical' ? 'Critical' : 'High',
          dueDate: due,
        }),
      });
      await updateAlertStatus(alert.id, 'Under Investigation', true);
      onNavigate('maintenance');
    } finally {
      setUpdatingId(null);
    }
  };

  const filtered = alerts.filter((a) => {
    if (statusFilter === 'ACTIVE') {
      return a.status !== 'Resolved' && a.status !== 'Dismissed';
    }
    if (statusFilter === 'ALL') return true;
    return a.status === statusFilter;
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Alerts & Incident Triage
          </h2>
          <p className="text-xs text-slate-500">
            Acknowledge, investigate, assign, and resolve operational alerts
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-200/70 p-1">
          {['ACTIVE', 'New', 'Acknowledged', 'Under Investigation', 'Resolved', 'Dismissed', 'ALL'].map(
            (st) => (
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
                {st === 'ACTIVE' ? 'Open Alerts' : st === 'ALL' ? 'All History' : st}
              </button>
            )
          )}
        </div>
      </div>

      <div className="space-y-3">
        {loading ? (
          <div className="h-40 rounded-lg border border-slate-200 bg-white animate-pulse" />
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            No alerts match the selected filter.
          </div>
        ) : (
          filtered.map((alert) => (
            <div
              key={alert.id}
              className="rounded-lg border border-slate-200 bg-white p-4 space-y-2.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono font-semibold text-slate-900">
                      {alert.alertCode}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span
                      className={`font-semibold ${
                        alert.severity === 'Critical'
                          ? 'text-red-700'
                          : alert.severity === 'High'
                            ? 'text-amber-700'
                            : 'text-slate-700'
                      }`}
                    >
                      {alert.severity}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{alert.installationName}</span>
                    {alert.inverterCode && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{alert.inverterCode}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {new Date(alert.triggeredAt).toLocaleString()}
                    </span>
                  </div>
                  <h3 className="mt-1 text-sm font-semibold text-slate-900">{alert.title}</h3>
                  <p className="mt-0.5 text-xs text-slate-600">{alert.description}</p>
                </div>

                <div className="text-xs font-medium text-slate-800 shrink-0">
                  Status: <span className="font-mono">{alert.status}</span>
                </div>
              </div>

              <div className="text-xs text-slate-600 bg-slate-50 rounded p-2.5 border border-slate-100">
                <strong className="text-slate-800">Recommended Action:</strong>{' '}
                {alert.recommendedAction}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                {alert.status === 'New' && (
                  <button
                    type="button"
                    disabled={updatingId === alert.id}
                    onClick={() => updateAlertStatus(alert.id, 'Acknowledged', true)}
                    className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Acknowledge
                  </button>
                )}
                {alert.status !== 'Under Investigation' && alert.status !== 'Resolved' && (
                  <button
                    type="button"
                    disabled={updatingId === alert.id}
                    onClick={() => updateAlertStatus(alert.id, 'Under Investigation', true)}
                    className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Mark Investigating
                  </button>
                )}
                {alert.status !== 'Resolved' && (
                  <>
                    <button
                      type="button"
                      disabled={updatingId === alert.id}
                      onClick={() => updateAlertStatus(alert.id, 'Resolved')}
                      className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
                    >
                      Resolve
                    </button>
                    <button
                      type="button"
                      disabled={updatingId === alert.id}
                      onClick={() => createTaskFromAlert(alert)}
                      className="rounded-md border border-emerald-700 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                    >
                      Create Maintenance Task
                    </button>
                    <button
                      type="button"
                      disabled={updatingId === alert.id}
                      onClick={() => updateAlertStatus(alert.id, 'Dismissed')}
                      className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"
                    >
                      Dismiss
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
