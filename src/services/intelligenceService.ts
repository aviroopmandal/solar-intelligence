import { GoogleGenAI } from '@google/genai';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  alerts,
  dailyEnergyAggregates,
  forecasts,
  hourlyEnergyAggregates,
  inverters,
  maintenanceRecords,
  maintenanceTasks,
  performanceAnomalies,
  solarInstallations,
  telemetryReadings,
  weatherReadings,
} from '../db/schema.ts';
import {
  calculatePoaIrradiance,
  calculateSolarElevationRad,
  getLocalCalendarParts,
  SIMULATION_DEFAULTS,
} from './solarPhysics.ts';

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function runAnomalyDetectionForOrganisation(organisationId: string) {
  const insts = await db
    .select()
    .from(solarInstallations)
    .where(
      and(
        eq(solarInstallations.organisationId, organisationId),
        eq(solarInstallations.isActive, true)
      )
    );

  const invs = await db
    .select()
    .from(inverters)
    .where(eq(inverters.organisationId, organisationId));

  const recentTelemetry = await db
    .select()
    .from(telemetryReadings)
    .where(eq(telemetryReadings.organisationId, organisationId))
    .orderBy(desc(telemetryReadings.measuredAt))
    .limit(500);

  const latestByInverter = new Map<string, typeof telemetryReadings.$inferSelect>();
  for (const row of recentTelemetry) {
    if (!latestByInverter.has(row.inverterId)) {
      latestByInverter.set(row.inverterId, row);
    }
  }

  const recentWeather = await db
    .select()
    .from(weatherReadings)
    .where(eq(weatherReadings.organisationId, organisationId))
    .orderBy(desc(weatherReadings.measuredAt))
    .limit(100);

  const latestWeatherByInst = new Map<string, typeof weatherReadings.$inferSelect>();
  for (const w of recentWeather) {
    if (!latestWeatherByInst.has(w.installationId)) {
      latestWeatherByInst.set(w.installationId, w);
    }
  }

  const openAlerts = await db
    .select()
    .from(alerts)
    .where(eq(alerts.organisationId, organisationId));

  const openAnomalies = await db
    .select()
    .from(performanceAnomalies)
    .where(eq(performanceAnomalies.organisationId, organisationId));

  const hasOpenAlert = (instId: string, invId: string | null, keyword: string) =>
    openAlerts.some(
      (a) =>
        a.installationId === instId &&
        (invId ? a.inverterId === invId : true) &&
        a.status !== 'Resolved' &&
        a.status !== 'Dismissed' &&
        a.title.toLowerCase().includes(keyword.toLowerCase())
    );

  const hasOpenAnomaly = (instId: string, invId: string | null, category: string) =>
    openAnomalies.some(
      (a) =>
        a.installationId === instId &&
        (invId ? a.inverterId === invId : true) &&
        a.category === category &&
        a.status !== 'RESOLVED' &&
        a.status !== 'DISMISSED'
    );

  let createdAnomalies = 0;
  let createdAlerts = 0;

  for (const inst of insts) {
    const siteInvs = invs.filter((i) => i.installationId === inst.id);
    const weather = latestWeatherByInst.get(inst.id);
    const poa = weather?.poaWm2 ?? 0;

    let siteActualKw = 0;
    let siteExpectedKw = 0;
    const invPowerRatios: Array<{ inv: typeof inverters.$inferSelect; ratio: number; kw: number }> = [];

    for (const inv of siteInvs) {
      const latest = latestByInverter.get(inv.id);
      const expectedInvKw =
        poa > 50
          ? Number(
              (
                inv.dcCapacityKwp *
                (poa / 1000) *
                (inst.performanceRatio / 0.88) *
                inst.shadingFactor *
                0.97
              ).toFixed(2)
            )
          : 0;
      siteExpectedKw += expectedInvKw;

      if (!latest) continue;

      const actualKw = latest.acPowerKw ?? 0;
      siteActualKw += actualKw;

      if (expectedInvKw > 5) {
        invPowerRatios.push({ inv, ratio: actualKw / expectedInvKw, kw: actualKw });
      }

      // 1. Confirmed equipment fault / offline
      if (latest.operatingStatus === 'OFFLINE' || latest.operatingStatus === 'FAULT' || latest.faultCode) {
        const isFaultCode = Boolean(latest.faultCode);
        if (!hasOpenAnomaly(inst.id, inv.id, 'REPEATED_SHUTDOWN')) {
          const [anom] = await db
            .insert(performanceAnomalies)
            .values({
              organisationId,
              installationId: inst.id,
              inverterId: inv.id,
              category: 'REPEATED_SHUTDOWN',
              classification: 'CONFIRMED_EQUIPMENT_FAULT',
              observedValue: `${actualKw.toFixed(2)} kW (${latest.operatingStatus}${latest.faultCode ? ` · ${latest.faultCode}` : ''})`,
              expectedBaseline: `${expectedInvKw.toFixed(2)} kW expected at ${poa.toFixed(0)} W/m² POA`,
              severity: latest.operatingStatus === 'OFFLINE' || latest.operatingStatus === 'FAULT' ? 'Critical' : 'High',
              explanation: `${inv.name} is ${latest.operatingStatus}${isFaultCode ? ` with fault code ${latest.faultCode}` : ''}. This reflects a confirmed equipment state or fault code.`,
              recommendedAction:
                'Dispatch qualified electrical technician to verify AC isolator, grid voltage, and inverter diagnostics.',
              evidenceJson: {
                measuredAt: latest.measuredAt,
                acPowerKw: actualKw,
                expectedInvKw,
                operatingStatus: latest.operatingStatus,
                faultCode: latest.faultCode,
              },
              status: 'OPEN',
            })
            .returning();
          createdAnomalies += 1;

          if (!hasOpenAlert(inst.id, inv.id, 'offline') && !hasOpenAlert(inst.id, inv.id, 'fault')) {
            await db.insert(alerts).values({
              organisationId,
              installationId: inst.id,
              inverterId: inv.id,
              anomalyId: anom.id,
              alertCode: `ALT-${Math.floor(1000 + Math.random() * 8999)}`,
              severity: anom.severity,
              title: `${inv.inverterCode} ${latest.operatingStatus}${latest.faultCode ? ` (${latest.faultCode})` : ''}`,
              description: anom.explanation,
              supportingMeasurements: anom.evidenceJson,
              recommendedAction: anom.recommendedAction,
              status: 'New',
            });
            createdAlerts += 1;
          }
        }
      }

      // 2. Excessive inverter temperature (> 72°C)
      if (latest.temperatureC !== null && latest.temperatureC >= 72) {
        if (!hasOpenAnomaly(inst.id, inv.id, 'EXCESSIVE_TEMPERATURE')) {
          const [anom] = await db
            .insert(performanceAnomalies)
            .values({
              organisationId,
              installationId: inst.id,
              inverterId: inv.id,
              category: 'EXCESSIVE_TEMPERATURE',
              classification: latest.faultCode ? 'CONFIRMED_EQUIPMENT_FAULT' : 'STATISTICAL_ANOMALY',
              observedValue: `${latest.temperatureC.toFixed(1)} °C`,
              expectedBaseline: `< 65.0 °C (ambient ${(weather?.ambientTemperatureC ?? 30).toFixed(1)} °C)`,
              severity: latest.temperatureC >= 80 ? 'Critical' : 'High',
              explanation: `${inv.name} heatsink temperature reached ${latest.temperatureC.toFixed(1)} °C, exceeding safe thermal thresholds.`,
              recommendedAction:
                'Inspect cooling fans, intake air filters, and shading/airflow clearance around the inverter enclosure.',
              evidenceJson: {
                measuredAt: latest.measuredAt,
                temperatureC: latest.temperatureC,
                ambientTemperatureC: weather?.ambientTemperatureC ?? null,
              },
              status: 'OPEN',
            })
            .returning();
          createdAnomalies += 1;

          if (!hasOpenAlert(inst.id, inv.id, 'temperature')) {
            await db.insert(alerts).values({
              organisationId,
              installationId: inst.id,
              inverterId: inv.id,
              anomalyId: anom.id,
              alertCode: `ALT-${Math.floor(1000 + Math.random() * 8999)}`,
              severity: anom.severity,
              title: `${inv.inverterCode} High Temperature (${latest.temperatureC.toFixed(1)} °C)`,
              description: anom.explanation,
              supportingMeasurements: anom.evidenceJson,
              recommendedAction: anom.recommendedAction,
              status: 'New',
            });
            createdAlerts += 1;
          }
        }
      }

      // 3. Abnormal voltage readings (< 330V or > 465V while not offline)
      if (
        latest.operatingStatus !== 'OFFLINE' &&
        latest.voltageV !== null &&
        latest.voltageV > 0 &&
        (latest.voltageV < 330 || latest.voltageV > 465)
      ) {
        if (!hasOpenAnomaly(inst.id, inv.id, 'ABNORMAL_VOLTAGE')) {
          const [anom] = await db
            .insert(performanceAnomalies)
            .values({
              organisationId,
              installationId: inst.id,
              inverterId: inv.id,
              category: 'ABNORMAL_VOLTAGE',
              classification: 'STATISTICAL_ANOMALY',
              observedValue: `${latest.voltageV.toFixed(1)} V AC`,
              expectedBaseline: '360 V – 440 V nominal 3-phase envelope',
              severity: 'High',
              explanation: `${inv.name} reported AC voltage of ${latest.voltageV.toFixed(1)} V outside normal grid operating limits.`,
              recommendedAction:
                'Have a qualified technician inspect grid interconnection voltage and transformer tap settings.',
              evidenceJson: { measuredAt: latest.measuredAt, voltageV: latest.voltageV },
              status: 'OPEN',
            })
            .returning();
          createdAnomalies += 1;

          if (!hasOpenAlert(inst.id, inv.id, 'voltage')) {
            await db.insert(alerts).values({
              organisationId,
              installationId: inst.id,
              inverterId: inv.id,
              anomalyId: anom.id,
              alertCode: `ALT-${Math.floor(1000 + Math.random() * 8999)}`,
              severity: 'High',
              title: `${inv.inverterCode} Abnormal Grid Voltage (${latest.voltageV.toFixed(1)} V)`,
              description: anom.explanation,
              supportingMeasurements: anom.evidenceJson,
              recommendedAction: anom.recommendedAction,
              status: 'New',
            });
            createdAlerts += 1;
          }
        }
      }
    }

    // 4. Installation-level weather-adjusted underperformance
    if (siteExpectedKw > 15 && siteActualKw < siteExpectedKw * 0.72) {
      if (!hasOpenAnomaly(inst.id, null, 'UNEXPECTED_GENERATION_REDUCTION')) {
        const pct = ((siteActualKw / siteExpectedKw) * 100).toFixed(1);
        const [anom] = await db
          .insert(performanceAnomalies)
          .values({
            organisationId,
            installationId: inst.id,
            inverterId: null,
            category: 'UNEXPECTED_GENERATION_REDUCTION',
            classification: 'STATISTICAL_ANOMALY',
            observedValue: `${siteActualKw.toFixed(2)} kW (${pct}% of baseline)`,
            expectedBaseline: `${siteExpectedKw.toFixed(2)} kW at ${poa.toFixed(0)} W/m² POA`,
            severity: siteActualKw < siteExpectedKw * 0.5 ? 'High' : 'Medium',
            explanation: `${inst.name} is producing ${pct}% of irradiance- and temperature-adjusted expectations. This is a statistical anomaly requiring field investigation rather than a confirmed physical fault.`,
            recommendedAction:
              'Investigate array soiling, partial shading, inverter derating, or offline strings.',
            evidenceJson: {
              siteActualKw,
              siteExpectedKw,
              poaWm2: poa,
              weatherCondition: weather?.weatherCondition ?? 'Unknown',
            },
            status: 'OPEN',
          })
          .returning();
        createdAnomalies += 1;

        if (!hasOpenAlert(inst.id, null, 'underperformance')) {
          await db.insert(alerts).values({
            organisationId,
            installationId: inst.id,
            inverterId: null,
            anomalyId: anom.id,
            alertCode: `ALT-${Math.floor(1000 + Math.random() * 8999)}`,
            severity: anom.severity,
            title: `${inst.name} Underperformance (${pct}% of Expected)`,
            description: anom.explanation,
            supportingMeasurements: anom.evidenceJson,
            recommendedAction: anom.recommendedAction,
            status: 'New',
          });
          createdAlerts += 1;
        }
      }
    }

    // 5. Unusual differences between peer inverters at the same installation
    if (invPowerRatios.length >= 2) {
      const sorted = [...invPowerRatios].sort((a, b) => b.ratio - a.ratio);
      const medianRatio = sorted[Math.floor(sorted.length / 2)].ratio;
      for (const item of invPowerRatios) {
        if (medianRatio > 0.4 && item.ratio < medianRatio * 0.65 && item.inv.operatingStatus === 'ONLINE') {
          if (!hasOpenAnomaly(inst.id, item.inv.id, 'INVERTER_PEER_DEVIATION')) {
            await db.insert(performanceAnomalies).values({
              organisationId,
              installationId: inst.id,
              inverterId: item.inv.id,
              category: 'INVERTER_PEER_DEVIATION',
              classification: 'STATISTICAL_ANOMALY',
              observedValue: `${item.kw.toFixed(2)} kW (${(item.ratio * 100).toFixed(0)}% of expected)`,
              expectedBaseline: `Peer median ${(medianRatio * 100).toFixed(0)}%`,
              severity: 'Medium',
              explanation: `${item.inv.name} is generating significantly less power than peer inverters at ${inst.name} under identical weather conditions.`,
              recommendedAction:
                'Compare DC string voltages/currents on this inverter against adjacent peer units.',
              evidenceJson: {
                inverterKw: item.kw,
                inverterRatio: item.ratio,
                peerMedianRatio: medianRatio,
              },
              status: 'OPEN',
            });
            createdAnomalies += 1;
          }
        }
      }
    }
  }

  return { createdAnomalies, createdAlerts };
}

