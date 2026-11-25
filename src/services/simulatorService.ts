import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  dailyEnergyAggregates,
  dataSources,
  hourlyEnergyAggregates,
  ingestionJobs,
  inverters,
  simulatorEvents,
  simulatorSessions,
  solarInstallations,
  telemetryReadings,
  weatherReadings,
} from '../db/schema.ts';
import {
  createSeededRng,
  getLocalCalendarParts,
  hashSeed,
  integrateIntervalEnergyKwh,
  simulateInverterTelemetryPoint,
  type WeatherCondition,
} from './solarPhysics.ts';
import { runAnomalyDetectionForOrganisation } from './intelligenceService.ts';

export async function getOrCreateSimulatorSession(organisationId: string) {
  const existing = await db
    .select()
    .from(simulatorSessions)
    .where(eq(simulatorSessions.organisationId, organisationId));
  if (existing.length > 0) return existing[0];

  const [created] = await db
    .insert(simulatorSessions)
    .values({
      organisationId,
      status: 'PAUSED',
      intervalSeconds: 60,
      weatherMode: 'Clear',
      ambientTempC: 31,
      randomSeed: 202611,
      simulationStartAt: new Date(),
      activeFaultsJson: {},
    })
    .returning();
  return created;
}

export async function setSimulatorState(
  organisationId: string,
  status: 'RUNNING' | 'PAUSED' | 'STOPPED',
  intervalSeconds?: number
) {
  const session = await getOrCreateSimulatorSession(organisationId);
  const now = new Date();

  const [updated] = await db
    .update(simulatorSessions)
    .set({
      status,
      ...(intervalSeconds ? { intervalSeconds } : {}),
      ...(status === 'RUNNING' && session.status === 'STOPPED'
        ? { simulationStartAt: now }
        : {}),
      updatedAt: now,
    })
    .where(eq(simulatorSessions.id, session.id))
    .returning();

  await db.insert(simulatorEvents).values({
    organisationId,
    sessionId: session.id,
    eventType: `SIMULATOR_${status}`,
    detailsJson: {
      previousStatus: session.status,
      newStatus: status,
      intervalSeconds: updated.intervalSeconds,
    },
    occurredAt: now,
  });

  return updated;
}

export async function updateSimulatorEnvironment(
  organisationId: string,
  params: { weatherMode?: WeatherCondition; ambientTempC?: number; intervalSeconds?: number }
) {
  const session = await getOrCreateSimulatorSession(organisationId);
  const now = new Date();
  const [updated] = await db
    .update(simulatorSessions)
    .set({
      ...(params.weatherMode ? { weatherMode: params.weatherMode } : {}),
      ...(params.ambientTempC !== undefined ? { ambientTempC: params.ambientTempC } : {}),
      ...(params.intervalSeconds ? { intervalSeconds: params.intervalSeconds } : {}),
      updatedAt: now,
    })
    .where(eq(simulatorSessions.id, session.id))
    .returning();

  await db.insert(simulatorEvents).values({
    organisationId,
    sessionId: session.id,
    eventType: 'WEATHER_OR_CONFIG_UPDATED',
    detailsJson: params as Record<string, unknown>,
    occurredAt: now,
  });

  return updated;
}

