#!/usr/bin/env python3
"""Build compact, static five-day forecasts for France and the Red Sea."""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


ROOT = Path(__file__).resolve().parents[1]
OUTPUTS = {
    "france": ROOT / "data" / "forecast.json",
    "red-sea": ROOT / "data" / "forecast.red-sea.json",
}
LAND_MASK_PATH = ROOT / "data" / "land-mask.geojson"
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
CHUNK_SIZE = 40
FORECAST_DAYS = 5

WEATHER_FIELDS = (
    "wind_speed_10m",
    "wind_gusts_10m",
    "wind_direction_10m",
    "pressure_msl",
)
MARINE_FIELDS = (
    "wave_height",
    "wave_period",
    "wave_direction",
    "swell_wave_height",
    "swell_wave_period",
    "swell_wave_direction",
    "sea_surface_temperature",
    "ocean_current_velocity",
    "ocean_current_direction",
    "sea_level_height_msl",
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
LOGGER = logging.getLogger("fetch-data")

# These coarse marine polygons exclude most land while covering each selected
# coastal zone. The grid is deliberately denser close to shore.
REGIONS = (
    {
        "name": "Manche",
        "offshore_step": 0.82,
        "coastline": [
            (-5.8, 48.0), (-5.0, 48.35), (-4.4, 48.65), (-3.8, 49.05),
            (-3.2, 49.35), (-2.6, 49.6), (-2.0, 49.8), (-1.4, 49.85),
            (-0.8, 49.75), (-0.2, 49.65), (0.25, 49.55), (0.8, 49.35),
            (1.25, 49.2), (1.65, 49.0), (2.25, 49.0),
        ],
        "polygon": [
            (-5.8, 48.0), (-5.8, 50.15), (-5.2, 50.45), (-4.5, 50.62),
            (-3.4, 50.78), (-2.5, 50.82), (-1.5, 50.88), (-0.5, 50.92),
            (0.5, 50.95), (1.3, 51.05), (2.25, 51.35), (2.25, 49.0),
            (1.65, 49.0), (1.25, 49.2), (0.8, 49.35), (0.25, 49.55),
            (-0.2, 49.65), (-0.8, 49.75), (-1.4, 49.85), (-2.0, 49.8),
            (-2.6, 49.6), (-3.2, 49.35), (-3.8, 49.05), (-4.4, 48.65),
            (-5.0, 48.35), (-5.8, 48.0),
        ],
    },
    {
        "name": "Atlantique",
        "offshore_step": 0.85,
        "coastline": [
            (-5.2, 48.8), (-4.6, 48.45), (-4.1, 48.25), (-3.5, 48.15),
            (-3.2, 47.9), (-2.7, 47.75), (-2.3, 47.5), (-2.0, 47.15),
            (-1.75, 46.8), (-1.65, 46.35), (-1.55, 45.9), (-1.4, 45.4),
            (-1.35, 44.9), (-1.3, 44.4), (-1.4, 43.9), (-1.5, 43.5),
            (-1.8, 43.2),
        ],
        "polygon": [
            (-7.0, 42.6), (-7.0, 49.8), (-5.8, 49.8), (-5.2, 48.8),
            (-4.6, 48.45), (-4.1, 48.25), (-3.5, 48.15), (-3.2, 47.9),
            (-2.7, 47.75), (-2.3, 47.5), (-2.0, 47.15), (-1.75, 46.8),
            (-1.65, 46.35), (-1.55, 45.9), (-1.4, 45.4), (-1.35, 44.9),
            (-1.3, 44.4), (-1.4, 43.9), (-1.5, 43.5), (-1.8, 43.2),
            (-7.0, 42.6),
        ],
    },
    {
        "name": "Méditerranée",
        "offshore_step": 0.85,
        "coastline": [
            (3.17, 42.44), (3.12, 42.72), (3.1, 42.9), (3.2, 43.05),
            (3.35, 43.2), (3.55, 43.3), (3.8, 43.35), (4.2, 43.35),
            (4.5, 43.3), (4.8, 43.25), (5.0, 43.2), (5.3, 43.25),
            (5.6, 43.2), (5.9, 43.1), (6.2, 43.1), (6.5, 43.2),
            (6.8, 43.35), (7.1, 43.45), (7.4, 43.65), (7.8, 43.75),
            (7.9, 43.8),
        ],
        "polygon": [
            (3.17, 42.44), (3.12, 42.72), (3.1, 42.9), (3.2, 43.05),
            (3.35, 43.2), (3.55, 43.3), (3.8, 43.35), (4.2, 43.35),
            (4.5, 43.3), (4.8, 43.25), (5.0, 43.2), (5.3, 43.25),
            (5.6, 43.2), (5.9, 43.1), (6.2, 43.1), (6.5, 43.2),
            (6.8, 43.35), (7.1, 43.45), (7.4, 43.65), (7.8, 43.75),
            (7.9, 43.8), (7.9, 41.0), (3.17, 41.0), (3.17, 42.44),
        ],
    },
    {
        "name": "Corse",
        "offshore_step": 0.72,
        "polygon": [
            (7.8, 40.7), (10.3, 40.7), (10.3, 43.8), (7.8, 43.8),
            (7.8, 40.7),
        ],
        "land_polygon": [
            (8.45, 41.35), (8.55, 41.75), (8.65, 42.05), (8.7, 42.35),
            (8.8, 42.65), (9.0, 42.9), (9.25, 42.85), (9.45, 42.65),
            (9.45, 42.35), (9.4, 42.05), (9.35, 41.75), (9.25, 41.5),
            (8.95, 41.35), (8.7, 41.3), (8.45, 41.35),
        ],
        "coastline": [
            (8.45, 41.35), (8.55, 41.75), (8.65, 42.05), (8.7, 42.35),
            (8.8, 42.65), (9.0, 42.9), (9.25, 42.85), (9.45, 42.65),
            (9.45, 42.35), (9.4, 42.05), (9.35, 41.75), (9.25, 41.5),
            (8.95, 41.35), (8.7, 41.3), (8.45, 41.35),
        ],
    },
)

RED_SEA_REGIONS = (
    {
        "name": "Mer Rouge · Égypte",
        "offshore_step": 0.16,
        "coastline": [
            (33.85, 25.0), (33.65, 26.0), (33.55, 27.0), (33.8, 28.0),
            (34.1, 28.8),
        ],
        "polygon": [
            (33.85, 25.0), (36.55, 25.0), (36.25, 26.0), (35.85, 27.0),
            (35.35, 28.0), (34.85, 28.8), (33.65, 28.8), (33.5, 28.0),
            (33.45, 27.0), (33.55, 26.0), (33.85, 25.0),
        ],
    },
)

COLLECTIONS = {
    "france": {
        "regions": REGIONS,
        "timezone": "Europe/Paris",
        "label": "France",
    },
    "red-sea": {
        "regions": RED_SEA_REGIONS,
        "timezone": "Africa/Cairo",
        "label": "Mer Rouge",
    },
}


def point_in_polygon(lon: float, lat: float, polygon: list[tuple[float, float]]) -> bool:
    inside = False
    previous = polygon[-1]
    for current in polygon:
        x1, y1 = previous
        x2, y2 = current
        if (y1 > lat) != (y2 > lat):
            crossing_lon = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
            if lon < crossing_lon:
                inside = not inside
        previous = current
    return inside


def load_land_mask() -> list[tuple[float, float, float, float, list[tuple[float, float]]]]:
    try:
        document = json.loads(LAND_MASK_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Unable to load land mask {LAND_MASK_PATH}: {exc}") from exc
    if document.get("type") != "FeatureCollection":
        raise ValueError(f"Invalid land mask format in {LAND_MASK_PATH}.")

    polygons = []
    for feature in document.get("features", []):
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates", [])
        if geometry.get("type") == "Polygon":
            country_polygons = [coordinates]
        elif geometry.get("type") == "MultiPolygon":
            country_polygons = coordinates
        else:
            continue
        for polygon in country_polygons:
            if not polygon or len(polygon[0]) < 4:
                continue
            ring = [(float(lon), float(lat)) for lon, lat in polygon[0]]
            polygons.append((
                min(lon for lon, _ in ring),
                min(lat for _, lat in ring),
                max(lon for lon, _ in ring),
                max(lat for _, lat in ring),
                ring,
            ))
    if not polygons:
        raise ValueError(f"The land mask in {LAND_MASK_PATH} contains no polygons.")
    return polygons


def point_on_land(
    lon: float,
    lat: float,
    land_mask: list[tuple[float, float, float, float, list[tuple[float, float]]]],
) -> bool:
    return any(
        min_lon <= lon <= max_lon
        and min_lat <= lat <= max_lat
        and point_in_polygon(lon, lat, polygon)
        for min_lon, min_lat, max_lon, max_lat, polygon in land_mask
    )


def distance_to_coast(lon: float, lat: float, coastline: list[tuple[float, float]]) -> float:
    """Approximate point-to-coast distance in degrees, corrected for latitude."""
    longitude_scale = math.cos(math.radians(lat))
    point_x = lon * longitude_scale
    nearest = math.inf
    for start, end in zip(coastline, coastline[1:]):
        x1, y1 = start[0] * longitude_scale, start[1]
        x2, y2 = end[0] * longitude_scale, end[1]
        dx, dy = x2 - x1, y2 - y1
        segment_length = dx * dx + dy * dy
        fraction = 0 if segment_length == 0 else max(
            0, min(1, ((point_x - x1) * dx + (lat - y1) * dy) / segment_length)
        )
        nearest = min(nearest, math.hypot(point_x - (x1 + fraction * dx), lat - (y1 + fraction * dy)))
    return nearest


def build_grid(
    regions: tuple[dict[str, Any], ...] = REGIONS,
    land_mask: list[tuple[float, float, float, float, list[tuple[float, float]]]] | None = None,
) -> list[dict[str, Any]]:
    land_mask = land_mask if land_mask is not None else load_land_mask()
    nearshore_points: list[dict[str, Any]] = []
    offshore_points: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    for region in regions:
        polygon = region["polygon"]
        coastline = region["coastline"]
        min_lon = min(point[0] for point in polygon)
        max_lon = max(point[0] for point in polygon)
        min_lat = min(point[1] for point in polygon)
        max_lat = max(point[1] for point in polygon)
        for step, destination, nearshore in (
            (0.25, nearshore_points, True),
            (region["offshore_step"], offshore_points, False),
        ):
            row = 0
            lat = min_lat
            while lat <= max_lat:
                lon = min_lon + (step / 2 if row % 2 else 0)
                while lon <= max_lon:
                    if point_in_polygon(lon, lat, polygon):
                        land_polygon = region.get("land_polygon")
                        on_land = land_polygon and point_in_polygon(lon, lat, land_polygon)
                        coast_distance = distance_to_coast(lon, lat, coastline)
                        is_nearshore = coast_distance <= 0.55
                        if not on_land and not point_on_land(lon, lat, land_mask) and is_nearshore == nearshore:
                            key = (round(lon * 10000), round(lat * 10000))
                            if key not in seen:
                                seen.add(key)
                                destination.append(
                                    {
                                        "lat": round(lat, 4),
                                        "lon": round(lon, 4),
                                        "region": region["name"],
                                    }
                                )
                    lon += step
                lat += step
                row += 1

    # Reserve offshore coverage even where a long coastline generates many
    # fine samples; thin coast and offshore sets independently.
    nearshore_limit = min(len(nearshore_points), 180)
    if len(nearshore_points) > nearshore_limit:
        stride = len(nearshore_points) / nearshore_limit
        nearshore_points = [
            nearshore_points[math.floor(i * stride)] for i in range(nearshore_limit)
        ]
    coastal_count = len(nearshore_points)
    points = nearshore_points
    remaining = max(0, 240 - len(points))
    if len(offshore_points) > remaining and remaining:
        stride = len(offshore_points) / remaining
        offshore_points = [offshore_points[math.floor(i * stride)] for i in range(remaining)]
    points.extend(offshore_points[:remaining])
    if len(points) > 240:
        stride = len(points) / 240
        points = [points[math.floor(i * stride)] for i in range(240)]
    if len(points) < 150:
        LOGGER.warning("Grid contains %d points (target: 150-240).", len(points))
    LOGGER.info(
        "Grid: %d points (%d coastal at 0.25°, %d offshore).",
        len(points),
        coastal_count,
        len(points) - coastal_count,
    )
    return points


def make_session() -> requests.Session:
    retries = Retry(
        total=4,
        connect=4,
        read=4,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
    )
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retries))
    session.headers.update({"User-Agent": "MeteoMarinePerso/1.0 (static forecast builder)"})
    return session


