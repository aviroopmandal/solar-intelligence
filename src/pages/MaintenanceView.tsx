import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type {
  InverterItem,
  MaintenanceRecordItem,
  MaintenanceTaskItem,
  SolarInstallation,
} from '../types/solar.ts';

export default function MaintenanceView() {
  const [tab, setTab] = useState<'tasks' | 'history'>('tasks');
  const [tasks, setTasks] = useState<MaintenanceTaskItem[]>([]);
  const [records, setRecords] = useState<MaintenanceRecordItem[]>([]);
  const [installations, setInstallations] = useState<SolarInstallation[]>([]);
  const [inverters, setInverters] = useState<InverterItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const [newTask, setNewTask] = useState({
    installationId: '',
    inverterId: '',
    title: '',
    description: '',
    priority: 'Medium',
    dueDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
    assignedToName: '',
  });

  const [activeCompleteTask, setActiveCompleteTask] = useState<MaintenanceTaskItem | null>(null);
  const [completionNotes, setCompletionNotes] = useState({
    inspectionFindings: '',
    workPerformed: '',
    partsReplaced: '',
    attachmentNote: '',
  });

  const loadAll = async () => {
    setLoading(true);
    try {
      const [t, r, insts, invs] = await Promise.all([
        apiFetch<MaintenanceTaskItem[]>('/api/v1/maintenance/tasks'),
        apiFetch<MaintenanceRecordItem[]>('/api/v1/maintenance/records'),
        apiFetch<SolarInstallation[]>('/api/v1/installations'),
        apiFetch<InverterItem[]>('/api/v1/inverters'),
      ]);
      setTasks(t);
      setRecords(r);
      setInstallations(insts);
      setInverters(invs);
      if (insts.length > 0 && !newTask.installationId) {
        setNewTask((prev) => ({ ...prev, installationId: insts[0].id }));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/v1/maintenance/tasks', {
      method: 'POST',
      body: JSON.stringify(newTask),
    });
    setShowCreate(false);
    setNewTask((prev) => ({ ...prev, title: '', description: '' }));
    await loadAll();
  };

  const handleUpdateTaskStatus = async (id: string, status: string) => {
    await apiFetch(`/api/v1/maintenance/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    await loadAll();
  };

  const handleCompleteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCompleteTask) return;
    await apiFetch(`/api/v1/maintenance/tasks/${activeCompleteTask.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'Completed',
        ...completionNotes,
      }),
    });
    setActiveCompleteTask(null);
    setCompletionNotes({
      inspectionFindings: '',
      workPerformed: '',
      partsReplaced: '',
      attachmentNote: '',
    });
    await loadAll();
  };

  const filteredSiteInvs = inverters.filter(
    (i) => i.installationId === newTask.installationId
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Maintenance Tasks & Chronological Records
          </h2>
          <p className="text-xs text-slate-500">
            Schedule technician work, log findings, and track repeated anomalies on serviced equipment
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1">
            <button
              type="button"
              onClick={() => setTab('tasks')}
              className={`rounded-md px-3 py-1 text-xs font-medium ${
                tab === 'tasks' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Tasks ({tasks.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('history')}
              className={`rounded-md px-3 py-1 text-xs font-medium ${
                tab === 'history' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Maintenance History ({records.length})
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-800"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New Task</span>
          </button>
        </div>
      </div>

      {showCreate && (
        <form
          onSubmit={handleCreateTask}
          className="rounded-lg border border-slate-200 bg-white p-5 space-y-3 text-xs"
        >
          <h3 className="font-display text-sm font-semibold text-slate-900">
            Create Maintenance Task
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Installation *</span>
              <select
                required
                value={newTask.installationId}
                onChange={(e) =>
                  setNewTask({ ...newTask, installationId: e.target.value, inverterId: '' })
                }
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
              <span className="font-medium text-slate-700">Inverter (Optional)</span>
              <select
                value={newTask.inverterId}
                onChange={(e) => setNewTask({ ...newTask, inverterId: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              >
                <option value="">Site-wide / All Equipment</option>
                {filteredSiteInvs.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.inverterCode}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Priority</span>
              <select
                value={newTask.priority}
                onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              >
                <option>Low</option>
                <option>Medium</option>
                <option>High</option>
                <option>Critical</option>
              </select>
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="font-medium text-slate-700">Task Title *</span>
              <input
                required
                value={newTask.title}
                onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                placeholder="Inspect DC string voltages and clean intake filter"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Due Date *</span>
              <input
                required
                type="date"
                value={newTask.dueDate}
                onChange={(e) => setNewTask({ ...newTask, dueDate: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Assign Technician</span>
              <input
                value={newTask.assignedToName}
                onChange={(e) => setNewTask({ ...newTask, assignedToName: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
                placeholder="Technician name"
              />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="font-medium text-slate-700">Instructions / Description</span>
              <input
                value={newTask.description}
                onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-slate-200 px-3 py-1.5 font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-emerald-700 px-4 py-1.5 font-medium text-white hover:bg-emerald-800"
            >
              Create Task
            </button>
          </div>
        </form>
      )}

      {activeCompleteTask && (
        <form
          onSubmit={handleCompleteSubmit}
          className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-5 space-y-3 text-xs"
        >
          <h3 className="font-display text-sm font-semibold text-slate-900">
            Complete Task & Log Maintenance Record: {activeCompleteTask.title}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Inspection Findings *</span>
              <textarea
                required
                rows={2}
                value={completionNotes.inspectionFindings}
                onChange={(e) =>
                  setCompletionNotes({ ...completionNotes, inspectionFindings: e.target.value })
                }
                className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Maintenance Work Performed *</span>
              <textarea
                required
                rows={2}
                value={completionNotes.workPerformed}
                onChange={(e) =>
                  setCompletionNotes({ ...completionNotes, workPerformed: e.target.value })
                }
                className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Parts Replaced (Optional)</span>
              <input
                value={completionNotes.partsReplaced}
                onChange={(e) =>
                  setCompletionNotes({ ...completionNotes, partsReplaced: e.target.value })
                }
                className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Document / Photo Reference</span>
              <input
                value={completionNotes.attachmentNote}
                onChange={(e) =>
                  setCompletionNotes({ ...completionNotes, attachmentNote: e.target.value })
                }
                className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5"
                placeholder="e.g. Thermal inspection log ref #441"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setActiveCompleteTask(null)}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-emerald-700 px-4 py-1.5 font-medium text-white hover:bg-emerald-800"
            >
              Mark Completed & Save Record
            </button>
          </div>
        </form>
      )}

      {tab === 'tasks' ? (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="py-2.5 px-4 font-medium">Task</th>
                  <th className="py-2.5 px-4 font-medium">Installation / Unit</th>
                  <th className="py-2.5 px-4 font-medium">Assigned</th>
                  <th className="py-2.5 px-4 font-medium">Priority</th>
                  <th className="py-2.5 px-4 font-medium">Due</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                  <th className="py-2.5 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      Loading tasks...
                    </td>
                  </tr>
                ) : tasks.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      No maintenance tasks recorded.
                    </td>
                  </tr>
                ) : (
                  tasks.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{t.title}</div>
                        <div className="text-slate-500 truncate max-w-xs">{t.description}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-800">{t.installationName}</div>
                        <div className="font-mono text-slate-400">{t.inverterCode || 'Site-wide'}</div>
                      </td>
                      <td className="py-3 px-4 text-slate-700">{t.assignedToName || 'Unassigned'}</td>
                      <td className="py-3 px-4 font-medium">{t.priority}</td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-600">{t.dueDate}</td>
                      <td className="py-3 px-4 font-medium text-slate-800">{t.status}</td>
                      <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                        {t.status === 'Open' && (
                          <button
                            type="button"
                            onClick={() => handleUpdateTaskStatus(t.id, 'In Progress')}
                            className="text-emerald-700 font-medium hover:underline"
                          >
                            Start
                          </button>
                        )}
                        {t.status !== 'Completed' && (
                          <button
                            type="button"
                            onClick={() => setActiveCompleteTask(t)}
                            className="text-emerald-700 font-semibold hover:underline"
                          >
                            Complete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {records.map((rec) => (
            <div
              key={rec.id}
              className="rounded-lg border border-slate-200 bg-white p-4 text-xs space-y-1.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-slate-900">
                  {rec.installationName} {rec.inverterCode ? `· ${rec.inverterCode}` : ''} ·{' '}
                  {rec.recordType}
                </div>
                <div className="font-mono text-slate-500">
                  {new Date(rec.performedAt).toISOString().slice(0, 10)} · Tech: {rec.performedByName}
                </div>
              </div>
              <p className="text-slate-700">
                <strong>Findings:</strong> {rec.findings}
              </p>
              <p className="text-slate-700">
                <strong>Work Performed:</strong> {rec.workPerformed}
                {rec.partsReplaced ? ` (Parts: ${rec.partsReplaced})` : ''}
              </p>
              {rec.repeatedIssuesSinceMaintenance > 0 && (
                <div className="text-amber-700 font-medium pt-1">
                  Repeat Anomaly Alert: {rec.repeatedIssuesSinceMaintenance} subsequent anomal
                  {rec.repeatedIssuesSinceMaintenance === 1 ? 'y' : 'ies'} recorded on this equipment after this maintenance intervention.
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
