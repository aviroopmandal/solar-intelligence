import {
  calculateSolarElevationRad,
  calculatePoaIrradiance,
  createSeededRng,
  getWeatherCloudFactorRange,
  hashSeed,
  SIMULATION_DEFAULTS,
  type WeatherCondition,
} from './solarPhysics.ts';

export interface EnvironmentalPoint {
  measuredAt: Date;
  ghiWm2: number;
  poaWm2: number;
  ambientTemperatureC: number;
  cloudCoverPercent: number;
  weatherCondition: WeatherCondition;
  windSpeedMs: number;
  sourceType: 'SIMULATED' | 'EXTERNAL_API';
}

export interface WeatherProviderMetadata {
  providerId: string;
  name: string;
  status: 'OPERATIONAL' | 'NOT_YET_CONNECTED';
  geographicCoverage: string;
  dataResolution: string;
  historicalAvailability: string;
  forecastHorizon: string;
  updateFrequency: string;
  units: string;
  authenticationMethod: string;
  usageRestrictions: string;
  commercialPricing: string;
}

export interface WeatherProvider {
  readonly metadata: WeatherProviderMetadata;
  getCurrentConditions(installation: {
    id: string;
    latitude: number;
    longitude: number;
    timezone: string;
    panelTiltDeg: number;
    panelOrientation: string;
    weatherMode?: WeatherCondition;
    ambientTempC?: number;
  }): Promise<EnvironmentalPoint>;
  getHistoricalConditions(
    installation: {
      id: string;
      latitude: number;
      longitude: number;
      timezone: string;
      panelTiltDeg: number;
      panelOrientation: string;
    },
    start: Date,
    end: Date
  ): Promise<EnvironmentalPoint[]>;
  getForecast(
    installation: {
      id: string;
      latitude: number;
      longitude: number;
      timezone: string;
      panelTiltDeg: number;
      panelOrientation: string;
    },
    start: Date,
    end: Date
  ): Promise<EnvironmentalPoint[]>;
}

export class SimulatedWeatherProvider implements WeatherProvider {
  readonly metadata: WeatherProviderMetadata = {
    providerId: 'simulated-weather',
    name: 'Internal Simulated Irradiance & Weather Provider',
    status: 'OPERATIONAL',
    geographicCoverage: 'Global synthetic clear-sky geometry',
    dataResolution: '1 minute to 1 hour',
    historicalAvailability: 'Synthetic deterministic history',
    forecastHorizon: '7 days synthetic outlook',
    updateFrequency: 'On simulation tick / 60s',
    units: 'SI (W/m², °C, %, m/s)',
    authenticationMethod: 'Internal service (no credentials required)',
    usageRestrictions: 'Demonstration & testing only — never label as physical sensor data',
    commercialPricing: 'Included (Free)',
  };

  private conditionCloudPct(condition: WeatherCondition): number {
    switch (condition) {
      case 'Clear':
        return 8;
      case 'Partly cloudy':
        return 35;
      case 'Cloudy':
        return 68;
      case 'Overcast':
        return 88;
      case 'Heavy rain':
        return 96;
    }
  }

  async getCurrentConditions(installation: {
    id: string;
    latitude: number;
    longitude: number;
    timezone: string;
    panelTiltDeg: number;
    panelOrientation: string;
    weatherMode?: WeatherCondition;
    ambientTempC?: number;
  }): Promise<EnvironmentalPoint> {
    const now = new Date();
    const condition = installation.weatherMode || 'Clear';
    const rng = createSeededRng(hashSeed(`${installation.id}-${now.toISOString().slice(0, 16)}`));
    const elev = calculateSolarElevationRad(
      now,
      installation.latitude,
      installation.longitude,
      installation.timezone
    );
    const [minC, maxC] = getWeatherCloudFactorRange(condition);
    const cf = minC + rng() * (maxC - minC);
    const sinElev = Math.max(0, Math.sin(elev));
    const ghi = sinElev > 0.01 ? SIMULATION_DEFAULTS.maxClearSkyGhiWm2 * sinElev * cf : 0;
    const poa = calculatePoaIrradiance(
      ghi,
      elev,
      installation.panelTiltDeg,
      installation.panelOrientation
    );
    return {
      measuredAt: now,
      ghiWm2: Number(ghi.toFixed(2)),
      poaWm2: Number(poa.toFixed(2)),
      ambientTemperatureC: Number((installation.ambientTempC ?? 30).toFixed(1)),
      cloudCoverPercent: this.conditionCloudPct(condition),
      weatherCondition: condition,
      windSpeedMs: Number((2.2 + rng() * 2.8).toFixed(1)),
      sourceType: 'SIMULATED',
    };
  }

