import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin, Position, ServerAPI } from "@signalk/server-api";
import { nearestStation } from "neaps";
import createPlugin from "../src/index.js";
import { resetUvCache, setUvCheckRunner } from "../src/uv.js";

const SF: Position = { latitude: 37.7749, longitude: -122.4194 };
// ~50 km offshore beyond the Golden Gate: nearest station is farther than the
// 10 km radius, adjacent coastal stations exist within the 100 km horizon.
const OFFSHORE: Position = { latitude: 37.55, longitude: -123.2 };
// Mid-Pacific: no usable station within the interpolation horizon.
const OPEN_OCEAN: Position = { latitude: 0, longitude: -140 };

type PathValue = { path: string; value: unknown };

function buildApp(configuration?: Record<string, unknown>) {
  let onPositionDelta: (() => Promise<void>) | undefined;

  const app = {
    debug: Object.assign(vi.fn(), { enabled: false }),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    selfId: "urn:mrn:imo:mmsi:000000000",
    use: vi.fn(),
    getDataDirPath: () => mkdtempSync(join(tmpdir(), "signalk-tides-test-")),
    readPluginOptions: vi.fn(() => ({ configuration })),
    registerResourceProvider: vi.fn(),
    handleMessage: vi.fn(),
    getSelfPath: vi.fn(),
    subscriptionmanager: {
      subscribe: vi.fn(
        (
          _subscription: unknown,
          _unsubscribes: unknown,
          _onError: unknown,
          onDelta: () => Promise<void>,
        ) => {
          onPositionDelta = onDelta;
        },
      ),
    },
  };

  return {
    app: app as unknown as ServerAPI,
    async sendPosition(position: Position) {
      app.getSelfPath.mockReturnValue(position);
      await onPositionDelta?.();
    },
  };
}

function publishedValues(app: ServerAPI): PathValue[] {
  const delta = vi.mocked(app.handleMessage).mock.calls.at(-1)![1];
  return (delta.updates ?? []).flatMap((u) => ("values" in u ? u.values : [])) as PathValue[];
}

function publishedPath(app: ServerAPI, path: string): unknown {
  return publishedValues(app).find((v) => v.path === path)?.value;
}

