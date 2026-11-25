export type OrgRole = 'Administrator' | 'Operations Manager' | 'Technician';

export type NavSection =
  | 'dashboard'
  | 'installations'
  | 'equipment'
  | 'analytics'
  | 'forecasting'
  | 'performance'
  | 'alerts'
  | 'maintenance'
  | 'reports'
  | 'assistant'
  | 'integrations'
  | 'settings';

export interface UserProfile {
  id: string;
  uid: string;
  email: string;
  displayName: string;
}

export interface OrganisationMembershipSummary {
  membershipId: string;
  organisationId: string;
  role: OrgRole;
  assignedInstallationIds: string[];
  orgName: string;
  isDemo: boolean;
  industry: string;
  country: string;
  defaultTimezone: string;
  contactEmail: string | null;
}

export interface AuthMeResponse {
  user: UserProfile;
  activeOrganisation: OrganisationMembershipSummary;
  memberships: OrganisationMembershipSummary[];
  aiConfigured: boolean;
}

export interface SolarInstallation {
  id: string;
  organisationId: string;
  installationCode: string;
  name: string;
  siteAddress: string;
  cityState: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  installationType: string;
  installedCapacityKwp: number;
  commissioningDate: string;
  panelManufacturer: string;
  panelModel: string;
  inverterManufacturer: string;
  inverterModel: string;
  inverterCount: number;
  panelOrientation: string;
  panelTiltDeg: number;
  shadingFactor: number;
  shadingNotes: string;
  performanceRatio: number;
  tempCoefficient: number;
  operationalStatus: string;
  operationalGroup: string;
  isActive: boolean;
  createdAt: string;
}

export interface TelemetryReading {
  id: string;
  installationId: string;
  inverterId: string;
  sourceType: string;
  measuredAt: string;
  receivedAt: string;
  acPowerKw: number | null;
  dcPowerKw: number | null;
  dailyEnergyKwh: number | null;
  cumulativeEnergyKwh: number | null;
  voltageV: number | null;
  currentA: number | null;
  temperatureC: number | null;
  operatingStatus: 'ONLINE' | 'OFFLINE' | 'WARNING' | 'FAULT' | 'UNKNOWN';
  faultCode: string | null;
  qualityStatus: string;
  qualityFlags: string[];
}

export interface InverterItem {
  id: string;
  installationId: string;
  installationName?: string;
  installationTimezone?: string;
  inverterCode: string;
  name: string;
  manufacturer: string;
  model: string;
  serialNumber: string | null;
  ratedCapacityKw: number;
  dcCapacityKwp: number;
  operatingStatus: 'ONLINE' | 'OFFLINE' | 'WARNING' | 'FAULT' | 'UNKNOWN';
  faultCode: string | null;
  lastSeenAt: string | null;
  latestReading?: TelemetryReading | null;
}

export interface DashboardPayload {
  metrics: {
    totalInstallations: number;
    totalCapacityKwp: number;
    energyTodayKwh: number;
    energyMonthKwh: number;
    avgPortfolioPerformancePct: number | null;
    operatingCount: number;
    abnormalCount: number;
    activeAlertsCount: number;
  };
  dailySeries: Array<{ date: string; actualKwh: number; expectedKwh: number }>;
  installationPerformance: Array<{
    id: string;
    name: string;
    capacityKwp: number;
    actualKwh: number;
    expectedKwh: number;
    performancePct: number | null;
    operationalStatus: string;
    onlineInverters: number;
    totalInverters: number;
    flaggedUnderperforming: boolean;
  }>;
  statusBreakdown: Array<{ status: string; count: number }>;
  recentActivity: Array<{
    id: string;
    type: string;
    title: string;
    detail: string;
    timestamp: string;
  }>;
  simulatorStatus: string;
}

export interface ForecastRow {
  id: string;
  installationId: string;
  generatedAt: string;
  targetTimestamp: string;
  horizonType: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  expectedEnergyKwh: number;
  confidenceLowKwh: number | null;
  confidenceHighKwh: number | null;
  confidenceAvailable: boolean;
  modelVersion: string;
  trainingPeriodStart: string;
  trainingPeriodEnd: string;
  maeKwh: number | null;
  rmseKwh: number | null;
  mapePct: number | null;
  isPreliminary: boolean;
  notes: string | null;
}

export interface MaintenanceAssessment {
  problemSummary: string;
  supportingEvidence: string[];
  possibleExplanations: string[];
  recommendedInvestigation: string[];
  priority: string;
  confidence: string;
  safetyDisclaimer: string;
  generatedBy: string;
}

export interface AnomalyItem {
  id: string;
  installationId: string;
  installationName: string;
  inverterId: string | null;
  inverterCode: string | null;
  detectedAt: string;
  category: string;
  classification: 'STATISTICAL_ANOMALY' | 'CONFIRMED_EQUIPMENT_FAULT';
  observedValue: string;
  expectedBaseline: string;
  severity: 'Informational' | 'Low' | 'Medium' | 'High' | 'Critical';
  explanation: string;
  recommendedAction: string;
  evidenceJson: Record<string, unknown>;
  aiAssessmentJson: MaintenanceAssessment | null;
  status: string;
}

export interface AlertItem {
  id: string;
  installationId: string;
  installationName: string;
  inverterId: string | null;
  inverterCode: string | null;
  anomalyId: string | null;
  alertCode: string;
  triggeredAt: string;
  severity: string;
  title: string;
  description: string;
  supportingMeasurements: Record<string, unknown>;
  recommendedAction: string;
  status: 'New' | 'Acknowledged' | 'Under Investigation' | 'Resolved' | 'Dismissed';
  assignedToUserId: string | null;
}

export interface MaintenanceTaskItem {
  id: string;
  installationId: string;
  installationName: string;
  inverterId: string | null;
  inverterCode: string | null;
  alertId: string | null;
  title: string;
  description: string;
  priority: string;
  status: string;
  assignedToName: string | null;
  dueDate: string;
  inspectionFindings: string | null;
  workPerformed: string | null;
  attachmentNote: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface MaintenanceRecordItem {
  id: string;
  installationId: string;
  installationName: string;
  inverterId: string | null;
  inverterCode: string | null;
  performedByName: string;
  performedAt: string;
  recordType: string;
  findings: string;
  workPerformed: string;
  partsReplaced: string | null;
  repeatedIssuesSinceMaintenance: number;
}
