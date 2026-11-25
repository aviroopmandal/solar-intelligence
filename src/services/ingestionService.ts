import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  dailyEnergyAggregates,
  dataSources,
  inverters,
  solarInstallations,
  telemetryImportBatches,
  telemetryImportErrors,
  telemetryReadings,
  weatherReadings,
} from '../db/schema.ts';

export type CsvTemplateType = 'INVERTER_TELEMETRY' | 'DAILY_ENERGY' | 'WEATHER';

export const CSV_TEMPLATE_HEADERS: Record<CsvTemplateType, string[]> = {
  INVERTER_TELEMETRY: [
    'timestamp',
    'installation_id',
    'inverter_id',
    'ac_power_kw',
    'dc_power_kw',
    'daily_energy_kwh',
    'cumulative_energy_kwh',
    'voltage_v',
    'current_a',
    'temperature_c',
    'operating_status',
    'fault_code',
  ],
  DAILY_ENERGY: [
    'date',
    'installation_id',
    'energy_kwh',
    'measurement_type',
    'source_timezone',
  ],
  WEATHER: [
    'timestamp',
    'installation_id',
    'ghi_w_m2',
    'poa_w_m2',
    'ambient_temperature_c',
    'cloud_cover_percent',
    'weather_condition',
  ],
};

