import React, { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { Sun, ShieldCheck } from 'lucide-react';
import { auth, googleAuthProvider } from './lib/firebase.ts';
import { apiFetch, setActiveOrgId } from './lib/api.ts';
import SidebarLayout from './components/SidebarLayout.tsx';
import DashboardView from './pages/DashboardView.tsx';
import InstallationsView from './pages/InstallationsView.tsx';
import EquipmentView from './pages/EquipmentView.tsx';
import AnalyticsView from './pages/AnalyticsView.tsx';
import ForecastingView from './pages/ForecastingView.tsx';
import PerformanceView from './pages/PerformanceView.tsx';
import AlertsView from './pages/AlertsView.tsx';
import MaintenanceView from './pages/MaintenanceView.tsx';
import ReportsView from './pages/ReportsView.tsx';
import AssistantView from './pages/AssistantView.tsx';
import IntegrationsView from './pages/IntegrationsView.tsx';
import SettingsView from './pages/SettingsView.tsx';
import type {
  AuthMeResponse,
  DashboardPayload,
  NavSection,
} from './types/solar.ts';

export default function App() {
  const [fbUser, setFbUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authData, setAuthData] = useState<AuthMeResponse | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeNav, setActiveNav] = useState<NavSection>('dashboard');
  const [selectedInstallationId, setSelectedInstallationId] = useState<string | null>(null);

  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  const [dashError, setDashError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setFbUser(user);
      setAuthReady(true);
      if (!user) {
        setAuthData(null);
        setDashboard(null);
        setActiveOrgId(null);
      }
    });
    return () => unsub();
  }, []);

  const loadSessionAndDashboard = useCallback(async (preferredOrgId?: string) => {
    if (preferredOrgId !== undefined) {
      setActiveOrgId(preferredOrgId);
    }
    setAuthError(null);
    try {
      const me = await apiFetch<AuthMeResponse>('/api/v1/auth/me');
      setAuthData(me);
      setActiveOrgId(me.activeOrganisation.organisationId);

      setDashLoading(true);
      setDashError(null);
      const dash = await apiFetch<DashboardPayload>('/api/v1/dashboard');
      setDashboard(dash);
    } catch (err: any) {
      setAuthError(err.message || 'Failed to load workspace.');
      setDashError(err.message || 'Failed to load dashboard.');
    } finally {
      setDashLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fbUser) {
      loadSessionAndDashboard();
    }
  }, [fbUser, loadSessionAndDashboard]);

  // Refresh dashboard every 30s per Section 31 schedule while signed in
  useEffect(() => {
    if (!fbUser || !authData) return;
    const id = setInterval(() => {
      apiFetch<DashboardPayload>('/api/v1/dashboard')
        .then(setDashboard)
        .catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, [fbUser, authData]);

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err: any) {
      setAuthError(err.message || 'Sign-in cancelled or failed.');
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

  const handleSwitchOrg = async (orgId: string) => {
    setSelectedInstallationId(null);
    await loadSessionAndDashboard(orgId);
  };

  const handleRefreshDashboard = async () => {
    setDashLoading(true);
    setDashError(null);
    try {
      const dash = await apiFetch<DashboardPayload>('/api/v1/dashboard');
      setDashboard(dash);
    } catch (err: any) {
      setDashError(err.message);
    } finally {
      setDashLoading(false);
    }
  };

  const handleGenerateInterval = async () => {
    await apiFetch('/api/v1/simulator/generate', { method: 'POST', body: JSON.stringify({}) });
    await handleRefreshDashboard();
  };

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-500">
        Initializing Solar Intelligence System...
      </div>
    );
  }

  if (!fbUser) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 space-y-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-700 text-white">
              <Sun className="h-5 w-5" />
            </div>
            <div>
              <h1 className="font-display text-xl font-semibold text-slate-900">
                Solar Intelligence System
              </h1>
              <p className="text-xs text-slate-500">
                Commercial Solar Monitoring, Forecasting & Maintenance Platform
              </p>
            </div>
          </div>

          <div className="space-y-2 text-xs text-slate-600 leading-relaxed">
            <p>
              Sign in to access your organisation&apos;s solar portfolio, inverter telemetry, staged energy forecasts, anomaly detection, and grounded AI maintenance diagnostics.
            </p>
            <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-slate-700">
              <ShieldCheck className="h-4 w-4 text-emerald-700 shrink-0 mt-0.5" />
              <span>
                First-time sign-in provisions a pre-populated Demonstration Organisation with 5 West Bengal solar installations and 30 days of seeded telemetry.
              </span>
            </div>
          </div>

          {authError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              {authError}
            </div>
          )}

          <button
            type="button"
            onClick={handleGoogleSignIn}
            className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
          >
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  if (!authData) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6 space-y-3">
        <div className="text-sm font-medium text-slate-700">
          {authError ? 'Workspace Initialization Issue' : 'Provisioning PostgreSQL workspace & demonstration dataset...'}
        </div>
        {authError && (
          <div className="max-w-md rounded-md border border-red-200 bg-red-50 p-4 text-xs text-red-800 space-y-2">
            <p>{authError}</p>
            <button
              type="button"
              onClick={() => loadSessionAndDashboard()}
              className="rounded bg-red-700 px-3 py-1.5 text-white font-medium"
            >
              Retry Connection
            </button>
          </div>
        )}
      </div>
    );
  }

  const role = authData.activeOrganisation.role;

  return (
    <SidebarLayout
      authData={authData}
      activeNav={activeNav}
      onSelectNav={(nav) => {
        setActiveNav(nav);
        if (nav !== 'installations') setSelectedInstallationId(null);
      }}
      onSwitchOrg={handleSwitchOrg}
      onSignOut={handleSignOut}
      activeAlertCount={dashboard?.metrics.activeAlertsCount ?? 0}
      simulatorStatus={dashboard?.simulatorStatus ?? 'PAUSED'}
    >
      {activeNav === 'dashboard' && (
        <DashboardView
          data={dashboard}
          loading={dashLoading}
          error={dashError}
          onRefresh={handleRefreshDashboard}
          onGenerateInterval={handleGenerateInterval}
          onNavigate={setActiveNav}
          onSelectInstallation={(id) => {
            setSelectedInstallationId(id);
            setActiveNav('installations');
          }}
        />
      )}

      {activeNav === 'installations' && (
        <InstallationsView
          role={role}
          selectedId={selectedInstallationId}
          onSelectId={setSelectedInstallationId}
          onChanged={handleRefreshDashboard}
        />
      )}

      {activeNav === 'equipment' && <EquipmentView />}

      {activeNav === 'analytics' && <AnalyticsView />}

      {activeNav === 'forecasting' && <ForecastingView role={role} />}

      {activeNav === 'performance' && <PerformanceView role={role} />}

      {activeNav === 'alerts' && (
        <AlertsView
          onAlertsUpdated={handleRefreshDashboard}
          onNavigate={setActiveNav}
        />
      )}

      {activeNav === 'maintenance' && <MaintenanceView />}

      {activeNav === 'reports' && <ReportsView />}

      {activeNav === 'assistant' && <AssistantView />}

      {activeNav === 'integrations' && (
        <IntegrationsView role={role} onDataChanged={handleRefreshDashboard} />
      )}

      {activeNav === 'settings' && (
        <SettingsView
          authData={authData}
          onOrgCreatedOrUpdated={loadSessionAndDashboard}
        />
      )}
    </SidebarLayout>
  );
}