export async function triggerDemoFaultEvent(
  organisationId: string,
  params: {
    action:
      | 'UNDERPERFORMANCE'
      | 'OVERHEATING'
      | 'OFFLINE'
      | 'ABNORMAL_VOLTAGE'
      | 'FAULT_CODE'
      | 'MISSING_TELEMETRY'
      | 'RESTORE_NORMAL';
    installationId?: string;
    inverterId?: string;
  }
) {
  const session = await getOrCreateSimulatorSession(organisationId);
  const now = new Date();
  const currentFaults = { ...(session.activeFaultsJson || {}) };

  if (params.action === 'RESTORE_NORMAL') {
    await db
      .update(simulatorSessions)
      .set({ activeFaultsJson: {}, weatherMode: 'Clear', updatedAt: now })
      .where(eq(simulatorSessions.id, session.id));

    await db
      .update(inverters)
      .set({ operatingStatus: 'ONLINE', faultCode: null })
      .where(eq(inverters.organisationId, organisationId));

    await db
      .update(solarInstallations)
      .set({ operationalStatus: 'Operational', updatedAt: now })
      .where(eq(solarInstallations.organisationId, organisationId));

    await db.insert(simulatorEvents).values({
      organisationId,
      sessionId: session.id,
      eventType: 'RESTORE_NORMAL_OPERATION',
      detailsJson: {},
      occurredAt: now,
    });
  } else {
    let verifiedInstId: string | null = null;
    let verifiedInvId: string | null = null;

    if (params.installationId) {
      const [inst] = await db
        .select({ id: solarInstallations.id })
        .from(solarInstallations)
        .where(
          and(
            eq(solarInstallations.id, params.installationId),
            eq(solarInstallations.organisationId, organisationId)
          )
        );
      if (inst) verifiedInstId = inst.id;
    }

    if (params.inverterId) {
      const [inv] = await db
        .select({ id: inverters.id, installationId: inverters.installationId })
        .from(inverters)
        .where(
          and(
            eq(inverters.id, params.inverterId),
            eq(inverters.organisationId, organisationId)
          )
        );
      if (inv) {
        verifiedInvId = inv.id;
        if (!verifiedInstId) verifiedInstId = inv.installationId;
      }
    }

    const targetKey = verifiedInvId || verifiedInstId;
    if (targetKey) {
      if (params.action === 'UNDERPERFORMANCE') {
        currentFaults[targetKey] = { underperformanceFactor: 0.52 };
        if (verifiedInstId) {
          await db
            .update(solarInstallations)
            .set({ operationalStatus: 'Underperforming', updatedAt: now })
            .where(
              and(
                eq(solarInstallations.organisationId, organisationId),
                eq(solarInstallations.id, verifiedInstId)
              )
            );
        }
      } else if (params.action === 'OVERHEATING') {
        currentFaults[targetKey] = { overheatDeltaC: 38, faultCode: 'ERR-TEMP-402' };
      } else if (params.action === 'OFFLINE') {
        currentFaults[targetKey] = { offline: true, faultCode: 'ERR-COMM-108' };
      } else if (params.action === 'ABNORMAL_VOLTAGE') {
        currentFaults[targetKey] = { abnormalVoltageV: 488 };
      } else if (params.action === 'FAULT_CODE') {
        currentFaults[targetKey] = { faultCode: 'ERR-INV-504', offline: true };
      } else if (params.action === 'MISSING_TELEMETRY') {
        currentFaults[targetKey] = { missingTelemetry: true };
      }

      await db
        .update(simulatorSessions)
        .set({ activeFaultsJson: currentFaults, updatedAt: now })
        .where(eq(simulatorSessions.id, session.id));

      await db.insert(simulatorEvents).values({
        organisationId,
        sessionId: session.id,
        installationId: verifiedInstId,
        inverterId: verifiedInvId,
        eventType: `INJECT_${params.action}`,
        detailsJson: currentFaults[targetKey],
        occurredAt: now,
      });
    }
  }

  // Generate one immediate interval so dashboard/equipment/alerts reflect the change immediately
  const tickResult = await generateSimulationInterval(organisationId, { manual: true });
  return { session: await getOrCreateSimulatorSession(organisationId), tickResult };
}

