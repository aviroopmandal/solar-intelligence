import React, { useState } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  Building2,
  Cpu,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Plug,
  Settings,
  Sun,
  TrendingUp,
  Wrench,
  X,
} from 'lucide-react';
import type {
  AuthMeResponse,
  NavSection,
} from '../types/solar.ts';

interface SidebarLayoutProps {
  authData: AuthMeResponse;
  activeNav: NavSection;
  onSelectNav: (nav: NavSection) => void;
  onSwitchOrg: (orgId: string) => void;
  onSignOut: () => void;
  activeAlertCount: number;
  simulatorStatus: string;
  children: React.ReactNode;
}

const NAV_ITEMS: Array<{
  id: NavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'installations', label: 'Installations', icon: Building2 },
  { id: 'equipment', label: 'Equipment', icon: Cpu },
  { id: 'analytics', label: 'Energy Analytics', icon: BarChart3 },
  { id: 'forecasting', label: 'Forecasting', icon: TrendingUp },
  { id: 'performance', label: 'Performance', icon: Activity },
  { id: 'alerts', label: 'Alerts', icon: Bell },
  { id: 'maintenance', label: 'Maintenance', icon: Wrench },
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'assistant', label: 'AI Assistant', icon: MessageSquare },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function SidebarLayout({
  authData,
  activeNav,
  onSelectNav,
  onSwitchOrg,
  onSignOut,
  activeAlertCount,
  simulatorStatus,
  children,
}: SidebarLayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const activeNavLabel =
    NAV_ITEMS.find((n) => n.id === activeNav)?.label || 'Dashboard';

  const sidebarContent = (
    <div className="flex h-full flex-col bg-slate-900 text-slate-200">
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
            <Sun className="h-4 w-4" />
          </div>
          <span className="font-display text-sm font-semibold tracking-tight text-white whitespace-nowrap">
            Solar Intelligence
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
          aria-label="Close navigation menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="border-b border-slate-800 px-4 py-3">
        <label className="block text-xs font-medium text-slate-400 mb-1">
          Organisation
        </label>
        <select
          value={authData.activeOrganisation.organisationId}
          onChange={(e) => onSwitchOrg(e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white focus:border-emerald-500 focus:outline-none"
        >
          {authData.memberships.map((m) => (
            <option key={m.organisationId} value={m.organisationId}>
              {m.orgName}
            </option>
          ))}
        </select>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
          <span>Role:</span>
          <span className="font-medium text-emerald-400">
            {authData.activeOrganisation.role}
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeNav === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectNav(item.id);
                setMobileOpen(false);
              }}
              className={`w-full flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-emerald-600/15 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-300 hover:bg-slate-800/80 hover:text-white border border-transparent'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </span>
              {item.id === 'alerts' && activeAlertCount > 0 && (
                <span className="font-mono text-xs tabular-nums text-amber-400">
                  {activeAlertCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-slate-800 p-4">
        <div className="mb-3 text-xs">
          <div className="font-medium text-white truncate">
            {authData.user.displayName}
          </div>
          <div className="text-slate-400 truncate">{authData.user.email}</div>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="w-full flex items-center justify-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block lg:w-64 lg:shrink-0 border-r border-slate-200">
        <div className="sticky top-0 h-screen">{sidebarContent}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-900/60"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 w-64 h-full">{sidebarContent}</div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="rounded-md border border-slate-200 p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
              aria-label="Open navigation menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-500 hidden sm:inline truncate">
                {authData.activeOrganisation.orgName}
              </span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <h1 className="font-display text-base font-semibold text-slate-900 truncate">
                {activeNavLabel}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0 text-xs text-slate-600">
            <span className="hidden md:inline whitespace-nowrap">
              Simulator: <strong className="font-mono text-slate-900">{simulatorStatus}</strong>
            </span>
            <button
              type="button"
              onClick={() => onSelectNav('integrations')}
              className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap"
            >
              Data & Simulator Controls
            </button>
          </div>
        </header>

        {/* Mandatory Provenance / Demo Boundary Banner */}
        <div className="border-b border-amber-200 bg-amber-50/80 px-4 py-2 text-xs text-amber-950 sm:px-6 flex flex-wrap items-center justify-between gap-2">
          <span>
            <strong>Demonstration Environment:</strong> Telemetry, weather, and irradiance records shown from the internal simulator are clearly labelled as <strong>SIMULATED</strong>. Manufacturer APIs and Modbus gateways remain marked <strong>Not Yet Connected</strong> until verified hardware integration.
          </span>
          <button
            type="button"
            onClick={() => onSelectNav('integrations')}
            className="font-medium text-amber-900 underline hover:text-amber-700 whitespace-nowrap"
          >
            Manage Data Sources
          </button>
        </div>

        <main className="flex-1 p-4 sm:p-6 max-w-[1400px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