/**
 * Staged Solar Energy Forecasting Engine (Sections 9 & 32):
 * Stage 1: Physical baseline (capacity, solar elevation, simulated weather/irradiance, temp coeff, PR, availability)
 * Stage 2: Historical residual correction using chronological train/validation split
 * Reports MAE, RMSE, MAPE (only where actual > threshold), and 95% confidence bounds.
 */
export async function generateForecastsForOrganisation(
  organisationId: string,
  targetInstallationId?: string
) {
  const insts = targetInstallationId
    ? await db
        .select()
        .from(solarInstallations)
        .where(
          and(
            eq(solarInstallations.organisationId, organisationId),
            eq(solarInstallations.id, targetInstallationId)
          )
        )
    : await db
        .select()
        .from(solarInstallations)
        .where(
          and(
            eq(solarInstallations.organisationId, organisationId),
            eq(solarInstallations.isActive, true)
          )
        );

  const generatedAt = new Date();
  let totalInserted = 0;

  for (const inst of insts) {
    // Retrieve chronological daily historical records
    const dailyHistory = await db
      .select()
      .from(dailyEnergyAggregates)
      .where(
        and(
          eq(dailyEnergyAggregates.organisationId, organisationId),
          eq(dailyEnergyAggregates.installationId, inst.id)
        )
      )
      .orderBy(dailyEnergyAggregates.localDate);

    // Filter out incomplete current day if < 50% complete or zero
    const completedDays = dailyHistory.filter((d) => d.dataCompletenessPct >= 50 && d.energyKwh > 0);
    const hasSufficientHistory = completedDays.length >= 7;

    // Chronological train / validation split (first 75% train, last 25% test)
    let residualCorrectionFactor = 1.0;
    let maeKwh: number | null = null;
    let rmseKwh: number | null = null;
    let mapePct: number | null = null;
    let residualStdDev = 0;

    if (hasSufficientHistory) {
      const splitIdx = Math.max(3, Math.floor(completedDays.length * 0.75));
      const trainSet = completedDays.slice(0, splitIdx);
      const valSet = completedDays.slice(splitIdx);

      const trainRatios = trainSet
        .filter((d) => d.expectedEnergyKwh && d.expectedEnergyKwh > 10)
        .map((d) => d.energyKwh / (d.expectedEnergyKwh as number));

      if (trainRatios.length > 0) {
        const avgRatio = trainRatios.reduce((a, b) => a + b, 0) / trainRatios.length;
        // Blend physical baseline with historical performance residual (bounded 0.45..1.15)
        residualCorrectionFactor = Math.max(0.45, Math.min(1.15, avgRatio));
      }

      const valErrors: number[] = [];
      const valAbsPctErrors: number[] = [];
      for (const d of valSet) {
        const baseline = d.expectedEnergyKwh || inst.installedCapacityKwp * 4.2;
        const predicted = baseline * residualCorrectionFactor;
        const err = d.energyKwh - predicted;
        valErrors.push(err);
        if (d.energyKwh >= inst.installedCapacityKwp * 0.5) {
          valAbsPctErrors.push((Math.abs(err) / d.energyKwh) * 100);
        }
      }

      if (valErrors.length > 0) {
        maeKwh = Number(
          (valErrors.reduce((s, e) => s + Math.abs(e), 0) / valErrors.length).toFixed(2)
        );
        rmseKwh = Number(
          Math.sqrt(valErrors.reduce((s, e) => s + e * e, 0) / valErrors.length).toFixed(2)
        );
        const meanErr = valErrors.reduce((s, e) => s + e, 0) / valErrors.length;
        residualStdDev = Math.sqrt(
          valErrors.reduce((s, e) => s + (e - meanErr) ** 2, 0) / valErrors.length
        );
      }
      if (valAbsPctErrors.length > 0) {
        mapePct = Number(
          (valAbsPctErrors.reduce((s, p) => s + p, 0) / valAbsPctErrors.length).toFixed(1)
        );
      }
    }

    const siteInvs = await db
      .select()
      .from(inverters)
      .where(eq(inverters.installationId, inst.id));
    const onlineCapacity = siteInvs
      .filter((i) => i.operatingStatus !== 'OFFLINE' && i.operatingStatus !== 'FAULT')
      .reduce((s, i) => s + i.ratedCapacityKw, 0);
    const availabilityFactor =
      inst.installedCapacityKwp > 0
        ? Math.min(1, onlineCapacity / inst.installedCapacityKwp)
        : 1;

    const trainingStart = completedDays[0]?.localDate || generatedAt.toISOString().slice(0, 10);
    const trainingEnd =
      completedDays[completedDays.length - 1]?.localDate ||
      generatedAt.toISOString().slice(0, 10);
    const modelVersion = hasSufficientHistory
      ? 'Stage2-Physical+Residual-v1.0'
      : 'Stage1-PhysicalBaseline-Preliminary-v1.0';

    // Remove previous forecasts for this installation to keep forecast view current
    await db.delete(forecasts).where(eq(forecasts.installationId, inst.id));

    const newForecasts: Array<typeof forecasts.$inferInsert> = [];

    // 1. Hourly forecast (next 24 hours)
    const startHour = new Date(Math.ceil(generatedAt.getTime() / 3600000) * 3600000);
    let next24hSum = 0;

    for (let h = 0; h < 24; h += 1) {
      const targetTs = new Date(startHour.getTime() + h * 3600000);
      const elev = calculateSolarElevationRad(
        targetTs,
        inst.latitude || 22.57,
        inst.longitude || 88.36,
        inst.timezone
      );
      const sinElev = Math.max(0, Math.sin(elev));
      const ghi = sinElev > 0.01 ? SIMULATION_DEFAULTS.maxClearSkyGhiWm2 * sinElev * 0.88 : 0;
      const poa = calculatePoaIrradiance(
        ghi,
        elev,
        inst.panelTiltDeg,
        inst.panelOrientation
      );
      const tCell = 30 + 0.03 * poa;
      const tempFactor = Math.max(0, 1 + inst.tempCoefficient * (tCell - 25));
      const physicalHourlyKwh =
        inst.installedCapacityKwp *
        (poa / 1000) *
        tempFactor *
        inst.shadingFactor *
        (inst.performanceRatio / 0.88) *
        0.97 *
        availabilityFactor;

      const expectedKwh = Number((physicalHourlyKwh * residualCorrectionFactor).toFixed(2));
      next24hSum += expectedKwh;

      const hourlyUncertainty =
        hasSufficientHistory && expectedKwh > 0 ? Math.max(1.5, (residualStdDev / 8)) : null;

      newForecasts.push({
        organisationId,
        installationId: inst.id,
        generatedAt,
        targetTimestamp: targetTs,
        horizonType: 'HOURLY',
        expectedEnergyKwh: expectedKwh,
        confidenceLowKwh:
          hourlyUncertainty !== null ? Number(Math.max(0, expectedKwh - hourlyUncertainty).toFixed(2)) : null,
        confidenceHighKwh:
          hourlyUncertainty !== null ? Number((expectedKwh + hourlyUncertainty).toFixed(2)) : null,
        confidenceAvailable: hourlyUncertainty !== null,
        modelVersion,
        trainingPeriodStart: trainingStart,
        trainingPeriodEnd: trainingEnd,
        maeKwh,
        rmseKwh,
        mapePct,
        isPreliminary: !hasSufficientHistory,
        notes: hasSufficientHistory
          ? `Calibrated with ${completedDays.length} days of chronological history (availability ${(availabilityFactor * 100).toFixed(0)}%).`
          : 'Preliminary physical estimate only — fewer than 7 days of historical generation available.',
      });
    }

    // 2. Daily forecast (next 7 days)
    const dailyBaseKwh = Math.max(0, next24hSum);
    for (let d = 1; d <= 7; d += 1) {
      const targetTs = new Date(generatedAt.getTime() + d * 86400000);
      const expectedKwh = Number(dailyBaseKwh.toFixed(2));
      const ciHalf = hasSufficientHistory ? Math.max(expectedKwh * 0.08, 1.96 * residualStdDev) : null;

      newForecasts.push({
        organisationId,
        installationId: inst.id,
        generatedAt,
        targetTimestamp: targetTs,
        horizonType: 'DAILY',
        expectedEnergyKwh: expectedKwh,
        confidenceLowKwh:
          ciHalf !== null ? Number(Math.max(0, expectedKwh - ciHalf).toFixed(2)) : null,
        confidenceHighKwh:
          ciHalf !== null ? Number((expectedKwh + ciHalf).toFixed(2)) : null,
        confidenceAvailable: ciHalf !== null,
        modelVersion,
        trainingPeriodStart: trainingStart,
        trainingPeriodEnd: trainingEnd,
        maeKwh,
        rmseKwh,
        mapePct,
        isPreliminary: !hasSufficientHistory,
        notes: hasSufficientHistory
          ? 'Expected daily production with 95% residual confidence interval (not a guaranteed yield).'
          : 'Preliminary estimate: insufficient historical data for confidence intervals.',
      });
    }

    // 3. Weekly (next 4 weeks) & Monthly (next 3 months)
    for (let w = 1; w <= 4; w += 1) {
      const targetTs = new Date(generatedAt.getTime() + w * 7 * 86400000);
      const expectedKwh = Number((dailyBaseKwh * 7).toFixed(2));
      const ciHalf = hasSufficientHistory ? Math.sqrt(7) * 1.96 * residualStdDev : null;
      newForecasts.push({
        organisationId,
        installationId: inst.id,
        generatedAt,
        targetTimestamp: targetTs,
        horizonType: 'WEEKLY',
        expectedEnergyKwh: expectedKwh,
        confidenceLowKwh:
          ciHalf !== null ? Number(Math.max(0, expectedKwh - ciHalf).toFixed(2)) : null,
        confidenceHighKwh:
          ciHalf !== null ? Number((expectedKwh + ciHalf).toFixed(2)) : null,
        confidenceAvailable: ciHalf !== null,
        modelVersion,
        trainingPeriodStart: trainingStart,
        trainingPeriodEnd: trainingEnd,
        maeKwh,
        rmseKwh,
        mapePct,
        isPreliminary: !hasSufficientHistory,
        notes: 'Weekly projection based on physical irradiance curve and historical residual factor.',
      });
    }

    for (let m = 1; m <= 3; m += 1) {
      const targetTs = new Date(generatedAt.getTime() + m * 30 * 86400000);
      const expectedKwh = Number((dailyBaseKwh * 30).toFixed(2));
      const ciHalf = hasSufficientHistory ? Math.sqrt(30) * 1.96 * residualStdDev : null;
      newForecasts.push({
        organisationId,
        installationId: inst.id,
        generatedAt,
        targetTimestamp: targetTs,
        horizonType: 'MONTHLY',
        expectedEnergyKwh: expectedKwh,
        confidenceLowKwh:
          ciHalf !== null ? Number(Math.max(0, expectedKwh - ciHalf).toFixed(2)) : null,
        confidenceHighKwh:
          ciHalf !== null ? Number((expectedKwh + ciHalf).toFixed(2)) : null,
        confidenceAvailable: ciHalf !== null,
        modelVersion,
        trainingPeriodStart: trainingStart,
        trainingPeriodEnd: trainingEnd,
        maeKwh,
        rmseKwh,
        mapePct,
        isPreliminary: !hasSufficientHistory,
        notes: '30-day rolling monthly projection (estimate only, subject to weather variance).',
      });
    }

    await db.insert(forecasts).values(newForecasts);
    totalInserted += newForecasts.length;
  }

  return { installationsProcessed: insts.length, forecastsCreated: totalInserted };
}

