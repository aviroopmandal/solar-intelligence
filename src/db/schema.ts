import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const organisations = pgTable('organisations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  industry: text('industry').default('Commercial & Industrial Solar').notNull(),
  country: text('country').default('India').notNull(),
  contactEmail: text('contact_email'),
  defaultTimezone: text('default_timezone').default('Asia/Kolkata').notNull(),
  isDemo: boolean('is_demo').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const organisationMemberships = pgTable(
  'organisation_memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    invitedEmail: text('invited_email').notNull(),
    role: text('role').notNull(), // 'Administrator' | 'Operations Manager' | 'Technician'
    assignedInstallationIds: jsonb('assigned_installation_ids').$type<string[]>().default([]).notNull(),
    status: text('status').default('ACTIVE').notNull(), // 'ACTIVE' | 'INVITED'
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_memberships_org').on(table.organisationId),
    index('idx_memberships_user').on(table.userId),
    index('idx_memberships_email').on(table.invitedEmail),
  ]
);

export const solarInstallations = pgTable(
  'solar_installations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationCode: text('installation_code').notNull(),
    name: text('name').notNull(),
    siteAddress: text('site_address').notNull(),
    cityState: text('city_state').notNull(),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    timezone: text('timezone').default('Asia/Kolkata').notNull(),
    installationType: text('installation_type').notNull(),
    installedCapacityKwp: doublePrecision('installed_capacity_kwp').notNull(),
    commissioningDate: text('commissioning_date').notNull(),
    panelManufacturer: text('panel_manufacturer').notNull(),
    panelModel: text('panel_model').notNull(),
    inverterManufacturer: text('inverter_manufacturer').notNull(),
    inverterModel: text('inverter_model').notNull(),
    inverterCount: integer('inverter_count').default(1).notNull(),
    panelOrientation: text('panel_orientation').default('South (180°)').notNull(),
    panelTiltDeg: doublePrecision('panel_tilt_deg').default(22).notNull(),
    shadingFactor: doublePrecision('shading_factor').default(1.0).notNull(),
    shadingNotes: text('shading_notes').default('Minimal shading').notNull(),
    performanceRatio: doublePrecision('performance_ratio').default(0.82).notNull(),
    tempCoefficient: doublePrecision('temp_coefficient').default(-0.004).notNull(),
    operationalStatus: text('operational_status').default('Operational').notNull(),
    operationalGroup: text('operational_group').default('Default Portfolio').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_installations_org').on(table.organisationId),
    uniqueIndex('uq_installation_org_code').on(table.organisationId, table.installationCode),
  ]
);

export const inverters = pgTable(
  'inverters',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    inverterCode: text('inverter_code').notNull(),
    name: text('name').notNull(),
    manufacturer: text('manufacturer').notNull(),
    model: text('model').notNull(),
    serialNumber: text('serial_number'),
    ratedCapacityKw: doublePrecision('rated_capacity_kw').notNull(),
    dcCapacityKwp: doublePrecision('dc_capacity_kwp').notNull(),
    operatingStatus: text('operating_status').default('ONLINE').notNull(), // ONLINE | OFFLINE | WARNING | FAULT | UNKNOWN
    faultCode: text('fault_code'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_inverters_org').on(table.organisationId),
    index('idx_inverters_installation').on(table.installationId),
  ]
);

export const dataSources = pgTable(
  'data_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    sourceType: text('source_type').notNull(), // SIMULATED | CSV_IMPORT | MANUFACTURER_API | MODBUS_GATEWAY
    provider: text('provider').notNull(),
    connectionStatus: text('connection_status').default('NOT_YET_CONNECTED').notNull(),
    configJson: jsonb('config_json').$type<Record<string, unknown>>().default({}).notNull(),
    pollingIntervalSec: integer('polling_interval_sec').default(60).notNull(),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_datasources_org').on(table.organisationId)]
);

