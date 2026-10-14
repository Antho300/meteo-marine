#!/usr/bin/env python3
"""Export requested and Open-Meteo-returned coordinates as CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FORECASTS = {
    "france": ROOT / "data" / "forecast.json",
    "red-sea": ROOT / "data" / "forecast.red-sea.json",
}
OUTPUTS = {
    "france": ROOT / "data" / "coordinates.france.csv",
    "red-sea": ROOT / "data" / "coordinates.red-sea.csv",
}
LOGGER = logging.getLogger("coordinate-audit")
CSV_FIELDS = (
    "region",
    "requested_latitude",
    "requested_longitude",
    "forecast_api_latitude",
    "forecast_api_longitude",
    "forecast_api_elevation_m",
    "forecast_snap_distance_km",
    "marine_api_latitude",
    "marine_api_longitude",
    "marine_api_elevation_m",
    "marine_snap_distance_km",
)


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radians = math.pi / 180
    latitude_delta = (lat2 - lat1) * radians
    longitude_delta = (lon2 - lon1) * radians
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(lat1 * radians)
        * math.cos(lat2 * radians)
        * math.sin(longitude_delta / 2) ** 2
    )
    return 6371 * 2 * math.atan2(math.sqrt(haversine), math.sqrt(1 - haversine))


def api_row(point: dict[str, Any], api: str) -> dict[str, Any]:
    coordinates = point.get("source_coordinates")
    if not isinstance(coordinates, dict):
        raise ValueError(
            "Forecast has no Open-Meteo coordinate metadata; regenerate it with "
            "scripts/fetch_data.py first."
        )
    requested = coordinates.get("requested")
    returned = coordinates.get(api)
    if not isinstance(requested, dict) or not isinstance(returned, dict):
        raise ValueError(f"Forecast is missing the {api} coordinate metadata.")
    lat = returned.get("latitude")
    lon = returned.get("longitude")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        raise ValueError(f"Open-Meteo returned no valid {api} coordinates.")
    request_lat = requested.get("latitude")
    request_lon = requested.get("longitude")
    if not isinstance(request_lat, (int, float)) or not isinstance(request_lon, (int, float)):
        raise ValueError("Forecast contains invalid requested coordinates.")

    return {
        f"{api}_api_latitude": lat,
        f"{api}_api_longitude": lon,
        f"{api}_api_elevation_m": returned.get("elevation"),
        f"{api}_snap_distance_km": round(
            distance_km(request_lat, request_lon, lat, lon), 3
        ),
    }


def export_region(region: str) -> None:
    document = json.loads(FORECASTS[region].read_text(encoding="utf-8"))
    rows = []
    for point in document.get("points", []):
        coordinates = point.get("source_coordinates", {})
        requested = coordinates.get("requested", {})
        rows.append(
            {
                "region": point.get("region", ""),
                "requested_latitude": requested.get("latitude", point.get("lat")),
                "requested_longitude": requested.get("longitude", point.get("lon")),
                **api_row(point, "forecast"),
                **api_row(point, "marine"),
            }
        )

    if not rows:
        raise ValueError(f"No points found in {FORECASTS[region]}.")
    OUTPUTS[region].parent.mkdir(parents=True, exist_ok=True)
    with OUTPUTS[region].open("w", encoding="utf-8-sig", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    LOGGER.info("Wrote %s (%d coordinate records).", OUTPUTS[region], len(rows))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--region",
        choices=tuple(FORECASTS),
        help="region to export (exports both if omitted)",
    )
    arguments = parser.parse_args()
    regions = (arguments.region,) if arguments.region else tuple(FORECASTS)
    try:
        for region in regions:
            export_region(region)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        LOGGER.error("Unable to export coordinate audit: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    raise SystemExit(main())