export interface MaintenanceAssessment {
  problemSummary: string;
  supportingEvidence: string[];
  possibleExplanations: string[];
  recommendedInvestigation: string[];
  priority: string;
  confidence: 'Strong Evidence' | 'Limited Evidence' | 'Insufficient Information';
  safetyDisclaimer: string;
  generatedBy: 'Gemini AI' | 'Deterministic Rule Engine';
}

function buildDeterministicAssessment(params: {
  anomaly: typeof performanceAnomalies.$inferSelect;
  installation: typeof solarInstallations.$inferSelect;
  inverter?: typeof inverters.$inferSelect;
  recentMaintCount: number;
}): MaintenanceAssessment {
  const { anomaly, installation, inverter, recentMaintCount } = params;
  const evidence: string[] = [
    `Installation: ${installation.name} (${installation.installedCapacityKwp} kWp)`,
    `Observed measurement: ${anomaly.observedValue}`,
    `Expected baseline: ${anomaly.expectedBaseline}`,
    `Classification: ${anomaly.classification === 'CONFIRMED_EQUIPMENT_FAULT' ? 'Confirmed Equipment State / Fault Code' : 'Statistical Anomaly (Requires Field Verification)'}`,
  ];
  if (inverter) {
    evidence.push(
      `Equipment: ${inverter.name} (${inverter.inverterCode}), Status: ${inverter.operatingStatus}${inverter.faultCode ? `, Fault Code: ${inverter.faultCode}` : ''}`
    );
  }
  if (recentMaintCount > 0) {
    evidence.push(`Prior maintenance records on file: ${recentMaintCount} intervention(s)`);
  }

  const explanations: string[] = [];
  const steps: string[] = [];

  switch (anomaly.category) {
    case 'EXCESSIVE_TEMPERATURE':
      explanations.push(
        'Inverter thermal dissipation obstruction (clogged intake filters or dust accumulation)',
        'Cooling fan degradation or high ambient enclosure temperature'
      );
      steps.push(
        'Have a qualified technician visually inspect exterior cooling vents and airflow clearances.',
        'Review historical inverter temperature vs ambient temperature trends before scheduling shutdown service.'
      );
      break;
    case 'REPEATED_SHUTDOWN':
      explanations.push(
        'Grid/AC isolator trip or telemetry communication failure',
        'Inverter internal protection lockout indicated by reported fault code'
      );
      steps.push(
        'Have a licensed electrical technician check AC distribution breaker status and inverter front-panel fault logs.',
        'Verify RS-485/Ethernet gateway connectivity and local power supply.'
      );
      break;
    case 'UNEXPECTED_GENERATION_REDUCTION':
    case 'INVERTER_PEER_DEVIATION':
      explanations.push(
        'Array surface soiling or localized shading reducing effective irradiance',
        'DC string fuse, connector, or MPPT tracker imbalance (requires on-site verification)'
      );
      steps.push(
        'Perform visual inspection for module soiling, bird droppings, or nearby shading obstructions.',
        'Have a qualified technician review inverter DC string current/voltage telemetry via safe diagnostic tools.'
      );
      break;
    case 'ABNORMAL_VOLTAGE':
      explanations.push(
        'Utility grid voltage fluctuation outside normal 3-phase operating limits',
        'High AC line impedance or loose external grid termination'
      );
      steps.push(
        'Review utility feeder voltage readings at the main AC meter.',
        'Schedule a licensed electrical engineer to verify protection relay settings.'
      );
      break;
    default:
      explanations.push('Telemetry communication interruption or sensor reporting delay');
      steps.push('Check site data logger and gateway connectivity logs.');
  }

  return {
    problemSummary: `${anomaly.explanation}`,
    supportingEvidence: evidence,
    possibleExplanations: explanations,
    recommendedInvestigation: steps,
    priority: anomaly.severity,
    confidence:
      anomaly.classification === 'CONFIRMED_EQUIPMENT_FAULT'
        ? 'Strong Evidence'
        : 'Limited Evidence',
    safetyDisclaimer:
      'Decision support only — statistical anomalies do not confirm physical faults. Only qualified, licensed electrical personnel should inspect or service energized equipment.',
    generatedBy: 'Deterministic Rule Engine',
  };
}