export async function generateSimulationInterval(
  organisationId: string,
  options: { manual?: boolean; solarHourOverride?: number } = {}
) {
  const startedAt = new Date();
  const session = await getOrCreateSimulatorSession(organisationId);

  if (!options.manual && session.status !== 'RUNNING') {
    return { skipped: true, reason: `Simulator status is ${session.status}` };
  }

  // Ensure simulated data source exists
  let [simSource] = await db
    .select()
    .from(dataSources)
    .where(
      and(eq(dataSources.organisationId, organisationId), eq(dataSources.sourceType, 'SIMULATED'))
    );
  if (!simSource) {
    [simSource] = await db
      .insert(dataSources)
      .values({
        organisationId,
        name: 'Internal Physics Telemetry Simulator',
        sourceType: 'SIMULATED',
        provider: 'Solar Intelligence Simulator',
        connectionStatus: 'OPERATIONAL',
        pollingIntervalSec: 60,
      })
      .returning();
  }

  const insts = await db
    .select()
    .from(solarInstallations)
    .where(
      and(
        eq(solarInstallations.organisationId, organisationId),
        eq(solarInstallations.isActive, true)
      )
    );
  const allInvs = await db
    .select()
    .from(inverters)
    .where(eq(inverters.organisationId, organisationId));

  // Align tick timestamp to minute boundary and ensure strictly advancing monotonically if manual clicks happen within same minute
  let tickTs = new Date(Math.floor(startedAt.getTime() / 60000) * 60000);
  if (session.lastTickAt && tickTs.getTime() <= session.lastTickAt.getTime()) {
    tickTs = new Date(session.lastTickAt.getTime() + Math.max(60000, session.intervalSeconds * 1000));
  }

  const elapsedSec = session.lastTickAt
    ? Math.min(3600, Math.max(60, Math.round((tickTs.getTime() - session.lastTickAt.getTime()) / 1000)))
    : session.intervalSeconds;

  const faultsMap = session.activeFaultsJson || {};
  let recordsGenerated = 0;

  for (const inst of insts) {
    const siteInvs = allInvs.filter((i) => i.installationId === inst.id);
    const siteFault = faultsMap[inst.id] || {};
    const { localDate } = getLocalCalendarParts(tickTs, inst.timezone);

    // For realistic daytime testing if local clock happens to be night when user clicks Generate,
    // allow explicit solarHourOverride if requested; otherwise strictly obey real UTC -> local solar time!
    const evalTs = new Date(tickTs.getTime());
    if (options.solarHourOverride !== undefined) {
      evalTs.setUTCHours(Math.max(0, Math.min(23, Math.floor(options.solarHourOverride - 5.5))), 30, 0, 0);
    }

    let siteGhi = 0;
    let sitePoa = 0;
    let siteEnergyDeltaKwh = 0;
    let siteExpectedDeltaKwh = 0;
    let siteAcPowerSum = 0;
    let siteTempSum = 0;
    let siteTempCount = 0;
    let hasMissing = false;
    let anyOffline = false;
    let anyWarningOrFault = false;

    for (const inv of siteInvs) {
      const invFault = faultsMap[inv.id] || {};
      const missing = Boolean(siteFault.missingTelemetry || invFault.missingTelemetry);

      if (missing) {
        hasMissing = true;
        await db
          .update(inverters)
          .set({ operatingStatus: 'UNKNOWN' })
          .where(eq(inverters.id, inv.id));
        continue;
      }

      const [prevReading] = await db
        .select()
        .from(telemetryReadings)
        .where(eq(telemetryReadings.inverterId, inv.id))
        .orderBy(desc(telemetryReadings.measuredAt))
        .limit(1);

      const rng = createSeededRng(
        hashSeed(`${inv.id}-${tickTs.toISOString()}`, session.randomSeed)
      );

      const isOffline = Boolean(siteFault.offline || invFault.offline);
      const faultCode =
        (invFault.faultCode as string | undefined) ||
        (siteFault.faultCode as string | undefined) ||
        null;

      const sim = simulateInverterTelemetryPoint({
        timestamp: evalTs,
        latitudeDeg: inst.latitude || 22.57,
        longitudeDeg: inst.longitude || 88.36,
        timezone: inst.timezone,
        weatherCondition: session.weatherMode as WeatherCondition,
        ambientTempC: session.ambientTempC,
        dcCapacityKwp: inv.dcCapacityKwp,
        ratedAcCapacityKw: inv.ratedCapacityKw,
        panelTiltDeg: inst.panelTiltDeg,
        panelOrientation: inst.panelOrientation,
        shadingFactor: inst.shadingFactor,
        performanceRatio: inst.performanceRatio,
        tempCoefficient: inst.tempCoefficient,
        operatingStatus: isOffline ? 'OFFLINE' : faultCode ? 'FAULT' : 'ONLINE',
        faultCode,
        rng,
        injectUnderperformanceFactor:
          (invFault.underperformanceFactor as number | undefined) ??
          (siteFault.underperformanceFactor as number | undefined),
        injectOverheatDeltaC:
          (invFault.overheatDeltaC as number | undefined) ??
          (siteFault.overheatDeltaC as number | undefined),
        injectAbnormalVoltageV:
          (invFault.abnormalVoltageV as number | undefined) ??
          (siteFault.abnormalVoltageV as number | undefined),
      });

      // Baseline expected without fault
      const expectedSim = simulateInverterTelemetryPoint({
        timestamp: evalTs,
        latitudeDeg: inst.latitude || 22.57,
        longitudeDeg: inst.longitude || 88.36,
        timezone: inst.timezone,
        weatherCondition: session.weatherMode as WeatherCondition,
        ambientTempC: session.ambientTempC,
        dcCapacityKwp: inv.dcCapacityKwp,
        ratedAcCapacityKw: inv.ratedCapacityKw,
        panelTiltDeg: inst.panelTiltDeg,
        panelOrientation: inst.panelOrientation,
        shadingFactor: inst.shadingFactor,
        performanceRatio: inst.performanceRatio,
        tempCoefficient: inst.tempCoefficient,
        operatingStatus: 'ONLINE',
        faultCode: null,
        rng: createSeededRng(hashSeed(`exp-${inv.id}-${tickTs.toISOString()}`, session.randomSeed)),
      });

      siteGhi = sim.ghiWm2;
      sitePoa = sim.poaWm2;
      siteAcPowerSum += sim.acPowerKw;
      siteTempSum += sim.inverterTempC;
      siteTempCount += 1;

      if (sim.operatingStatus === 'OFFLINE') anyOffline = true;
      if (sim.operatingStatus === 'WARNING' || sim.operatingStatus === 'FAULT') {
        anyWarningOrFault = true;
      }

      const prevPower = prevReading?.acPowerKw ?? null;
      const intervalKwh = integrateIntervalEnergyKwh(prevPower, sim.acPowerKw, elapsedSec);
      const expectedIntervalKwh = integrateIntervalEnergyKwh(
        expectedSim.acPowerKw,
        expectedSim.acPowerKw,
        elapsedSec
      );
      siteEnergyDeltaKwh += intervalKwh;
      siteExpectedDeltaKwh += expectedIntervalKwh;

      // Reset daily_energy_kwh at local midnight according to installation's IANA timezone
      const prevLocalDate = prevReading
        ? getLocalCalendarParts(prevReading.measuredAt, inst.timezone).localDate
        : localDate;
      const prevDaily = prevLocalDate === localDate ? prevReading?.dailyEnergyKwh ?? 0 : 0;
      const nextDaily = Number((prevDaily + intervalKwh).toFixed(4));
      const nextCumulative = Number(
        ((prevReading?.cumulativeEnergyKwh ?? 0) + intervalKwh).toFixed(4)
      );

      await db
        .insert(telemetryReadings)
        .values({
          organisationId,
          installationId: inst.id,
          inverterId: inv.id,
          dataSourceId: simSource.id,
          sourceType: 'SIMULATED',
          measuredAt: tickTs,
          receivedAt: new Date(),
          acPowerKw: sim.acPowerKw,
          dcPowerKw: sim.dcPowerKw,
          dailyEnergyKwh: nextDaily,
          cumulativeEnergyKwh: nextCumulative,
          voltageV: sim.voltageV,
          currentA: sim.currentA,
          temperatureC: sim.inverterTempC,
          operatingStatus: sim.operatingStatus,
          faultCode: sim.faultCode,
          qualityStatus: 'SIMULATED',
          qualityFlags: sim.faultCode ? ['FAULT_CODE_PRESENT'] : [],
        })
        .onConflictDoNothing();

      await db
        .update(inverters)
        .set({
          operatingStatus: sim.operatingStatus,
          faultCode: sim.faultCode,
          lastSeenAt: tickTs,
        })
        .where(eq(inverters.id, inv.id));

      recordsGenerated += 1;
    }

    if (!hasMissing) {
      await db
        .insert(weatherReadings)
        .values({
          organisationId,
          installationId: inst.id,
          dataSourceId: simSource.id,
          sourceType: 'SIMULATED',
          measuredAt: tickTs,
          ghiWm2: siteGhi,
          poaWm2: sitePoa,
          ambientTemperatureC: session.ambientTempC,
          cloudCoverPercent:
            session.weatherMode === 'Clear'
              ? 8
              : session.weatherMode === 'Partly cloudy'
                ? 35
                : session.weatherMode === 'Cloudy'
                  ? 68
                  : 88,
          weatherCondition: session.weatherMode,
          windSpeedMs: 2.5,
        })
        .onConflictDoNothing();
    }

    // Update hourly aggregate for current UTC hour
    const hourStart = new Date(tickTs.getTime());
    hourStart.setUTCMinutes(0, 0, 0);
    const existingHourly = await db
      .select()
      .from(hourlyEnergyAggregates)
      .where(
        and(
          eq(hourlyEnergyAggregates.installationId, inst.id),
          eq(hourlyEnergyAggregates.hourStart, hourStart)
        )
      );
    if (existingHourly.length > 0) {
      const h = existingHourly[0];
      await db
        .update(hourlyEnergyAggregates)
        .set({
          integratedEnergyKwh: Number((h.integratedEnergyKwh + siteEnergyDeltaKwh).toFixed(3)),
          expectedEnergyKwh: Number(
            ((h.expectedEnergyKwh || 0) + siteExpectedDeltaKwh).toFixed(3)
          ),
          avgAcPowerKw: Number(((h.avgAcPowerKw + siteAcPowerSum) / 2).toFixed(3)),
          avgIrradianceWm2: sitePoa,
          avgTemperatureC:
            siteTempCount > 0 ? Number((siteTempSum / siteTempCount).toFixed(2)) : h.avgTemperatureC,
        })
        .where(eq(hourlyEnergyAggregates.id, h.id));
    } else {
      await db.insert(hourlyEnergyAggregates).values({
        organisationId,
        installationId: inst.id,
        inverterId: null,
        hourStart,
        integratedEnergyKwh: Number(siteEnergyDeltaKwh.toFixed(3)),
        counterEnergyKwh: Number(siteEnergyDeltaKwh.toFixed(3)),
        expectedEnergyKwh: Number(siteExpectedDeltaKwh.toFixed(3)),
        avgAcPowerKw: Number(siteAcPowerSum.toFixed(3)),
        avgIrradianceWm2: sitePoa,
        avgTemperatureC: siteTempCount > 0 ? Number((siteTempSum / siteTempCount).toFixed(2)) : null,
        missingIntervalsCount: hasMissing ? 1 : 0,
        sourceType: 'SIMULATED',
      });
    }

    // Update daily aggregate for local calendar date
    const existingDaily = await db
      .select()
      .from(dailyEnergyAggregates)
      .where(
        and(
          eq(dailyEnergyAggregates.installationId, inst.id),
          eq(dailyEnergyAggregates.localDate, localDate),
          eq(dailyEnergyAggregates.measurementType, 'SIMULATED'),
          eq(dailyEnergyAggregates.dataSourceId, simSource.id)
        )
      );
    if (existingDaily.length > 0) {
      const d = existingDaily[0];
      await db
        .update(dailyEnergyAggregates)
        .set({
          energyKwh: Number((d.energyKwh + siteEnergyDeltaKwh).toFixed(3)),
          expectedEnergyKwh: Number(
            ((d.expectedEnergyKwh || 0) + siteExpectedDeltaKwh).toFixed(3)
          ),
          integratedPowerKwh: Number(
            ((d.integratedPowerKwh || d.energyKwh) + siteEnergyDeltaKwh).toFixed(3)
          ),
        })
        .where(eq(dailyEnergyAggregates.id, d.id));
    } else {
      await db.insert(dailyEnergyAggregates).values({
        organisationId,
        installationId: inst.id,
        localDate,
        sourceTimezone: inst.timezone,
        energyKwh: Number(siteEnergyDeltaKwh.toFixed(3)),
        expectedEnergyKwh: Number(siteExpectedDeltaKwh.toFixed(3)),
        counterDerivedKwh: Number(siteEnergyDeltaKwh.toFixed(3)),
        integratedPowerKwh: Number(siteEnergyDeltaKwh.toFixed(3)),
        measurementType: 'SIMULATED',
        sourceType: 'SIMULATED',
        dataCompletenessPct: 100,
        dataSourceId: simSource.id,
      });
    }

    // Update installation operational status
    let nextInstStatus = 'Operational';
    if (anyOffline || anyWarningOrFault || hasMissing) {
      nextInstStatus = 'Requires Investigation';
    } else if (siteFault.underperformanceFactor) {
      nextInstStatus = 'Underperforming';
    }
    await db
      .update(solarInstallations)
      .set({ operationalStatus: nextInstStatus, updatedAt: new Date() })
      .where(eq(solarInstallations.id, inst.id));
  }

  await db
    .update(simulatorSessions)
    .set({ lastTickAt: tickTs, updatedAt: new Date() })
    .where(eq(simulatorSessions.id, session.id));

  await db
    .update(dataSources)
    .set({ lastSyncAt: tickTs })
    .where(eq(dataSources.id, simSource.id));

  const anomalyResult = await runAnomalyDetectionForOrganisation(organisationId);

  await db.insert(ingestionJobs).values({
    organisationId,
    jobType: options.manual ? 'SIMULATOR_MANUAL_INTERVAL' : 'SIMULATOR_SCHEDULED_INTERVAL',
    status: 'SUCCESS',
    recordsProcessed: recordsGenerated,
    startedAt,
    finishedAt: new Date(),
  });

  return {
    skipped: false,
    tickTimestamp: tickTs.toISOString(),
    recordsGenerated,
    ...anomalyResult,
  };
}
