export type WeatherCondition =
  | 'Clear'
  | 'Partly cloudy'
  | 'Cloudy'
  | 'Overcast'
  | 'Heavy rain';

export interface SimulationPhysicsDefaults {
  performanceRatio: number;
  tempCoefficient: number;
  referenceCellTempC: number;
  tempModelCoeff: number;
  inverterEfficiency: number;
  defaultShadingFactor: number;
  maxClearSkyGhiWm2: number;
}

export const SIMULATION_DEFAULTS: SimulationPhysicsDefaults = {
  performanceRatio: 0.82,
  tempCoefficient: -0.004,
  referenceCellTempC: 25,
  tempModelCoeff: 0.03,
  inverterEfficiency: 0.97,
  defaultShadingFactor: 1.0,
  maxClearSkyGhiWm2: 900,
};

/**
 * Deterministic seeded PRNG (Mulberry32) so demonstration datasets and tests
 * reproduce identical physical profiles for a given seed.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(input: string, baseSeed = 202611): number {
  let h = baseSeed;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(31, h) + input.charCodeAt(i);
  }
  return h >>> 0;
}

export function getWeatherCloudFactorRange(condition: string): [number, number] {
  switch (condition) {
    case 'Clear':
      return [0.95, 1.0];
    case 'Partly cloudy':
      return [0.65, 0.85];
    case 'Cloudy':
      return [0.3, 0.55];
    case 'Overcast':
      return [0.1, 0.3];
    case 'Heavy rain':
      return [0.05, 0.25];
    default:
      return [0.75, 0.92];
  }
}

export function getLocalCalendarParts(
  date: Date,
  ianaTimezone: string
): { localDate: string; localHourDecimal: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: ianaTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) {
      map[p.type] = p.value;
    }
    const year = map.year || '2026';
    const month = map.month || '01';
    const day = map.day || '01';
    const hour = Number(map.hour === '24' ? '0' : map.hour || '0');
    const minute = Number(map.minute || '0');
    const second = Number(map.second || '0');
    return {
      localDate: `${year}-${month}-${day}`,
      localHourDecimal: hour + minute / 60 + second / 3600,
    };
  } catch {
    const iso = date.toISOString();
    const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
    return { localDate: iso.slice(0, 10), localHourDecimal: hour };
  }
}

export function getDayOfYear(date: Date): number {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
}

/**
 * Solar elevation angle approximation in radians using latitude, day of year,
 * and local solar hour. Guarantees zero/negative elevation during nighttime.
 */
export function calculateSolarElevationRad(
  timestamp: Date,
  latitudeDeg: number,
  longitudeDeg: number,
  timezone: string
): number {
  const { localHourDecimal } = getLocalCalendarParts(timestamp, timezone);
  const dayOfYear = getDayOfYear(timestamp);
  const declinationRad =
    (23.44 * Math.PI) / 180 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));
  const latRad = (latitudeDeg * Math.PI) / 180;

  // Approximate local solar time correction from longitude relative to IST 82.5°E or standard meridian
  const stdMeridian = Math.round(longitudeDeg / 15) * 15;
  const solarTime = localHourDecimal + (longitudeDeg - stdMeridian) / 15;
  const hourAngleRad = ((solarTime - 12) * 15 * Math.PI) / 180;

  const sinElevation =
    Math.sin(latRad) * Math.sin(declinationRad) +
    Math.cos(latRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad);

  return Math.asin(Math.max(-1, Math.min(1, sinElevation)));
}

/**
 * Computes orientation + tilt transposition adjustment (POA / GHI) for South/East/West panels.
 * Explicitly documented so simulated POA irradiance remains physically consistent.
 */