export const telemetryImportBatches = pgTable(
  'telemetry_import_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id').references(() => solarInstallations.id, {
      onDelete: 'set null',
    }),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    templateType: text('template_type').notNull(), // INVERTER_TELEMETRY | DAILY_ENERGY | WEATHER
    filename: text('filename').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    totalRows: integer('total_rows').default(0).notNull(),
    acceptedRows: integer('accepted_rows').default(0).notNull(),
    rejectedRows: integer('rejected_rows').default(0).notNull(),
    duplicateRows: integer('duplicate_rows').default(0).notNull(),
    status: text('status').default('COMPLETED').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_import_batches_org').on(table.organisationId)]
);

export const telemetryImportErrors = pgTable(
  'telemetry_import_errors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    batchId: uuid('batch_id')
      .references(() => telemetryImportBatches.id, { onDelete: 'cascade' })
      .notNull(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    rowNumber: integer('row_number').notNull(),
    rawRow: jsonb('raw_row').$type<Record<string, unknown>>().default({}).notNull(),
    errorMessage: text('error_message').notNull(),
  },
  (table) => [index('idx_import_errors_batch').on(table.batchId)]
);

export const telemetryReadings = pgTable(
  'telemetry_readings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    inverterId: uuid('inverter_id')
      .references(() => inverters.id, { onDelete: 'cascade' })
      .notNull(),
    dataSourceId: uuid('data_source_id')
      .references(() => dataSources.id, { onDelete: 'cascade' })
      .notNull(),
    sourceType: text('source_type').default('SIMULATED').notNull(),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    acPowerKw: doublePrecision('ac_power_kw'),
    dcPowerKw: doublePrecision('dc_power_kw'),
    dailyEnergyKwh: doublePrecision('daily_energy_kwh'),
    cumulativeEnergyKwh: doublePrecision('cumulative_energy_kwh'),
    voltageV: doublePrecision('voltage_v'),
    currentA: doublePrecision('current_a'),
    temperatureC: doublePrecision('temperature_c'),
    operatingStatus: text('operating_status').default('ONLINE').notNull(),
    faultCode: text('fault_code'),
    qualityStatus: text('quality_status').default('SIMULATED').notNull(), // VALID | ESTIMATED | DELAYED | INVALID | SIMULATED | UNDER_REVIEW
    qualityFlags: jsonb('quality_flags').$type<string[]>().default([]).notNull(),
    importBatchId: uuid('import_batch_id').references(() => telemetryImportBatches.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_telemetry_idempotency').on(
      table.organisationId,
      table.inverterId,
      table.dataSourceId,
      table.measuredAt
    ),
    index('idx_telemetry_org_inst_time').on(
      table.organisationId,
      table.installationId,
      table.measuredAt
    ),
    index('idx_telemetry_inv_time').on(table.inverterId, table.measuredAt),
  ]
);

export const weatherReadings = pgTable(
  'weather_readings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    dataSourceId: uuid('data_source_id')
      .references(() => dataSources.id, { onDelete: 'cascade' })
      .notNull(),
    sourceType: text('source_type').default('SIMULATED').notNull(),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull(),
    ghiWm2: doublePrecision('ghi_wm2'),
    poaWm2: doublePrecision('poa_wm2'),
    ambientTemperatureC: doublePrecision('ambient_temperature_c'),
    cloudCoverPercent: doublePrecision('cloud_cover_percent'),
    weatherCondition: text('weather_condition'),
    windSpeedMs: doublePrecision('wind_speed_ms'),
    importBatchId: uuid('import_batch_id').references(() => telemetryImportBatches.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_weather_idempotency').on(
      table.installationId,
      table.dataSourceId,
      table.measuredAt
    ),
    index('idx_weather_org_inst_time').on(
      table.organisationId,
      table.installationId,
      table.measuredAt
    ),
  ]
);

