/*
 * Copyright 2017 Scott Bender <scott@scottbender.net> and Joachim Bakke
 * Copyright 2025 Brandon Keepers <brandon@opensoul.org>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { PathValue } from "@signalk/server-api";
import type { Context, Delta, Path, Plugin, Position, ServerAPI, Timestamp } from "@signalk/server-api";
import { RequestHandler } from "express";
import { createRoutes } from "@neaps/api";
import { findStation, nearestStation, stationsNear } from "neaps";
import { tideStateAt, timeToNextExtreme } from "./calculations.js";
import FileCache from "./cache.js";
import { interpolateStation, type InterpolationMeta } from "./interpolation.js";
import { checkUv, UV_INSTALL_INSTRUCTIONS, type UvStatus } from "./uv.js";
import { withVesselPosition } from "./middleware.js";

type Predictor = ReturnType<typeof findStation>;
type Forecast = ReturnType<Predictor["getExtremesPrediction"]>;

interface Config {
  defaultStation?: string;
  /** When false, disable the interpolated calculation and always publish the nearest station prediction. */
  useInterpolation?: boolean;
  /** Use the nearest station's prediction directly when the vessel is within this radius (km). */
  stationRadiusKm?: number;
  /** Number of surrounding stations blended for the interpolated prediction. */
  interpolationStations?: number;
  /** Stations beyond this distance (km) are not blended. */
  interpolationMaxDistanceKm?: number;
  /** FES spatial model (Python/uv sidecar); gated on uv being installed. */
  fes?: { enabled?: boolean };
}

const DEFAULT_STATION_RADIUS_KM = 10;
const DEFAULT_INTERPOLATION_STATIONS = 4;
const DEFAULT_INTERPOLATION_MAX_DISTANCE_KM = 100;

// Recompute and republish on a fixed interval. Predictions are computed locally
// by neaps, so this is cheap and needs no configuration.
const UPDATE_INTERVAL = 60 * 1000; // 1 minute
const API_PATH = "/signalk/v2/api/tides";

/**
 * How the canonical tide for this minute was produced. Every tier carries its
 * own attribution so downstream consumers (bathymetry, instrument panels) can
 * judge the provenance instead of guessing:
 *
 * - `station`: the vessel is within the configured radius of a station, or an
 *   explicit default station is configured; that station's prediction is canonical.
 * - `interpolated`: beyond the radius, the canonical value is the harmonic
 *   blend of surrounding stations synthesized at the vessel's position.
 * - `nearest-far`: no blend was possible nearby, so the nearest station within
 *   the interpolation horizon is canonical, with its distance in the attribution.
 * - `no-coverage`: the nearest usable station is beyond the horizon; the
 *   canonical paths go quiet (consumers such as bathymetry stop rather than
 *   record a wrong tide) while the nearest-station path stays published.
 */
type TideMethod = "station" | "interpolated" | "nearest-far" | "no-coverage";

interface CanonicalPrediction {
  method: TideMethod;
  predictor: Predictor | null;
  forecast: Forecast | null;
  /** Human-readable provenance published on environment.tide.stationName. */
  attribution: string | null;
  nearest: NearestStation | null;
  /** Spatially blended prediction for environment.tide.calculated.heightNow. */
  calculated: Predictor | null;
  interpolation: InterpolationMeta | null;
}

interface NearestStation {
  name: string;
  id: string;
  distanceKm?: number;
  predictor: Predictor;
}