  async getHistoricalConditions(
    installation: {
      id: string;
      latitude: number;
      longitude: number;
      timezone: string;
      panelTiltDeg: number;
      panelOrientation: string;
    },
    start: Date,
    end: Date
  ): Promise<EnvironmentalPoint[]> {
    const points: EnvironmentalPoint[] = [];
    const cursor = new Date(start.getTime());
    const conditions: WeatherCondition[] = [
      'Clear',
      'Clear',
      'Partly cloudy',
      'Clear',
      'Cloudy',
      'Partly cloudy',
      'Overcast',
    ];
    while (cursor <= end) {
      const dayBucket = Math.floor(cursor.getTime() / 86400000);
      const rng = createSeededRng(hashSeed(`${installation.id}-${dayBucket}`));
      const cond = conditions[Math.floor(rng() * conditions.length)];
      const elev = calculateSolarElevationRad(
        cursor,
        installation.latitude,
        installation.longitude,
        installation.timezone
      );
      const [minC, maxC] = getWeatherCloudFactorRange(cond);
      const cf = minC + rng() * (maxC - minC);
      const sinElev = Math.max(0, Math.sin(elev));
      const ghi = sinElev > 0.01 ? SIMULATION_DEFAULTS.maxClearSkyGhiWm2 * sinElev * cf : 0;
      const poa = calculatePoaIrradiance(
        ghi,
        elev,
        installation.panelTiltDeg,
        installation.panelOrientation
      );
      const ambient = 24 + 8 * Math.max(0, sinElev) + (rng() - 0.5) * 3;
      points.push({
        measuredAt: new Date(cursor.getTime()),
        ghiWm2: Number(ghi.toFixed(2)),
        poaWm2: Number(poa.toFixed(2)),
        ambientTemperatureC: Number(ambient.toFixed(1)),
        cloudCoverPercent: this.conditionCloudPct(cond),
        weatherCondition: cond,
        windSpeedMs: Number((1.8 + rng() * 3.2).toFixed(1)),
        sourceType: 'SIMULATED',
      });
      cursor.setTime(cursor.getTime() + 3600000);
    }
    return points;
  }

  async getForecast(
    installation: {
      id: string;
      latitude: number;
      longitude: number;
      timezone: string;
      panelTiltDeg: number;
      panelOrientation: string;
    },
    start: Date,
    end: Date
  ): Promise<EnvironmentalPoint[]> {
    return this.getHistoricalConditions(installation, start, end);
  }
}

export interface ManufacturerConnectorCapabilities {
  supportsOAuth2: boolean;
  supportsApiKey: boolean;
  supportsHistoricalBackfill: boolean;
  supportsInverterLevelTelemetry: boolean;
  pollingRateLimitSeconds: number;
  retryPolicyDelaysSeconds: number[];
  unavailableCapabilities: string[];
}

export interface ManufacturerConnector {
  readonly providerId: string;
  readonly displayName: string;
  readonly status: 'NOT_YET_CONNECTED';
  readonly capabilities: ManufacturerConnectorCapabilities;
  authenticate(): Promise<{ connected: false; message: string }>;
  testConnection(): Promise<{ connected: false; status: 'NOT_YET_CONNECTED'; message: string }>;
  listPlants(): Promise<never>;
  listDevices(plantId: string): Promise<never>;
  getLatestTelemetry(deviceId: string): Promise<never>;
  getHistoricalTelemetry(deviceId: string, start: Date, end: Date): Promise<never>;
  normaliseMeasurement(rawData: Record<string, unknown>): Record<string, unknown>;
  refreshCredentials(): Promise<{ refreshed: false; message: string }>;
  disconnect(): Promise<void>;
}