export const hourlyEnergyAggregates = pgTable(
  'hourly_energy_aggregates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    inverterId: uuid('inverter_id').references(() => inverters.id, { onDelete: 'cascade' }),
    hourStart: timestamp('hour_start', { withTimezone: true }).notNull(),
    integratedEnergyKwh: doublePrecision('integrated_energy_kwh').notNull(),
    counterEnergyKwh: doublePrecision('counter_energy_kwh'),
    expectedEnergyKwh: doublePrecision('expected_energy_kwh'),
    avgAcPowerKw: doublePrecision('avg_ac_power_kw').notNull(),
    avgIrradianceWm2: doublePrecision('avg_irradiance_wm2'),
    avgTemperatureC: doublePrecision('avg_temperature_c'),
    missingIntervalsCount: integer('missing_intervals_count').default(0).notNull(),
    sourceType: text('source_type').default('SIMULATED').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_hourly_org_inst_hour').on(
      table.organisationId,
      table.installationId,
      table.hourStart
    ),
  ]
);

export const dailyEnergyAggregates = pgTable(
  'daily_energy_aggregates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    localDate: text('local_date').notNull(), // YYYY-MM-DD
    sourceTimezone: text('source_timezone').default('Asia/Kolkata').notNull(),
    energyKwh: doublePrecision('energy_kwh').notNull(),
    expectedEnergyKwh: doublePrecision('expected_energy_kwh'),
    counterDerivedKwh: doublePrecision('counter_derived_kwh'),
    integratedPowerKwh: doublePrecision('integrated_power_kwh'),
    measurementType: text('measurement_type').default('SIMULATED').notNull(), // MEASURED | ESTIMATED | SIMULATED
    sourceType: text('source_type').default('SIMULATED').notNull(),
    dataCompletenessPct: doublePrecision('data_completeness_pct').default(100).notNull(),
    dataSourceId: uuid('data_source_id')
      .references(() => dataSources.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_daily_energy_identity').on(
      table.installationId,
      table.localDate,
      table.measurementType,
      table.dataSourceId
    ),
    index('idx_daily_org_inst_date').on(
      table.organisationId,
      table.installationId,
      table.localDate
    ),
  ]
);

export const forecasts = pgTable(
  'forecasts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
    targetTimestamp: timestamp('target_timestamp', { withTimezone: true }).notNull(),
    horizonType: text('horizon_type').notNull(), // HOURLY | DAILY | WEEKLY | MONTHLY
    expectedEnergyKwh: doublePrecision('expected_energy_kwh').notNull(),
    confidenceLowKwh: doublePrecision('confidence_low_kwh'),
    confidenceHighKwh: doublePrecision('confidence_high_kwh'),
    confidenceAvailable: boolean('confidence_available').default(false).notNull(),
    modelVersion: text('model_version').notNull(),
    trainingPeriodStart: text('training_period_start').notNull(),
    trainingPeriodEnd: text('training_period_end').notNull(),
    maeKwh: doublePrecision('mae_kwh'),
    rmseKwh: doublePrecision('rmse_kwh'),
    mapePct: doublePrecision('mape_pct'),
    isPreliminary: boolean('is_preliminary').default(false).notNull(),
    notes: text('notes'),
  },
  (table) => [
    index('idx_forecasts_org_inst').on(
      table.organisationId,
      table.installationId,
      table.targetTimestamp
    ),
  ]
);

export const performanceAnomalies = pgTable(
  'performance_anomalies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    inverterId: uuid('inverter_id').references(() => inverters.id, { onDelete: 'set null' }),
    detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
    category: text('category').notNull(),
    classification: text('classification').notNull(), // STATISTICAL_ANOMALY | CONFIRMED_EQUIPMENT_FAULT
    observedValue: text('observed_value').notNull(),
    expectedBaseline: text('expected_baseline').notNull(),
    severity: text('severity').notNull(), // Informational | Low | Medium | High | Critical
    explanation: text('explanation').notNull(),
    recommendedAction: text('recommended_action').notNull(),
    evidenceJson: jsonb('evidence_json').$type<Record<string, unknown>>().default({}).notNull(),
    aiAssessmentJson: jsonb('ai_assessment_json').$type<Record<string, unknown> | null>(),
    status: text('status').default('OPEN').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_anomalies_org_inst').on(table.organisationId, table.installationId)]
);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    inverterId: uuid('inverter_id').references(() => inverters.id, { onDelete: 'set null' }),
    anomalyId: uuid('anomaly_id').references(() => performanceAnomalies.id, {
      onDelete: 'set null',
    }),
    alertCode: text('alert_code').notNull(),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).defaultNow().notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    supportingMeasurements: jsonb('supporting_measurements')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    recommendedAction: text('recommended_action').notNull(),
    status: text('status').default('New').notNull(), // New | Acknowledged | Under Investigation | Resolved | Dismissed
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [index('idx_alerts_org_status').on(table.organisationId, table.status)]
);

