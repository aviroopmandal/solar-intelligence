import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  alerts,
  auditLogs,
  dataSources,
  dailyEnergyAggregates,
  gatewayDevices,
  hourlyEnergyAggregates,
  inverters,
  maintenanceRecords,
  maintenanceTasks,
  organisationMemberships,
  organisations,
  performanceAnomalies,
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

interface SeedSiteSpec {
  code: string;
  name: string;
  siteAddress: string;
  cityState: string;
  lat: number;
  lon: number;
  type: string;
  capacityKwp: number;
  inverterCount: number;
  panelManufacturer: string;
  panelModel: string;
  inverterManufacturer: string;
  inverterModel: string;
  orientation: string;
  tiltDeg: number;
  shadingFactor: number;
  shadingNotes: string;
  performanceRatio: number;
  condition: 'Normal' | 'Underperforming' | 'OneOffline' | 'Overheating';
  operationalStatus: string;
  group: string;
}

const DEMO_SITES: SeedSiteSpec[] = [
  {
    code: 'IND-KOL-001',
    name: 'Kolkata Industrial',
    siteAddress: 'Plot 14, Salt Lake Sector V Industrial Estate',
    cityState: 'Kolkata, West Bengal',
    lat: 22.5726,
    lon: 88.3639,
    type: 'Industrial Rooftop',
    capacityKwp: 250,
    inverterCount: 5,
    panelManufacturer: 'Waaree Energies',
    panelModel: 'Bi-55-550 Mono PERC',
    inverterManufacturer: 'Sungrow',
    inverterModel: 'SG50CX-P2',
    orientation: 'South (180°)',
    tiltDeg: 22,
    shadingFactor: 0.99,
    shadingNotes: 'Clear unobstructed industrial roof',
    performanceRatio: 0.83,
    condition: 'Normal',
    operationalStatus: 'Operational',
    group: 'Kolkata Metro Cluster',
  },
  {
    code: 'COM-HOW-002',
    name: 'Howrah Commercial',
    siteAddress: '88 Kona Expressway Logistics Hub',
    cityState: 'Howrah, West Bengal',
    lat: 22.5958,
    lon: 88.2636,
    type: 'Commercial Rooftop',
    capacityKwp: 150,
    inverterCount: 3,
    panelManufacturer: 'Tata Power Solar',
    panelModel: 'TP540M-144',
    inverterManufacturer: 'Huawei',
    inverterModel: 'SUN2000-50KTL-M3',
    orientation: 'South-East (160°)',
    tiltDeg: 18,
    shadingFactor: 0.95,
    shadingNotes: 'Moderate industrial dust accumulation observed',
    performanceRatio: 0.81,
    condition: 'Underperforming',
    operationalStatus: 'Underperforming',
    group: 'Kolkata Metro Cluster',
  },
  {
    code: 'MFG-DGP-003',
    name: 'Durgapur Manufacturing',
    siteAddress: 'Phase II Steel & Alloy Park, Bidhannagar',
    cityState: 'Durgapur, West Bengal',
    lat: 23.5204,
    lon: 87.3119,
    type: 'Ground-Mount',
    capacityKwp: 500,
    inverterCount: 5,
    panelManufacturer: 'Vikram Solar',
    panelModel: 'Paradea 555W Bifacial',
    inverterManufacturer: 'SMA',
    inverterModel: 'Sunny Tripower CORE2 110',
    orientation: 'South (180°)',
    tiltDeg: 24,
    shadingFactor: 1.0,
    shadingNotes: 'Open ground array, zero horizon shading',
    performanceRatio: 0.84,
    condition: 'Normal',
    operationalStatus: 'Operational',
    group: 'Western Industrial Belt',
  },
  {
    code: 'WHS-SLG-004',
    name: 'Siliguri Warehouse',
    siteAddress: 'Fulbari Freight & Cold Chain Corridor',
    cityState: 'Siliguri, West Bengal',
    lat: 26.7271,
    lon: 88.3953,
    type: 'Warehouse Rooftop',
    capacityKwp: 100,
    inverterCount: 2,
    panelManufacturer: 'Adani Solar',
    panelModel: 'Eternal 540W',
    inverterManufacturer: 'Fronius',
    inverterModel: 'Tauro ECO 50-3-P',
    orientation: 'South (180°)',
    tiltDeg: 25,
    shadingFactor: 0.98,
    shadingNotes: 'Clear roof; Inverter 2 currently offline for breaker trip',
    performanceRatio: 0.82,
    condition: 'OneOffline',
    operationalStatus: 'Requires Investigation',
    group: 'North Bengal Logistics',
  },
  {
    code: 'IND-HLD-005',
    name: 'Haldia Industrial',
    siteAddress: 'Petrochemical Zone Sector C, Chiranjibpur',
    cityState: 'Haldia, West Bengal',
    lat: 22.0667,
    lon: 88.0698,
    type: 'Industrial Rooftop',
    capacityKwp: 350,
    inverterCount: 4,
    panelManufacturer: 'RenewSys',
    panelModel: 'Deserv Extreme 545W',
    inverterManufacturer: 'SolarEdge',
    inverterModel: 'SE90K Three Phase',
    orientation: 'South-West (195°)',
    tiltDeg: 20,
    shadingFactor: 0.98,
    shadingNotes: 'Elevated thermal enclosure temperature on Inverter 3',
    performanceRatio: 0.82,
    condition: 'Overheating',
    operationalStatus: 'Requires Investigation',
    group: 'Coastal Industrial Corridor',
  },
];