export function calculatePoaIrradiance(
  ghiWm2: number,
  solarElevationRad: number,
  panelTiltDeg: number,
  panelOrientation: string
): number {
  if (ghiWm2 <= 0 || solarElevationRad <= 0) return 0;

  const tiltFactor = 1 + 0.08 * Math.sin((panelTiltDeg * Math.PI) / 180);
  let orientationMultiplier = 1.0;
  const lower = panelOrientation.toLowerCase();
  if (lower.includes('south-east') || lower.includes('south-west')) {
    orientationMultiplier = 0.96;
  } else if (lower.includes('east') || lower.includes('west')) {
    orientationMultiplier = 0.89;
  } else if (lower.includes('north')) {
    orientationMultiplier = 0.72;
  }

  // Slight elevation gain when sun is mid-sky on tilted arrays
  const elevationAdj = 0.94 + 0.12 * Math.sin(solarElevationRad);
  return Math.max(0, Math.min(1150, ghiWm2 * tiltFactor * orientationMultiplier * elevationAdj));
}

export interface SimulatedInverterReadingInput {
  timestamp: Date;
  latitudeDeg: number;
  longitudeDeg: number;
  timezone: string;
  weatherCondition: WeatherCondition;
  ambientTempC: number;
  dcCapacityKwp: number;
  ratedAcCapacityKw: number;
  panelTiltDeg: number;
  panelOrientation: string;
  shadingFactor: number;
  performanceRatio: number;
  tempCoefficient: number;
  operatingStatus: 'ONLINE' | 'OFFLINE' | 'WARNING' | 'FAULT' | 'UNKNOWN';
  faultCode: string | null;
  rng: () => number;
  injectUnderperformanceFactor?: number; // e.g., 0.56 for 44% reduction
  injectOverheatDeltaC?: number; // e.g., +36°C excess inverter heat
  injectAbnormalVoltageV?: number; // e.g., 285V or 492V
}

export interface SimulatedInverterReadingOutput {
  ghiWm2: number;
  poaWm2: number;
  cellTempC: number;
  inverterTempC: number;
  acPowerKw: number;
  dcPowerKw: number;
  voltageV: number;
  currentA: number;
  effectivePr: number;
  operatingStatus: 'ONLINE' | 'OFFLINE' | 'WARNING' | 'FAULT' | 'UNKNOWN';
  faultCode: string | null;
}

/**
 * Physical Solar Simulation Engine (Sections 23 & 36):
 * - GHI = 900 * max(0, sin(elevation)) * CloudFactor
 * - Tcell = Tambient + 0.03 * POA
 * - TemperatureFactor = max(0, 1 + TempCoeff * (Tcell - 25))
 * - SystemLossFactor derived from PR without double-counting temperature, shading, or inverter efficiency:
 *   Nominal reference efficiency chain = 0.97 (inverter) * 0.91 (BOS/wiring/soiling) ≈ 0.883.
 *   To honor configurable PR (default 0.82) without double-counting, BOS/soiling residual factor = PR / 0.88.
 *   Thus DC Power = Installed DC Capacity * (POA / 1000) * TemperatureFactor * ShadingFactor * (PR / 0.88).
 * - AC Power = min(Inverter AC Capacity, DC Power * Inverter Efficiency 0.97)
 */