class UnconnectedManufacturerConnector implements ManufacturerConnector {
  readonly status = 'NOT_YET_CONNECTED' as const;
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: ManufacturerConnectorCapabilities;

  constructor(
    providerId: string,
    displayName: string,
    capabilities: ManufacturerConnectorCapabilities
  ) {
    this.providerId = providerId;
    this.displayName = displayName;
    this.capabilities = capabilities;
  }

  async authenticate() {
    return {
      connected: false as const,
      message: `${this.displayName} connector is architecturally prepared but not yet connected. Verify provider credentials and endpoint approval before enabling.`,
    };
  }

  async testConnection() {
    return {
      connected: false as const,
      status: 'NOT_YET_CONNECTED' as const,
      message: `${this.displayName} API integration is not yet connected in this release. Live polling is disabled.`,
    };
  }

  async listPlants(): Promise<never> {
    throw new Error(`${this.displayName} connector is not yet connected.`);
  }

  async listDevices(): Promise<never> {
    throw new Error(`${this.displayName} connector is not yet connected.`);
  }

  async getLatestTelemetry(): Promise<never> {
    throw new Error(`${this.displayName} connector is not yet connected.`);
  }

  async getHistoricalTelemetry(): Promise<never> {
    throw new Error(`${this.displayName} connector is not yet connected.`);
  }

  normaliseMeasurement(rawData: Record<string, unknown>) {
    return { ...rawData, normalised: false, provider: this.providerId };
  }

  async refreshCredentials() {
    return {
      refreshed: false as const,
      message: `${this.displayName} credential refresh is unavailable while disconnected.`,
    };
  }

  async disconnect() {
    return;
  }
}

export const MANUFACTURER_CONNECTORS: ManufacturerConnector[] = [
  new UnconnectedManufacturerConnector('huawei', 'Huawei FusionSolar', {
    supportsOAuth2: false,
    supportsApiKey: true,
    supportsHistoricalBackfill: true,
    supportsInverterLevelTelemetry: true,
    pollingRateLimitSeconds: 300,
    retryPolicyDelaysSeconds: [30, 120, 300],
    unavailableCapabilities: ['Direct OAuth 2.0 user flow', 'Live push webhooks'],
  }),
  new UnconnectedManufacturerConnector('solaredge', 'SolarEdge Monitoring', {
    supportsOAuth2: false,
    supportsApiKey: true,
    supportsHistoricalBackfill: true,
    supportsInverterLevelTelemetry: true,
    pollingRateLimitSeconds: 900,
    retryPolicyDelaysSeconds: [30, 120, 300],
    unavailableCapabilities: ['Sub-5-minute polling', 'Remote inverter curtailment'],
  }),
  new UnconnectedManufacturerConnector('sma', 'SMA Sunny Portal', {
    supportsOAuth2: true,
    supportsApiKey: false,
    supportsHistoricalBackfill: true,
    supportsInverterLevelTelemetry: true,
    pollingRateLimitSeconds: 300,
    retryPolicyDelaysSeconds: [30, 120, 300],
    unavailableCapabilities: ['Unauthenticated site discovery'],
  }),
  new UnconnectedManufacturerConnector('sungrow', 'Sungrow iSolarCloud', {
    supportsOAuth2: true,
    supportsApiKey: true,
    supportsHistoricalBackfill: true,
    supportsInverterLevelTelemetry: true,
    pollingRateLimitSeconds: 300,
    retryPolicyDelaysSeconds: [30, 120, 300],
    unavailableCapabilities: ['Direct Modbus pass-through via cloud API'],
  }),
  new UnconnectedManufacturerConnector('fronius', 'Fronius Solar.web', {
    supportsOAuth2: true,
    supportsApiKey: true,
    supportsHistoricalBackfill: true,
    supportsInverterLevelTelemetry: true,
    pollingRateLimitSeconds: 300,
    retryPolicyDelaysSeconds: [30, 120, 300],
    unavailableCapabilities: ['Firmware OTA management'],
  }),
];

export const simulatedWeatherProvider = new SimulatedWeatherProvider();