export async function seedDemoOrganisationForUser(
  userId: string,
  userEmail: string
): Promise<string> {
  const slug = `bengal-solar-demo-${userId.slice(0, 8)}`;

  const existing = await db
    .select()
    .from(organisations)
    .where(eq(organisations.slug, slug));
  if (existing.length > 0) {
    return existing[0].id;
  }

  return await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organisations)
      .values({
        name: 'Bengal Solar Operations (Demo)',
        slug,
        industry: 'Commercial & Industrial Solar Portfolio',
        country: 'India',
        contactEmail: userEmail,
        defaultTimezone: 'Asia/Kolkata',
        isDemo: true,
      })
      .returning();

    await tx.insert(organisationMemberships).values({
      organisationId: org.id,
      userId,
      invitedEmail: userEmail,
      role: 'Administrator',
      assignedInstallationIds: [],
      status: 'ACTIVE',
    });

    // Data sources (Simulated & CSV operational; Manufacturer & Modbus NOT_YET_CONNECTED)
    const [simSource] = await tx
      .insert(dataSources)
      .values([
        {
          organisationId: org.id,
          name: 'Internal Physics Telemetry Simulator',
          sourceType: 'SIMULATED',
          provider: 'Solar Intelligence Simulator',
          connectionStatus: 'OPERATIONAL',
          pollingIntervalSec: 60,
          lastSyncAt: new Date(),
          configJson: {
            mode: 'Demonstration',
            clearSkyMaxWm2: 900,
            defaultPr: 0.82,
          },
        },
        {
          organisationId: org.id,
          name: 'Historical CSV Ingestion Pipeline',
          sourceType: 'CSV_IMPORT',
          provider: 'UTF-8 Batch Importer',
          connectionStatus: 'OPERATIONAL',
          pollingIntervalSec: 0,
          configJson: { maxUploadMb: 10, maxRows: 100000 },
        },
        {
          organisationId: org.id,
          name: 'Huawei FusionSolar API',
          sourceType: 'MANUFACTURER_API',
          provider: 'huawei',
          connectionStatus: 'NOT_YET_CONNECTED',
          pollingIntervalSec: 300,
          configJson: { plantId: null, authMode: 'API Key' },
        },
        {
          organisationId: org.id,
          name: 'SolarEdge Monitoring API',
          sourceType: 'MANUFACTURER_API',
          provider: 'solaredge',
          connectionStatus: 'NOT_YET_CONNECTED',
          pollingIntervalSec: 900,
          configJson: { siteId: null, authMode: 'API Key' },
        },
        {
          organisationId: org.id,
          name: 'SMA Sunny Portal API',
          sourceType: 'MANUFACTURER_API',
          provider: 'sma',
          connectionStatus: 'NOT_YET_CONNECTED',
          pollingIntervalSec: 300,
          configJson: { plantId: null, authMode: 'OAuth 2.0' },
        },
        {
          organisationId: org.id,
          name: 'Sungrow iSolarCloud API',
          sourceType: 'MANUFACTURER_API',
          provider: 'sungrow',
          connectionStatus: 'NOT_YET_CONNECTED',
          pollingIntervalSec: 300,
          configJson: { psId: null, authMode: 'OAuth 2.0 / API Key' },
        },
        {
          organisationId: org.id,
          name: 'Fronius Solar.web API',
          sourceType: 'MANUFACTURER_API',
          provider: 'fronius',
          connectionStatus: 'NOT_YET_CONNECTED',
          pollingIntervalSec: 300,
          configJson: { pvSystemId: null, authMode: 'OAuth 2.0 / API Key' },
        },
      ])
      .returning();

    const now = new Date();
    // Simulation start timestamp cleanly separates 30-day historical hourly + 90-min backfill from live ticks
    const simStartAt = new Date(Math.floor(now.getTime() / 60000) * 60000);

    const [simSession] = await tx
      .insert(simulatorSessions)
      .values({
        organisationId: org.id,
        status: 'PAUSED',
        intervalSeconds: 60,
        weatherMode: 'Clear',
        ambientTempC: 31,
        randomSeed: 202611,
        simulationStartAt: simStartAt,
        lastTickAt: simStartAt,
        activeFaultsJson: {},
      })
      .returning();

    const createdInstallations: Array<{
      inst: typeof solarInstallations.$inferSelect;
      spec: SeedSiteSpec;
      invList: Array<typeof inverters.$inferSelect>;
    }> = [];

    for (const spec of DEMO_SITES) {
      const [inst] = await tx
        .insert(solarInstallations)
        .values({
          organisationId: org.id,
          installationCode: spec.code,
          name: spec.name,
          siteAddress: spec.siteAddress,
          cityState: spec.cityState,
          latitude: spec.lat,
          longitude: spec.lon,
          timezone: 'Asia/Kolkata',
          installationType: spec.type,
          installedCapacityKwp: spec.capacityKwp,
          commissioningDate: '2024-03-15',
          panelManufacturer: spec.panelManufacturer,
          panelModel: spec.panelModel,
          inverterManufacturer: spec.inverterManufacturer,
          inverterModel: spec.inverterModel,
          inverterCount: spec.inverterCount,
          panelOrientation: spec.orientation,
          panelTiltDeg: spec.tiltDeg,
          shadingFactor: spec.shadingFactor,
          shadingNotes: spec.shadingNotes,
          performanceRatio: spec.performanceRatio,
          tempCoefficient: -0.004,
          operationalStatus: spec.operationalStatus,
          operationalGroup: spec.group,
          isActive: true,
        })
        .returning();

      const perInvCap = Number((spec.capacityKwp / spec.inverterCount).toFixed(2));
      const invValues = [];
      for (let idx = 1; idx <= spec.inverterCount; idx += 1) {
        const invCode = `${spec.code.split('-')[1]}-INV-${String(idx).padStart(2, '0')}`;
        let opStatus = 'ONLINE';
        let faultCode: string | null = null;
        if (spec.condition === 'OneOffline' && idx === 2) {
          opStatus = 'OFFLINE';
          faultCode = 'ERR-COMM-108';
        } else if (spec.condition === 'Overheating' && idx === 3) {
          opStatus = 'WARNING';
          faultCode = 'WARN-TEMP-HIGH';
        }
        invValues.push({
          organisationId: org.id,
          installationId: inst.id,
          inverterCode: invCode,
          name: `${spec.name} Inverter ${idx}`,
          manufacturer: spec.inverterManufacturer,
          model: spec.inverterModel,
          serialNumber: `SN-${spec.code}-${1000 + idx}`,
          ratedCapacityKw: perInvCap,
          dcCapacityKwp: perInvCap,
          operatingStatus: opStatus,
          faultCode,
          lastSeenAt: simStartAt,
        });
      }

      const invList = await tx.insert(inverters).values(invValues).returning();
      createdInstallations.push({ inst, spec, invList });

      // Architectural local Modbus gateway placeholder per site
      await tx.insert(gatewayDevices).values({
        organisationId: org.id,
        installationId: inst.id,
        name: `${spec.name} SunSpec Edge Gateway`,
        protocol: 'SUNSPEC',
        connectionStatus: 'NOT_YET_CONNECTED',
        registerProfile: 'SunSpec Model 103 (Three-Phase Inverter) — Pending Hardware Pairing',
      });
    }

    // Configure initial simulator fault map matching Howrah (underperforming), Siliguri (offline inv 2), Haldia (overheating inv 3)
    const activeFaults: Record<string, Record<string, unknown>> = {};
    for (const item of createdInstallations) {
      if (item.spec.condition === 'Underperforming') {
        activeFaults[item.inst.id] = { underperformanceFactor: 0.56, reason: 'Simulated array soiling / string mismatch' };
      } else if (item.spec.condition === 'OneOffline' && item.invList[1]) {
        activeFaults[item.invList[1].id] = { offline: true, faultCode: 'ERR-COMM-108' };
      } else if (item.spec.condition === 'Overheating' && item.invList[2]) {
        activeFaults[item.invList[2].id] = { overheatDeltaC: 37, faultCode: 'ERR-TEMP-402' };
      }
    }

    await tx
      .update(simulatorSessions)
      .set({ activeFaultsJson: activeFaults })
      .where(eq(simulatorSessions.id, simSession.id));

    // Generate 30 days of historical hourly telemetry + weather + aggregates + last 60 minutes minute-level readings
    const weatherCycle: WeatherCondition[] = [
      'Clear',
      'Clear',
      'Partly cloudy',
      'Clear',
      'Cloudy',
      'Clear',
      'Partly cloudy',
      'Overcast',
      'Clear',
      'Clear',
    ];

    const start30DaysAgo = new Date(simStartAt.getTime() - 30 * 86400000);
    // Align to top of hour
    start30DaysAgo.setUTCMinutes(0, 0, 0);
    const minuteWindowStart = new Date(simStartAt.getTime() - 60 * 60000);

    const weatherInsertBatch: Array<typeof weatherReadings.$inferInsert> = [];
    const telemetryInsertBatch: Array<typeof telemetryReadings.$inferInsert> = [];
    const hourlyInsertBatch: Array<typeof hourlyEnergyAggregates.$inferInsert> = [];
    const dailyMap = new Map<
      string,
      {
        installationId: string;
        localDate: string;
        energyKwh: number;
        expectedKwh: number;
        counterKwh: number;
        intervals: number;
      }
    >();

    for (const { inst, spec, invList } of createdInstallations) {
      const siteRng = createSeededRng(hashSeed(spec.code, 202611));
      const invCumulative: Record<string, number> = {};
      const invDaily: Record<string, number> = {};
      const invPrevPower: Record<string, number | null> = {};
      let lastLocalDate = '';

      for (const inv of invList) {
        // Seed existing lifetime generation prior to 30 days ago
        invCumulative[inv.id] = Number((inv.ratedCapacityKw * 1450 + siteRng() * 500).toFixed(2));
        invDaily[inv.id] = 0;
        invPrevPower[inv.id] = null;
      }

      // Hourly steps from 30 days ago up to 60 minutes ago
      let cursor = new Date(start30DaysAgo.getTime());
      while (cursor < minuteWindowStart) {
        const dayIndex = Math.floor((cursor.getTime() - start30DaysAgo.getTime()) / 86400000);
        const weatherCond = weatherCycle[(dayIndex + spec.code.charCodeAt(4)) % weatherCycle.length];
        const { localDate, localHourDecimal } = getLocalCalendarParts(cursor, inst.timezone);

        if (localDate !== lastLocalDate) {
          for (const inv of invList) {
            invDaily[inv.id] = 0;
          }
          lastLocalDate = localDate;
        }

        const ambientBase = 24 + 9 * Math.max(0, Math.sin(((localHourDecimal - 6) / 12) * Math.PI));
        const ambientTempC = Number((ambientBase + (siteRng() - 0.5) * 2).toFixed(1));

        // Simulate realistic 2-hour communication interruption on day 27 for Siliguri
        const isCommGap =
          spec.condition === 'OneOffline' &&
          dayIndex === 27 &&
          localHourDecimal >= 11 &&
          localHourDecimal < 13;

        let siteGhi = 0;
        let sitePoa = 0;
        let siteHourlyEnergy = 0;
        let siteExpectedHourly = 0;
        let siteAcPowerSum = 0;
        let siteTempSum = 0;

        for (let iIdx = 0; iIdx < invList.length; iIdx += 1) {
          const inv = invList[iIdx];

          // Recent 5 days degradation for Howrah, recent 2 days offline for Siliguri Inv 2, recent 2 days overheat for Haldia Inv 3
          const isHowrahUnderperf = spec.condition === 'Underperforming' && dayIndex >= 24;
          const isSiliguriOffline = spec.condition === 'OneOffline' && iIdx === 1 && dayIndex >= 28;
          const isHaldiaOverheat = spec.condition === 'Overheating' && iIdx === 2 && dayIndex >= 28;

          // Baseline expected without fault
          const baselineSim = simulateInverterTelemetryPoint({
            timestamp: cursor,
            latitudeDeg: inst.latitude || 22.57,
            longitudeDeg: inst.longitude || 88.36,
            timezone: inst.timezone,
            weatherCondition: weatherCond,
            ambientTempC,
            dcCapacityKwp: inv.dcCapacityKwp,
            ratedAcCapacityKw: inv.ratedCapacityKw,
            panelTiltDeg: inst.panelTiltDeg,
            panelOrientation: inst.panelOrientation,
            shadingFactor: inst.shadingFactor,
            performanceRatio: inst.performanceRatio,
            tempCoefficient: inst.tempCoefficient,
            operatingStatus: 'ONLINE',
            faultCode: null,
            rng: siteRng,
          });
          siteExpectedHourly += baselineSim.acPowerKw;

          if (isCommGap) {
            // Missing telemetry represented as missing record (no fabricated 0)
            invPrevPower[inv.id] = null;
            continue;
          }

          const sim = simulateInverterTelemetryPoint({
            timestamp: cursor,
            latitudeDeg: inst.latitude || 22.57,
            longitudeDeg: inst.longitude || 88.36,
            timezone: inst.timezone,
            weatherCondition: weatherCond,
            ambientTempC,
            dcCapacityKwp: inv.dcCapacityKwp,
            ratedAcCapacityKw: inv.ratedCapacityKw,
            panelTiltDeg: inst.panelTiltDeg,
            panelOrientation: inst.panelOrientation,
            shadingFactor: inst.shadingFactor,
            performanceRatio: inst.performanceRatio,
            tempCoefficient: inst.tempCoefficient,
            operatingStatus: isSiliguriOffline ? 'OFFLINE' : 'ONLINE',
            faultCode: isSiliguriOffline ? 'ERR-COMM-108' : isHaldiaOverheat ? 'ERR-TEMP-402' : null,
            rng: siteRng,
            injectUnderperformanceFactor: isHowrahUnderperf ? 0.56 : undefined,
            injectOverheatDeltaC: isHaldiaOverheat ? 36 : undefined,
          });

          siteGhi = sim.ghiWm2;
          sitePoa = sim.poaWm2;
          const intervalKwh = integrateIntervalEnergyKwh(invPrevPower[inv.id], sim.acPowerKw, 3600);
          invPrevPower[inv.id] = sim.acPowerKw;
          invDaily[inv.id] = Number((invDaily[inv.id] + intervalKwh).toFixed(3));
          invCumulative[inv.id] = Number((invCumulative[inv.id] + intervalKwh).toFixed(3));

          siteHourlyEnergy += intervalKwh;
          siteAcPowerSum += sim.acPowerKw;
          siteTempSum += sim.inverterTempC;

          telemetryInsertBatch.push({
            organisationId: org.id,
            installationId: inst.id,
            inverterId: inv.id,
            dataSourceId: simSource.id,
            sourceType: 'SIMULATED',
            measuredAt: new Date(cursor.getTime()),
            receivedAt: new Date(cursor.getTime() + 1500),
            acPowerKw: sim.acPowerKw,
            dcPowerKw: sim.dcPowerKw,
            dailyEnergyKwh: invDaily[inv.id],
            cumulativeEnergyKwh: invCumulative[inv.id],
            voltageV: sim.voltageV,
            currentA: sim.currentA,
            temperatureC: sim.inverterTempC,
            operatingStatus: sim.operatingStatus,
            faultCode: sim.faultCode,
            qualityStatus: 'SIMULATED',
            qualityFlags: sim.faultCode ? ['FAULT_CODE_PRESENT'] : [],
          });
        }

        if (!isCommGap) {
          weatherInsertBatch.push({
            organisationId: org.id,
            installationId: inst.id,
            dataSourceId: simSource.id,
            sourceType: 'SIMULATED',
            measuredAt: new Date(cursor.getTime()),
            ghiWm2: siteGhi,
            poaWm2: sitePoa,
            ambientTemperatureC: ambientTempC,
            cloudCoverPercent:
              weatherCond === 'Clear'
                ? 8
                : weatherCond === 'Partly cloudy'
                  ? 35
                  : weatherCond === 'Cloudy'
                    ? 68
                    : 88,
            weatherCondition: weatherCond,
            windSpeedMs: Number((2.4 + siteRng() * 2.5).toFixed(1)),
          });

          hourlyInsertBatch.push({
            organisationId: org.id,
            installationId: inst.id,
            inverterId: null,
            hourStart: new Date(cursor.getTime()),
            integratedEnergyKwh: Number(siteHourlyEnergy.toFixed(3)),
            counterEnergyKwh: Number(siteHourlyEnergy.toFixed(3)),
            expectedEnergyKwh: Number(siteExpectedHourly.toFixed(3)),
            avgAcPowerKw: Number(siteAcPowerSum.toFixed(3)),
            avgIrradianceWm2: sitePoa,
            avgTemperatureC: Number((siteTempSum / invList.length).toFixed(2)),
            missingIntervalsCount: 0,
            sourceType: 'SIMULATED',
          });

          const dKey = `${inst.id}|${localDate}`;
          const existingDaily = dailyMap.get(dKey) || {
            installationId: inst.id,
            localDate,
            energyKwh: 0,
            expectedKwh: 0,
            counterKwh: 0,
            intervals: 0,
          };
          existingDaily.energyKwh = Number((existingDaily.energyKwh + siteHourlyEnergy).toFixed(3));
          existingDaily.expectedKwh = Number(
            (existingDaily.expectedKwh + siteExpectedHourly).toFixed(3)
          );
          existingDaily.counterKwh = existingDaily.energyKwh;
          existingDaily.intervals += 1;
          dailyMap.set(dKey, existingDaily);
        }

        cursor = new Date(cursor.getTime() + 3600000);
      }

      // Recent 60 minutes minute-level readings (every 5 minutes to keep DB crisp and fast while supporting fine charts)
      let minCursor = new Date(minuteWindowStart.getTime());
      while (minCursor <= simStartAt) {
        const { localDate, localHourDecimal } = getLocalCalendarParts(minCursor, inst.timezone);
        if (localDate !== lastLocalDate) {
          for (const inv of invList) {
            invDaily[inv.id] = 0;
          }
          lastLocalDate = localDate;
        }
        const ambientBase = 26 + 7 * Math.max(0, Math.sin(((localHourDecimal - 6) / 12) * Math.PI));
        const ambientTempC = Number((ambientBase + (siteRng() - 0.5) * 1.2).toFixed(1));
        let siteGhi = 0;
        let sitePoa = 0;

        for (let iIdx = 0; iIdx < invList.length; iIdx += 1) {
          const inv = invList[iIdx];
          const isHowrahUnderperf = spec.condition === 'Underperforming';
          const isSiliguriOffline = spec.condition === 'OneOffline' && iIdx === 1;
          const isHaldiaOverheat = spec.condition === 'Overheating' && iIdx === 2;

          const sim = simulateInverterTelemetryPoint({
            timestamp: minCursor,
            latitudeDeg: inst.latitude || 22.57,
            longitudeDeg: inst.longitude || 88.36,
            timezone: inst.timezone,
            weatherCondition: 'Clear',
            ambientTempC,
            dcCapacityKwp: inv.dcCapacityKwp,
            ratedAcCapacityKw: inv.ratedCapacityKw,
            panelTiltDeg: inst.panelTiltDeg,
            panelOrientation: inst.panelOrientation,
            shadingFactor: inst.shadingFactor,
            performanceRatio: inst.performanceRatio,
            tempCoefficient: inst.tempCoefficient,
            operatingStatus: isSiliguriOffline ? 'OFFLINE' : 'ONLINE',
            faultCode: isSiliguriOffline ? 'ERR-COMM-108' : isHaldiaOverheat ? 'ERR-TEMP-402' : null,
            rng: siteRng,
            injectUnderperformanceFactor: isHowrahUnderperf ? 0.56 : undefined,
            injectOverheatDeltaC: isHaldiaOverheat ? 37 : undefined,
          });
          siteGhi = sim.ghiWm2;
          sitePoa = sim.poaWm2;
          const intervalKwh = integrateIntervalEnergyKwh(invPrevPower[inv.id], sim.acPowerKw, 300);
          invPrevPower[inv.id] = sim.acPowerKw;
          invDaily[inv.id] = Number((invDaily[inv.id] + intervalKwh).toFixed(3));
          invCumulative[inv.id] = Number((invCumulative[inv.id] + intervalKwh).toFixed(3));

          telemetryInsertBatch.push({
            organisationId: org.id,
            installationId: inst.id,
            inverterId: inv.id,
            dataSourceId: simSource.id,
            sourceType: 'SIMULATED',
            measuredAt: new Date(minCursor.getTime()),
            receivedAt: new Date(minCursor.getTime() + 500),
            acPowerKw: sim.acPowerKw,
            dcPowerKw: sim.dcPowerKw,
            dailyEnergyKwh: invDaily[inv.id],
            cumulativeEnergyKwh: invCumulative[inv.id],
            voltageV: sim.voltageV,
            currentA: sim.currentA,
            temperatureC: sim.inverterTempC,
            operatingStatus: sim.operatingStatus,
            faultCode: sim.faultCode,
            qualityStatus: 'SIMULATED',
            qualityFlags: sim.faultCode ? ['FAULT_CODE_PRESENT'] : [],
          });
        }

        weatherInsertBatch.push({
          organisationId: org.id,
          installationId: inst.id,
          dataSourceId: simSource.id,
          sourceType: 'SIMULATED',
          measuredAt: new Date(minCursor.getTime()),
          ghiWm2: siteGhi,
          poaWm2: sitePoa,
          ambientTemperatureC: ambientTempC,
          cloudCoverPercent: 8,
          weatherCondition: 'Clear',
          windSpeedMs: 2.8,
        });

        minCursor = new Date(minCursor.getTime() + 300000);
      }
    }

    // Batch insert telemetry, weather, hourly, and daily records
    const chunk = async <T>(rows: T[], fn: (slice: T[]) => Promise<void>) => {
      const size = 400;
      for (let i = 0; i < rows.length; i += size) {
        await fn(rows.slice(i, i + size));
      }
    };

    await chunk(weatherInsertBatch, async (slice) => {
      await tx.insert(weatherReadings).values(slice).onConflictDoNothing();
    });

    await chunk(telemetryInsertBatch, async (slice) => {
      await tx.insert(telemetryReadings).values(slice).onConflictDoNothing();
    });

    await chunk(hourlyInsertBatch, async (slice) => {
      await tx.insert(hourlyEnergyAggregates).values(slice);
    });

    const dailyValues: Array<typeof dailyEnergyAggregates.$inferInsert> = Array.from(
      dailyMap.values()
    ).map((d) => ({
      organisationId: org.id,
      installationId: d.installationId,
      localDate: d.localDate,
      sourceTimezone: 'Asia/Kolkata',
      energyKwh: d.energyKwh,
      expectedEnergyKwh: d.expectedKwh,
      counterDerivedKwh: d.counterKwh,
      integratedPowerKwh: d.energyKwh,
      measurementType: 'SIMULATED',
      sourceType: 'SIMULATED',
      dataCompletenessPct: Number(Math.min(100, (d.intervals / 24) * 100).toFixed(1)),
      dataSourceId: simSource.id,
    }));

    await chunk(dailyValues, async (slice) => {
      await tx.insert(dailyEnergyAggregates).values(slice).onConflictDoNothing();
    });

    // Seed initial realistic anomalies, alerts, maintenance tasks, and historical maintenance records
    const howrah = createdInstallations[1];
    const siliguri = createdInstallations[3];
    const haldia = createdInstallations[4];
    const kolkata = createdInstallations[0];

    const [anomHowrah, anomSiliguri, anomHaldia] = await tx
      .insert(performanceAnomalies)
      .values([
        {
          organisationId: org.id,
          installationId: howrah.inst.id,
          inverterId: null,
          category: 'UNEXPECTED_GENERATION_REDUCTION',
          classification: 'STATISTICAL_ANOMALY',
          observedValue: '56% of weather-adjusted baseline',
          expectedBaseline: '100% weather-adjusted baseline (PR 0.81)',
          severity: 'High',
          explanation:
            'Howrah Commercial daily generation fell ~44% below clear-sky POA irradiance expectations over the past 6 days. This is a statistical anomaly requiring site inspection rather than a confirmed equipment fault.',
          recommendedAction:
            'Schedule qualified technician inspection for array soiling, DC string fuses, or partial shading obstructions.',
          evidenceJson: {
            avgPerformanceRatioObserved: 0.45,
            expectedPerformanceRatio: 0.81,
            daysObserved: 6,
            weatherCondition: 'Clear / Partly cloudy',
          },
          status: 'OPEN',
        },
        {
          organisationId: org.id,
          installationId: siliguri.inst.id,
          inverterId: siliguri.invList[1].id,
          category: 'REPEATED_SHUTDOWN',
          classification: 'CONFIRMED_EQUIPMENT_FAULT',
          observedValue: '0.00 kW AC (OFFLINE · ERR-COMM-108)',
          expectedBaseline: 'Peer inverter generating nominal power',
          severity: 'Critical',
          explanation:
            'Siliguri Warehouse Inverter 2 reported fault code ERR-COMM-108 and dropped to OFFLINE status while sibling Inverter 1 remained online.',
          recommendedAction:
            'Verify AC breaker state, RS-485/Ethernet telemetry link, and inverter status display by qualified electrical staff.',
          evidenceJson: {
            faultCode: 'ERR-COMM-108',
            operatingStatus: 'OFFLINE',
            peerInverterStatus: 'ONLINE',
          },
          status: 'OPEN',
        },
        {
          organisationId: org.id,
          installationId: haldia.inst.id,
          inverterId: haldia.invList[2].id,
          category: 'EXCESSIVE_TEMPERATURE',
          classification: 'CONFIRMED_EQUIPMENT_FAULT',
          observedValue: '79.4 °C internal heatsink (WARN/ERR-TEMP-402)',
          expectedBaseline: '< 65 °C nominal operating envelope',
          severity: 'High',
          explanation:
            'Haldia Industrial Inverter 3 is operating +36 °C above peer inverters at the same site and flagged thermal warning ERR-TEMP-402.',
          recommendedAction:
            'Inspect cooling fan airflow, intake dust filters, and ambient ventilation around Inverter 3.',
          evidenceJson: {
            faultCode: 'ERR-TEMP-402',
            observedTempDeltaC: 36,
            peerAvgTempC: 43.2,
          },
          status: 'OPEN',
        },
      ])
      .returning();

    const [alert1, alert2, alert3] = await tx
      .insert(alerts)
      .values([
        {
          organisationId: org.id,
          installationId: siliguri.inst.id,
          inverterId: siliguri.invList[1].id,
          anomalyId: anomSiliguri.id,
          alertCode: 'ALT-1001',
          severity: 'Critical',
          title: 'Inverter 2 Offline (ERR-COMM-108)',
          description:
            'Siliguri Warehouse Inverter 2 transitioned to OFFLINE with fault code ERR-COMM-108.',
          supportingMeasurements: { acPowerKw: 0, faultCode: 'ERR-COMM-108', peerOnline: true },
          recommendedAction:
            'Dispatch qualified technician to inspect AC isolator and telemetry link.',
          status: 'New',
        },
        {
          organisationId: org.id,
          installationId: haldia.inst.id,
          inverterId: haldia.invList[2].id,
          anomalyId: anomHaldia.id,
          alertCode: 'ALT-1002',
          severity: 'High',
          title: 'Excessive Inverter Temperature (ERR-TEMP-402)',
          description:
            'Haldia Industrial Inverter 3 exceeded 75°C thermal warning threshold.',
          supportingMeasurements: { temperatureDeltaC: '+36°C vs peers', faultCode: 'ERR-TEMP-402' },
          recommendedAction: 'Check inverter cooling fans and cabinet ventilation clearances.',
          status: 'Acknowledged',
          assignedToUserId: userId,
        },
        {
          organisationId: org.id,
          installationId: howrah.inst.id,
          inverterId: null,
          anomalyId: anomHowrah.id,
          alertCode: 'ALT-1003',
          severity: 'High',
          title: 'Sustained Underperformance (-44% vs Baseline)',
          description:
            'Howrah Commercial output is consistently below irradiance-adjusted baseline across all 3 inverters.',
          supportingMeasurements: { observedVsExpectedPct: '56%', periodDays: 6 },
          recommendedAction: 'Inspect array surface soiling and DC combiner string currents.',
          status: 'Under Investigation',
          assignedToUserId: userId,
        },
      ])
      .returning();

    const dueSoon = new Date(now.getTime() + 2 * 86400000).toISOString().slice(0, 10);
    const dueNextWeek = new Date(now.getTime() + 5 * 86400000).toISOString().slice(0, 10);
    const pastDate = new Date(now.getTime() - 12 * 86400000);

    const [completedTask] = await tx
      .insert(maintenanceTasks)
      .values([
        {
          organisationId: org.id,
          installationId: kolkata.inst.id,
          inverterId: kolkata.invList[0].id,
          title: 'Quarterly Preventive Array Cleaning & Torque Check',
          description: 'Routine Q4 cleaning and thermal camera check on Kolkata Industrial array.',
          priority: 'Low',
          status: 'Completed',
          assignedToUserId: userId,
          assignedToName: 'R. Banerjee (Lead Tech)',
          dueDate: pastDate.toISOString().slice(0, 10),
          inspectionFindings: 'Minor dust accumulation on southern rows; no hotspots detected.',
          workPerformed: 'Demineralized water wash completed across 250 kWp array; verified inverter terminals.',
          completedAt: pastDate,
        },
        {
          organisationId: org.id,
          installationId: siliguri.inst.id,
          inverterId: siliguri.invList[1].id,
          alertId: alert1.id,
          anomalyId: anomSiliguri.id,
          title: 'Investigate Siliguri Inverter 2 Offline Fault (ERR-COMM-108)',
          description: 'Diagnose communication loss and AC output drop on Inverter 2.',
          priority: 'Critical',
          status: 'Open',
          assignedToUserId: userId,
          assignedToName: userEmail.split('@')[0],
          dueDate: dueSoon,
        },
        {
          organisationId: org.id,
          installationId: haldia.inst.id,
          inverterId: haldia.invList[2].id,
          alertId: alert2.id,
          anomalyId: anomHaldia.id,
          title: 'Haldia Inverter 3 Thermal & Fan Inspection',
          description: 'Inspect air intake filters and cooling fan assembly following ERR-TEMP-402.',
          priority: 'High',
          status: 'In Progress',
          assignedToUserId: userId,
          assignedToName: userEmail.split('@')[0],
          dueDate: dueSoon,
          inspectionFindings: 'Initial check confirms elevated ambient dust near petrochemical vent.',
        },
        {
          organisationId: org.id,
          installationId: howrah.inst.id,
          alertId: alert3.id,
          anomalyId: anomHowrah.id,
          title: 'Howrah Commercial Array Soiling & String Audit',
          description: 'Investigate 44% underperformance relative to weather-adjusted expectations.',
          priority: 'High',
          status: 'Open',
          assignedToUserId: userId,
          assignedToName: userEmail.split('@')[0],
          dueDate: dueNextWeek,
        },
      ])
      .returning();

    await tx.insert(maintenanceRecords).values([
      {
        organisationId: org.id,
        installationId: kolkata.inst.id,
        inverterId: kolkata.invList[0].id,
        taskId: completedTask.id,
        performedByUserId: userId,
        performedByName: 'R. Banerjee',
        performedAt: pastDate,
        recordType: 'CLEANING',
        findings: 'Light particulate deposition; post-wash PR improved by +3.4%.',
        workPerformed: 'Full module wash and visual DC conduit inspection.',
        partsReplaced: 'None',
      },
      {
        organisationId: org.id,
        installationId: haldia.inst.id,
        inverterId: haldia.invList[2].id,
        performedByUserId: userId,
        performedByName: 'S. Chatterjee',
        performedAt: new Date(now.getTime() - 18 * 86400000),
        recordType: 'PREVENTIVE',
        findings: 'Fan filter partially clogged with coastal industrial dust.',
        workPerformed: 'Cleaned cooling fan shroud and replaced mesh intake filter.',
        partsReplaced: 'Intake dust mesh filter (1x)',
      },
    ]);

    await tx.insert(simulatorEvents).values({
      organisationId: org.id,
      sessionId: simSession.id,
      eventType: 'DEMO_SEED_INITIALIZED',
      detailsJson: {
        installationsCount: createdInstallations.length,
        historicalDays: 30,
        seed: 202611,
      },
    });

    await tx.insert(auditLogs).values({
      organisationId: org.id,
      userId,
      userEmail,
      action: 'DEMO_ORGANISATION_PROVISIONED',
      entityType: 'organisation',
      entityId: org.id,
      detailsJson: { name: org.name, installations: 5, inverters: 19 },
    });

    return org.id;
  });
}