export function generateCsvTemplateContent(
  type: CsvTemplateType,
  sampleInstallationId = '00000000-0000-0000-0000-000000000001',
  sampleInverterId = '00000000-0000-0000-0000-000000000002'
): string {
  const header = CSV_TEMPLATE_HEADERS[type].join(',');
  if (type === 'INVERTER_TELEMETRY') {
    return `${header}\n2026-11-24T06:30:00Z,${sampleInstallationId},${sampleInverterId},32.45,33.50,45.20,12450.80,402.1,46.6,41.2,ONLINE,\n`;
  }
  if (type === 'DAILY_ENERGY') {
    return `${header}\n2026-11-24,${sampleInstallationId},842.50,MEASURED,Asia/Kolkata\n`;
  }
  return `${header}\n2026-11-24T06:30:00Z,${sampleInstallationId},720.5,765.2,29.4,15,Clear\n`;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isValidIsoTimestampWithOffset(value: string): Date | null {
  if (!value) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

function isValidIanaTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface CsvImportValidationRowError {
  rowNumber: number;
  rawRow: Record<string, string>;
  errorMessage: string;
}

export interface CsvPreviewResult {
  templateType: CsvTemplateType;
  filename: string;
  fileSizeBytes: number;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  conflictingDuplicateCount: number;
  headersValid: boolean;
  headerError?: string;
  previewRows: Array<{
    rowNumber: number;
    status: 'VALID' | 'INVALID' | 'DUPLICATE_IDENTICAL' | 'DUPLICATE_CONFLICT';
    warnings: string[];
    errorMessage?: string;
    data: Record<string, string>;
  }>;
  errors: CsvImportValidationRowError[];
}

export async function processCsvImport(params: {
  organisationId: string;
  userId: string;
  templateType: CsvTemplateType;
  filename: string;
  csvText: string;
  installationIdFilter?: string;
  commit: boolean;
}): Promise<CsvPreviewResult & { batchId?: string }> {
  const { organisationId, userId, templateType, filename, csvText, installationIdFilter, commit } =
    params;

  const byteSize = Buffer.byteLength(csvText, 'utf8');
  if (byteSize > 10 * 1024 * 1024) {
    throw new Error('CSV file exceeds maximum allowed upload size of 10 MB.');
  }

  const rawLines = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (rawLines.length < 2) {
    throw new Error('CSV file must include a header row and at least one data row.');
  }

  if (rawLines.length - 1 > 100000) {
    throw new Error('CSV file exceeds maximum row count of 100,000 records per import.');
  }

  const expectedHeaders = CSV_TEMPLATE_HEADERS[templateType];
  const actualHeaders = parseCsvLine(rawLines[0]);

  const headersMatch =
    actualHeaders.length === expectedHeaders.length &&
    actualHeaders.every((h, idx) => h === expectedHeaders[idx]);

  if (!headersMatch) {
    return {
      templateType,
      filename,
      fileSizeBytes: byteSize,
      totalRows: rawLines.length - 1,
      validCount: 0,
      invalidCount: rawLines.length - 1,
      duplicateCount: 0,
      conflictingDuplicateCount: 0,
      headersValid: false,
      headerError: `Header mismatch. Expected exact columns: ${expectedHeaders.join(',')}`,
      previewRows: [],
      errors: [
        {
          rowNumber: 1,
          rawRow: { header: rawLines[0] },
          errorMessage: `Unexpected or missing columns. Expected: ${expectedHeaders.join(',')}`,
        },
      ],
    };
  }

  // Load organisation installations and inverters for strict ownership & physical bounds checks
  const orgInsts = await db
    .select()
    .from(solarInstallations)
    .where(eq(solarInstallations.organisationId, organisationId));
  const instMap = new Map(orgInsts.map((i) => [i.id, i]));

  const orgInvs = await db
    .select()
    .from(inverters)
    .where(eq(inverters.organisationId, organisationId));
  const invMap = new Map(orgInvs.map((inv) => [inv.id, inv]));

  // Ensure CSV data source exists for this org
  let [csvSource] = await db
    .select()
    .from(dataSources)
    .where(
      and(eq(dataSources.organisationId, organisationId), eq(dataSources.sourceType, 'CSV_IMPORT'))
    );
  if (!csvSource) {
    [csvSource] = await db
      .insert(dataSources)
      .values({
        organisationId,
        name: 'Historical CSV Ingestion Pipeline',
        sourceType: 'CSV_IMPORT',
        provider: 'UTF-8 Batch Importer',
        connectionStatus: 'OPERATIONAL',
        pollingIntervalSec: 0,
      })
      .returning();
  }

  const now = new Date();
  const maxFutureMs = now.getTime() + 15 * 60000;

  const validTelemetryRows: Array<typeof telemetryReadings.$inferInsert> = [];
  const validDailyRows: Array<typeof dailyEnergyAggregates.$inferInsert> = [];
  const validWeatherRows: Array<typeof weatherReadings.$inferInsert> = [];
  const errors: CsvImportValidationRowError[] = [];
  const previewRows: CsvPreviewResult['previewRows'] = [];

  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;
  let conflictingDuplicateCount = 0;

  // Track seen keys inside the same CSV file
  const seenInFile = new Set<string>();

  for (let i = 1; i < rawLines.length; i += 1) {
    const rowNumber = i + 1;
    const cells = parseCsvLine(rawLines[i]);
    const rowObj: Record<string, string> = {};
    expectedHeaders.forEach((h, idx) => {
      rowObj[h] = cells[idx] ?? '';
    });

    if (cells.length !== expectedHeaders.length) {
      invalidCount += 1;
      const msg = `Row ${rowNumber}: Expected ${expectedHeaders.length} columns, found ${cells.length}.`;
      errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
      if (previewRows.length < 100) {
        previewRows.push({ rowNumber, status: 'INVALID', warnings: [], errorMessage: msg, data: rowObj });
      }
      continue;
    }

    const inst = instMap.get(rowObj.installation_id);
    if (!inst) {
      invalidCount += 1;
      const msg = `Row ${rowNumber}: installation_id "${rowObj.installation_id}" not found in active organisation.`;
      errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
      if (previewRows.length < 100) {
        previewRows.push({ rowNumber, status: 'INVALID', warnings: [], errorMessage: msg, data: rowObj });
      }
      continue;
    }

    if (installationIdFilter && inst.id !== installationIdFilter) {
      invalidCount += 1;
      const msg = `Row ${rowNumber}: installation_id does not match selected target installation.`;
      errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
      if (previewRows.length < 100) {
        previewRows.push({ rowNumber, status: 'INVALID', warnings: [], errorMessage: msg, data: rowObj });
      }
      continue;
    }

    const warnings: string[] = [];

    if (templateType === 'INVERTER_TELEMETRY') {
      const ts = isValidIsoTimestampWithOffset(rowObj.timestamp);
      if (!ts) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: timestamp must be ISO 8601 with UTC offset or Z.`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }
      if (ts.getTime() > maxFutureMs) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: timestamp is unreasonably far in the future.`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }

      const inv = invMap.get(rowObj.inverter_id);
      if (!inv || inv.installationId !== inst.id) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: inverter_id "${rowObj.inverter_id}" does not belong to installation "${inst.id}".`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }

      const acPower = Number(rowObj.ac_power_kw);
      if (rowObj.ac_power_kw === '' || Number.isNaN(acPower) || acPower < 0) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: ac_power_kw must be a non-negative decimal.`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }
      if (acPower > inv.ratedCapacityKw * 1.15) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: ac_power_kw (${acPower} kW) exceeds hard physical equipment limit (${(inv.ratedCapacityKw * 1.15).toFixed(1)} kW).`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }
      if (acPower > inv.ratedCapacityKw) {
        warnings.push('Power exceeds rated capacity within transient tolerance (<=115%)');
      }

      const parseOptNonNeg = (v: string, field: string): number | null | 'ERR' => {
        if (v === '') return null;
        const n = Number(v);
        if (Number.isNaN(n) || n < 0) {
          errors.push({
            rowNumber,
            rawRow: rowObj,
            errorMessage: `Row ${rowNumber}: ${field} must be a non-negative decimal.`,
          });
          return 'ERR';
        }
        return n;
      };
      const parseOptNum = (v: string, field: string): number | null | 'ERR' => {
        if (v === '') return null;
        const n = Number(v);
        if (Number.isNaN(n)) {
          errors.push({
            rowNumber,
            rawRow: rowObj,
            errorMessage: `Row ${rowNumber}: ${field} must be a valid decimal.`,
          });
          return 'ERR';
        }
        return n;
      };

      const dcPower = parseOptNonNeg(rowObj.dc_power_kw, 'dc_power_kw');
      const dailyEnergy = parseOptNonNeg(rowObj.daily_energy_kwh, 'daily_energy_kwh');
      const cumEnergy = parseOptNonNeg(rowObj.cumulative_energy_kwh, 'cumulative_energy_kwh');
      const voltageV = parseOptNum(rowObj.voltage_v, 'voltage_v');
      const currentA = parseOptNum(rowObj.current_a, 'current_a');
      const tempC = parseOptNum(rowObj.temperature_c, 'temperature_c');

      if (
        dcPower === 'ERR' ||
        dailyEnergy === 'ERR' ||
        cumEnergy === 'ERR' ||
        voltageV === 'ERR' ||
        currentA === 'ERR' ||
        tempC === 'ERR'
      ) {
        invalidCount += 1;
        if (previewRows.length < 100) {
          previewRows.push({
            rowNumber,
            status: 'INVALID',
            warnings,
            errorMessage: errors[errors.length - 1]?.errorMessage,
            data: rowObj,
          });
        }
        continue;
      }

      const validStatuses = ['ONLINE', 'OFFLINE', 'WARNING', 'FAULT', 'UNKNOWN'];
      if (!validStatuses.includes(rowObj.operating_status)) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: operating_status must be one of ${validStatuses.join(', ')}.`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }

      if (voltageV !== null && (voltageV < 320 || voltageV > 475) && rowObj.operating_status !== 'OFFLINE') {
        warnings.push('Voltage outside normal operating limits (320-475V)');
      }
      if (tempC !== null && tempC > 70) {
        warnings.push('Temperature exceeds warning threshold (>70°C)');
      }

      const idempKey = `${inv.id}|${ts.toISOString()}`;
      if (seenInFile.has(idempKey)) {
        duplicateCount += 1;
        if (previewRows.length < 100) {
          previewRows.push({
            rowNumber,
            status: 'DUPLICATE_IDENTICAL',
            warnings: ['Duplicate timestamp in uploaded CSV'],
            data: rowObj,
          });
        }
        continue;
      }
      seenInFile.add(idempKey);

      // Check existing DB reading for idempotency conflict check
      const existing = await db
        .select()
        .from(telemetryReadings)
        .where(
          and(
            eq(telemetryReadings.organisationId, organisationId),
            eq(telemetryReadings.inverterId, inv.id),
            eq(telemetryReadings.dataSourceId, csvSource.id),
            eq(telemetryReadings.measuredAt, ts)
          )
        );

      if (existing.length > 0) {
        const prev = existing[0];
        const isConflicting =
          prev.acPowerKw !== acPower ||
          prev.operatingStatus !== rowObj.operating_status;
        if (isConflicting) {
          conflictingDuplicateCount += 1;
          const msg = `Row ${rowNumber}: Conflicting duplicate reading at ${ts.toISOString()} (existing AC=${prev.acPowerKw} kW vs CSV AC=${acPower} kW). Existing record preserved.`;
          errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
          if (previewRows.length < 100) {
            previewRows.push({
              rowNumber,
              status: 'DUPLICATE_CONFLICT',
              warnings,
              errorMessage: msg,
              data: rowObj,
            });
          }
        } else {
          duplicateCount += 1;
          if (previewRows.length < 100) {
            previewRows.push({
              rowNumber,
              status: 'DUPLICATE_IDENTICAL',
              warnings: ['Already imported — skipped idempotently'],
              data: rowObj,
            });
          }
        }
        continue;
      }

      validCount += 1;
      const qualityStatus = warnings.length > 0 ? 'UNDER_REVIEW' : 'VALID';
      validTelemetryRows.push({
        organisationId,
        installationId: inst.id,
        inverterId: inv.id,
        dataSourceId: csvSource.id,
        sourceType: 'IMPORTED',
        measuredAt: ts,
        receivedAt: now,
        acPowerKw: acPower,
        dcPowerKw: dcPower,
        dailyEnergyKwh: dailyEnergy,
        cumulativeEnergyKwh: cumEnergy,
        voltageV,
        currentA,
        temperatureC: tempC,
        operatingStatus: rowObj.operating_status,
        faultCode: rowObj.fault_code || null,
        qualityStatus,
        qualityFlags: warnings,
      });

      if (previewRows.length < 100) {
        previewRows.push({ rowNumber, status: 'VALID', warnings, data: rowObj });
      }
    } else if (templateType === 'DAILY_ENERGY') {
      if (!isValidIsoDate(rowObj.date)) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: date must be a valid ISO 8601 calendar date (YYYY-MM-DD).`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }

      const energyKwh = Number(rowObj.energy_kwh);
      if (rowObj.energy_kwh === '' || Number.isNaN(energyKwh) || energyKwh < 0) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: energy_kwh must be a non-negative decimal.`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }

      if (rowObj.measurement_type !== 'MEASURED' && rowObj.measurement_type !== 'ESTIMATED') {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: measurement_type must be MEASURED or ESTIMATED.`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }

      if (!isValidIanaTimezone(rowObj.source_timezone)) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: source_timezone "${rowObj.source_timezone}" is not a valid IANA time zone identifier.`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }

      const key = `${inst.id}|${rowObj.date}|${rowObj.measurement_type}`;
      if (seenInFile.has(key)) {
        duplicateCount += 1;
        if (previewRows.length < 100) {
          previewRows.push({
            rowNumber,
            status: 'DUPLICATE_IDENTICAL',
            warnings: ['Duplicate daily entry in file'],
            data: rowObj,
          });
        }
        continue;
      }
      seenInFile.add(key);

      const existing = await db
        .select()
        .from(dailyEnergyAggregates)
        .where(
          and(
            eq(dailyEnergyAggregates.installationId, inst.id),
            eq(dailyEnergyAggregates.localDate, rowObj.date),
            eq(dailyEnergyAggregates.measurementType, rowObj.measurement_type),
            eq(dailyEnergyAggregates.dataSourceId, csvSource.id)
          )
        );
      if (existing.length > 0) {
        if (existing[0].energyKwh !== energyKwh) {
          conflictingDuplicateCount += 1;
          const msg = `Row ${rowNumber}: Conflicting duplicate daily energy for ${rowObj.date} (${existing[0].energyKwh} vs ${energyKwh} kWh).`;
          errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
          if (previewRows.length < 100) {
            previewRows.push({
              rowNumber,
              status: 'DUPLICATE_CONFLICT',
              warnings,
              errorMessage: msg,
              data: rowObj,
            });
          }
        } else {
          duplicateCount += 1;
          if (previewRows.length < 100) {
            previewRows.push({
              rowNumber,
              status: 'DUPLICATE_IDENTICAL',
              warnings: ['Already imported — skipped idempotently'],
              data: rowObj,
            });
          }
        }
        continue;
      }

      validCount += 1;
      validDailyRows.push({
        organisationId,
        installationId: inst.id,
        localDate: rowObj.date,
        sourceTimezone: rowObj.source_timezone,
        energyKwh,
        expectedEnergyKwh: null,
        counterDerivedKwh: energyKwh,
        integratedPowerKwh: null,
        measurementType: rowObj.measurement_type,
        sourceType: 'IMPORTED',
        dataCompletenessPct: 100,
        dataSourceId: csvSource.id,
      });

      if (previewRows.length < 100) {
        previewRows.push({ rowNumber, status: 'VALID', warnings, data: rowObj });
      }
    } else {
      // WEATHER
      const ts = isValidIsoTimestampWithOffset(rowObj.timestamp);
      if (!ts || ts.getTime() > maxFutureMs) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: invalid or future ISO 8601 timestamp with UTC offset or Z.`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }

      const ghi = rowObj.ghi_w_m2 === '' ? null : Number(rowObj.ghi_w_m2);
      const poa = rowObj.poa_w_m2 === '' ? null : Number(rowObj.poa_w_m2);
      const amb = rowObj.ambient_temperature_c === '' ? null : Number(rowObj.ambient_temperature_c);
      const cloud = rowObj.cloud_cover_percent === '' ? null : Number(rowObj.cloud_cover_percent);

      if (
        (ghi !== null && (Number.isNaN(ghi) || ghi < 0)) ||
        (poa !== null && (Number.isNaN(poa) || poa < 0)) ||
        (amb !== null && Number.isNaN(amb)) ||
        (cloud !== null && (Number.isNaN(cloud) || cloud < 0 || cloud > 100))
      ) {
        invalidCount += 1;
        const msg = `Row ${rowNumber}: numeric weather field out of valid physical bounds.`;
        errors.push({ rowNumber, rawRow: rowObj, errorMessage: msg });
        if (previewRows.length < 100) {
          previewRows.push({ rowNumber, status: 'INVALID', warnings, errorMessage: msg, data: rowObj });
        }
        continue;
      }

      const key = `${inst.id}|${ts.toISOString()}`;
      if (seenInFile.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seenInFile.add(key);

      const existing = await db
        .select()
        .from(weatherReadings)
        .where(
          and(
            eq(weatherReadings.installationId, inst.id),
            eq(weatherReadings.dataSourceId, csvSource.id),
            eq(weatherReadings.measuredAt, ts)
          )
        );
      if (existing.length > 0) {
        duplicateCount += 1;
        if (previewRows.length < 100) {
          previewRows.push({
            rowNumber,
            status: 'DUPLICATE_IDENTICAL',
            warnings: ['Already imported — skipped idempotently'],
            data: rowObj,
          });
        }
        continue;
      }

      validCount += 1;
      validWeatherRows.push({
        organisationId,
        installationId: inst.id,
        dataSourceId: csvSource.id,
        sourceType: 'IMPORTED',
        measuredAt: ts,
        ghiWm2: ghi,
        poaWm2: poa,
        ambientTemperatureC: amb,
        cloudCoverPercent: cloud,
        weatherCondition: rowObj.weather_condition || null,
      });

      if (previewRows.length < 100) {
        previewRows.push({ rowNumber, status: 'VALID', warnings, data: rowObj });
      }
    }
  }

  let batchId: string | undefined;

  if (commit) {
    batchId = await db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(telemetryImportBatches)
        .values({
          organisationId,
          installationId: installationIdFilter || null,
          uploadedByUserId: userId,
          templateType,
          filename,
          fileSizeBytes: byteSize,
          totalRows: rawLines.length - 1,
          acceptedRows: validCount,
          rejectedRows: invalidCount + conflictingDuplicateCount,
          duplicateRows: duplicateCount,
          status: validCount > 0 ? 'COMPLETED' : 'FAILED',
        })
        .returning();

      if (validTelemetryRows.length > 0) {
        for (let idx = 0; idx < validTelemetryRows.length; idx += 300) {
          await tx
            .insert(telemetryReadings)
            .values(
              validTelemetryRows.slice(idx, idx + 300).map((r) => ({ ...r, importBatchId: batch.id }))
            )
            .onConflictDoNothing();
        }
      }

      if (validDailyRows.length > 0) {
        for (let idx = 0; idx < validDailyRows.length; idx += 300) {
          await tx
            .insert(dailyEnergyAggregates)
            .values(validDailyRows.slice(idx, idx + 300))
            .onConflictDoNothing();
        }
      }

      if (validWeatherRows.length > 0) {
        for (let idx = 0; idx < validWeatherRows.length; idx += 300) {
          await tx
            .insert(weatherReadings)
            .values(
              validWeatherRows.slice(idx, idx + 300).map((r) => ({ ...r, importBatchId: batch.id }))
            )
            .onConflictDoNothing();
        }
      }

      if (errors.length > 0) {
        for (let idx = 0; idx < errors.length; idx += 300) {
          await tx.insert(telemetryImportErrors).values(
            errors.slice(idx, idx + 300).map((e) => ({
              batchId: batch.id,
              organisationId,
              rowNumber: e.rowNumber,
              rawRow: e.rawRow,
              errorMessage: e.errorMessage,
            }))
          );
        }
      }

      return batch.id;
    });
  }

  return {
    batchId,
    templateType,
    filename,
    fileSizeBytes: byteSize,
    totalRows: rawLines.length - 1,
    validCount,
    invalidCount: invalidCount + conflictingDuplicateCount,
    duplicateCount,
    conflictingDuplicateCount,
    headersValid: true,
    previewRows,
    errors,
  };
}

export async function listImportBatches(organisationId: string) {
  return await db
    .select()
    .from(telemetryImportBatches)
    .where(eq(telemetryImportBatches.organisationId, organisationId))
    .orderBy(desc(telemetryImportBatches.createdAt))
    .limit(50);
}