def fetch_batch(
    session: requests.Session,
    url: str,
    points: list[dict[str, Any]],
    fields: tuple[str, ...],
    timezone_name: str,
) -> list[dict[str, Any]] | None:
    params = {
        "latitude": ",".join(str(point["lat"]) for point in points),
        "longitude": ",".join(str(point["lon"]) for point in points),
        "hourly": ",".join(fields),
        "forecast_days": FORECAST_DAYS,
        "timezone": timezone_name,
        "wind_speed_unit": "kmh",
    }
    try:
        response = session.get(url, params=params, timeout=(10, 60))
        response.raise_for_status()
        payload = response.json()
        if len(points) == 1 and isinstance(payload, dict):
            payload = [payload]
        if not isinstance(payload, list) or len(payload) != len(points):
            raise ValueError(f"Unexpected response shape for {len(points)} locations")
        return payload
    except (requests.RequestException, ValueError) as exc:
        LOGGER.error("Batch failed (%s, %d points): %s", url, len(points), exc)
        return None


def has_marine_coverage(point: dict[str, Any]) -> bool:
    hourly = point.get("hourly", {})
    return any(
        isinstance(hourly.get(field), list)
        and any(
            isinstance(value, (int, float)) and math.isfinite(value)
            for value in hourly[field]
        )
        for field in MARINE_FIELDS
    )


