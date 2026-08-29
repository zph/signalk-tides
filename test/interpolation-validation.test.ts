import { describe, expect, it } from "vitest";
import { nearestStation, stationsNear } from "neaps";
import { useStation } from "@neaps/tide-predictor";
import { interpolateStation } from "../src/interpolation.js";

/**
 * Leave-one-out regression test for the spatial interpolation.
 *
 * Each sample station is hidden from the blender: the prediction at its own
 * position comes from adjacent stations only, and is compared against the
 * station's harmonic prediction over a fixed 48-hour window. The thresholds
 * come from a measured baseline run (see scripts/validate-interpolation.ts)
 * with roughly 2x margin for database updates and sampling phase.
 *
 * These errors are the delta of correctness a vessel would get from the
 * interpolated tide path when it is far from any station.
 */

const HORIZON_KM = 100;
const MAX_STATIONS = 4;
const START = new Date("2026-09-01T00:00:00Z");

interface Sample {
  label: string;
  geography: string;
  latitude: number;
  longitude: number;
  /** Baseline RMSE measured on the initial run, in cm. */
  baselineRmseCm: number;
  /** Regression threshold, in cm (roughly 2x baseline). */
  thresholdRmseCm: number;
}

const SAMPLES: Sample[] = [
  { label: "Montezuma Slough", geography: "inland river", latitude: 38.165, longitude: -121.99, baselineRmseCm: 7.4, thresholdRmseCm: 25 },
  { label: "Vallejo", geography: "north bay", latitude: 38.1, longitude: -122.26, baselineRmseCm: 22.9, thresholdRmseCm: 45 },
  { label: "Alameda", geography: "inner bay", latitude: 37.732, longitude: -122.26, baselineRmseCm: 12.9, thresholdRmseCm: 30 },
  { label: "Golden Gate", geography: "bay entrance", latitude: 37.8, longitude: -122.46, baselineRmseCm: 5.3, thresholdRmseCm: 15 },
  { label: "Point Reyes", geography: "open coast", latitude: 37.99, longitude: -123.02, baselineRmseCm: 14.7, thresholdRmseCm: 35 },
  { label: "Half Moon Bay", geography: "open coast", latitude: 37.47, longitude: -122.43, baselineRmseCm: 19.6, thresholdRmseCm: 40 },
  { label: "Boston", geography: "east coast harbor", latitude: 42.35, longitude: -71.05, baselineRmseCm: 1.7, thresholdRmseCm: 10 },
];

describe("interpolation leave-one-out validation", () => {
  for (const sample of SAMPLES) {
    it(`predicts ${sample.label} (${sample.geography}) within ${sample.thresholdRmseCm} cm using adjacent stations only`, () => {
      const station = nearestStation({
        latitude: sample.latitude,
        longitude: sample.longitude,
      });
      expect(station, `no station found for ${sample.label}`).toBeTruthy();

      const neighbors = stationsNear({
        latitude: station!.latitude,
        longitude: station!.longitude,
        maxDistance: HORIZON_KM,
        maxResults: 10,
      }).filter((candidate) => candidate.id !== station!.id);

      const estimate = interpolateStation(
        { latitude: station!.latitude, longitude: station!.longitude },
        neighbors.map((candidate) => ({
          station: candidate,
          distanceKm: candidate.distance ?? Infinity,
        })),
        { stations: MAX_STATIONS },
      );
      expect(estimate, `cannot interpolate for ${sample.label}`).toBeTruthy();

      const reference = useStation(station!);
      const errors: number[] = [];
      for (let hour = 0; hour <= 48; hour += 1) {
        const time = new Date(START.getTime() + hour * 3600 * 1000);
        const own = reference.getWaterLevelAtTime({ time, datum: "MSL" }).level;
        const blended = estimate!.predictor.getWaterLevelAtTime({ time, datum: "MSL" }).level;
        errors.push(blended - own);
      }

      const rmseCm =
        Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length) * 100;
      expect(
        rmseCm,
        `${sample.label} (${sample.geography}) leave-one-out RMSE ${rmseCm.toFixed(1)} cm ` +
          `exceeds threshold (baseline ${sample.baselineRmseCm} cm)`,
      ).toBeLessThan(sample.thresholdRmseCm);
    });
  }

  it("does not interpolate with fewer than two usable neighbors", () => {
    const station = nearestStation({ latitude: 42.35, longitude: -71.05 });
    const onlySelf = interpolateStation(
      { latitude: station!.latitude, longitude: station!.longitude },
      [{ station: station!, distanceKm: 0 }],
    );
    expect(onlySelf).toBeUndefined();
  });
});