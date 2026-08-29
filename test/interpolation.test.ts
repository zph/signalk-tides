import { describe, expect, it } from "vitest";
import type { Station } from "@neaps/tide-predictor";
import { blendConstituents, idwWeights, interpolateStation } from "../src/interpolation.js";

function stationFixture(
  overrides: Partial<Station> & {
    id: string;
    name: string;
    constituents?: Array<{ name: string; amplitude: number; phase: number }>;
  },
): Station {
  return {
    id: overrides.id,
    name: overrides.name,
    continent: "North America",
    country: "USA",
    timezone: "America/Los_Angeles",
    disclaimers: "test fixture",
    type: "reference",
    latitude: overrides.latitude ?? 37.8,
    longitude: overrides.longitude ?? -122.4,
    source: { name: "test", id: "test", url: "https://example.com" },
    datums: overrides.datums ?? { MSL: 0, MLLW: -1 },
    chart_datum: overrides.chart_datum ?? "MLLW",
    harmonic_constituents: overrides.constituents ?? [
      { name: "M2", amplitude: 0.5, phase: 10 },
      { name: "S2", amplitude: 0.2, phase: 20 },
      { name: "K1", amplitude: 0.3, phase: 30 },
      { name: "O1", amplitude: 0.15, phase: 40 },
    ],
  };
}

describe("idwWeights", () => {
  it("weights closer stations more, floored at 1 km", () => {
    const [near, far] = idwWeights([2, 10]);
    expect(near).toBeGreaterThan(far);
    expect(near + far).toBeCloseTo(1, 10);
  });

  it("does not let a station under the vessel swallow the blend", () => {
    const [at, other] = idwWeights([0, 10]);
    expect(at).toBeGreaterThan(other);
    // The 1 km floor keeps roughly 1% of the weight on the farther station.
    expect(at).toBeLessThan(0.999);
    expect(other).toBeGreaterThan(0.001);
  });
});

describe("blendConstituents", () => {
  it("blends phases as phasors so 350 and 10 average to 0, not 180", () => {
    const a = stationFixture({
      id: "a",
      name: "A",
      constituents: [
        { name: "M2", amplitude: 1, phase: 350 },
        { name: "S2", amplitude: 1, phase: 0 },
        { name: "K1", amplitude: 1, phase: 0 },
        { name: "O1", amplitude: 1, phase: 0 },
      ],
    });
    const b = stationFixture({
      id: "b",
      name: "B",
      constituents: [
        { name: "M2", amplitude: 1, phase: 10 },
        { name: "S2", amplitude: 1, phase: 0 },
        { name: "K1", amplitude: 1, phase: 0 },
        { name: "O1", amplitude: 1, phase: 0 },
      ],
    });

    const blended = blendConstituents([a, b], [0.5, 0.5])!;
    const m2 = blended.find((c) => c.name === "M2")!;
    // Two unit phasors 10 degrees either side of 0: x-mean is cos(10 deg),
    // y-mean cancels, so amplitude shrinks to cos(10 deg) at phase 0.
    expect(m2.amplitude).toBeCloseTo(Math.cos((10 * Math.PI) / 180), 10);
    expect(m2.phase).toBeCloseTo(0, 10);
  });

  it("drops constituents missing from any station", () => {
    const a = stationFixture({ id: "a", name: "A" });
    const b = stationFixture({
      id: "b",
      name: "B",
      constituents: [
        { name: "M2", amplitude: 0.5, phase: 10 },
        { name: "S2", amplitude: 0.2, phase: 20 },
        { name: "K1", amplitude: 0.3, phase: 30 },
      ],
    });
    const blended = blendConstituents([a, b], [0.5, 0.5])!;
    // O1 is missing from B, so the blend carries only the three shared names.
    expect(blended.map((c) => c.name)).toEqual(["M2", "S2", "K1"]);
  });
});

describe("interpolateStation", () => {
  it("builds a virtual station with attribution and metadata", () => {
    const a = stationFixture({ id: "a", name: "Alpha", latitude: 37.9, longitude: -122.4 });
    const b = stationFixture({ id: "b", name: "Bravo", latitude: 37.7, longitude: -122.4 });
    const virtual = interpolateStation(
      { latitude: 37.8, longitude: -122.4 },
      [
        { station: a, distanceKm: 11 },
        { station: b, distanceKm: 12 },
      ],
    )!;

    expect(virtual.meta.method).toBe("interpolated");
    expect(virtual.meta.stations.map((s) => s.id)).toEqual(["a", "b"]);
    expect(virtual.attribution).toContain("Interpolated from Alpha");
    expect(virtual.attribution).toContain("Bravo");
    expect(virtual.predictor.chart_datum).toBe("MLLW");
  });

  it("returns undefined when only one usable station is available", () => {
    const a = stationFixture({ id: "a", name: "Alpha" });
    expect(
      interpolateStation({ latitude: 37.8, longitude: -122.4 }, [{ station: a, distanceKm: 1 }]),
    ).toBeUndefined();
  });

  it("skips subordinate stations without real harmonics", () => {
    const a = stationFixture({ id: "a", name: "Alpha" });
    const offsetOnly = stationFixture({ id: "b", name: "Bravo", constituents: [] });
    expect(
      interpolateStation(
        { latitude: 37.8, longitude: -122.4 },
        [
          { station: a, distanceKm: 1 },
          { station: offsetOnly, distanceKm: 2 },
        ],
      ),
    ).toBeUndefined();
  });

  it("predicts a finite water level at the vessel position", () => {
    const a = stationFixture({ id: "a", name: "Alpha", latitude: 37.9, longitude: -122.4 });
    const b = stationFixture({
      id: "b",
      name: "Bravo",
      latitude: 37.7,
      longitude: -122.4,
      constituents: [
        { name: "M2", amplitude: 0.55, phase: 25 },
        { name: "S2", amplitude: 0.25, phase: 35 },
        { name: "K1", amplitude: 0.28, phase: 45 },
        { name: "O1", amplitude: 0.18, phase: 55 },
      ],
    });
    const virtual = interpolateStation(
      { latitude: 37.8, longitude: -122.4 },
      [
        { station: a, distanceKm: 11 },
        { station: b, distanceKm: 12 },
      ],
    )!;
    const level = virtual.predictor.getWaterLevelAtTime({
      time: new Date("2026-09-01T12:00:00Z"),
    }).level;
    expect(Number.isFinite(level)).toBe(true);
    expect(Math.abs(level)).toBeLessThan(10);
  });
});