export const maintenanceTasks = pgTable(
  'maintenance_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    inverterId: uuid('inverter_id').references(() => inverters.id, { onDelete: 'set null' }),
    alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
    anomalyId: uuid('anomaly_id').references(() => performanceAnomalies.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    priority: text('priority').default('Medium').notNull(),
    status: text('status').default('Open').notNull(), // Open | In Progress | Completed | Cancelled
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assignedToName: text('assigned_to_name'),
    dueDate: text('due_date').notNull(),
    inspectionFindings: text('inspection_findings'),
    workPerformed: text('work_performed'),
    attachmentNote: text('attachment_note'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_tasks_org_inst').on(table.organisationId, table.installationId)]
);

export const maintenanceRecords = pgTable(
  'maintenance_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    inverterId: uuid('inverter_id').references(() => inverters.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => maintenanceTasks.id, { onDelete: 'set null' }),
    performedByUserId: uuid('performed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    performedByName: text('performed_by_name').notNull(),
    performedAt: timestamp('performed_at', { withTimezone: true }).defaultNow().notNull(),
    recordType: text('record_type').default('INSPECTION').notNull(),
    findings: text('findings').notNull(),
    workPerformed: text('work_performed').notNull(),
    partsReplaced: text('parts_replaced'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_maint_records_org_inst').on(table.organisationId, table.installationId)]
);

export const simulatorSessions = pgTable(
  'simulator_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    status: text('status').default('PAUSED').notNull(), // RUNNING | PAUSED | STOPPED
    intervalSeconds: integer('interval_seconds').default(60).notNull(),
    weatherMode: text('weather_mode').default('Clear').notNull(),
    ambientTempC: doublePrecision('ambient_temp_c').default(31).notNull(),
    randomSeed: integer('random_seed').default(202611).notNull(),
    simulationStartAt: timestamp('simulation_start_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastTickAt: timestamp('last_tick_at', { withTimezone: true }),
    activeFaultsJson: jsonb('active_faults_json')
      .$type<Record<string, Record<string, unknown>>>()
      .default({})
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_sim_session_org').on(table.organisationId)]
);

export const simulatorEvents = pgTable(
  'simulator_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    sessionId: uuid('session_id')
      .references(() => simulatorSessions.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id').references(() => solarInstallations.id, {
      onDelete: 'set null',
    }),
    inverterId: uuid('inverter_id').references(() => inverters.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    detailsJson: jsonb('details_json').$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_sim_events_org').on(table.organisationId)]
);

export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    jobType: text('job_type').notNull(),
    status: text('status').notNull(),
    recordsProcessed: integer('records_processed').default(0).notNull(),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_ingestion_jobs_org').on(table.organisationId)]
);

export const gatewayDevices = pgTable(
  'gateway_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    installationId: uuid('installation_id')
      .references(() => solarInstallations.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    protocol: text('protocol').notNull(), // MODBUS_TCP | MODBUS_RTU | SUNSPEC
    connectionStatus: text('connection_status').default('NOT_YET_CONNECTED').notNull(),
    registerProfile: text('register_profile').notNull(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_gateway_org').on(table.organisationId)]
);

export const connectorSyncLogs = pgTable(
  'connector_sync_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    dataSourceId: uuid('data_source_id')
      .references(() => dataSources.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status').notNull(),
    recordsSynced: integer('records_synced').default(0).notNull(),
    message: text('message').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_connector_logs_org').on(table.organisationId)]
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organisationId: uuid('organisation_id')
      .references(() => organisations.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    userEmail: text('user_email').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    detailsJson: jsonb('details_json').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_audit_logs_org').on(table.organisationId)]
);
