import PDFDocument from 'pdfkit';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  dailyEnergyAggregates,
  inverters,
  maintenanceRecords,
  maintenanceTasks,
  organisations,
  performanceAnomalies,
  solarInstallations,
} from '../db/schema.ts';

export type ReportType = 'ENERGY' | 'PERFORMANCE' | 'EQUIPMENT' | 'MAINTENANCE';

export async function generateReportData(params: {
  organisationId: string;
  reportType: ReportType;
  installationId?: string;
  days?: number;
}) {
  const { organisationId, reportType, installationId, days = 30 } = params;

  const [org] = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, organisationId));

  const insts = installationId
    ? await db
        .select()
        .from(solarInstallations)
        .where(
          and(
            eq(solarInstallations.organisationId, organisationId),
            eq(solarInstallations.id, installationId)
          )
        )
    : await db
        .select()
        .from(solarInstallations)
        .where(eq(solarInstallations.organisationId, organisationId));

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 86400000);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const dailyRows = await db
    .select()
    .from(dailyEnergyAggregates)
    .where(
      and(
        eq(dailyEnergyAggregates.organisationId, organisationId),
        gte(dailyEnergyAggregates.localDate, startStr),
        ...(installationId ? [eq(dailyEnergyAggregates.installationId, installationId)] : [])
      )
    )
    .orderBy(desc(dailyEnergyAggregates.localDate));

  const invRows = await db
    .select()
    .from(inverters)
    .where(
      and(
        eq(inverters.organisationId, organisationId),
        ...(installationId ? [eq(inverters.installationId, installationId)] : [])
      )
    );

  const anomalyRows = await db
    .select()
    .from(performanceAnomalies)
    .where(
      and(
        eq(performanceAnomalies.organisationId, organisationId),
        ...(installationId ? [eq(performanceAnomalies.installationId, installationId)] : [])
      )
    )
    .orderBy(desc(performanceAnomalies.detectedAt));

  const taskRows = await db
    .select()
    .from(maintenanceTasks)
    .where(
      and(
        eq(maintenanceTasks.organisationId, organisationId),
        ...(installationId ? [eq(maintenanceTasks.installationId, installationId)] : [])
      )
    )
    .orderBy(desc(maintenanceTasks.createdAt));

  const recordRows = await db
    .select()
    .from(maintenanceRecords)
    .where(
      and(
        eq(maintenanceRecords.organisationId, organisationId),
        ...(installationId ? [eq(maintenanceRecords.installationId, installationId)] : [])
      )
    )
    .orderBy(desc(maintenanceRecords.performedAt));

  const totalActualKwh = dailyRows.reduce((s, r) => s + r.energyKwh, 0);
  const totalExpectedKwh = dailyRows.reduce((s, r) => s + (r.expectedEnergyKwh || 0), 0);
  const totalCapacityKwp = insts.reduce((s, i) => s + i.installedCapacityKwp, 0);

  return {
    organisationName: org?.name || 'Organisation',
    reportType,
    scopeName: installationId && insts[0] ? insts[0].name : 'Entire Organisation Portfolio',
    reportingPeriod: { start: startStr, end: endStr, days },
    generatedAt: new Date().toISOString(),
    summary: {
      installationsCount: insts.length,
      totalCapacityKwp: Number(totalCapacityKwp.toFixed(2)),
      totalEnergyKwh: Number(totalActualKwh.toFixed(2)),
      totalExpectedKwh: Number(totalExpectedKwh.toFixed(2)),
      performanceIndexPct:
        totalExpectedKwh > 0 ? Number(((totalActualKwh / totalExpectedKwh) * 100).toFixed(1)) : null,
      invertersTotal: invRows.length,
      invertersOnline: invRows.filter((i) => i.operatingStatus === 'ONLINE').length,
      anomaliesCount: anomalyRows.length,
      openTasksCount: taskRows.filter((t) => t.status !== 'Completed' && t.status !== 'Cancelled')
        .length,
      completedRecordsCount: recordRows.length,
    },
    installations: insts,
    dailyEnergy: dailyRows.slice(0, 60),
    inverters: invRows,
    anomalies: anomalyRows.slice(0, 30),
    tasks: taskRows.slice(0, 30),
    records: recordRows.slice(0, 30),
  };
}