export function simulateInverterTelemetryPoint(
  input: SimulatedInverterReadingInput
): SimulatedInverterReadingOutput {
  const elevationRad = calculateSolarElevationRad(
    input.timestamp,
    input.latitudeDeg,
    input.longitudeDeg,
    input.timezone
  );

  const [minCloud, maxCloud] = getWeatherCloudFactorRange(input.weatherCondition);
  const cloudFactor = minCloud + input.rng() * (maxCloud - minCloud);

  const sinElev = Math.max(0, Math.sin(elevationRad));
  const ghiWm2 =
    sinElev > 0.01
      ? Number((SIMULATION_DEFAULTS.maxClearSkyGhiWm2 * sinElev * cloudFactor).toFixed(2))
      : 0;

  const poaWm2 = Number(
    calculatePoaIrradiance(
      ghiWm2,
      elevationRad,
      input.panelTiltDeg,
      input.panelOrientation
    ).toFixed(2)
  );

  const cellTempC = Number(
    (input.ambientTempC + SIMULATION_DEFAULTS.tempModelCoeff * poaWm2).toFixed(2)
  );

  const tempFactor = Math.max(
    0,
    1 + input.tempCoefficient * (cellTempC - SIMULATION_DEFAULTS.referenceCellTempC)
  );

  // Documented non-double-counted PR system loss adjustment (wiring, mismatch, soiling)
  const effectivePr = input.performanceRatio > 0 ? input.performanceRatio : SIMULATION_DEFAULTS.performanceRatio;
  const bosSystemLossFactor = Math.min(1.05, Math.max(0.4, effectivePr / 0.88));

  let dcPowerKw =
    input.dcCapacityKwp *
    (poaWm2 / 1000) *
    tempFactor *
    input.shadingFactor *
    bosSystemLossFactor;

  if (input.injectUnderperformanceFactor !== undefined) {
    dcPowerKw *= input.injectUnderperformanceFactor;
  }

  let acPowerKw = Math.min(
    input.ratedAcCapacityKw,
    dcPowerKw * SIMULATION_DEFAULTS.inverterEfficiency
  );

  // Small bounded measurement noise (±1.5%) clamped to >= 0
  if (acPowerKw > 0) {
    const noise = 1 + (input.rng() - 0.5) * 0.03;
    acPowerKw = Math.max(0, Math.min(input.ratedAcCapacityKw, acPowerKw * noise));
  } else {
    acPowerKw = 0;
    dcPowerKw = 0;
  }

  let operatingStatus = input.operatingStatus;
  let faultCode = input.faultCode;

  // Apply equipment operating state after calculating expected output
  if (operatingStatus === 'OFFLINE' || operatingStatus === 'FAULT') {
    acPowerKw = 0;
    dcPowerKw = 0;
  }

  const baseInverterTemp =
    operatingStatus === 'OFFLINE'
      ? input.ambientTempC + 1.5
      : input.ambientTempC + 8 + (acPowerKw / Math.max(1, input.ratedAcCapacityKw)) * 24;

  const inverterTempC = Number(
    (baseInverterTemp + (input.injectOverheatDeltaC ?? 0) + (input.rng() - 0.5) * 1.4).toFixed(2)
  );

  if (inverterTempC >= 75 && operatingStatus === 'ONLINE') {
    operatingStatus = 'WARNING';
    faultCode = faultCode || 'WARN-TEMP-HIGH';
  }

  const nominalVoltage = 400 + (input.rng() - 0.5) * 14;
  const voltageV =
    operatingStatus === 'OFFLINE'
      ? 0
      : Number((input.injectAbnormalVoltageV ?? nominalVoltage).toFixed(1));

  const currentA =
    voltageV > 10 && acPowerKw > 0
      ? Number(((acPowerKw * 1000) / (voltageV * 1.732)).toFixed(2))
      : 0;

  return {
    ghiWm2,
    poaWm2,
    cellTempC,
    inverterTempC,
    acPowerKw: Number(acPowerKw.toFixed(3)),
    dcPowerKw: Number(dcPowerKw.toFixed(3)),
    voltageV,
    currentA,
    effectivePr,
    operatingStatus,
    faultCode,
  };
}

/**
 * Trapezoidal integration for interval energy (kWh):
 * Energy = ((PreviousPower + CurrentPower) / 2) * (ElapsedSeconds / 3600)
 */
export function integrateIntervalEnergyKwh(
  previousPowerKw: number | null,
  currentPowerKw: number,
  elapsedSeconds: number
): number {
  if (elapsedSeconds <= 0) return 0;
  const prev = previousPowerKw !== null && previousPowerKw >= 0 ? previousPowerKw : currentPowerKw;
  return Number((((prev + currentPowerKw) / 2) * (elapsedSeconds / 3600)).toFixed(4));
}
