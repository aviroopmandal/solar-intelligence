import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { createServer as createViteServer } from 'vite';
import { db } from './src/db/index.ts';
import {
  alerts,
  auditLogs,
  connectorSyncLogs,
  dailyEnergyAggregates,
  dataSources,
  forecasts,
  gatewayDevices,
  hourlyEnergyAggregates,
  ingestionJobs,
  inverters,
  maintenanceRecords,
  maintenanceTasks,
  organisationMemberships,
  organisations,
  performanceAnomalies,
  simulatorEvents,
  simulatorSessions,
  solarInstallations,
  telemetryImportBatches,
  telemetryImportErrors,
  telemetryReadings,
  users,
  weatherReadings,
} from './src/db/schema.ts';
import { requireAuth, requireRole, type AuthRequest, type OrgRole } from './src/middleware/auth.ts';
import {
  generateCsvTemplateContent,
  listImportBatches,
  processCsvImport,
  type CsvTemplateType,
} from './src/services/ingestionService.ts';
import {
  answerAssistantQuestion,
  generateForecastsForOrganisation,
  generateMaintenanceAssessment,
  runAnomalyDetectionForOrganisation,
} from './src/services/intelligenceService.ts';
import {
  generateReportData,
  renderReportPdfBuffer,
  type ReportType,
} from './src/services/pdfReportService.ts';
import {
  generateSimulationInterval,
  getOrCreateSimulatorSession,
  setSimulatorState,
  triggerDemoFaultEvent,
  updateSimulatorEnvironment,
} from './src/services/simulatorService.ts';
import {
  MANUFACTURER_CONNECTORS,
  simulatedWeatherProvider,
} from './src/services/weatherAndConnectors.ts';

async function recordAudit(
  req: AuthRequest,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {}
) {
  if (!req.auth) return;
  await db.insert(auditLogs).values({
    organisationId: req.auth.organisationId,
    userId: req.auth.userId,
    userEmail: req.auth.email,
    action,
    entityType,
    entityId,
    detailsJson: details,
  });
}

