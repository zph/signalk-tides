import { useStation, type Station, type StationPredictor } from "@neaps/tide-predictor";

/**
 * Spatial tide interpolation.
 *
 * When the vessel sits near a station, that station's prediction is the honest
 * answer. When it does not, reusing the nearest station pretends that tides do
 * not vary with geography. This module synthesizes a "virtual station" at the
 * vessel's position by inverse-distance blending the harmonic constituents of
 * the surrounding stations:
 *
 * - Amplitudes blend linearly, phases blend as phasors (so 350 deg and 10 deg
 *   average to 0 deg, not 180 deg).
 * - The datum offset (MSL to chart datum) blends as the same weighted mean,
 *   keeping predictions in the target datum the same way useStation does.
 *
 * The virtual station goes through useStation, so every downstream consumer
 * (delta paths, resource provider, Binnacle) sees the same shape as a real
 * station prediction.
 */

export interface StationCandidate {
  station: Station;
  distanceKm: number;
}

export interface BlendedStation {
  name: string;
  id: string;
  distanceKm: number;
  weight: number;
}

export interface InterpolationMeta {
  method: "interpolated";
  datum: string | undefined;
  /** Stations blended, nearest first. */
  stations: BlendedStation[];
}

export interface VirtualPrediction {
  predictor: StationPredictor;
  meta: InterpolationMeta;
  attribution: string;
}

const MIN_SHARED_CONSTITUENTS = 3;

/**
 * Blend the surrounding stations into a virtual station at `position`.
 *
 * Returns undefined when fewer than two usable stations are supplied. A single
 * neighbor carries no spatial information, so the caller falls back to plain
 * nearest-station behavior instead of pretending to interpolate.
 */
export function interpolateStation(
  position: { latitude: number; longitude: number },
  candidates: StationCandidate[],
  options?: { stations?: number },
): VirtualPrediction | undefined {
  const limit = Math.max(2, options?.stations ?? 4);
  const nearestUsable = candidates
    .filter(usableForInterpolation)
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];
  const targetDatum = chartDatumOf(nearestUsable?.station);
  if (targetDatum === undefined) return undefined;

  const usable = candidates
    .filter(usableForInterpolation)
    .filter((candidate) => datumOffsets(candidate.station, targetDatum) !== undefined)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);

  if (usable.length < 2) return undefined;

  const weights = idwWeights(usable.map((candidate) => candidate.distanceKm));

  const blended = blendConstituents(
    usable.map((candidate) => candidate.station),
    weights,
  );
  if (!blended || blended.length < MIN_SHARED_CONSTITUENTS) return undefined;

  const datumOffset = usable.reduce((sum, candidate, index) => {
    const offset = datumOffsets(candidate.station, targetDatum)!;
    return sum + weights[index]! * offset;
  }, 0);

  const attribution = `Interpolated from ${usable
    .map((candidate, index) => stationLabel(candidate, weights[index]!))
    .join(", ")}`;

  const meta: InterpolationMeta = {
    method: "interpolated",
    datum: targetDatum,
    stations: usable.map((candidate, index) => ({
      name: candidate.station.name,
      id: candidate.station.id,
      distanceKm: candidate.distanceKm,
      weight: weights[index]!,
    })),
  };

  const station: Station = {
    id: `virtual:${position.latitude.toFixed(5)},${position.longitude.toFixed(5)}`,
    name: attribution,
    continent: usable[0]!.station.continent,
    country: usable[0]!.station.country,
    region: usable[0]!.station.region,
    timezone: usable[0]!.station.timezone,
    disclaimers:
      "Synthesized from surrounding stations; supplemental estimate, not an official prediction",
    type: "reference",
    latitude: position.latitude,
    longitude: position.longitude,
    source: usable[0]!.station.source,
    datums: { MSL: 0, [targetDatum]: -datumOffset },
    chart_datum: targetDatum,
    harmonic_constituents: blended,
  };

  return { predictor: useStation(station, 0), meta, attribution };
}

function stationLabel(candidate: StationCandidate, weight: number): string {
  return `${candidate.station.name} (${candidate.distanceKm.toFixed(1)} km, ${(weight * 100).toFixed(0)}%)`;
}

function chartDatumOf(station: Station | undefined): string | undefined {
  if (!station) return undefined;
  return station.chart_datum ?? Object.keys(station.datums ?? {})[0] ?? "MSL";
}

/** MSL to `datum` offset in meters, or undefined when the station lacks either datum. */
function datumOffsets(station: Station, datum: string): number | undefined {
  const msl = station.datums?.["MSL"];
  const target = station.datums?.[datum];
  return typeof msl === "number" && typeof target === "number" ? msl - target : undefined;
}

/**
 * A station can participate in blending only when it carries a real harmonic
 * set. Subordinate stations that are defined by offsets against a reference
 * station have an empty or missing constituent list and would poison the sum.
 */
function usableForInterpolation(candidate: StationCandidate): boolean {
  const constituents = candidate.station.harmonic_constituents;
  return Array.isArray(constituents) && constituents.length >= MIN_SHARED_CONSTITUENTS;
}

/**
 * Inverse-distance weights (power 2, normalized). Distances are floored at
 * 1 km so a station under the vessel cannot swallow the blend entirely.
 */
export function idwWeights(distancesKm: number[]): number[] {
  const raw = distancesKm.map((distance) => 1 / Math.max(distance, 1) ** 2);
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

/**
 * Blend constituents across stations. Only constituents carried by every
 * station are blended; a constituent missing from one station is dropped
 * rather than averaged over a subset, which would bias the sum toward the
 * stations that report it. Phases blend as phasors so they wrap correctly.
 */
export function blendConstituents(
  stations: Station[],
  weights: number[],
): Station["harmonic_constituents"] | undefined {
  const first = stations[0];
  if (!first || stations.length !== weights.length) return undefined;
  const shared = first.harmonic_constituents
    .map((constituent) => constituent.name)
    .filter((name) =>
      stations.every((station) =>
        station.harmonic_constituents.some((constituent) => constituent.name === name),
      ),
    );
  if (shared.length < MIN_SHARED_CONSTITUENTS) return undefined;

  return shared.map((name) => {
    let x = 0;
    let y = 0;
    for (const [index, station] of stations.entries()) {
      const constituent = station.harmonic_constituents.find(
        (candidate) => candidate.name === name,
      )!;
      const phaseRad = (constituent.phase * Math.PI) / 180;
      x += weights[index]! * constituent.amplitude * Math.cos(phaseRad);
      y += weights[index]! * constituent.amplitude * Math.sin(phaseRad);
    }
    return {
      name,
      amplitude: Math.hypot(x, y),
      phase: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360,
    };
  });
}