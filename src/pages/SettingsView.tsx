import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api.ts';
import type { AuthMeResponse, OrgRole, SolarInstallation } from '../types/solar.ts';

interface SettingsViewProps {
  authData: AuthMeResponse;
  onOrgCreatedOrUpdated: (newOrgId?: string) => Promise<void>;
}

export default function SettingsView({
  authData,
  onOrgCreatedOrUpdated,
}: SettingsViewProps) {
  const isAdmin = authData.activeOrganisation.role === 'Administrator';
  const [members, setMembers] = useState<any[]>([]);
  const [installations, setInstallations] = useState<SolarInstallation[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);

  const [orgForm, setOrgForm] = useState({
    name: authData.activeOrganisation.orgName,
    industry: authData.activeOrganisation.industry,
    country: authData.activeOrganisation.country,
    defaultTimezone: authData.activeOrganisation.defaultTimezone,
    contactEmail: authData.activeOrganisation.contactEmail || '',
  });

  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgCountry, setNewOrgCountry] = useState('India');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('Operations Manager');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSettingsData = async () => {
    const [m, insts, logs] = await Promise.all([
      apiFetch<any[]>('/api/v1/members'),
      apiFetch<SolarInstallation[]>('/api/v1/installations'),
      apiFetch<any[]>('/api/v1/audit-logs'),
    ]);
    setMembers(m);
    setInstallations(insts);
    setAuditLogs(logs);
  };

  useEffect(() => {
    setOrgForm({
      name: authData.activeOrganisation.orgName,
      industry: authData.activeOrganisation.industry,
      country: authData.activeOrganisation.country,
      defaultTimezone: authData.activeOrganisation.defaultTimezone,
      contactEmail: authData.activeOrganisation.contactEmail || '',
    });
    loadSettingsData();
  }, [authData.activeOrganisation.organisationId]);

  const handleSaveOrgProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatusMessage(null);
    try {
      await apiFetch('/api/v1/organisations/current', {
        method: 'PATCH',
        body: JSON.stringify(orgForm),
      });
      await onOrgCreatedOrUpdated();
      setStatusMessage('Organisation profile updated.');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRegisterNewOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOrgName.trim()) return;
    setError(null);
    try {
      const created = await apiFetch<{ id: string }>('/api/v1/organisations', {
        method: 'POST',
        body: JSON.stringify({ name: newOrgName.trim(), country: newOrgCountry }),
      });
      setNewOrgName('');
      await onOrgCreatedOrUpdated(created.id);
      setStatusMessage('New isolated organisation registered and activated.');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/v1/members/invite', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      setInviteEmail('');
      await loadSettingsData();
      setStatusMessage('User invitation recorded.');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleUpdateRole = async (memberId: string, role: OrgRole) => {
    await apiFetch(`/api/v1/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    await loadSettingsData();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-slate-900">
          Organisation, Access Control & Application Settings
        </h2>
        <p className="text-xs text-slate-500">
          Manage company profiles, multi-tenant organisation isolation, role-based access control, and audit logs
        </p>
      </div>

      {statusMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-900">
          {statusMessage}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Active Organisation Profile */}
        <form
          onSubmit={handleSaveOrgProfile}
          className="rounded-lg border border-slate-200 bg-white p-5 space-y-3 text-xs"
        >
          <h3 className="font-display text-sm font-semibold text-slate-900">
            Active Organisation Profile
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1 sm:col-span-2">
              <span className="font-medium text-slate-700">Company Name</span>
              <input
                disabled={!isAdmin}
                value={orgForm.name}
                onChange={(e) => setOrgForm({ ...orgForm, name: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 disabled:bg-slate-50"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Industry</span>
              <input
                disabled={!isAdmin}
                value={orgForm.industry}
                onChange={(e) => setOrgForm({ ...orgForm, industry: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 disabled:bg-slate-50"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Default Timezone (IANA)</span>
              <input
                disabled={!isAdmin}
                value={orgForm.defaultTimezone}
                onChange={(e) => setOrgForm({ ...orgForm, defaultTimezone: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 font-mono disabled:bg-slate-50"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Country</span>
              <input
                disabled={!isAdmin}
                value={orgForm.country}
                onChange={(e) => setOrgForm({ ...orgForm, country: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 disabled:bg-slate-50"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Operations Email</span>
              <input
                disabled={!isAdmin}
                value={orgForm.contactEmail}
                onChange={(e) => setOrgForm({ ...orgForm, contactEmail: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 disabled:bg-slate-50"
              />
            </label>
          </div>
          {isAdmin && (
            <button
              type="submit"
              className="rounded-md bg-emerald-700 px-4 py-1.5 font-medium text-white hover:bg-emerald-800"
            >
              Save Profile
            </button>
          )}
        </form>

        {/* Register New Isolated Company Organisation */}
        <form
          onSubmit={handleRegisterNewOrg}
          className="rounded-lg border border-slate-200 bg-white p-5 space-y-3 text-xs"
        >
          <h3 className="font-display text-sm font-semibold text-slate-900">
            Register New Company Organisation
          </h3>
          <p className="text-slate-500">
            Create an isolated commercial workspace separate from the demonstration organisation. Installations, telemetry, and alerts are strictly partitioned per organisation.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="font-medium text-slate-700">New Organisation Name *</span>
              <input
                required
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder="Eastern Grid Renewables Ltd."
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
            <label className="space-y-1">
              <span className="font-medium text-slate-700">Country</span>
              <input
                value={newOrgCountry}
                onChange={(e) => setNewOrgCountry(e.target.value)}
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5"
              />
            </label>
          </div>
          <button
            type="submit"
            className="rounded-md border border-slate-900 bg-slate-900 px-4 py-1.5 font-medium text-white hover:bg-slate-800"
          >
            Create Isolated Organisation
          </button>
        </form>
      </div>

      {/* Team Members & RBAC */}
      <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900">
              Team Members & Role-Based Permissions
            </h3>
            <p className="text-xs text-slate-500">
              Roles: Administrator (full access), Operations Manager (monitoring/analytics/alerts), Technician (assigned sites & maintenance records)
            </p>
          </div>
        </div>

        {isAdmin && (
          <form onSubmit={handleInviteMember} className="flex flex-wrap items-center gap-2 text-xs">
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="rounded-md border border-slate-200 px-3 py-1.5 min-w-[240px]"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as OrgRole)}
              className="rounded-md border border-slate-200 px-2.5 py-1.5"
            >
              <option value="Administrator">Administrator</option>
              <option value="Operations Manager">Operations Manager</option>
              <option value="Technician">Technician</option>
            </select>
            <button
              type="submit"
              className="rounded-md bg-emerald-700 px-3.5 py-1.5 font-medium text-white hover:bg-emerald-800"
            >
              Invite User
            </button>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-medium">User / Email</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Role</th>
                <th className="py-2 font-medium">Installed Sites Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="py-2.5 pr-4">
                    <div className="font-medium text-slate-900">
                      {m.displayName || m.invitedEmail}
                    </div>
                    <div className="text-slate-500">{m.invitedEmail}</div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono">{m.status}</td>
                  <td className="py-2.5 pr-4">
                    {isAdmin ? (
                      <select
                        value={m.role}
                        onChange={(e) => handleUpdateRole(m.id, e.target.value as OrgRole)}
                        className="rounded border border-slate-200 px-2 py-1 text-xs"
                      >
                        <option value="Administrator">Administrator</option>
                        <option value="Operations Manager">Operations Manager</option>
                        <option value="Technician">Technician</option>
                      </select>
                    ) : (
                      <span>{m.role}</span>
                    )}
                  </td>
                  <td className="py-2.5 font-mono text-slate-500">
                    {m.role === 'Technician' && m.assignedInstallationIds?.length > 0
                      ? `${m.assignedInstallationIds.length} assigned`
                      : `All (${installations.length})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Audit Logs */}
      <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
        <h3 className="font-display text-sm font-semibold text-slate-900">
          Organisation Audit Trail
        </h3>
        <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 text-xs">
          {auditLogs.map((log) => (
            <div key={log.id} className="py-2 flex flex-wrap justify-between gap-2">
              <div>
                <span className="font-mono font-medium text-slate-900">{log.action}</span> ·{' '}
                <span className="text-slate-600">{log.userEmail}</span> ·{' '}
                <span className="text-slate-500">{log.entityType}</span>
              </div>
              <span className="font-mono text-slate-400">
                {new Date(log.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