function filterInstallationsForRole<T extends { id: string }>(
  req: AuthRequest,
  rows: T[]
): T[] {
  if (
    req.auth?.role === 'Technician' &&
    req.auth.assignedInstallationIds.length > 0
  ) {
    const allowed = new Set(req.auth.assignedInstallationIds);
    return rows.filter((r) => allowed.has(r.id));
  }
  return rows;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Health endpoint (public, no secrets)
  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', service: 'Solar Intelligence System', timestamp: new Date().toISOString() });
  });

  // 1. Auth & Organisation Context
  app.get('/api/v1/auth/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      const auth = req.auth!;
      const memberships = await db
        .select({
          membershipId: organisationMemberships.id,
          organisationId: organisationMemberships.organisationId,
          role: organisationMemberships.role,
          assignedInstallationIds: organisationMemberships.assignedInstallationIds,
          orgName: organisations.name,
          isDemo: organisations.isDemo,
          industry: organisations.industry,
          country: organisations.country,
          defaultTimezone: organisations.defaultTimezone,
          contactEmail: organisations.contactEmail,
        })
        .from(organisationMemberships)
        .innerJoin(organisations, eq(organisationMemberships.organisationId, organisations.id))
        .where(eq(organisationMemberships.userId, auth.userId));

      const activeOrg = memberships.find((m) => m.organisationId === auth.organisationId) || memberships[0];

      res.json({
        user: {
          id: auth.userId,
          uid: auth.uid,
          email: auth.email,
          displayName: auth.displayName,
        },
        activeOrganisation: activeOrg,
        memberships,
        aiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      });
    } catch (error) {
      console.error('Error in /auth/me:', error);
      res.status(500).json({ error: 'Failed to load user profile.' });
    }
  });

  app.post('/api/v1/organisations', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { name, industry, country, defaultTimezone, contactEmail } = req.body as {
        name?: string;
        industry?: string;
        country?: string;
        defaultTimezone?: string;
        contactEmail?: string;
      };
      if (!name || name.trim().length < 2) {
        res.status(400).json({ error: 'Organisation name is required (min 2 characters).' });
        return;
      }
      const slug = `${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

      const created = await db.transaction(async (tx) => {
        const [org] = await tx
          .insert(organisations)
          .values({
            name: name.trim(),
            slug,
            industry: industry?.trim() || 'Commercial & Industrial Solar',
            country: country?.trim() || 'India',
            contactEmail: contactEmail?.trim() || req.auth!.email,
            defaultTimezone: defaultTimezone?.trim() || 'Asia/Kolkata',
            isDemo: false,
          })
          .returning();

        await tx.insert(organisationMemberships).values({
          organisationId: org.id,
          userId: req.auth!.userId,
          invitedEmail: req.auth!.email,
          role: 'Administrator',
          assignedInstallationIds: [],
          status: 'ACTIVE',
        });

        await tx.insert(dataSources).values([
          {
            organisationId: org.id,
            name: 'Internal Physics Telemetry Simulator',
            sourceType: 'SIMULATED',
            provider: 'Solar Intelligence Simulator',
            connectionStatus: 'OPERATIONAL',
            pollingIntervalSec: 60,
          },
          {
            organisationId: org.id,
            name: 'Historical CSV Ingestion Pipeline',
            sourceType: 'CSV_IMPORT',
            provider: 'UTF-8 Batch Importer',
            connectionStatus: 'OPERATIONAL',
            pollingIntervalSec: 0,
          },
        ]);

        return org;
      });

      res.status(201).json(created);
    } catch (error) {
      console.error('Create organisation failed:', error);
      res.status(500).json({ error: 'Failed to register organisation.' });
    }
  });

  app.patch(
    '/api/v1/organisations/current',
    requireAuth,
    requireRole(['Administrator']),
    async (req: AuthRequest, res) => {
      try {
        const { name, industry, country, contactEmail, defaultTimezone } = req.body as {
          name?: string;
          industry?: string;
          country?: string;
          contactEmail?: string;
          defaultTimezone?: string;
        };
        const [updated] = await db
          .update(organisations)
          .set({
            ...(name ? { name: name.trim() } : {}),
            ...(industry ? { industry: industry.trim() } : {}),
            ...(country ? { country: country.trim() } : {}),
            ...(contactEmail !== undefined ? { contactEmail: contactEmail.trim() } : {}),
            ...(defaultTimezone ? { defaultTimezone: defaultTimezone.trim() } : {}),
          })
          .where(eq(organisations.id, req.auth!.organisationId))
          .returning();

        await recordAudit(req, 'ORGANISATION_UPDATED', 'organisation', updated.id);
        res.json(updated);
      } catch (error) {
        console.error('Update organisation failed:', error);
        res.status(500).json({ error: 'Failed to update organisation profile.' });
      }
    }
  );

  // 2. Members & RBAC Management
  app.get('/api/v1/members', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rows = await db
        .select({
          id: organisationMemberships.id,
          organisationId: organisationMemberships.organisationId,
          userId: organisationMemberships.userId,
          invitedEmail: organisationMemberships.invitedEmail,
          role: organisationMemberships.role,
          assignedInstallationIds: organisationMemberships.assignedInstallationIds,
          status: organisationMemberships.status,
          createdAt: organisationMemberships.createdAt,
          displayName: users.displayName,
        })
        .from(organisationMemberships)
        .leftJoin(users, eq(organisationMemberships.userId, users.id))
        .where(eq(organisationMemberships.organisationId, req.auth!.organisationId))
        .orderBy(organisationMemberships.createdAt);
      res.json(rows);
    } catch (error) {
      console.error('List members failed:', error);
      res.status(500).json({ error: 'Failed to load organisation members.' });
    }
  });

  app.post(
    '/api/v1/members/invite',
    requireAuth,
    requireRole(['Administrator']),
    async (req: AuthRequest, res) => {
      try {
        const { email, role, assignedInstallationIds } = req.body as {
          email?: string;
          role?: OrgRole;
          assignedInstallationIds?: string[];
        };
        if (!email || !email.includes('@')) {
          res.status(400).json({ error: 'Valid email address is required.' });
          return;
        }
        const validRoles: OrgRole[] = ['Administrator', 'Operations Manager', 'Technician'];
        if (!role || !validRoles.includes(role)) {
          res.status(400).json({ error: 'Role must be Administrator, Operations Manager, or Technician.' });
          return;
        }
        const normalizedEmail = email.trim().toLowerCase();
        const existing = await db
          .select()
          .from(organisationMemberships)
          .where(
            and(
              eq(organisationMemberships.organisationId, req.auth!.organisationId),
              eq(organisationMemberships.invitedEmail, normalizedEmail)
            )
          );
        if (existing.length > 0) {
          res.status(409).json({ error: 'User is already a member or invited to this organisation.' });
          return;
        }

        const [matchedUser] = await db
          .select()
          .from(users)
          .where(eq(users.email, normalizedEmail));

        const [created] = await db
          .insert(organisationMemberships)
          .values({
            organisationId: req.auth!.organisationId,
            userId: matchedUser?.id || null,
            invitedEmail: normalizedEmail,
            role,
            assignedInstallationIds: Array.isArray(assignedInstallationIds)
              ? assignedInstallationIds
              : [],
            status: matchedUser ? 'ACTIVE' : 'INVITED',
          })
          .returning();

        await recordAudit(req, 'MEMBER_INVITED', 'organisation_membership', created.id, {
          email: normalizedEmail,
          role,
        });
        res.status(201).json(created);
      } catch (error) {
        console.error('Invite member failed:', error);
        res.status(500).json({ error: 'Failed to invite user.' });
      }
    }
  );

  app.patch(
    '/api/v1/members/:id',
    requireAuth,
    requireRole(['Administrator']),
    async (req: AuthRequest, res) => {
      try {
        const memberId = String(req.params.id);
        const { role, assignedInstallationIds } = req.body as {
          role?: OrgRole;
          assignedInstallationIds?: string[];
        };
        const validRoles: OrgRole[] = ['Administrator', 'Operations Manager', 'Technician'];
        if (role !== undefined && !validRoles.includes(role)) {
          res.status(400).json({ error: 'Invalid role specified.' });
          return;
        }
        let validatedInstIds: string[] | undefined;
        if (Array.isArray(assignedInstallationIds)) {
          const orgInsts = await db
            .select({ id: solarInstallations.id })
            .from(solarInstallations)
            .where(eq(solarInstallations.organisationId, req.auth!.organisationId));
          const allowed = new Set(orgInsts.map((i) => i.id));
          validatedInstIds = assignedInstallationIds.filter((id) => allowed.has(String(id)));
        }
        const [updated] = await db
          .update(organisationMemberships)
          .set({
            ...(role ? { role } : {}),
            ...(validatedInstIds !== undefined ? { assignedInstallationIds: validatedInstIds } : {}),
          })
          .where(
            and(
              eq(organisationMemberships.id, memberId),
              eq(organisationMemberships.organisationId, req.auth!.organisationId)
            )
          )
          .returning();
        if (!updated) {
          res.status(404).json({ error: 'Membership not found.' });
          return;
        }
        await recordAudit(req, 'MEMBER_ROLE_UPDATED', 'organisation_membership', updated.id, {
          role: updated.role,
        });
        res.json(updated);
      } catch (error) {
        console.error('Update member failed:', error);
        res.status(500).json({ error: 'Failed to update member permissions.' });
      }
    }
  );

  // 3. Dashboard Overview (100% calculated from DB)
  app.get('/api/v1/dashboard', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const allInsts = await db
        .select()
        .from(solarInstallations)
        .where(eq(solarInstallations.organisationId, orgId))
        .orderBy(solarInstallations.name);

      const insts = filterInstallationsForRole(req, allInsts);
      const instIds = insts.map((i) => i.id);

      if (instIds.length === 0) {
        res.json({
          metrics: {
            totalInstallations: 0,
            totalCapacityKwp: 0,
            energyTodayKwh: 0,
            energyMonthKwh: 0,
            avgPortfolioPerformancePct: null,
            operatingCount: 0,
            abnormalCount: 0,
            activeAlertsCount: 0,
          },
          dailySeries: [],
          installationPerformance: [],
          statusBreakdown: [],
          recentActivity: [],
          simulatorStatus: (await getOrCreateSimulatorSession(orgId)).status,
        });
        return;
      }

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const monthPrefix = now.toISOString().slice(0, 7);

      const dailyRows = await db
        .select()
        .from(dailyEnergyAggregates)
        .where(
          and(
            eq(dailyEnergyAggregates.organisationId, orgId),
            inArray(dailyEnergyAggregates.installationId, instIds)
          )
        )
        .orderBy(dailyEnergyAggregates.localDate);

      const alertRows = await db
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.organisationId, orgId),
            inArray(alerts.installationId, instIds)
          )
        )
        .orderBy(desc(alerts.triggeredAt))
        .limit(40);

      const invRows = await db
        .select()
        .from(inverters)
        .where(
          and(
            eq(inverters.organisationId, orgId),
            inArray(inverters.installationId, instIds)
          )
        );

      const maintRows = await db
        .select()
        .from(maintenanceRecords)
        .where(
          and(
            eq(maintenanceRecords.organisationId, orgId),
            inArray(maintenanceRecords.installationId, instIds)
          )
        )
        .orderBy(desc(maintenanceRecords.performedAt))
        .limit(10);

      const simEvents = await db
        .select()
        .from(simulatorEvents)
        .where(eq(simulatorEvents.organisationId, orgId))
        .orderBy(desc(simulatorEvents.occurredAt))
        .limit(10);

      const totalCapacityKwp = insts.reduce((s, i) => s + i.installedCapacityKwp, 0);
      const energyTodayKwh = dailyRows
        .filter((d) => d.localDate === todayStr)
        .reduce((s, d) => s + d.energyKwh, 0);
      const energyMonthKwh = dailyRows
        .filter((d) => d.localDate.startsWith(monthPrefix))
        .reduce((s, d) => s + d.energyKwh, 0);

      // Portfolio performance ratio vs weather-adjusted expected energy over available daily records
      const totalActualAll = dailyRows.reduce((s, d) => s + d.energyKwh, 0);
      const totalExpectedAll = dailyRows.reduce((s, d) => s + (d.expectedEnergyKwh || 0), 0);
      const avgPortfolioPerformancePct =
        totalExpectedAll > 0
          ? Number(((totalActualAll / totalExpectedAll) * 100).toFixed(1))
          : null;

      const activeAlerts = alertRows.filter(
        (a) => a.status !== 'Resolved' && a.status !== 'Dismissed'
      );

      const operatingCount = insts.filter((i) => i.operationalStatus === 'Operational').length;
      const abnormalCount = insts.filter(
        (i) => i.isActive && i.operationalStatus !== 'Operational'
      ).length;

      // Aggregate daily generation chart series (last 30 days)
      const byDate = new Map<string, { date: string; actualKwh: number; expectedKwh: number }>();
      for (const d of dailyRows) {
        const cur = byDate.get(d.localDate) || {
          date: d.localDate,
          actualKwh: 0,
          expectedKwh: 0,
        };
        cur.actualKwh = Number((cur.actualKwh + d.energyKwh).toFixed(1));
        cur.expectedKwh = Number((cur.expectedKwh + (d.expectedEnergyKwh || 0)).toFixed(1));
        byDate.set(d.localDate, cur);
      }

      // Per-installation performance comparison
      const installationPerformance = insts.map((inst) => {
        const siteDaily = dailyRows.filter((d) => d.installationId === inst.id);
        const actual = siteDaily.reduce((s, d) => s + d.energyKwh, 0);
        const expected = siteDaily.reduce((s, d) => s + (d.expectedEnergyKwh || 0), 0);
        const siteInvs = invRows.filter((inv) => inv.installationId === inst.id);
        const onlineInvs = siteInvs.filter((inv) => inv.operatingStatus === 'ONLINE').length;
        const performancePct =
          expected > 0 ? Number(((actual / expected) * 100).toFixed(1)) : null;
        return {
          id: inst.id,
          name: inst.name,
          capacityKwp: inst.installedCapacityKwp,
          actualKwh: Number(actual.toFixed(1)),
          expectedKwh: Number(expected.toFixed(1)),
          performancePct,
          operationalStatus: inst.operationalStatus,
          onlineInverters: onlineInvs,
          totalInverters: siteInvs.length,
          flaggedUnderperforming: performancePct !== null && performancePct < 80,
        };
      });

      const statusCounts = {
        Operational: insts.filter((i) => i.operationalStatus === 'Operational').length,
        Underperforming: insts.filter((i) => i.operationalStatus === 'Underperforming').length,
        Offline: insts.filter((i) => i.operationalStatus === 'Offline').length,
        'Requires Investigation': insts.filter(
          (i) => i.operationalStatus === 'Requires Investigation'
        ).length,
      };
      const statusBreakdown = Object.entries(statusCounts)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => ({ status, count }));

      const instNameMap = new Map(insts.map((i) => [i.id, i.name]));
      const recentActivity = [
        ...alertRows.slice(0, 6).map((a) => ({
          id: `alert-${a.id}`,
          type: 'Alert',
          title: a.title,
          detail: `${instNameMap.get(a.installationId) || 'Site'} · ${a.severity} · ${a.status}`,
          timestamp: a.triggeredAt,
        })),
        ...maintRows.slice(0, 4).map((m) => ({
          id: `maint-${m.id}`,
          type: 'Maintenance',
          title: `${m.recordType} completed`,
          detail: `${instNameMap.get(m.installationId) || 'Site'} · ${m.workPerformed.slice(0, 72)}`,
          timestamp: m.performedAt,
        })),
        ...simEvents.slice(0, 3).map((e) => ({
          id: `sim-${e.id}`,
          type: 'Equipment/Simulator',
          title: e.eventType.replace(/_/g, ' '),
          detail: e.installationId ? instNameMap.get(e.installationId) || 'Portfolio' : 'Portfolio',
          timestamp: e.occurredAt,
        })),
      ]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 12);

      const session = await getOrCreateSimulatorSession(orgId);

      res.json({
        metrics: {
          totalInstallations: insts.length,
          totalCapacityKwp: Number(totalCapacityKwp.toFixed(1)),
          energyTodayKwh: Number(energyTodayKwh.toFixed(1)),
          energyMonthKwh: Number(energyMonthKwh.toFixed(1)),
          avgPortfolioPerformancePct,
          operatingCount,
          abnormalCount,
          activeAlertsCount: activeAlerts.length,
        },
        dailySeries: Array.from(byDate.values()).slice(-30),
        installationPerformance,
        statusBreakdown,
        recentActivity,
        simulatorStatus: session.status,
      });
    } catch (error) {
      console.error('Error in /dashboard:', error);
      res.status(500).json({ error: 'Failed to load dashboard metrics.' });
    }
  });

  // 4. Solar Installations Management
  app.get('/api/v1/installations', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rows = await db
        .select()
        .from(solarInstallations)
        .where(eq(solarInstallations.organisationId, req.auth!.organisationId))
        .orderBy(solarInstallations.name);
      res.json(filterInstallationsForRole(req, rows));
    } catch (error) {
      console.error('List installations failed:', error);
      res.status(500).json({ error: 'Failed to load installations.' });
    }
  });

  app.get('/api/v1/installations/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const instId = String(req.params.id);
      const [inst] = await db
        .select()
        .from(solarInstallations)
        .where(
          and(
            eq(solarInstallations.organisationId, req.auth!.organisationId),
            eq(solarInstallations.id, instId)
          )
        );
      if (!inst) {
        res.status(404).json({ error: 'Installation not found.' });
        return;
      }
      if (
        req.auth!.role === 'Technician' &&
        req.auth!.assignedInstallationIds.length > 0 &&
        !req.auth!.assignedInstallationIds.includes(inst.id)
      ) {
        res.status(403).json({ error: 'You do not have access to this installation.' });
        return;
      }

      const invRows = await db
        .select()
        .from(inverters)
        .where(
          and(
            eq(inverters.organisationId, req.auth!.organisationId),
            eq(inverters.installationId, inst.id)
          )
        )
        .orderBy(inverters.inverterCode);

      const dailyRows = await db
        .select()
        .from(dailyEnergyAggregates)
        .where(
          and(
            eq(dailyEnergyAggregates.organisationId, req.auth!.organisationId),
            eq(dailyEnergyAggregates.installationId, inst.id)
          )
        )
        .orderBy(dailyEnergyAggregates.localDate);

      const forecastRows = await db
        .select()
        .from(forecasts)
        .where(
          and(
            eq(forecasts.organisationId, req.auth!.organisationId),
            eq(forecasts.installationId, inst.id)
          )
        )
        .orderBy(forecasts.targetTimestamp);

      const alertRows = await db
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.organisationId, req.auth!.organisationId),
            eq(alerts.installationId, inst.id)
          )
        )
        .orderBy(desc(alerts.triggeredAt));

      const anomalyRows = await db
        .select()
        .from(performanceAnomalies)
        .where(
          and(
            eq(performanceAnomalies.organisationId, req.auth!.organisationId),
            eq(performanceAnomalies.installationId, inst.id)
          )
        )
        .orderBy(desc(performanceAnomalies.detectedAt));

      const maintRows = await db
        .select()
        .from(maintenanceRecords)
        .where(
          and(
            eq(maintenanceRecords.organisationId, req.auth!.organisationId),
            eq(maintenanceRecords.installationId, inst.id)
          )
        )
        .orderBy(desc(maintenanceRecords.performedAt));

      res.json({
        installation: inst,
        inverters: invRows,
        dailyEnergy: dailyRows,
        forecasts: forecastRows,
        alerts: alertRows,
        anomalies: anomalyRows,
        maintenanceRecords: maintRows,
      });
    } catch (error) {
      console.error('Get installation profile failed:', error);
      res.status(500).json({ error: 'Failed to load installation profile.' });
    }
  });

  app.post(
    '/api/v1/installations',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      try {
        const b = req.body as Record<string, unknown>;
        if (!b.name || !b.installationCode || !b.siteAddress || !b.cityState || !b.installedCapacityKwp) {
          res.status(400).json({ error: 'Missing required installation fields.' });
          return;
        }
        const capacity = Number(b.installedCapacityKwp);
        const invCount = Math.max(1, Number(b.inverterCount || 1));
        if (Number.isNaN(capacity) || capacity <= 0) {
          res.status(400).json({ error: 'Installed capacity must be a positive number.' });
          return;
        }

        const created = await db.transaction(async (tx) => {
          const [inst] = await tx
            .insert(solarInstallations)
            .values({
              organisationId: req.auth!.organisationId,
              installationCode: String(b.installationCode).trim(),
              name: String(b.name).trim(),
              siteAddress: String(b.siteAddress).trim(),
              cityState: String(b.cityState).trim(),
              latitude: b.latitude !== undefined && b.latitude !== '' ? Number(b.latitude) : 22.57,
              longitude: b.longitude !== undefined && b.longitude !== '' ? Number(b.longitude) : 88.36,
              timezone: String(b.timezone || 'Asia/Kolkata'),
              installationType: String(b.installationType || 'Commercial Rooftop'),
              installedCapacityKwp: capacity,
              commissioningDate: String(b.commissioningDate || new Date().toISOString().slice(0, 10)),
              panelManufacturer: String(b.panelManufacturer || 'Generic Solar'),
              panelModel: String(b.panelModel || '540W Mono PERC'),
              inverterManufacturer: String(b.inverterManufacturer || 'Sungrow'),
              inverterModel: String(b.inverterModel || 'SG50CX'),
              inverterCount: invCount,
              panelOrientation: String(b.panelOrientation || 'South (180°)'),
              panelTiltDeg: Number(b.panelTiltDeg ?? 20),
              shadingFactor: Number(b.shadingFactor ?? 1.0),
              shadingNotes: String(b.shadingNotes || 'Minimal shading'),
              performanceRatio: Number(b.performanceRatio ?? 0.82),
              tempCoefficient: Number(b.tempCoefficient ?? -0.004),
              operationalStatus: String(b.operationalStatus || 'Operational'),
              operationalGroup: String(b.operationalGroup || 'Default Portfolio'),
              isActive: true,
            })
            .returning();

          const perInvCap = Number((capacity / invCount).toFixed(2));
          const invValues = [];
          for (let i = 1; i <= invCount; i += 1) {
            invValues.push({
              organisationId: req.auth!.organisationId,
              installationId: inst.id,
              inverterCode: `${inst.installationCode}-INV-${String(i).padStart(2, '0')}`,
              name: `${inst.name} Inverter ${i}`,
              manufacturer: inst.inverterManufacturer,
              model: inst.inverterModel,
              ratedCapacityKw: perInvCap,
              dcCapacityKwp: perInvCap,
              operatingStatus: 'ONLINE',
            });
          }
          await tx.insert(inverters).values(invValues);
          return inst;
        });

        await recordAudit(req, 'INSTALLATION_CREATED', 'solar_installation', created.id, {
          name: created.name,
          capacityKwp: created.installedCapacityKwp,
        });
        res.status(201).json(created);
      } catch (error) {
        console.error('Create installation failed:', error);
        res.status(500).json({ error: 'Failed to create solar installation (check duplicate code).' });
      }
    }
  );

  app.patch(
    '/api/v1/installations/:id',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      try {
        const instId = String(req.params.id);
        const b = req.body as Record<string, unknown>;
        const [updated] = await db
          .update(solarInstallations)
          .set({
            ...(b.name !== undefined ? { name: String(b.name) } : {}),
            ...(b.siteAddress !== undefined ? { siteAddress: String(b.siteAddress) } : {}),
            ...(b.cityState !== undefined ? { cityState: String(b.cityState) } : {}),
            ...(b.operationalStatus !== undefined
              ? { operationalStatus: String(b.operationalStatus) }
              : {}),
            ...(b.operationalGroup !== undefined
              ? { operationalGroup: String(b.operationalGroup) }
              : {}),
            ...(b.performanceRatio !== undefined
              ? { performanceRatio: Number(b.performanceRatio) }
              : {}),
            ...(b.shadingFactor !== undefined ? { shadingFactor: Number(b.shadingFactor) } : {}),
            ...(b.shadingNotes !== undefined ? { shadingNotes: String(b.shadingNotes) } : {}),
            ...(b.isActive !== undefined ? { isActive: Boolean(b.isActive) } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(solarInstallations.id, instId),
              eq(solarInstallations.organisationId, req.auth!.organisationId)
            )
          )
          .returning();

        if (!updated) {
          res.status(404).json({ error: 'Installation not found.' });
          return;
        }
        await recordAudit(req, 'INSTALLATION_UPDATED', 'solar_installation', updated.id);
        res.json(updated);
      } catch (error) {
        console.error('Update installation failed:', error);
        res.status(500).json({ error: 'Failed to update installation.' });
      }
    }
  );

  // 5. Inverters & Telemetry Endpoints (Section 26)
  app.get('/api/v1/inverters', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const installationId =
        typeof req.query.installationId === 'string' ? req.query.installationId : undefined;

      const invRows = await db
        .select()
        .from(inverters)
        .where(
          and(
            eq(inverters.organisationId, orgId),
            ...(installationId ? [eq(inverters.installationId, installationId)] : [])
          )
        )
        .orderBy(inverters.inverterCode);

      const instRows = await db
        .select()
        .from(solarInstallations)
        .where(eq(solarInstallations.organisationId, orgId));
      const allowedInsts = new Set(filterInstallationsForRole(req, instRows).map((i) => i.id));
      const instMap = new Map(instRows.map((i) => [i.id, i]));

      const latestReadings = await db
        .select()
        .from(telemetryReadings)
        .where(eq(telemetryReadings.organisationId, orgId))
        .orderBy(desc(telemetryReadings.measuredAt))
        .limit(400);

      const latestMap = new Map<string, typeof telemetryReadings.$inferSelect>();
      for (const r of latestReadings) {
        if (!latestMap.has(r.inverterId)) {
          latestMap.set(r.inverterId, r);
        }
      }

      const enriched = invRows
        .filter((inv) => allowedInsts.has(inv.installationId))
        .map((inv) => ({
          ...inv,
          installationName: instMap.get(inv.installationId)?.name || 'Unknown',
          installationTimezone: instMap.get(inv.installationId)?.timezone || 'Asia/Kolkata',
          latestReading: latestMap.get(inv.id) || null,
        }));

      res.json(enriched);
    } catch (error) {
      console.error('List inverters failed:', error);
      res.status(500).json({ error: 'Failed to load inverter fleet.' });
    }
  });

  app.get('/api/v1/telemetry/latest', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const rows = await db
        .select()
        .from(telemetryReadings)
        .where(eq(telemetryReadings.organisationId, orgId))
        .orderBy(desc(telemetryReadings.measuredAt))
        .limit(200);
      const seen = new Set<string>();
      const latest = [];
      for (const r of rows) {
        if (!seen.has(r.inverterId)) {
          seen.add(r.inverterId);
          latest.push(r);
        }
      }
      res.json({ success: true, count: latest.length, readings: latest });
    } catch (error) {
      console.error('Latest telemetry failed:', error);
      res.status(500).json({ error: 'Failed to fetch latest telemetry.' });
    }
  });

  app.get('/api/v1/telemetry', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const installationId =
        typeof req.query.installationId === 'string' ? req.query.installationId : undefined;
      const inverterId =
        typeof req.query.inverterId === 'string' ? req.query.inverterId : undefined;
      const limit = Math.min(500, Math.max(10, Number(req.query.limit || 100)));

      const rows = await db
        .select()
        .from(telemetryReadings)
        .where(
          and(
            eq(telemetryReadings.organisationId, orgId),
            ...(installationId ? [eq(telemetryReadings.installationId, installationId)] : []),
            ...(inverterId ? [eq(telemetryReadings.inverterId, inverterId)] : [])
          )
        )
        .orderBy(desc(telemetryReadings.measuredAt))
        .limit(limit);

      res.json({ success: true, count: rows.length, readings: rows });
    } catch (error) {
      console.error('Retrieve telemetry failed:', error);
      res.status(500).json({ error: 'Failed to fetch telemetry history.' });
    }
  });

  app.post(
    '/api/v1/telemetry/ingest',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      const requestId = crypto.randomUUID();
      try {
        const orgId = req.auth!.organisationId;
        const payload = req.body as {
          records?: Array<Record<string, unknown>>;
        };
        const records = Array.isArray(payload.records) ? payload.records : [];
        if (records.length === 0) {
          res.status(400).json({
            success: false,
            acceptedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            validationErrors: ['records array is required and must be non-empty.'],
            requestId,
          });
          return;
        }

        const orgInsts = await db
          .select()
          .from(solarInstallations)
          .where(eq(solarInstallations.organisationId, orgId));
        const orgInvs = await db
          .select()
          .from(inverters)
          .where(eq(inverters.organisationId, orgId));
        const instMap = new Map(orgInsts.map((i) => [i.id, i]));
        const invMap = new Map(orgInvs.map((i) => [i.id, i]));

        let [simSource] = await db
          .select()
          .from(dataSources)
          .where(eq(dataSources.organisationId, orgId))
          .limit(1);
        if (!simSource) {
          [simSource] = await db
            .insert(dataSources)
            .values({
              organisationId: orgId,
              name: 'Internal Physics Telemetry Simulator',
              sourceType: 'SIMULATED',
              provider: 'Solar Intelligence Simulator',
              connectionStatus: 'OPERATIONAL',
              pollingIntervalSec: 60,
            })
            .returning();
        }

        let acceptedCount = 0;
        let rejectedCount = 0;
        let duplicateCount = 0;
        const validationErrors: string[] = [];

        for (let idx = 0; idx < records.length; idx += 1) {
          const r = records[idx];
          const instId = String(r.installationId || '');
          const invId = String(r.inverterId || '');
          const inst = instMap.get(instId);
          const inv = invMap.get(invId);
          if (!inst || !inv || inv.installationId !== inst.id) {
            rejectedCount += 1;
            validationErrors.push(`Record ${idx + 1}: Invalid installationId or inverterId ownership.`);
            continue;
          }
          const ts = new Date(String(r.measuredAt || ''));
          if (Number.isNaN(ts.getTime()) || ts.getTime() > Date.now() + 15 * 60000) {
            rejectedCount += 1;
            validationErrors.push(`Record ${idx + 1}: Invalid or future measuredAt timestamp.`);
            continue;
          }
          const acPower = r.acPowerKw !== undefined && r.acPowerKw !== null ? Number(r.acPowerKw) : null;
          if (acPower !== null && (Number.isNaN(acPower) || acPower < 0 || acPower > inv.ratedCapacityKw * 1.15)) {
            rejectedCount += 1;
            validationErrors.push(`Record ${idx + 1}: acPowerKw outside valid physical bounds.`);
            continue;
          }

          const inserted = await db
            .insert(telemetryReadings)
            .values({
              organisationId: orgId,
              installationId: inst.id,
              inverterId: inv.id,
              dataSourceId: simSource.id,
              sourceType: String(r.sourceType || 'SIMULATED'),
              measuredAt: ts,
              receivedAt: new Date(),
              acPowerKw: acPower,
              dcPowerKw: r.dcPowerKw !== undefined ? Number(r.dcPowerKw) : null,
              dailyEnergyKwh: r.dailyEnergyKwh !== undefined ? Number(r.dailyEnergyKwh) : null,
              cumulativeEnergyKwh:
                r.cumulativeEnergyKwh !== undefined ? Number(r.cumulativeEnergyKwh) : null,
              voltageV: r.voltageV !== undefined ? Number(r.voltageV) : null,
              currentA: r.currentA !== undefined ? Number(r.currentA) : null,
              temperatureC: r.temperatureC !== undefined ? Number(r.temperatureC) : null,
              operatingStatus: String(r.operatingStatus || 'ONLINE'),
              faultCode: r.faultCode ? String(r.faultCode) : null,
              qualityStatus: 'VALID',
              qualityFlags: [],
            })
            .onConflictDoNothing()
            .returning();

          if (inserted.length === 0) {
            duplicateCount += 1;
          } else {
            acceptedCount += 1;
          }
        }

        res.json({
          success: rejectedCount === 0,
          acceptedCount,
          rejectedCount,
          duplicateCount,
          validationErrors,
          requestId,
        });
      } catch (error) {
        console.error('Telemetry ingest failed:', error);
        res.status(500).json({
          success: false,
          acceptedCount: 0,
          rejectedCount: 0,
          duplicateCount: 0,
          validationErrors: ['Internal ingestion failure.'],
          requestId,
        });
      }
    }
  );

  // 6. Energy Generation Analytics
  app.get('/api/v1/analytics', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const installationId =
        typeof req.query.installationId === 'string' && req.query.installationId !== 'ALL'
          ? req.query.installationId
          : undefined;
      const inverterId =
        typeof req.query.inverterId === 'string' && req.query.inverterId !== 'ALL'
          ? req.query.inverterId
          : undefined;
      const granularity =
        typeof req.query.granularity === 'string' ? req.query.granularity : 'daily';
      const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));

      const allInsts = await db
        .select()
        .from(solarInstallations)
        .where(eq(solarInstallations.organisationId, orgId));
      const insts = filterInstallationsForRole(req, allInsts);
      const selectedInsts = installationId
        ? insts.filter((i) => i.id === installationId)
        : insts;
      const selectedIds = selectedInsts.map((i) => i.id);

      if (selectedIds.length === 0) {
        res.json({
          summary: {
            totalActualKwh: 0,
            totalExpectedKwh: 0,
            installedCapacityKwp: 0,
            capacityFactorPct: null,
            missingIntervalsCount: 0,
          },
          series: [],
        });
        return;
      }

      const startDt = new Date(Date.now() - days * 86400000);
      const startStr = startDt.toISOString().slice(0, 10);
      const installedCapacityKwp = selectedInsts.reduce((s, i) => s + i.installedCapacityKwp, 0);

      // Forecast series for overlay
      const forecastRows = await db
        .select()
        .from(forecasts)
        .where(
          and(
            eq(forecasts.organisationId, orgId),
            inArray(forecasts.installationId, selectedIds)
          )
        );

      if (granularity === 'hourly') {
        if (inverterId) {
          const rawInv = await db
            .select()
            .from(telemetryReadings)
            .where(
              and(
                eq(telemetryReadings.organisationId, orgId),
                eq(telemetryReadings.inverterId, inverterId),
                gte(telemetryReadings.measuredAt, startDt)
              )
            )
            .orderBy(telemetryReadings.measuredAt);

          const byHour = new Map<
            string,
            { label: string; actualKwh: number; expectedKwh: number; forecastKwh: number | null }
          >();
          for (const r of rawInv) {
            const key = r.measuredAt.toISOString().slice(0, 13) + ':00';
            const cur = byHour.get(key) || {
              label: key,
              actualKwh: 0,
              expectedKwh: 0,
              forecastKwh: null,
            };
            cur.actualKwh = Number(((cur.actualKwh + (r.acPowerKw || 0)) / (cur.actualKwh > 0 ? 2 : 1)).toFixed(2));
            byHour.set(key, cur);
          }
          const series = Array.from(byHour.values()).slice(-72);
          const totalActual = series.reduce((s, p) => s + p.actualKwh, 0);
          res.json({
            summary: {
              totalActualKwh: Number(totalActual.toFixed(1)),
              totalExpectedKwh: 0,
              installedCapacityKwp,
              capacityFactorPct: null,
              missingIntervalsCount: 0,
            },
            series,
          });
          return;
        }

        const hourlyRows = await db
          .select()
          .from(hourlyEnergyAggregates)
          .where(
            and(
              eq(hourlyEnergyAggregates.organisationId, orgId),
              inArray(hourlyEnergyAggregates.installationId, selectedIds),
              gte(hourlyEnergyAggregates.hourStart, startDt)
            )
          )
          .orderBy(hourlyEnergyAggregates.hourStart);

        const byHour = new Map<
          string,
          { label: string; actualKwh: number; expectedKwh: number; forecastKwh: number | null; irradianceWm2: number }
        >();
        for (const h of hourlyRows) {
          const label = h.hourStart.toISOString().slice(0, 13) + ':00';
          const cur = byHour.get(label) || {
            label,
            actualKwh: 0,
            expectedKwh: 0,
            forecastKwh: null,
            irradianceWm2: 0,
          };
          cur.actualKwh = Number((cur.actualKwh + h.integratedEnergyKwh).toFixed(2));
          cur.expectedKwh = Number((cur.expectedKwh + (h.expectedEnergyKwh || 0)).toFixed(2));
          cur.irradianceWm2 = h.avgIrradianceWm2 || 0;
          byHour.set(label, cur);
        }

        for (const f of forecastRows.filter((f) => f.horizonType === 'HOURLY')) {
          const label = f.targetTimestamp.toISOString().slice(0, 13) + ':00';
          const cur = byHour.get(label) || {
            label,
            actualKwh: 0,
            expectedKwh: 0,
            forecastKwh: 0,
            irradianceWm2: 0,
          };
          cur.forecastKwh = Number(((cur.forecastKwh || 0) + f.expectedEnergyKwh).toFixed(2));
          byHour.set(label, cur);
        }

        const series = Array.from(byHour.values())
          .sort((a, b) => a.label.localeCompare(b.label))
          .slice(-96);

        const totalActualKwh = hourlyRows.reduce((s, r) => s + r.integratedEnergyKwh, 0);
        const totalExpectedKwh = hourlyRows.reduce((s, r) => s + (r.expectedEnergyKwh || 0), 0);
        const hoursCount = Math.max(1, byHour.size);
        const capacityFactorPct =
          installedCapacityKwp > 0
            ? Number(((totalActualKwh / (installedCapacityKwp * hoursCount)) * 100).toFixed(1))
            : null;

        res.json({
          summary: {
            totalActualKwh: Number(totalActualKwh.toFixed(1)),
            totalExpectedKwh: Number(totalExpectedKwh.toFixed(1)),
            installedCapacityKwp,
            capacityFactorPct,
            missingIntervalsCount: hourlyRows.reduce((s, r) => s + r.missingIntervalsCount, 0),
          },
          series,
        });
        return;
      }

      // Daily / Weekly / Monthly / Annual rollups from dailyEnergyAggregates
      const dailyRows = await db
        .select()
        .from(dailyEnergyAggregates)
        .where(
          and(
            eq(dailyEnergyAggregates.organisationId, orgId),
            inArray(dailyEnergyAggregates.installationId, selectedIds),
            gte(dailyEnergyAggregates.localDate, startStr)
          )
        )
        .orderBy(dailyEnergyAggregates.localDate);

      const bucketMap = new Map<
        string,
        { label: string; actualKwh: number; expectedKwh: number; forecastKwh: number | null; completenessPct: number; count: number }
      >();

      for (const d of dailyRows) {
        let key = d.localDate;
        if (granularity === 'weekly') {
          const dt = new Date(`${d.localDate}T00:00:00Z`);
          const day = dt.getUTCDay();
          const monday = new Date(dt.getTime() - ((day + 6) % 7) * 86400000);
          key = `W-${monday.toISOString().slice(0, 10)}`;
        } else if (granularity === 'monthly') {
          key = d.localDate.slice(0, 7);
        } else if (granularity === 'annual') {
          key = d.localDate.slice(0, 4);
        }

        const cur = bucketMap.get(key) || {
          label: key,
          actualKwh: 0,
          expectedKwh: 0,
          forecastKwh: null,
          completenessPct: 0,
          count: 0,
        };
        cur.actualKwh = Number((cur.actualKwh + d.energyKwh).toFixed(1));
        cur.expectedKwh = Number((cur.expectedKwh + (d.expectedEnergyKwh || 0)).toFixed(1));
        cur.completenessPct += d.dataCompletenessPct;
        cur.count += 1;
        bucketMap.set(key, cur);
      }

      if (granularity === 'daily') {
        for (const f of forecastRows.filter((f) => f.horizonType === 'DAILY')) {
          const key = f.targetTimestamp.toISOString().slice(0, 10);
          const cur = bucketMap.get(key) || {
            label: key,
            actualKwh: 0,
            expectedKwh: 0,
            forecastKwh: 0,
            completenessPct: 100,
            count: 1,
          };
          cur.forecastKwh = Number(((cur.forecastKwh || 0) + f.expectedEnergyKwh).toFixed(1));
          bucketMap.set(key, cur);
        }
      }

      const series = Array.from(bucketMap.values())
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((b) => ({
          label: b.label,
          actualKwh: b.actualKwh,
          expectedKwh: b.expectedKwh,
          forecastKwh: b.forecastKwh,
          completenessPct: Number((b.completenessPct / Math.max(1, b.count)).toFixed(1)),
        }));

      const totalActualKwh = dailyRows.reduce((s, d) => s + d.energyKwh, 0);
      const totalExpectedKwh = dailyRows.reduce((s, d) => s + (d.expectedEnergyKwh || 0), 0);
      const uniqueDays = new Set(dailyRows.map((d) => d.localDate)).size || 1;
      const capacityFactorPct =
        installedCapacityKwp > 0
          ? Number(((totalActualKwh / (installedCapacityKwp * uniqueDays * 24)) * 100).toFixed(1))
          : null;

      res.json({
        summary: {
          totalActualKwh: Number(totalActualKwh.toFixed(1)),
          totalExpectedKwh: Number(totalExpectedKwh.toFixed(1)),
          installedCapacityKwp,
          capacityFactorPct,
          missingIntervalsCount: dailyRows.filter((d) => d.dataCompletenessPct < 95).length,
        },
        series,
      });
    } catch (error) {
      console.error('Analytics query failed:', error);
      res.status(500).json({ error: 'Failed to compute analytics.' });
    }
  });

  // 7. Forecasting
  app.get('/api/v1/forecasts', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const installationId =
        typeof req.query.installationId === 'string' && req.query.installationId !== 'ALL'
          ? req.query.installationId
          : undefined;

      let rows = await db
        .select()
        .from(forecasts)
        .where(
          and(
            eq(forecasts.organisationId, orgId),
            ...(installationId ? [eq(forecasts.installationId, installationId)] : [])
          )
        )
        .orderBy(forecasts.targetTimestamp);

      if (rows.length === 0) {
        await generateForecastsForOrganisation(orgId, installationId);
        rows = await db
          .select()
          .from(forecasts)
          .where(
            and(
              eq(forecasts.organisationId, orgId),
              ...(installationId ? [eq(forecasts.installationId, installationId)] : [])
            )
          )
          .orderBy(forecasts.targetTimestamp);
      }

      res.json(rows);
    } catch (error) {
      console.error('Load forecasts failed:', error);
      res.status(500).json({ error: 'Failed to load forecasts.' });
    }
  });

  app.post(
    '/api/v1/forecasts/generate',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      try {
        const installationId =
          typeof req.body?.installationId === 'string' && req.body.installationId !== 'ALL'
            ? req.body.installationId
            : undefined;
        const result = await generateForecastsForOrganisation(
          req.auth!.organisationId,
          installationId
        );
        res.json(result);
      } catch (error) {
        console.error('Generate forecasts failed:', error);
        res.status(500).json({ error: 'Failed to generate forecasts.' });
      }
    }
  );

  // 8. Performance Anomalies & AI Maintenance Assessments
  app.get('/api/v1/anomalies', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const rows = await db
        .select()
        .from(performanceAnomalies)
        .where(eq(performanceAnomalies.organisationId, orgId))
        .orderBy(desc(performanceAnomalies.detectedAt));

      const insts = await db
        .select()
        .from(solarInstallations)
        .where(eq(solarInstallations.organisationId, orgId));
      const invs = await db
        .select()
        .from(inverters)
        .where(eq(inverters.organisationId, orgId));

      const instMap = new Map(insts.map((i) => [i.id, i.name]));
      const invMap = new Map(invs.map((i) => [i.id, i.inverterCode]));

      res.json(
        rows.map((r) => ({
          ...r,
          installationName: instMap.get(r.installationId) || 'Unknown',
          inverterCode: r.inverterId ? invMap.get(r.inverterId) || null : null,
        }))
      );
    } catch (error) {
      console.error('List anomalies failed:', error);
      res.status(500).json({ error: 'Failed to load performance anomalies.' });
    }
  });

  app.post(
    '/api/v1/anomalies/scan',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      try {
        const result = await runAnomalyDetectionForOrganisation(req.auth!.organisationId);
        res.json(result);
      } catch (error) {
        console.error('Anomaly scan failed:', error);
        res.status(500).json({ error: 'Failed to run anomaly detection scan.' });
      }
    }
  );

  app.post('/api/v1/anomalies/:id/assess', requireAuth, async (req: AuthRequest, res) => {
    try {
      const assessment = await generateMaintenanceAssessment(
        req.auth!.organisationId,
        String(req.params.id)
      );
      res.json(assessment);
    } catch (error) {
      console.error('Maintenance assessment failed:', error);
      res.status(500).json({ error: 'Failed to generate maintenance assessment.' });
    }
  });

  // 9. Alerts Management
  app.get('/api/v1/alerts', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const rows = await db
        .select()
        .from(alerts)
        .where(eq(alerts.organisationId, orgId))
        .orderBy(desc(alerts.triggeredAt));
      const insts = await db
        .select()
        .from(solarInstallations)
        .where(eq(solarInstallations.organisationId, orgId));
      const invs = await db
        .select()
        .from(inverters)
        .where(eq(inverters.organisationId, orgId));
      const instMap = new Map(insts.map((i) => [i.id, i.name]));
      const invMap = new Map(invs.map((i) => [i.id, i.inverterCode]));

      res.json(
        rows.map((a) => ({
          ...a,
          installationName: instMap.get(a.installationId) || 'Unknown',
          inverterCode: a.inverterId ? invMap.get(a.inverterId) || null : null,
        }))
      );
    } catch (error) {
      console.error('List alerts failed:', error);
      res.status(500).json({ error: 'Failed to load alerts.' });
    }
  });

  app.patch('/api/v1/alerts/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const alertId = String(req.params.id);
      const { status, assignToSelf } = req.body as {
        status?: 'New' | 'Acknowledged' | 'Under Investigation' | 'Resolved' | 'Dismissed';
        assignToSelf?: boolean;
      };
      const validAlertStatuses = ['New', 'Acknowledged', 'Under Investigation', 'Resolved', 'Dismissed'];
      if (status !== undefined && !validAlertStatuses.includes(status)) {
        res.status(400).json({ error: 'Invalid alert status.' });
        return;
      }
      const [updated] = await db
        .update(alerts)
        .set({
          ...(status ? { status } : {}),
          ...(assignToSelf ? { assignedToUserId: req.auth!.userId } : {}),
          ...(status === 'Resolved' ? { resolvedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(alerts.id, alertId),
            eq(alerts.organisationId, req.auth!.organisationId)
          )
        )
        .returning();
      if (!updated) {
        res.status(404).json({ error: 'Alert not found.' });
        return;
      }
      await recordAudit(req, 'ALERT_UPDATED', 'alert', updated.id, { status: updated.status });
      res.json(updated);
    } catch (error) {
      console.error('Update alert failed:', error);
      res.status(500).json({ error: 'Failed to update alert.' });
    }
  });

  // 10. Maintenance Tasks & Historical Records
  app.get('/api/v1/maintenance/tasks', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const rows = await db
        .select()
        .from(maintenanceTasks)
        .where(eq(maintenanceTasks.organisationId, orgId))
        .orderBy(desc(maintenanceTasks.createdAt));
      const insts = await db
        .select()
        .from(solarInstallations)
        .where(eq(solarInstallations.organisationId, orgId));
      const invs = await db
        .select()
        .from(inverters)
        .where(eq(inverters.organisationId, orgId));
      const instMap = new Map(insts.map((i) => [i.id, i.name]));
      const invMap = new Map(invs.map((i) => [i.id, i.inverterCode]));

      res.json(
        rows.map((t) => ({
          ...t,
          installationName: instMap.get(t.installationId) || 'Unknown',
          inverterCode: t.inverterId ? invMap.get(t.inverterId) || null : null,
        }))
      );
    } catch (error) {
      console.error('List maintenance tasks failed:', error);
      res.status(500).json({ error: 'Failed to load maintenance tasks.' });
    }
  });

  app.post('/api/v1/maintenance/tasks', requireAuth, async (req: AuthRequest, res) => {
    try {
      const b = req.body as Record<string, unknown>;
      if (!b.installationId || !b.title || !b.dueDate) {
        res.status(400).json({ error: 'installationId, title, and dueDate are required.' });
        return;
      }
      const installationId = String(b.installationId);
      const [ownedInst] = await db
        .select()
        .from(solarInstallations)
        .where(
          and(
            eq(solarInstallations.id, installationId),
            eq(solarInstallations.organisationId, req.auth!.organisationId)
          )
        );
      if (!ownedInst) {
        res.status(404).json({ error: 'Installation not found in active organisation.' });
        return;
      }
      if (
        req.auth!.role === 'Technician' &&
        req.auth!.assignedInstallationIds.length > 0 &&
        !req.auth!.assignedInstallationIds.includes(ownedInst.id)
      ) {
        res.status(403).json({ error: 'You do not have access to this installation.' });
        return;
      }
      let verifiedInverterId: string | null = null;
      if (b.inverterId) {
        const [ownedInv] = await db
          .select()
          .from(inverters)
          .where(
            and(
              eq(inverters.id, String(b.inverterId)),
              eq(inverters.installationId, ownedInst.id),
              eq(inverters.organisationId, req.auth!.organisationId)
            )
          );
        if (!ownedInv) {
          res.status(400).json({ error: 'Inverter does not belong to the specified installation.' });
          return;
        }
        verifiedInverterId = ownedInv.id;
      }

      const [created] = await db
        .insert(maintenanceTasks)
        .values({
          organisationId: req.auth!.organisationId,
          installationId: ownedInst.id,
          inverterId: verifiedInverterId,
          alertId: b.alertId ? String(b.alertId) : null,
          anomalyId: b.anomalyId ? String(b.anomalyId) : null,
          title: String(b.title).trim(),
          description: String(b.description || ''),
          priority: String(b.priority || 'Medium'),
          status: String(b.status || 'Open'),
          assignedToUserId: req.auth!.userId,
          assignedToName: String(b.assignedToName || req.auth!.displayName),
          dueDate: String(b.dueDate),
        })
        .returning();

      await recordAudit(req, 'MAINTENANCE_TASK_CREATED', 'maintenance_task', created.id);
      res.status(201).json(created);
    } catch (error) {
      console.error('Create maintenance task failed:', error);
      res.status(500).json({ error: 'Failed to create maintenance task.' });
    }
  });

  app.patch('/api/v1/maintenance/tasks/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const taskId = String(req.params.id);
      const b = req.body as {
        status?: string;
        inspectionFindings?: string;
        workPerformed?: string;
        attachmentNote?: string;
        partsReplaced?: string;
      };
      const validTaskStatuses = ['Open', 'In Progress', 'Completed', 'Cancelled'];
      if (b.status !== undefined && !validTaskStatuses.includes(b.status)) {
        res.status(400).json({ error: 'Invalid maintenance task status.' });
        return;
      }

      const [existing] = await db
        .select()
        .from(maintenanceTasks)
        .where(
          and(
            eq(maintenanceTasks.id, taskId),
            eq(maintenanceTasks.organisationId, req.auth!.organisationId)
          )
        );
      if (!existing) {
        res.status(404).json({ error: 'Maintenance task not found.' });
        return;
      }

      const completedNow = b.status === 'Completed' && existing.status !== 'Completed';

      const [updated] = await db
        .update(maintenanceTasks)
        .set({
          ...(b.status ? { status: b.status } : {}),
          ...(b.inspectionFindings !== undefined
            ? { inspectionFindings: b.inspectionFindings }
            : {}),
          ...(b.workPerformed !== undefined ? { workPerformed: b.workPerformed } : {}),
          ...(b.attachmentNote !== undefined ? { attachmentNote: b.attachmentNote } : {}),
          ...(completedNow ? { completedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(maintenanceTasks.id, taskId))
        .returning();

      if (completedNow) {
        await db.insert(maintenanceRecords).values({
          organisationId: req.auth!.organisationId,
          installationId: existing.installationId,
          inverterId: existing.inverterId,
          taskId: existing.id,
          performedByUserId: req.auth!.userId,
          performedByName: req.auth!.displayName,
          performedAt: new Date(),
          recordType: 'REPAIR',
          findings: b.inspectionFindings || existing.inspectionFindings || 'Field inspection completed.',
          workPerformed: b.workPerformed || existing.workPerformed || `Completed task: ${existing.title}`,
          partsReplaced: b.partsReplaced || null,
        });
      }

      await recordAudit(req, 'MAINTENANCE_TASK_UPDATED', 'maintenance_task', updated.id, {
        status: updated.status,
      });
      res.json(updated);
    } catch (error) {
      console.error('Update maintenance task failed:', error);
      res.status(500).json({ error: 'Failed to update maintenance task.' });
    }
  });

  app.get('/api/v1/maintenance/records', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const rows = await db
        .select()
        .from(maintenanceRecords)
        .where(eq(maintenanceRecords.organisationId, orgId))
        .orderBy(desc(maintenanceRecords.performedAt));
      const insts = await db
        .select()
        .from(solarInstallations)
        .where(eq(solarInstallations.organisationId, orgId));
      const invs = await db
        .select()
        .from(inverters)
        .where(eq(inverters.organisationId, orgId));
      const anomRows = await db
        .select()
        .from(performanceAnomalies)
        .where(eq(performanceAnomalies.organisationId, orgId));

      const instMap = new Map(insts.map((i) => [i.id, i.name]));
      const invMap = new Map(invs.map((i) => [i.id, i.inverterCode]));

      res.json(
        rows.map((r) => {
          const subsequentAnomalies = anomRows.filter(
            (a) =>
              a.installationId === r.installationId &&
              (r.inverterId ? a.inverterId === r.inverterId : true) &&
              new Date(a.detectedAt).getTime() > new Date(r.performedAt).getTime()
          ).length;
          return {
            ...r,
            installationName: instMap.get(r.installationId) || 'Unknown',
            inverterCode: r.inverterId ? invMap.get(r.inverterId) || null : null,
            repeatedIssuesSinceMaintenance: subsequentAnomalies,
          };
        })
      );
    } catch (error) {
      console.error('List maintenance records failed:', error);
      res.status(500).json({ error: 'Failed to load maintenance history.' });
    }
  });

  // 11. CSV Ingestion Endpoints (Section 26)
  app.get('/api/v1/imports/templates/:type', requireAuth, async (req: AuthRequest, res) => {
    const t = String(req.params.type).toUpperCase() as CsvTemplateType;
    if (!['INVERTER_TELEMETRY', 'DAILY_ENERGY', 'WEATHER'].includes(t)) {
      res.status(400).json({ error: 'Invalid CSV template type.' });
      return;
    }
    const [inst] = await db
      .select()
      .from(solarInstallations)
      .where(eq(solarInstallations.organisationId, req.auth!.organisationId))
      .limit(1);
    const [inv] = inst
      ? await db.select().from(inverters).where(eq(inverters.installationId, inst.id)).limit(1)
      : [undefined];

    const csv = generateCsvTemplateContent(t, inst?.id, inv?.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="template_${t.toLowerCase()}.csv"`);
    res.send(csv);
  });

  app.post(
    '/api/v1/imports/csv',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      try {
        const { templateType, filename, csvText, installationIdFilter, commit } = req.body as {
          templateType?: CsvTemplateType;
          filename?: string;
          csvText?: string;
          installationIdFilter?: string;
          commit?: boolean;
        };
        if (!templateType || !['INVERTER_TELEMETRY', 'DAILY_ENERGY', 'WEATHER'].includes(templateType)) {
          res.status(400).json({ error: 'templateType must be INVERTER_TELEMETRY, DAILY_ENERGY, or WEATHER.' });
          return;
        }
        if (!csvText) {
          res.status(400).json({ error: 'csvText is required.' });
          return;
        }
        const result = await processCsvImport({
          organisationId: req.auth!.organisationId,
          userId: req.auth!.userId,
          templateType,
          filename: filename || 'upload.csv',
          csvText,
          installationIdFilter:
            installationIdFilter && installationIdFilter !== 'ALL'
              ? installationIdFilter
              : undefined,
          commit: Boolean(commit),
        });
        if (commit && result.batchId) {
          await recordAudit(req, 'CSV_IMPORT_COMMITTED', 'telemetry_import_batch', result.batchId, {
            acceptedRows: result.validCount,
            rejectedRows: result.invalidCount,
            duplicateRows: result.duplicateCount,
          });
        }
        res.json(result);
      } catch (error: any) {
        console.error('CSV import failed:', error);
        res.status(400).json({ error: error.message || 'CSV import validation failed.' });
      }
    }
  );

  app.get('/api/v1/imports', requireAuth, async (req: AuthRequest, res) => {
    try {
      const batches = await listImportBatches(req.auth!.organisationId);
      res.json(batches);
    } catch (error) {
      console.error('List imports failed:', error);
      res.status(500).json({ error: 'Failed to load import history.' });
    }
  });

  app.get('/api/v1/imports/:id', requireAuth, async (req: AuthRequest, res) => {
    const [batch] = await db
      .select()
      .from(telemetryImportBatches)
      .where(
        and(
          eq(telemetryImportBatches.id, String(req.params.id)),
          eq(telemetryImportBatches.organisationId, req.auth!.organisationId)
        )
      );
    if (!batch) {
      res.status(404).json({ error: 'Import batch not found.' });
      return;
    }
    res.json(batch);
  });

  app.get('/api/v1/imports/:id/errors', requireAuth, async (req: AuthRequest, res) => {
    const errs = await db
      .select()
      .from(telemetryImportErrors)
      .where(
        and(
          eq(telemetryImportErrors.batchId, String(req.params.id)),
          eq(telemetryImportErrors.organisationId, req.auth!.organisationId)
        )
      )
      .orderBy(telemetryImportErrors.rowNumber);
    res.json(errs);
  });

  // 12. Simulator Controls (Section 26)
  app.get('/api/v1/simulator', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const session = await getOrCreateSimulatorSession(orgId);
      const events = await db
        .select()
        .from(simulatorEvents)
        .where(eq(simulatorEvents.organisationId, orgId))
        .orderBy(desc(simulatorEvents.occurredAt))
        .limit(20);
      const jobs = await db
        .select()
        .from(ingestionJobs)
        .where(eq(ingestionJobs.organisationId, orgId))
        .orderBy(desc(ingestionJobs.startedAt))
        .limit(10);
      res.json({ session, events, jobs });
    } catch (error) {
      console.error('Get simulator failed:', error);
      res.status(500).json({ error: 'Failed to load simulator state.' });
    }
  });

  app.post(
    '/api/v1/simulator/start',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      const intervalSeconds = req.body?.intervalSeconds ? Number(req.body.intervalSeconds) : undefined;
      const session = await setSimulatorState(req.auth!.organisationId, 'RUNNING', intervalSeconds);
      res.json(session);
    }
  );

  app.post(
    '/api/v1/simulator/pause',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      const session = await setSimulatorState(req.auth!.organisationId, 'PAUSED');
      res.json(session);
    }
  );

  app.post(
    '/api/v1/simulator/stop',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      const session = await setSimulatorState(req.auth!.organisationId, 'STOPPED');
      res.json(session);
    }
  );

  app.post(
    '/api/v1/simulator/generate',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      try {
        const solarHourOverride =
          req.body?.solarHourOverride !== undefined ? Number(req.body.solarHourOverride) : undefined;
        const result = await generateSimulationInterval(req.auth!.organisationId, {
          manual: true,
          solarHourOverride,
        });
        res.json(result);
      } catch (error) {
        console.error('Manual simulator tick failed:', error);
        res.status(500).json({ error: 'Failed to generate simulated interval.' });
      }
    }
  );

  app.post(
    '/api/v1/simulator/config',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      const { weatherMode, ambientTempC, intervalSeconds } = req.body as {
        weatherMode?: any;
        ambientTempC?: number;
        intervalSeconds?: number;
      };
      const session = await updateSimulatorEnvironment(req.auth!.organisationId, {
        weatherMode,
        ambientTempC: ambientTempC !== undefined ? Number(ambientTempC) : undefined,
        intervalSeconds: intervalSeconds !== undefined ? Number(intervalSeconds) : undefined,
      });
      res.json(session);
    }
  );

  app.post(
    '/api/v1/simulator/fault',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      try {
        const validActions = [
          'UNDERPERFORMANCE',
          'OVERHEATING',
          'OFFLINE',
          'ABNORMAL_VOLTAGE',
          'FAULT_CODE',
          'MISSING_TELEMETRY',
          'RESTORE_NORMAL',
        ];
        if (!req.body?.action || !validActions.includes(String(req.body.action))) {
          res.status(400).json({ error: 'Invalid fault simulation action.' });
          return;
        }
        const result = await triggerDemoFaultEvent(req.auth!.organisationId, req.body);
        res.json(result);
      } catch (error) {
        console.error('Inject fault failed:', error);
        res.status(500).json({ error: 'Failed to inject simulated fault event.' });
      }
    }
  );

  app.post(
    '/api/v1/simulator/restore',
    requireAuth,
    requireRole(['Administrator', 'Operations Manager']),
    async (req: AuthRequest, res) => {
      try {
        const result = await triggerDemoFaultEvent(req.auth!.organisationId, {
          action: 'RESTORE_NORMAL',
        });
        res.json(result);
      } catch (error) {
        console.error('Restore normal failed:', error);
        res.status(500).json({ error: 'Failed to restore normal simulation state.' });
      }
    }
  );

  // 13. Data Sources, Manufacturer Connectors & Gateways (Section 26, 27, 28, 29)
  app.get('/api/v1/data-sources', requireAuth, async (req: AuthRequest, res) => {
    try {
      const orgId = req.auth!.organisationId;
      const sources = await db
        .select()
        .from(dataSources)
        .where(eq(dataSources.organisationId, orgId))
        .orderBy(dataSources.sourceType, dataSources.name);
      const gateways = await db
        .select()
        .from(gatewayDevices)
        .where(eq(gatewayDevices.organisationId, orgId));
      const syncLogs = await db
        .select()
        .from(connectorSyncLogs)
        .where(eq(connectorSyncLogs.organisationId, orgId))
        .orderBy(desc(connectorSyncLogs.syncedAt))
        .limit(20);

      res.json({
        sources,
        gateways,
        syncLogs,
        weatherProvider: simulatedWeatherProvider.metadata,
        connectorSpecs: MANUFACTURER_CONNECTORS.map((c) => ({
          providerId: c.providerId,
          displayName: c.displayName,
          status: c.status,
          capabilities: c.capabilities,
        })),
      });
    } catch (error) {
      console.error('List data sources failed:', error);
      res.status(500).json({ error: 'Failed to load data sources.' });
    }
  });

  app.post(
    '/api/v1/data-sources/test',
    requireAuth,
    requireRole(['Administrator']),
    async (req: AuthRequest, res) => {
      try {
        const { dataSourceId } = req.body as { dataSourceId?: string };
        if (!dataSourceId) {
          res.status(400).json({ error: 'dataSourceId is required.' });
          return;
        }
        const [source] = await db
          .select()
          .from(dataSources)
          .where(
            and(
              eq(dataSources.id, dataSourceId),
              eq(dataSources.organisationId, req.auth!.organisationId)
            )
          );
        if (!source) {
          res.status(404).json({ error: 'Data source not found.' });
          return;
        }

        if (source.sourceType === 'SIMULATED' || source.sourceType === 'CSV_IMPORT') {
          await db.insert(connectorSyncLogs).values({
            organisationId: req.auth!.organisationId,
            dataSourceId: source.id,
            status: 'OPERATIONAL',
            recordsSynced: 0,
            message: `${source.name} verified operational.`,
          });
          res.json({
            connected: true,
            status: 'OPERATIONAL',
            message: `${source.name} is operational.`,
          });
          return;
        }

        const connector = MANUFACTURER_CONNECTORS.find((c) => c.providerId === source.provider);
        const testRes = connector
          ? await connector.testConnection()
          : {
              connected: false,
              status: 'NOT_YET_CONNECTED' as const,
              message: 'Provider integration is not yet connected in this release.',
            };

        await db.insert(connectorSyncLogs).values({
          organisationId: req.auth!.organisationId,
          dataSourceId: source.id,
          status: testRes.status,
          recordsSynced: 0,
          message: testRes.message,
        });

        res.json(testRes);
      } catch (error) {
        console.error('Test data source failed:', error);
        res.status(500).json({ error: 'Failed to test data source connection.' });
      }
    }
  );

  // 14. Reports & PDF Export
  app.get('/api/v1/reports/data', requireAuth, async (req: AuthRequest, res) => {
    try {
      const reportType = String(req.query.type || 'ENERGY').toUpperCase() as ReportType;
      if (!['ENERGY', 'PERFORMANCE', 'EQUIPMENT', 'MAINTENANCE'].includes(reportType)) {
        res.status(400).json({ error: 'Invalid report type.' });
        return;
      }
      const installationId =
        typeof req.query.installationId === 'string' && req.query.installationId !== 'ALL'
          ? req.query.installationId
          : undefined;
      const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
      const data = await generateReportData({
        organisationId: req.auth!.organisationId,
        reportType,
        installationId,
        days,
      });
      res.json(data);
    } catch (error) {
      console.error('Generate report data failed:', error);
      res.status(500).json({ error: 'Failed to generate report.' });
    }
  });

  app.get('/api/v1/reports/pdf', requireAuth, async (req: AuthRequest, res) => {
    try {
      const reportType = String(req.query.type || 'ENERGY').toUpperCase() as ReportType;
      if (!['ENERGY', 'PERFORMANCE', 'EQUIPMENT', 'MAINTENANCE'].includes(reportType)) {
        res.status(400).json({ error: 'Invalid report type.' });
        return;
      }
      const installationId =
        typeof req.query.installationId === 'string' && req.query.installationId !== 'ALL'
          ? req.query.installationId
          : undefined;
      const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
      const pdf = await renderReportPdfBuffer({
        organisationId: req.auth!.organisationId,
        reportType,
        installationId,
        days,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="solar_report_${reportType.toLowerCase()}.pdf"`
      );
      res.send(pdf);
    } catch (error) {
      console.error('PDF generation failed:', error);
      res.status(500).json({ error: 'Failed to generate PDF report.' });
    }
  });

  // 15. Grounded AI Assistant
  app.post('/api/v1/assistant/query', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { question } = req.body as { question?: string };
      if (!question || question.trim().length < 2) {
        res.status(400).json({ error: 'Please enter a question about your solar portfolio.' });
        return;
      }
      const result = await answerAssistantQuestion(req.auth!.organisationId, question.trim());
      res.json(result);
    } catch (error) {
      console.error('Assistant query failed:', error);
      res.status(500).json({ error: 'Failed to query solar intelligence assistant.' });
    }
  });

  // 16. Audit Logs
  app.get('/api/v1/audit-logs', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rows = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organisationId, req.auth!.organisationId))
        .orderBy(desc(auditLogs.createdAt))
        .limit(50);
      res.json(rows);
    } catch (error) {
      console.error('List audit logs failed:', error);
      res.status(500).json({ error: 'Failed to load audit logs.' });
    }
  });

  // Background Simulator Scheduler (guarded against overlapping runs; executes ONLY for RUNNING sessions)
  let schedulerBusy = false;
  const schedulerTimer = setInterval(async () => {
    if (schedulerBusy) return;
    schedulerBusy = true;
    try {
      const runningSessions = await db
        .select()
        .from(simulatorSessions)
        .where(eq(simulatorSessions.status, 'RUNNING'));

      const now = Date.now();
      for (const s of runningSessions) {
        const last = s.lastTickAt ? new Date(s.lastTickAt).getTime() : 0;
        if (now - last >= s.intervalSeconds * 1000) {
          await generateSimulationInterval(s.organisationId, { manual: false });
        }
      }
    } catch (err) {
      console.error('Background simulator scheduler error:', err);
    } finally {
      schedulerBusy = false;
    }
  }, 15000);

  schedulerTimer.unref();

  // Vite Dev Middleware or Static Production Build
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Solar Intelligence System listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