export async function renderReportPdfBuffer(params: {
  organisationId: string;
  reportType: ReportType;
  installationId?: string;
  days?: number;
}): Promise<Buffer> {
  const data = await generateReportData(params);

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const titleMap: Record<ReportType, string> = {
      ENERGY: 'Energy Generation Report',
      PERFORMANCE: 'Performance & Anomaly Report',
      EQUIPMENT: 'Inverter & Equipment Status Report',
      MAINTENANCE: 'Maintenance Operations Report',
    };

    doc
      .fontSize(18)
      .fillColor('#0F172A')
      .text(`Solar Intelligence System — ${titleMap[data.reportType]}`);
    doc.moveDown(0.3);
    doc
      .fontSize(10)
      .fillColor('#475569')
      .text(`Organisation: ${data.organisationName}`)
      .text(`Scope: ${data.scopeName}`)
      .text(`Reporting Period: ${data.reportingPeriod.start} to ${data.reportingPeriod.end} (${data.reportingPeriod.days} days)`)
      .text(`Generated (UTC): ${data.generatedAt}`)
      .text('Data Provenance: Stored PostgreSQL telemetry, simulated/imported records as labelled in database.');

    doc.moveDown(0.8);
    doc
      .strokeColor('#CBD5E1')
      .lineWidth(1)
      .moveTo(44, doc.y)
      .lineTo(551, doc.y)
      .stroke();
    doc.moveDown(0.8);

    doc.fontSize(12).fillColor('#0F172A').text('Portfolio Summary Metrics');
    doc.moveDown(0.4);
    doc
      .fontSize(10)
      .fillColor('#1E293B')
      .text(`Registered Installations: ${data.summary.installationsCount}`)
      .text(`Total Installed Capacity: ${data.summary.totalCapacityKwp.toLocaleString()} kWp`)
      .text(`Total Energy Produced: ${data.summary.totalEnergyKwh.toLocaleString()} kWh`)
      .text(
        `Weather-Adjusted Expected Energy: ${data.summary.totalExpectedKwh.toLocaleString()} kWh (${
          data.summary.performanceIndexPct !== null ? `${data.summary.performanceIndexPct}%` : 'N/A'
        })`
      )
      .text(`Inverters Online: ${data.summary.invertersOnline} / ${data.summary.invertersTotal}`)
      .text(`Recorded Anomalies: ${data.summary.anomaliesCount}`)
      .text(`Open Maintenance Tasks: ${data.summary.openTasksCount}`);

    doc.moveDown(0.8);

    if (data.reportType === 'ENERGY' || data.reportType === 'PERFORMANCE') {
      doc.fontSize(12).fillColor('#0F172A').text('Daily Energy Generation Records (Recent)');
      doc.moveDown(0.4);
      const instNameMap = new Map(data.installations.map((i) => [i.id, i.name]));
      for (const row of data.dailyEnergy.slice(0, 22)) {
        const site = instNameMap.get(row.installationId) || row.installationId.slice(0, 8);
        const exp = row.expectedEnergyKwh !== null ? `${row.expectedEnergyKwh.toFixed(1)} kWh` : 'N/A';
        doc
          .fontSize(9)
          .fillColor('#334155')
          .text(
            `${row.localDate} | ${site} | Actual: ${row.energyKwh.toFixed(1)} kWh | Expected: ${exp} | Type: ${row.measurementType}`
          );
      }
      doc.moveDown(0.6);
    }

    if (data.reportType === 'PERFORMANCE') {
      doc.fontSize(12).fillColor('#0F172A').text('Detected Anomalies & Performance Flags');
      doc.moveDown(0.4);
      if (data.anomalies.length === 0) {
        doc.fontSize(9).fillColor('#475569').text('No anomalies recorded for this scope.');
      } else {
        for (const a of data.anomalies.slice(0, 15)) {
          doc
            .fontSize(9)
            .fillColor('#0F172A')
            .text(`[${a.severity}] ${a.category} (${a.classification})`)
            .fillColor('#475569')
            .text(`Observed: ${a.observedValue} | Expected: ${a.expectedBaseline}`)
            .text(`Action: ${a.recommendedAction}`);
          doc.moveDown(0.3);
        }
      }
    }

    if (data.reportType === 'EQUIPMENT') {
      doc.fontSize(12).fillColor('#0F172A').text('Inverter Fleet Status');
      doc.moveDown(0.4);
      for (const inv of data.inverters) {
        doc
          .fontSize(9)
          .fillColor('#334155')
          .text(
            `${inv.inverterCode} | ${inv.name} | ${inv.ratedCapacityKw} kW | Status: ${inv.operatingStatus}${
              inv.faultCode ? ` (${inv.faultCode})` : ''
            }`
          );
      }
    }

    if (data.reportType === 'MAINTENANCE') {
      doc.fontSize(12).fillColor('#0F172A').text('Maintenance Tasks & Completed Records');
      doc.moveDown(0.4);
      for (const t of data.tasks.slice(0, 15)) {
        doc
          .fontSize(9)
          .fillColor('#0F172A')
          .text(`[${t.priority}] ${t.title} — Status: ${t.status} (Due: ${t.dueDate})`);
      }
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#0F172A').text('Completed Work History');
      doc.moveDown(0.3);
      for (const r of data.records.slice(0, 15)) {
        doc
          .fontSize(9)
          .fillColor('#334155')
          .text(
            `${new Date(r.performedAt).toISOString().slice(0, 10)} | ${r.recordType} by ${r.performedByName}: ${r.workPerformed}`
          );
      }
    }

    doc.end();
  });
}