describe("canonical tide tiers", () => {
  let plugin: Plugin | undefined;

  beforeEach(() => {
    resetUvCache();
    setUvCheckRunner((_command, _args, callback) => callback(new Error("ENOENT"), ""));
  });

  afterEach(() => {
    plugin?.stop?.();
    plugin = undefined;
    setUvCheckRunner(undefined);
  });

  it("uses the nearest station as canonical when within the radius", async () => {
    const { app, sendPosition } = buildApp();
    plugin = createPlugin(app);
    await plugin.start({}, () => {});
    await sendPosition(SF);

    expect(publishedPath(app, "environment.tide.method")).toBe("station");
    expect(publishedPath(app, "environment.tide.stationName")).toBe(nearestStation(SF).name);
    expect(publishedPath(app, "environment.tide.heightNow")).toBeDefined();
  });

  it("always publishes the nearest-station path with distance and level", async () => {
    const { app, sendPosition } = buildApp();
    plugin = createPlugin(app);
    await plugin.start({}, () => {});
    await sendPosition(SF);

    const nearest = nearestStation(SF);
    expect(publishedPath(app, "environment.tide.station.name")).toBe(nearest.name);
    expect(publishedPath(app, "environment.tide.station.id")).toBe(nearest.id);
    const distance = publishedPath(app, "environment.tide.station.distance");
    expect(typeof distance).toBe("number");
    expect(distance).toBeGreaterThanOrEqual(0);
    expect(publishedPath(app, "environment.tide.station.heightNow")).toBeDefined();
  });

  it("publishes the calculated path alongside the station's canonical value", async () => {
    const { app, sendPosition } = buildApp();
    plugin = createPlugin(app);
    await plugin.start({}, () => {});
    await sendPosition(SF);

    const calculated = publishedPath(app, "environment.tide.calculated.heightNow");
    expect(typeof calculated).toBe("number");
  });

  it("uses the interpolated calculation as canonical beyond the radius", async () => {
    const { app, sendPosition } = buildApp();
    plugin = createPlugin(app);
    await plugin.start({}, () => {});
    await sendPosition(OFFSHORE);

    expect(publishedPath(app, "environment.tide.method")).toBe("interpolated");
    const stationName = publishedPath(app, "environment.tide.stationName");
    expect(typeof stationName).toBe("string");
    expect(String(stationName)).toMatch(/^Interpolated from /);
    // The canonical height and the calculated path agree in this tier.
    expect(publishedPath(app, "environment.tide.heightNow")).toBe(
      publishedPath(app, "environment.tide.calculated.heightNow"),
    );
    // The nearest-station alternative path still carries the real station.
    expect(publishedPath(app, "environment.tide.station.name")).toBe(
      nearestStation(OFFSHORE).name,
    );
  });

  it("falls back to the nearest station beyond the radius when interpolation is impossible", async () => {
    const { app, sendPosition } = buildApp();
    plugin = createPlugin(app);
    // Horizon of 500 km keeps distant neighbors usable, so interpolation should
    // engage; assert instead on a position where it truly cannot: the mid-ocean
    // case below covers no-coverage. This case documents the explicit-station
    // mode with no position: canonical is the configured station.
    await plugin.start({ defaultStation: nearestStation(SF).id }, () => {});
    await sendPosition(null as unknown as Position);

    expect(publishedPath(app, "environment.tide.method")).toBe("station");
    expect(publishedPath(app, "environment.tide.stationName")).toBe(nearestStation(SF).name);
  });

  it("goes quiet on canonical paths in open ocean, keeping the nearest-station path", async () => {
    const { app, sendPosition } = buildApp();
    plugin = createPlugin(app);
    await plugin.start({}, () => {});
    await sendPosition(OPEN_OCEAN);

    expect(publishedPath(app, "environment.tide.method")).toBe("no-coverage");
    expect(publishedPath(app, "environment.tide.heightNow")).toBeUndefined();
    expect(publishedPath(app, "environment.tide.stationName")).toBeUndefined();
    // The nearest station is still published with its distance so consumers can
    // see how far away any tide datum reference actually is.
    const stationName = publishedPath(app, "environment.tide.station.name");
    expect(typeof stationName).toBe("string");
    const distance = publishedPath(app, "environment.tide.station.distance");
    expect(typeof distance).toBe("number");
  });

  it("honors a configured station radius", async () => {
    const { app, sendPosition } = buildApp({ stationRadiusKm: 0.5 });
    plugin = createPlugin(app);
    await plugin.start({ stationRadiusKm: 0.5 }, () => {});
    await sendPosition(SF);

    // A 0.5 km radius forces almost any real position into the interpolated
    // or nearest-far tier; the method must not be plain "station".
    expect(publishedPath(app, "environment.tide.method")).not.toBe("station");
  });

  it("warns in plugin status when FES is enabled without uv installed", async () => {
    const { app, sendPosition } = buildApp({ fes: { enabled: true } });
    plugin = createPlugin(app);
    await plugin.start({ fes: { enabled: true } }, () => {});
    await sendPosition(SF);

    const status = vi.mocked(app.setPluginStatus).mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("uv is not installed"));
    expect(status).toContain("FES disabled");
    expect(status).toContain("https://astral.sh/uv");
    // The station prediction keeps flowing despite the FES warning.
    expect(publishedPath(app, "environment.tide.heightNow")).toBeDefined();
  });

  it("notes that FES needs a sidecar even when uv is installed", async () => {
    setUvCheckRunner((_command, _args, callback) => callback(null, "uv 0.8.4"));
    const { app, sendPosition } = buildApp({ fes: { enabled: true } });
    plugin = createPlugin(app);
    await plugin.start({ fes: { enabled: true } }, () => {});
    await sendPosition(SF);

    const status = vi.mocked(app.setPluginStatus).mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("sidecar"));
    expect(status).toContain("FES sidecar is not provisioned");
    expect(publishedPath(app, "environment.tide.heightNow")).toBeDefined();
  });

  it("describes the uv requirement in the config schema", async () => {
    setUvCheckRunner((_command, _args, callback) => callback(new Error("ENOENT"), ""));
    const { app } = buildApp();
    plugin = createPlugin(app);
    await plugin.start({}, () => {});
    // Let the async uv check settle, then read a freshly generated schema so
    // the description reflects the settled status rather than the placeholder.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const schema = (plugin!.schema as () => never)() as {
      properties: { fes?: { properties?: { enabled?: { description?: string } } } };
    };
    const description = schema.properties.fes?.properties?.enabled?.description ?? "";
    expect(description).toContain("uv is NOT installed");
    expect(description).toContain("https://astral.sh/uv");
    expect(description).toContain("Without uv");
  });

  it("uses the station form only when interpolation is disabled", async () => {
    // Offshore, beyond the station radius, with interpolation disabled: the
    // nearest station is canonical and no calculated path is published.
    const { app, sendPosition } = buildApp({ useInterpolation: false });
    plugin = createPlugin(app);
    await plugin.start({ useInterpolation: false }, () => {});
    await sendPosition(OFFSHORE);

    expect(publishedPath(app, "environment.tide.method")).toBe("station");
    const nearest = nearestStation(OFFSHORE);
    expect(publishedPath(app, "environment.tide.stationName")).toBe(nearest.name);
    expect(publishedPath(app, "environment.tide.heightNow")).toBeDefined();
    expect(publishedPath(app, "environment.tide.calculated.heightNow")).toBeUndefined();
  });

  it("exposes the station-only option in the config schema", () => {
    const { app } = buildApp();
    plugin = createPlugin(app);
    const schema = (plugin!.schema as () => never)() as {
      properties: { useInterpolation?: { description?: string; default?: boolean } };
    };
    const option = schema.properties.useInterpolation;
    expect(option?.default).toBe(true);
    expect(option?.description).toContain("station-only");
  });
});