export default function (app: ServerAPI): Plugin {
  let unsubscribes: (() => void)[] = [];
  let activeRouter: RequestHandler | null = null;
  let lastPosition: Position | null = null;
  let config: Config = {};
  let lastCanonical: CanonicalPrediction | null = null;
  let fesWarning: string | null = null;
  let uvStatus: UvStatus | undefined;

  // Mount forwarding middleware once (Express doesn't support unmounting)
  // @ts-expect-error: app is an Express app at runtime
  app.use(API_PATH, (req, res, next) => {
    if (activeRouter) {
      activeRouter(req, res, next);
    } else {
      next();
    }
  });

  const plugin: Plugin = {
    id: "tides",
    name: "Tides",
    description:
      "Offline tidal predictions for the vessel's position, powered by Neaps. Near a station the station prediction is canonical; farther away the canonical tide is interpolated from the surrounding stations, with the nearest station always published alongside.",
    schema: () => ({
      title: "Tides",
      type: "object",
      properties: {
        defaultStation: {
          type: "string",
          title: "Default tide station",
          description:
            "Use the closest station to the vessel's current position, or pick a default nearby station.",
          default: "auto",
          oneOf: defaultStationOptions(),
        },
        stationRadiusKm: {
          type: "number",
          title: "Station radius (km)",
          description:
            "When the vessel is within this distance of a tide station, that station's prediction is used as the canonical tide. Farther away, the canonical tide is interpolated from the surrounding stations.",
          default: DEFAULT_STATION_RADIUS_KM,
          minimum: 0.5,
          maximum: 100,
        },
        useInterpolation: {
          type: "boolean",
          title: "Interpolated tides",
          description:
            "Blend surrounding stations into an interpolated tide when the vessel is beyond the station radius. " +
            "Disable to always publish the nearest station's prediction on the canonical paths, the more conservative station-only behavior.",
          default: true,
        },
        interpolationStations: {
          type: "number",
          title: "Interpolation stations",
          description:
            "How many surrounding stations to blend into the interpolated prediction (nearest first).",
          default: DEFAULT_INTERPOLATION_STATIONS,
          minimum: 2,
          maximum: 10,
        },
        interpolationMaxDistanceKm: {
          type: "number",
          title: "Interpolation horizon (km)",
          description:
            "Stations farther than this are not blended. Beyond the horizon the canonical tide goes quiet rather than extrapolate, and only the nearest-station path is published.",
          default: DEFAULT_INTERPOLATION_MAX_DISTANCE_KM,
          minimum: 5,
          maximum: 500,
        },
        fes: {
          type: "object",
          title: "FES spatial model",
          properties: {
            enabled: {
              type: "boolean",
              title: "Use FES (requires uv)",
              description: fesDescription(),
              default: false,
            },
          },
        },
      },
    }),
    start,
    stop() {
      unsubscribes.forEach((f) => f());
      unsubscribes = [];
      activeRouter = null;
    },
  };

  function fesDescription(): string {
    const uvNote =
      uvStatus === undefined
        ? "Checking for uv..."
        : uvStatus.available
          ? `uv ${uvStatus.version ?? ""} is installed on this server.`.trim()
          : `uv is NOT installed on this server. ${UV_INSTALL_INSTRUCTIONS}`;
    return (
      "FES provides global spatial tide harmonics for waters far from any station, " +
      "computed by a Python sidecar managed by uv. " +
      uvNote +
      " Without uv, the plugin never attempts FES and falls back to station interpolation."
    );
  }

  function defaultStationOptions(): { const: string; title: string }[] {
    const options = [{ const: "auto", title: "Closest station" }];

    if (lastPosition) {
      for (const station of stationsNear({ ...lastPosition, maxResults: 10 })) {
        options.push({ const: station.id, title: stationTitle(station) });
      }
    }

    // Keep the saved station selectable even when it is not in the nearby
    // list, so opening the settings far from it (or before a position fix)
    // cannot clobber it on save.
    const saved = savedDefaultStation();
    if (saved && saved !== "auto" && !options.some((o) => o.const === saved)) {
      let title = saved;
      try {
        title = stationTitle(findStation(saved));
      } catch {
        // Unknown id: keep the raw value as the label
      }
      options.splice(1, 0, { const: saved, title });
    }

    return options;
  }

  function savedDefaultStation(): string | undefined {
    try {
      const saved = app.readPluginOptions() as {
        configuration?: Config | null;
      };
      return saved?.configuration?.defaultStation;
    } catch {
      return undefined;
    }
  }

  async function start(options?: object) {
    app.debug("Starting tides");
    config = (options ?? {}) as Config;

    // Keep the forecast and the predictor that produced it together, so the
    // extremes and the current height are always read from the same source.
    const cache = new FileCache(app.getDataDirPath());

    // Safety gate: FES calculations need uv. Check before ever attempting the
    // fancy path, and surface the result in the config description.
    void checkUv().then((status) => {
      uvStatus = status;
    });
    if (config.fes?.enabled) {
      const uv = await checkUv();
      uvStatus = uv;
      if (!uv.available) {
        fesWarning = `FES disabled: uv is not installed. ${UV_INSTALL_INSTRUCTIONS}`;
        app.setPluginStatus(fesWarning);
      } else {
        // uv is present, but no FES sidecar is shipped yet. Never attempt the
        // heavy calculations without the sidecar; fall back to interpolation.
        fesWarning =
          "uv is installed, but the FES sidecar is not provisioned on this server; using station interpolation.";
        app.setPluginStatus(fesWarning);
      }
    }

    // Mount the Neaps API, with vessel/default resolved to the configured
    // default station (or the nearest one).
    activeRouter = withVesselPosition(
      // @neaps/api bundles its own Express declarations, so its Router is
      // callable at runtime but not structurally compatible with ours.
      createRoutes({ prefix: API_PATH }) as unknown as RequestHandler,
      () => lastPosition,
      () => config.defaultStation ?? null,
    );

    // Register tide predictions as a resource provider
    app.registerResourceProvider({
      type: "tides",
      methods: {
        async listResources() {
          const canonical = resolveCanonical();
          if (!canonical.predictor) {
            throw new Error("No position or default station available");
          }
          return {
            ...forecastFor(canonical.predictor),
            method: canonical.method,
            stationDistanceKm: canonical.nearest?.distanceKm,
          } as unknown as Record<string, unknown>;
        },
        getResource(): never {
          throw new Error("Not implemented");
        },
        setResource(): never {
          throw new Error("Not implemented");
        },
        deleteResource(): never {
          throw new Error("Not implemented");
        },
      },
    });

    app.subscriptionmanager.subscribe(
      {
        context: ("vessels." + app.selfId) as Context,
        subscribe: [
          {
            path: "navigation.position" as Path,
            period: UPDATE_INTERVAL,
            policy: "fixed",
          },
        ],
      },
      unsubscribes,
      (subscriptionError) => {
        app.error("Error:" + subscriptionError);
      },
      updatePosition,
    );

    function forecastFor(predictor: Predictor): Forecast {
      const now = new Date();
      return predictor.getExtremesPrediction({
        start: now,
        end: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      });
    }

    /**
     * Resolve the nearest station to the vessel, if a position is known.
     * findStation() is used for the explicit-station case.
     */
    function interpolationEnabled(): boolean {
      return config.useInterpolation !== false;
    }

    function nearestToPosition(): NearestStation | null {
      if (!lastPosition) return null;
      try {
        const predictor = nearestStation(lastPosition);
        return {
          name: predictor.name,
          id: predictor.id,
          distanceKm: predictor.distance,
          predictor,
        };
      } catch {
        return null;
      }
    }

    function interpolatedAt(position: Position): ReturnType<typeof interpolateStation> {
      const neighbors = stationsNear({
        ...position,
        maxDistance: config.interpolationMaxDistanceKm ?? DEFAULT_INTERPOLATION_MAX_DISTANCE_KM,
        maxResults: 10,
      });
      return interpolateStation(
        position,
        neighbors.map((station) => ({ station, distanceKm: station.distance ?? Infinity })),
        { stations: config.interpolationStations },
      );
    }

    function resolveCanonical(): CanonicalPrediction {
      // Explicit default station: its prediction is canonical regardless of distance.
      if (config.defaultStation && config.defaultStation !== "auto") {
        try {
          const predictor = findStation(config.defaultStation);
          const nearest = nearestToPosition() ?? {
            name: predictor.name,
            id: predictor.id,
            predictor,
          };
          const calculated =
            interpolationEnabled() && lastPosition ? interpolatedAt(lastPosition) : undefined;
          return {
            method: "station",
            predictor,
            forecast: forecastFor(predictor),
            attribution: predictor.name,
            nearest,
            calculated: calculated?.predictor ?? null,
            interpolation: calculated?.meta ?? null,
          };
        } catch {
          app.error(`Configured tide station not found: ${config.defaultStation}`);
        }
      }

      if (!lastPosition) {
        return {
          method: "no-coverage",
          predictor: null,
          forecast: null,
          attribution: null,
          nearest: null,
          calculated: null,
          interpolation: null,
        };
      }

      const nearest = nearestToPosition();
      if (!nearest) {
        return {
          method: "no-coverage",
          predictor: null,
          forecast: null,
          attribution: null,
          nearest: null,
          calculated: null,
          interpolation: null,
        };
      }

      const radiusKm = config.stationRadiusKm ?? DEFAULT_STATION_RADIUS_KM;
      const horizonKm =
        config.interpolationMaxDistanceKm ?? DEFAULT_INTERPOLATION_MAX_DISTANCE_KM;

      // Station-only mode: the nearest station's prediction is canonical
      // regardless of distance, and no calculated path is published.
      if (!interpolationEnabled()) {
        return {
          method: "station",
          predictor: nearest.predictor,
          forecast: forecastFor(nearest.predictor),
          attribution: nearest.name,
          nearest,
          calculated: null,
          interpolation: null,
        };
      }

      if (nearest.distanceKm !== undefined && nearest.distanceKm <= radiusKm) {
        const calculated = interpolatedAt(lastPosition);
        return {
          method: "station",
          predictor: nearest.predictor,
          forecast: forecastFor(nearest.predictor),
          attribution: nearest.name,
          nearest,
          calculated: calculated?.predictor ?? null,
          interpolation: calculated?.meta ?? null,
        };
      }

      const virtual = interpolatedAt(lastPosition);
      if (virtual) {
        return {
          method: "interpolated",
          predictor: virtual.predictor,
          forecast: forecastFor(virtual.predictor),
          attribution: virtual.attribution,
          nearest,
          calculated: virtual.predictor,
          interpolation: virtual.meta,
        };
      }

      if (nearest.distanceKm !== undefined && nearest.distanceKm <= horizonKm) {
        return {
          method: "nearest-far",
          predictor: nearest.predictor,
          forecast: forecastFor(nearest.predictor),
          attribution: `${nearest.name} (nearest station, ${nearest.distanceKm.toFixed(0)} km away)`,
          nearest,
          calculated: null,
          interpolation: null,
        };
      }

      return {
        method: "no-coverage",
        predictor: null,
        forecast: null,
        attribution: null,
        nearest,
        calculated: null,
        interpolation: null,
      };
    }

    async function updatePosition() {
      const newPosition = app.getSelfPath("navigation.position.value");

      // New position received, save it to the cache
      if (newPosition) {
        lastPosition = newPosition as Position | null;
        await cache.set("position", lastPosition);
      }

      // No last known position, try to load from cache.
      if (!lastPosition) {
        lastPosition = (await cache.get("position")) as Position;
      }

      // A configured default station predicts without a position
      updateForecast();
    }

    function updateForecast() {
      try {
        const canonical = resolveCanonical();
        lastCanonical = canonical;

        if (!canonical.predictor || !canonical.forecast) {
          const detail = canonical.nearest
            ? `no station within ${
                config.interpolationMaxDistanceKm ?? DEFAULT_INTERPOLATION_MAX_DISTANCE_KM
              } km`
            : "no position or default station available";
          app.setPluginStatus(`No canonical tide: ${detail}. Nearest station path only.${fesSuffix()}`);
        } else {
          app.setPluginStatus(`Updated tide forecast (${canonical.method}).${fesSuffix()}`);
        }
        updateTides();
      } catch (e: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app.setPluginError((e as any).message);
        // @ts-expect-error: TODO[TS] this accepts more than just a string: https://github.com/bkeepers/signalk-server/blob/d6845ee1f915e6b729d66d2b08b15dc2e0da8e51/src/interfaces/plugins.ts#L517-L519
        app.error(e);
      }
    }

    function fesSuffix(): string {
      return fesWarning ? ` ${fesWarning}` : "";
    }

    function updateTides(now = new Date()) {
      const canonical = lastCanonical;
      if (!canonical) return;

      const values: PathValue[] = [];

      // Always publish the nearest-station alternative path with its distance,
      // so consumers can compare provenance even when the canonical tide is
      // interpolated.
      if (canonical.nearest) {
        const nearestLevel = canonical.nearest.predictor.getWaterLevelAtTime({
          time: now,
        }).level;
        values.push(
          { path: "environment.tide.station.name" as Path, value: canonical.nearest.name },
          { path: "environment.tide.station.id" as Path, value: canonical.nearest.id },
          {
            path: "environment.tide.station.distance" as Path,
            value: canonical.nearest.distanceKm === undefined
              ? 0
              : Math.round(canonical.nearest.distanceKm * 1000),
          },
          { path: "environment.tide.station.heightNow" as Path, value: nearestLevel },
        );
      }

      // Always publish the spatially calculated value when a blend exists.
      if (canonical.calculated) {
        values.push({
          path: "environment.tide.calculated.heightNow" as Path,
          value: canonical.calculated.getWaterLevelAtTime({ time: now }).level,
        });
      }

      values.push({ path: "environment.tide.method" as Path, value: canonical.method });

      // Canonical paths go quiet on no-coverage rather than publish a tide
      // extrapolated from a distant station; consumers stop instead of
      // recording a wrong datum.
      if (!canonical.predictor || !canonical.forecast || !canonical.attribution) {
        publish(now, values);
        return;
      }

      const heightNow = canonical.predictor.getWaterLevelAtTime({ time: now }).level;
      const state = tideStateAt(canonical.forecast.extremes, now);
      const secondsToNextExtreme = timeToNextExtreme(canonical.forecast.extremes, now);
      const nextTides = canonical.forecast.extremes
        .filter(({ time }) => time >= now)
        .slice(0, 2);

      values.push(
        { path: "environment.tide.stationName" as Path, value: canonical.attribution },
        { path: "environment.tide.heightNow" as Path, value: heightNow },
      );
      if (state !== null) {
        values.push({ path: "environment.tide.state" as Path, value: state });
      }
      if (secondsToNextExtreme !== null) {
        values.push({
          path: "environment.tide.timeToNextExtreme" as Path,
          value: secondsToNextExtreme,
        });
      }
      for (const { label, time, level } of nextTides) {
        values.push({
          path: `environment.tide.height${label}` as Path,
          value: level,
        });
        values.push({
          path: `environment.tide.time${label}` as Path,
          value: time.toISOString(),
        });
      }

      publish(now, values);
    }

    function publish(now: Date, values: PathValue[]) {
      if (values.length === 0) return;
      const delta: Delta = {
        context: ("vessels." + app.selfId) as Context,
        updates: [
          {
            timestamp: now.toISOString() as Timestamp,
            values,
          },
          {
            timestamp: now.toISOString() as Timestamp,
            meta: [
              {
                path: "environment.tide.method" as Path,
                value: {
                  description:
                    "How the canonical tide was produced: station (near or configured), interpolated (blended from surrounding stations), nearest-far (nearest station beyond the radius), or no-coverage (canonical tide withheld)",
                },
              },
              {
                path: "environment.tide.station.distance" as Path,
                value: {
                  units: "m",
                  description: "Distance to the nearest tide station",
                },
              },
              {
                path: "environment.tide.station.heightNow" as Path,
                value: {
                  description: "Nearest station's predicted water level, always published",
                },
              },
              {
                path: "environment.tide.calculated.heightNow" as Path,
                value: {
                  description:
                    "Water level interpolated from surrounding stations' harmonics at the vessel's position",
                },
              },
            ],
          },
        ],
      };

      if (app.debug.enabled) {
        app.debug("Sending delta: " + JSON.stringify(delta));
      }
      app.handleMessage(plugin.id, delta);
    }

    // Perform initial update on startup after short delay to allow gnss position to be populated
    const startupTimer = setTimeout(updatePosition, 4000);
    unsubscribes.push(() => clearTimeout(startupTimer));
    // Recompute the current height and next tides every minute
    const updateTimer = setInterval(() => updateTides(), UPDATE_INTERVAL);
    unsubscribes.push(() => clearInterval(updateTimer));
  }

  return plugin;
}

function stationTitle(station: Predictor): string {
  const where = [station.region, station.country].filter(Boolean).join(", ");
  const distance =
    station.distance != null ? ` — ${station.distance.toFixed(1)} km` : "";
  return `${station.name}${where ? ` (${where})` : ""}${distance}`;
}