def main(region_key: str = "france") -> int:
    collection = COLLECTIONS[region_key]
    timezone_name = collection["timezone"]
    output_path = OUTPUTS[region_key]
    try:
        land_mask = load_land_mask()
    except (RuntimeError, ValueError):
        LOGGER.exception("Unable to build the grid without a valid land mask.")
        return 1
    points = build_grid(collection["regions"], land_mask)
    if not points:
        LOGGER.error("The coastal grid is empty; refusing to write a forecast.")
        return 1

    session = make_session()
    timeline: list[str] = []
    output_points: list[dict[str, Any]] = []
    failed_batches: list[int] = []
    for point in points:
        output_points.append(
            {
                **point,
                "depth_m": None,
                "hourly": {
                    field: [None] * (FORECAST_DAYS * 24)
                    for field in WEATHER_FIELDS + MARINE_FIELDS
                },
            }
        )

    for start in range(0, len(points), CHUNK_SIZE):
        batch_points = points[start : start + CHUNK_SIZE]
        batch_targets = output_points[start : start + CHUNK_SIZE]
        weather = fetch_batch(
            session, WEATHER_URL, batch_points, WEATHER_FIELDS, timezone_name
        )
        marine = fetch_batch(
            session, MARINE_URL, batch_points, MARINE_FIELDS, timezone_name
        )
        if weather is None or marine is None:
            failed_batches.append(start // CHUNK_SIZE + 1)
            LOGGER.error(
                "Skipping forecast publication: batch %d/%d did not return both sources.",
                start // CHUNK_SIZE + 1,
                math.ceil(len(points) / CHUNK_SIZE),
            )
            continue

        sources = ((weather, WEATHER_FIELDS), (marine, MARINE_FIELDS))
        has_hourly_timeline = all(
            all(
                isinstance(location, dict)
                and isinstance(location.get("hourly"), dict)
                and isinstance(location["hourly"].get("time"), list)
                for location in responses
            )
            for responses, _ in sources
        )
        has_values_for_each_source = all(
            any(
                isinstance(location, dict)
                and isinstance(location.get("hourly"), dict)
                and any(
                    isinstance(location["hourly"].get(field), list)
                    and any(
                        isinstance(value, (int, float)) and math.isfinite(value)
                        for value in location["hourly"][field]
                    )
                    for field in fields
                )
                for location in responses
            )
            for responses, fields in sources
        )
        if not has_hourly_timeline or not has_values_for_each_source:
            failed_batches.append(start // CHUNK_SIZE + 1)
            LOGGER.error(
                "Skipping forecast publication: batch %d/%d has an invalid response or a location without forecast values.",
                start // CHUNK_SIZE + 1,
                math.ceil(len(points) / CHUNK_SIZE),
            )
            continue

        for index, target in enumerate(batch_targets):
            target["source_coordinates"] = {
                "requested": {
                    "latitude": target["lat"],
                    "longitude": target["lon"],
                },
                "forecast": {
                    key: weather[index].get(key)
                    for key in ("latitude", "longitude", "elevation")
                },
                "marine": {
                    key: marine[index].get(key)
                    for key in ("latitude", "longitude", "elevation")
                },
            }
            for response_data, fields in (
                (weather[index], WEATHER_FIELDS),
                (marine[index], MARINE_FIELDS),
            ):
                if not isinstance(response_data, dict):
                    continue
                hourly = response_data.get("hourly")
                if not isinstance(hourly, dict):
                    continue
                times = hourly.get("time")
                if not isinstance(times, list):
                    continue
                if not timeline:
                    timeline.extend(str(value) for value in times)
                for field in fields:
                    values = hourly.get(field)
                    if not isinstance(values, list):
                        continue
                    for hour_index, value in enumerate(values[: len(target["hourly"][field])]):
                        target["hourly"][field][hour_index] = value

        LOGGER.info(
            "Processed %d/%d locations; weather %s, marine %s.",
            min(start + CHUNK_SIZE, len(points)),
            len(points),
            "ok" if weather else "missing",
            "ok" if marine else "missing",
        )

    if failed_batches:
        LOGGER.error(
            "Refusing to replace existing forecast: incomplete batches %s.",
            ", ".join(str(batch) for batch in failed_batches),
        )
        return 1

    if not timeline:
        LOGGER.error("No hourly forecast was received; refusing to replace existing data.")
        return 1

    if region_key == "red-sea":
        points_with_marine_data = [
            point for point in output_points if has_marine_coverage(point)
        ]
        omitted_count = len(output_points) - len(points_with_marine_data)
        if not points_with_marine_data:
            LOGGER.error("No Red Sea grid points have marine data; refusing to publish.")
            return 1
        if omitted_count:
            LOGGER.info(
                "Omitting %d Red Sea grid points with no marine data in any forecast hour.",
                omitted_count,
            )
        output_points = points_with_marine_data
        if len(output_points) < 150:
            LOGGER.warning(
                "Red Sea marine grid contains %d usable points (target: 150-240).",
                len(output_points),
            )

    document = {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Open-Meteo Forecast API + Marine API",
        "timezone": timezone_name,
        "forecast_days": FORECAST_DAYS,
        "grid_count": len(output_points),
        "hours": timeline,
        "points": output_points,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output_path.with_suffix(".json.tmp")
    try:
        temporary_output.write_text(
            json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        temporary_output.replace(output_path)
    except OSError:
        LOGGER.exception("Unable to write forecast file %s.", output_path)
        return 1

    LOGGER.info(
        "Wrote %s (%d points, %d hourly slots).",
        output_path,
        len(output_points),
        len(timeline),
    )
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--region",
        choices=tuple(COLLECTIONS),
        default="france",
        help="forecast region to collect (default: france)",
    )
    arguments = parser.parse_args()
    sys.exit(main(arguments.region))
