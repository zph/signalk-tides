/**
 * Leave-one-out validation of the spatial tide interpolation.
 *
 * For each sample station we pretend it does not exist: the blended prediction
 * at that station's position is computed from the *adjacent* stations only,
 * then compared hour by hour against the station's own harmonic prediction.
 * The error is what a vessel moored at that spot would get from the
 * interpolated path, which is the honest delta of correctness for the
 * algorithm far from a station.
 *
 * Samples cover inland (river), inner bay, bay entrance, and open coast
 * geography, because interpolation quality collapses differently in each.
 *
 * Run: npx tsx scripts/validate-interpolation.ts
 */
import { nearestStation, stationsNear } from "neaps";
import { useStation } from "@neaps/tide-predictor";
import { interpolateStation } from "../src/interpolation.js";

interface Sample {
  label: string;
  geography: string;
  latitude: number;
  longitude: number;
}

const HORIZON_KM = 100;
const MAX_STATIONS = 4;
const HOURS = 48;

const SAMPLES: Sample[] = [
  { label: "Rio Vista", geography: "inland river", latitude: 38.165, longitude: -121.99 },
  { label: "Vallejo", geography: "north bay", latitude: 38.1, longitude: -122.26 },
  { label: "Alameda", geography: "inner bay", latitude: 37.732, longitude: -122.26 },
  { label: "San Francisco (Presidio)", geography: "bay entrance", latitude: 37.8, longitude: -122.46 },
  { label: "Point Reyes", geography: "open coast", latitude: 37.99, longitude: -123.02 },
  { label: "Half Moon Bay", geography: "open coast", latitude: 37.47, longitude: -122.43 },
  { label: "Monterey", geography: "open coast", latitude: 36.605, longitude: -121.89 },
  { label: "Boston", geography: "east coast harbor", latitude: 42.35, longitude: -71.05 },
];

const start = new Date();

for (const sample of SAMPLES) {
  const station = nearestStation({
    latitude: sample.latitude,
    longitude: sample.longitude,
  });
  if (!station) {
    console.log(`${sample.label}: no station found`);
    continue;
  }

  // Adjacent stations only: the target station must not see itself.
  const neighbors = stationsNear({
    latitude: station.latitude,
    longitude: station.longitude,
    maxDistance: HORIZON_KM,
    maxResults: 10,
  }).filter((candidate) => candidate.id !== station.id);

  const estimate = interpolateStation(
    { latitude: station.latitude, longitude: station.longitude },
    neighbors.map((candidate) => ({
      station: candidate,
      distanceKm: candidate.distance ?? Infinity,
    })),
    { stations: MAX_STATIONS },
  );

  const neighborNames = neighbors
    .slice(0, MAX_STATIONS)
    .map((candidate) => `${candidate.name} (${(candidate.distance ?? 0).toFixed(0)} km)`)
    .join(", ");

  if (!estimate) {
    console.log(
      `${sample.label} [${sample.geography}]: cannot interpolate ` +
        `(station ${station.name}, ${station.id}; neighbors: ${neighborNames || "none"})`,
    );
    continue;
  }

  const reference = useStation(station);
  const errors: number[] = [];
  for (let hour = 0; hour <= HOURS; hour += 1) {
    const time = new Date(start.getTime() + hour * 3600 * 1000);
    const own = reference.getWaterLevelAtTime({ time, datum: "MSL" }).level;
    const blended = estimate.predictor.getWaterLevelAtTime({ time, datum: "MSL" }).level;
    errors.push(blended - own);
  }

  const rmseM = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
  const maxAbsM = Math.max(...errors.map(Math.abs));
  const biasM = errors.reduce((sum, e) => sum + e, 0) / errors.length;
  // Range error: high-low swing of the station vs the blend, the number a
  // depth-referencing consumer (bathymetry) actually feels.
  const ownLevels = [];
  const blendedLevels = [];
  for (let hour = 0; hour <= HOURS; hour += 1) {
    const time = new Date(start.getTime() + hour * 3600 * 1000);
    ownLevels.push(reference.getWaterLevelAtTime({ time, datum: "MSL" }).level);
    blendedLevels.push(estimate.predictor.getWaterLevelAtTime({ time, datum: "MSL" }).level);
  }
  const ownRange = Math.max(...ownLevels) - Math.min(...ownLevels);
  const blendedRange = Math.max(...blendedLevels) - Math.min(...blendedLevels);

  console.log(
    `${sample.label} [${sample.geography}]: station=${station.name} (${station.id})`,
  );
  console.log(
    `  blended from: ${estimate.meta.stations
      .map((s) => `${s.name} (${s.distanceKm.toFixed(0)} km, ${(s.weight * 100).toFixed(0)}%)`)
      .join(", ")}`,
  );
  console.log(
    `  RMSE=${(rmseM * 100).toFixed(1)} cm  max=${(maxAbsM * 100).toFixed(1)} cm  ` +
      `bias=${biasM >= 0 ? "+" : ""}${(biasM * 100).toFixed(1)} cm  ` +
      `range own=${(ownRange * 100).toFixed(0)} cm vs blend=${(blendedRange * 100).toFixed(0)} cm`,
  );
}