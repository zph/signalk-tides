# signalk-tides

A SignalK plugin that provides offline tidal predictions for the vessel's position, powered by [Neaps](https://github.com/neaps/neaps).

Since 2.0, predictions are computed locally from harmonic constituents — no network access or API keys required.

## Installation

Install `signalk-tides` from the SignalK Appstore or manually by running `npm install signalk-tides` in the SignalK server directory (`~/.signalk`).


## Usage

This plugin depends on `navigation.position`.

It publishes the following [tide data](https://signalk.org/specification/1.7.0/doc/vesselsBranch.html#vesselsregexpenvironmenttide):

* `environment.tide.heightHigh`
* `environment.tide.timeHigh`
* `environment.tide.heightLow`
* `environment.tide.timeLow`
* `environment.tide.heightNow`
* `environment.tide.stationName`
* `environment.tide.state` — tide trend, `rising` or `falling`
* `environment.tide.timeToNextExtreme` — seconds until the next high or low water

### How the canonical tide is chosen

The prediction published on `environment.tide.heightNow` is *canonical*, and the plugin
always says how it was produced:

* `environment.tide.method` — `station` (the vessel is within the station radius, or a
  default station is configured), `interpolated` (the canonical tide is the harmonic blend
  of surrounding stations synthesized at the vessel's position), `nearest-far` (no blend was
  possible, so the nearest station within the horizon is canonical, with its distance in the
  attribution), or `no-coverage` (nothing usable within the horizon; the canonical paths go
  quiet so consumers such as bathymetry stop rather than record a wrong tide).

Alongside the canonical value, two paths always tell the truth about provenance:

* `environment.tide.station.*` — `name`, `id`, `distance` (meters), and `heightNow` of the
  nearest station, regardless of how the canonical tide was produced.
* `environment.tide.calculated.heightNow` — the spatially interpolated water level at the
  vessel's position, whenever at least two surrounding stations can be blended.

### Interpolated tides and station-only mode

Beyond the configured station radius (default 10 km), the canonical tide switches to the
interpolated calculation: constituent amplitudes and phases are blended across the nearest
stations (inverse-distance weighted, phases blended as phasors), and the blended prediction
is labeled with every station and weight used.

Leave-one-out validation against real stations (a station predicted only from its
neighbors) measured 5-23 cm RMSE in bay, river, and coastal geography around San Francisco
and Boston; see `scripts/validate-interpolation.ts` and
`test/interpolation-validation.test.ts`.

Set **Interpolated tides** (config key `useInterpolation`) to `false` to disable the
calculation entirely: the nearest station's prediction is published on the canonical paths
regardless of distance, and no calculated path is published. This is the more conservative
station-only behavior.

### FES spatial model (optional, requires uv)

FES is reserved for a future spatial-model sidecar managed by
[uv](https://docs.astral.sh/uv/). The plugin checks that uv is installed before ever
attempting that path, but does not yet ship or provision the sidecar. Enabling the option
therefore leaves FES inactive, reports the reason in plugin status, and continues with
station interpolation.

### Tides API

The plugin mounts the [Neaps API](https://github.com/neaps/neaps) at `/signalk/v2/api/tides`, which serves station search, extremes, and timeline predictions. The synthetic station `vessel/default` resolves to the configured default station, or the nearest station to the vessel when none is set:

```
$ curl http://localhost:3000/signalk/v2/api/tides/stations/vessel/default/extremes
```

### Tides resource

It also registers a `tides` resource, which returns the next 7 days of tide extremes for the vessel's position.

```
$ curl http://localhost:3000/signalk/v2/api/resources/tides
```

##### Response

```json
{
   "datum": "MLLW",
   "units": "meters",
   "station": {
      "id": "noaa/9414290",
      "name": "San Francisco",
      "latitude": 37.806,
      "longitude": -122.465
   },
   "extremes": [
      { "time": "2025-03-29T00:45:00.000Z", "level": 0.025, "high": false, "low": true, "label": "Low" },
      { "time": "2025-03-29T07:20:00.000Z", "level": 1.928, "high": true, "low": false, "label": "High" }
   ]
}
```

## License

This plugin is a fork of the [signalk-tides-api](https://github.com/joabakk/signalk-tides-api) plugin (which is no longer working) and is licensed under the [Apache License 2.0](LICENSE). Kudos to @joabakk and @sbender9 for the original work.