export async function generateMaintenanceAssessment(
  organisationId: string,
  anomalyId: string
): Promise<MaintenanceAssessment> {
  const [anomaly] = await db
    .select()
    .from(performanceAnomalies)
    .where(
      and(
        eq(performanceAnomalies.organisationId, organisationId),
        eq(performanceAnomalies.id, anomalyId)
      )
    );
  if (!anomaly) {
    throw new Error('Anomaly not found.');
  }

  const [installation] = await db
    .select()
    .from(solarInstallations)
    .where(eq(solarInstallations.id, anomaly.installationId));
  if (!installation) {
    throw new Error('Installation not found.');
  }

  const [inverter] = anomaly.inverterId
    ? await db.select().from(inverters).where(eq(inverters.id, anomaly.inverterId))
    : [undefined];

  const prevRecords = await db
    .select()
    .from(maintenanceRecords)
    .where(
      and(
        eq(maintenanceRecords.organisationId, organisationId),
        eq(maintenanceRecords.installationId, anomaly.installationId)
      )
    )
    .orderBy(desc(maintenanceRecords.performedAt))
    .limit(5);

  const deterministic = buildDeterministicAssessment({
    anomaly,
    installation,
    inverter,
    recentMaintCount: prevRecords.length,
  });

  const ai = getGeminiClient();
  if (!ai) {
    await db
      .update(performanceAnomalies)
      .set({ aiAssessmentJson: deterministic as unknown as Record<string, unknown> })
      .where(eq(performanceAnomalies.id, anomaly.id));
    return deterministic;
  }

  try {
    const context = {
      installation: {
        name: installation.name,
        capacityKwp: installation.installedCapacityKwp,
        panelModel: `${installation.panelManufacturer} ${installation.panelModel}`,
        inverterModel: `${installation.inverterManufacturer} ${installation.inverterModel}`,
        shadingNotes: installation.shadingNotes,
      },
      inverter: inverter
        ? {
            code: inverter.inverterCode,
            status: inverter.operatingStatus,
            faultCode: inverter.faultCode,
            ratedCapacityKw: inverter.ratedCapacityKw,
          }
        : null,
      anomaly: {
        category: anomaly.category,
        classification: anomaly.classification,
        observedValue: anomaly.observedValue,
        expectedBaseline: anomaly.expectedBaseline,
        severity: anomaly.severity,
        explanation: anomaly.explanation,
        evidence: anomaly.evidenceJson,
      },
      previousMaintenance: prevRecords.map((r) => ({
        date: r.performedAt,
        type: r.recordType,
        findings: r.findings,
        workPerformed: r.workPerformed,
      })),
    };

    const prompt = `You are a solar plant reliability advisor. Analyze ONLY the supplied database evidence and return valid JSON matching this schema:
{
  "problemSummary": "string",
  "supportingEvidence": ["string"],
  "possibleExplanations": ["string"],
  "recommendedInvestigation": ["string"],
  "priority": "Informational | Low | Medium | High | Critical",
  "confidence": "Strong Evidence | Limited Evidence | Insufficient Information"
}
Rules:
1. Never claim a physical fault is confirmed purely from a statistical anomaly.
2. Only list explanations supported by the provided readings/evidence.
3. Never instruct unqualified users to open electrical enclosures or perform dangerous electrical repairs — always recommend qualified technician inspection.
4. Do not invent readings or numbers not present in context.

Context JSON:
${JSON.stringify(context)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    const result: MaintenanceAssessment = {
      problemSummary: parsed.problemSummary || deterministic.problemSummary,
      supportingEvidence: Array.isArray(parsed.supportingEvidence) && parsed.supportingEvidence.length > 0
        ? parsed.supportingEvidence
        : deterministic.supportingEvidence,
      possibleExplanations: Array.isArray(parsed.possibleExplanations) && parsed.possibleExplanations.length > 0
        ? parsed.possibleExplanations
        : deterministic.possibleExplanations,
      recommendedInvestigation: Array.isArray(parsed.recommendedInvestigation) && parsed.recommendedInvestigation.length > 0
        ? parsed.recommendedInvestigation
        : deterministic.recommendedInvestigation,
      priority: parsed.priority || deterministic.priority,
      confidence: parsed.confidence || deterministic.confidence,
      safetyDisclaimer: deterministic.safetyDisclaimer,
      generatedBy: 'Gemini AI',
    };

    await db
      .update(performanceAnomalies)
      .set({ aiAssessmentJson: result as unknown as Record<string, unknown> })
      .where(eq(performanceAnomalies.id, anomaly.id));

    return result;
  } catch (err) {
    console.warn('Gemini maintenance assessment fallback used:', err);
    await db
      .update(performanceAnomalies)
      .set({ aiAssessmentJson: deterministic as unknown as Record<string, unknown> })
      .where(eq(performanceAnomalies.id, anomaly.id));
    return deterministic;
  }
}

export async function answerAssistantQuestion(
  organisationId: string,
  question: string
): Promise<{
  answer: string;
  mode: 'Gemini AI (Grounded)' | 'Deterministic Database Engine';
  citedFacts: Array<{ label: string; value: string }>;
}> {
  // Always retrieve authoritative database facts & computed aggregations in the backend first
  const insts = await db
    .select()
    .from(solarInstallations)
    .where(eq(solarInstallations.organisationId, organisationId));

  const invs = await db
    .select()
    .from(inverters)
    .where(eq(inverters.organisationId, organisationId));

  const now = new Date();
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const dailyRows = await db
    .select()
    .from(dailyEnergyAggregates)
    .where(
      and(
        eq(dailyEnergyAggregates.organisationId, organisationId),
        gte(dailyEnergyAggregates.localDate, monthStart)
      )
    );

  const allDaily = await db
    .select()
    .from(dailyEnergyAggregates)
    .where(eq(dailyEnergyAggregates.organisationId, organisationId));

  const recentTelemetry = await db
    .select()
    .from(telemetryReadings)
    .where(
      and(
        eq(telemetryReadings.organisationId, organisationId),
        gte(telemetryReadings.measuredAt, sevenDaysAgo)
      )
    )
    .orderBy(desc(telemetryReadings.measuredAt))
    .limit(1500);

  const activeAnomalies = await db
    .select()
    .from(performanceAnomalies)
    .where(eq(performanceAnomalies.organisationId, organisationId))
    .orderBy(desc(performanceAnomalies.detectedAt));

  const activeAlerts = await db
    .select()
    .from(alerts)
    .where(eq(alerts.organisationId, organisationId))
    .orderBy(desc(alerts.triggeredAt));

  const tasks = await db
    .select()
    .from(maintenanceTasks)
    .where(eq(maintenanceTasks.organisationId, organisationId));

  // Pre-compute backend metrics accurately
  const monthEnergyByInst = new Map<string, number>();
  const total30dEnergyByInst = new Map<string, { actual: number; expected: number }>();

  for (const d of dailyRows) {
    monthEnergyByInst.set(
      d.installationId,
      (monthEnergyByInst.get(d.installationId) || 0) + d.energyKwh
    );
  }
  for (const d of allDaily) {
    const cur = total30dEnergyByInst.get(d.installationId) || { actual: 0, expected: 0 };
    cur.actual += d.energyKwh;
    cur.expected += d.expectedEnergyKwh || 0;
    total30dEnergyByInst.set(d.installationId, cur);
  }

  const totalMonthKwh = Array.from(monthEnergyByInst.values()).reduce((a, b) => a + b, 0);
  const totalCapacityKwp = insts.reduce((s, i) => s + i.installedCapacityKwp, 0);

  // Average inverter temperatures from recent telemetry
  const invTempAgg = new Map<string, { sum: number; count: number }>();
  for (const t of recentTelemetry) {
    if (t.temperatureC !== null) {
      const cur = invTempAgg.get(t.inverterId) || { sum: 0, count: 0 };
      cur.sum += t.temperatureC;
      cur.count += 1;
      invTempAgg.set(t.inverterId, cur);
    }
  }
  let highestAvgTempInv: { name: string; code: string; avgTempC: number; site: string } | null = null;
  for (const inv of invs) {
    const agg = invTempAgg.get(inv.id);
    if (agg && agg.count > 0) {
      const avg = agg.sum / agg.count;
      if (!highestAvgTempInv || avg > highestAvgTempInv.avgTempC) {
        const siteName = insts.find((i) => i.id === inv.installationId)?.name || 'Unknown';
        highestAvgTempInv = {
          name: inv.name,
          code: inv.inverterCode,
          avgTempC: Number(avg.toFixed(1)),
          site: siteName,
        };
      }
    }
  }

  const instSummary = insts.map((i) => {
    const t30 = total30dEnergyByInst.get(i.id) || { actual: 0, expected: 0 };
    const perfPct = t30.expected > 0 ? Number(((t30.actual / t30.expected) * 100).toFixed(1)) : null;
    return {
      id: i.id,
      name: i.name,
      capacityKwp: i.installedCapacityKwp,
      operationalStatus: i.operationalStatus,
      thisMonthKwh: Number((monthEnergyByInst.get(i.id) || 0).toFixed(1)),
      historical30dActualKwh: Number(t30.actual.toFixed(1)),
      historical30dExpectedKwh: Number(t30.expected.toFixed(1)),
      performanceVsExpectedPct: perfPct,
    };
  });

  const openAlerts = activeAlerts.filter(
    (a) => a.status !== 'Resolved' && a.status !== 'Dismissed'
  );
  const unresolvedTasks = tasks.filter(
    (t) => t.status !== 'Completed' && t.status !== 'Cancelled'
  );
  const weekAnomalies = activeAnomalies.filter(
    (a) => new Date(a.detectedAt).getTime() >= sevenDaysAgo.getTime()
  );

  const citedFacts: Array<{ label: string; value: string }> = [
    { label: 'Portfolio Capacity', value: `${totalCapacityKwp.toFixed(1)} kWp across ${insts.length} sites` },
    { label: 'Month-to-Date Generation', value: `${totalMonthKwh.toFixed(1)} kWh` },
    { label: 'Active Open Alerts', value: `${openAlerts.length}` },
    { label: 'Unresolved Maintenance Tasks', value: `${unresolvedTasks.length}` },
  ];

  if (highestAvgTempInv) {
    citedFacts.push({
      label: 'Highest Avg Inverter Temp (7d)',
      value: `${highestAvgTempInv.code} (${highestAvgTempInv.avgTempC} °C)`,
    });
  }

  const groundedContext = {
    portfolioTotals: {
      installationsCount: insts.length,
      totalCapacityKwp,
      thisMonthEnergyKwh: Number(totalMonthKwh.toFixed(2)),
      invertersOnline: invs.filter((i) => i.operatingStatus === 'ONLINE').length,
      invertersTotal: invs.length,
    },
    installations: instSummary,
    highestAvgTemperatureInverter: highestAvgTempInv,
    recentAnomaliesThisWeek: weekAnomalies.slice(0, 10).map((a) => ({
      installation: insts.find((i) => i.id === a.installationId)?.name || a.installationId,
      category: a.category,
      classification: a.classification,
      severity: a.severity,
      observedValue: a.observedValue,
      expectedBaseline: a.expectedBaseline,
      explanation: a.explanation,
    })),
    openAlerts: openAlerts.slice(0, 10).map((a) => ({
      code: a.alertCode,
      installation: insts.find((i) => i.id === a.installationId)?.name || a.installationId,
      severity: a.severity,
      title: a.title,
      status: a.status,
    })),
    unresolvedMaintenanceTasks: unresolvedTasks.map((t) => ({
      title: t.title,
      installation: insts.find((i) => i.id === t.installationId)?.name || t.installationId,
      priority: t.priority,
      status: t.status,
      dueDate: t.dueDate,
    })),
  };

  // Deterministic fallback responder
  const buildDeterministicReply = () => {
    const q = question.toLowerCase();
    const lines: string[] = [];

    if (q.includes('month') || q.includes('how much') || q.includes('generate')) {
      lines.push(
        `Your portfolio of ${insts.length} installations (${totalCapacityKwp} kWp total) generated ${totalMonthKwh.toFixed(1)} kWh month-to-date from stored records.`
      );
    }
    if (q.includes('underperform') || q.includes('investigate') || q.includes('worst')) {
      const flagged = instSummary.filter(
        (i) =>
          i.operationalStatus !== 'Operational' ||
          (i.performanceVsExpectedPct !== null && i.performanceVsExpectedPct < 85)
      );
      if (flagged.length > 0) {
        lines.push(
          `Installations requiring investigation first: ${flagged
            .map(
              (f) =>
                `${f.name} (${f.operationalStatus}${
                  f.performanceVsExpectedPct !== null
                    ? `, ${f.performanceVsExpectedPct}% of expected`
                    : ''
                })`
            )
            .join('; ')}.`
        );
      } else {
        lines.push('All installations are currently tracking within expected performance thresholds.');
      }
    }
    if (q.includes('temp') || q.includes('hot') || q.includes('overheat')) {
      if (highestAvgTempInv) {
        lines.push(
          `Highest 7-day average inverter temperature is ${highestAvgTempInv.name} (${highestAvgTempInv.code}) at ${highestAvgTempInv.site} with ${highestAvgTempInv.avgTempC} °C.`
        );
      } else {
        lines.push('No inverter temperature telemetry is available for the requested period.');
      }
    }
    if (q.includes('anomal')) {
      if (weekAnomalies.length > 0) {
        lines.push(
          `${weekAnomalies.length} anomalies were recorded this week: ${weekAnomalies
            .slice(0, 5)
            .map(
              (a) =>
                `[${a.severity}] ${insts.find((i) => i.id === a.installationId)?.name}: ${a.category} (${a.observedValue})`
            )
            .join('; ')}.`
        );
      } else {
        lines.push('No anomalies have been recorded in the past 7 days.');
      }
    }
    if (q.includes('task') || q.includes('maint') || q.includes('unresolved')) {
      if (unresolvedTasks.length > 0) {
        lines.push(
          `${unresolvedTasks.length} unresolved maintenance tasks: ${unresolvedTasks
            .map((t) => `${t.title} [${t.priority} · ${t.status}, due ${t.dueDate}]`)
            .join('; ')}.`
        );
      } else {
        lines.push('All maintenance tasks are currently resolved or completed.');
      }
    }
    if (q.includes('compare')) {
      lines.push(
        `Site comparison (30d actual vs expected): ${instSummary
          .map(
            (i) =>
              `${i.name}: ${i.historical30dActualKwh} kWh actual / ${i.historical30dExpectedKwh} kWh expected (${i.performanceVsExpectedPct ?? 'N/A'}%)`
          )
          .join(' | ')}.`
      );
    }

    if (lines.length === 0) {
      lines.push(
        `Portfolio summary: ${insts.length} installations (${totalCapacityKwp} kWp), ${totalMonthKwh.toFixed(1)} kWh generated this month, ${openAlerts.length} active alerts, and ${unresolvedTasks.length} unresolved maintenance tasks.`
      );
      const flagged = instSummary.filter((i) => i.operationalStatus !== 'Operational');
      if (flagged.length > 0) {
        lines.push(
          `Priority attention sites: ${flagged
            .map((f) => `${f.name} (${f.operationalStatus})`)
            .join(', ')}.`
        );
      }
    }

    return lines.join('\n\n');
  };

  const ai = getGeminiClient();
  if (!ai) {
    return {
      answer: buildDeterministicReply(),
      mode: 'Deterministic Database Engine',
      citedFacts,
    };
  }

  try {
    const prompt = `You are the Solar Intelligence System assistant for an enterprise solar operator.
Answer the user's question strictly using the authoritative database context JSON below.
Rules:
- Never invent measurements, fault codes, dates, or generation figures.
- If requested information is missing from the context, explicitly state that it is unavailable in stored records.
- Clearly distinguish simulated/demonstration records if asked, and never instruct unqualified personnel to perform dangerous electrical repairs.
- Keep your answer crisp, structured, and executive-ready.

Database Context:
${JSON.stringify(groundedContext)}

User Question: ${question}`;

    const resp = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
    });

    const text = (resp.text ?? '').trim();
    if (!text) {
      return {
        answer: buildDeterministicReply(),
        mode: 'Deterministic Database Engine',
        citedFacts,
      };
    }

    return {
      answer: text,
      mode: 'Gemini AI (Grounded)',
      citedFacts,
    };
  } catch (err) {
    console.warn('Gemini assistant fallback used:', err);
    return {
      answer: buildDeterministicReply(),
      mode: 'Deterministic Database Engine',
      citedFacts,
    };
  }
}
