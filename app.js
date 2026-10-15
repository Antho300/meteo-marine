(() => {
  "use strict";

  const CONFIG = window.MARINE_CONFIG;
  const regionKey = new URLSearchParams(window.location.search).get("region");
  const regionConfig = regionKey === "france" || regionKey === "red-sea"
    ? CONFIG.regions[regionKey]
    : null;
  if (!regionConfig) return;

  const appShell = document.querySelector(".app-shell");
  document.querySelector("#home-page").hidden = true;
  appShell.hidden = false;
  document.title = `Météo marine ${regionConfig.label} — Anthony Navarro`;

  const KNOTS_PER_KMH = 1 / 1.852;
  const MAP_STYLES = {
    liberty: "https://tiles.openfreemap.org/styles/liberty",
    bright: "https://tiles.openfreemap.org/styles/bright",
    positron: "https://tiles.openfreemap.org/styles/positron",
    dark: "https://tiles.openfreemap.org/styles/dark"
  };
  const BATHYMETRY_WMS = "https://ows.emodnet-bathymetry.eu/wms";
  const WEB_MERCATOR_HALF_WORLD = 20037508.342789244;
  const MAX_BATHYMETRY_ZOOM = 8;
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    updatedAt: $("#updated-at"),
    layerSelect: $("#layer-select"),
    basemapSelect: $("#basemap-select"),
    vectorToggle: $("#vector-toggle"),
    propagateToggle: $("#propagate-toggle"),
    estimateToggle: $("#estimate-toggle"),
    estimateState: $("#estimate-state"),
    mapHint: $(".map-hint"),
    timeSlider: $("#time-slider"),
    timeLabel: $("#time-label"),
    timeOffset: $("#time-offset"),
    emptyState: $("#empty-state"),
    pointDetails: $("#point-details"),
    pointRegion: $("#point-region"),
    pointName: $("#point-name"),
    pointCoordinates: $("#point-coordinates"),
    metricGrid: $("#metric-grid"),
    assessment: $("#assessment"),
    compass: $("#map-compass"),
    compassHeading: $("#compass-heading"),
    chartWind: $("#chart-wind"),
    chartWater: $("#chart-water"),
    chartWaves: $("#chart-waves"),
    chartCurrent: $("#chart-current"),
    chartWindValue: $("#trend-wind-value"),
    chartWaterValue: $("#trend-water-value"),
    chartWavesValue: $("#trend-waves-value"),
    chartCurrentValue: $("#trend-current-value"),
    detailSheet: $("#detail-sheet"),
    sheetResizeHandle: $("#sheet-resize-handle"),
    depthValue: null,
    estimateNote: $("#estimate-note"),
    toast: $("#toast"),
    mapLegend: $("#map-legend")
  };
  if (!regionConfig.bathymetry) {
    const bathymetryOption = elements.layerSelect.querySelector('option[value="bathymetry"]');
    bathymetryOption.disabled = true;
    bathymetryOption.textContent = "Bathymétrie (non disponible)";
  }
  const menuToggle = $("#menu-toggle");
  const mapControls = $("#map-controls");
  const appearanceToggle = $("#appearance-toggle");
  const savedAppearance = localStorage.getItem("marine-ui-theme") || localStorage.getItem("marine-menu-theme");
  let lightAppearance = savedAppearance === "light";
  appShell.classList.toggle("theme-light", lightAppearance);

  function updateAppearanceButton() {
    const nextAppearance = lightAppearance ? "bleu pétrole" : "claire";
    appearanceToggle.setAttribute("aria-label", `Passer à l’apparence ${nextAppearance}`);
    appearanceToggle.title = `Passer à l’apparence ${nextAppearance}`;
  }

  updateAppearanceButton();

  let forecast = null;
  let map = null;
  let selectedPoint = null;
  let selectedDistance = null;
  let vectorsEnabled = false;
  let propagationEnabled = false;
  let estimateModeEnabled = false;
  let toastTimeout = null;
  let depthRequestId = 0;
  let mapLoaded = false;
  let bathymetryOverlay = null;
  let bathymetryRefreshFrame = 0;
  let propagationRefreshFrame = 0;
  let bathymetryErrorShown = false;
  const bathymetryTiles = new Map();
  const failedBathymetryTiles = new Map();
  const depthCache = new Map();
  const chartInteractionStates = new WeakMap();
  const POINT_SOURCE_ID = "weather-grid";
  const POINT_LAYER_ID = "weather-grid-circles";
  const VECTOR_SOURCE_ID = "weather-vectors";
  const VECTOR_LAYER_ID = "weather-vector-arrows";
  const PROPAGATED_VECTOR_LAYER_ID = "weather-vector-propagated";
  const MAX_ESTIMATE_DISTANCE_KM = 50;
  const MAX_INTERPOLATION_NEIGHBORS = 4;
  const DIRECTION_FIELDS = new Set([
    "wind_direction_10m",
    "wave_direction",
    "swell_wave_direction",
    "ocean_current_direction"
  ]);

  const metricForLayer = {
    wind: { field: "wind_speed_10m", convert: (value) => value },
    waves: { field: "wave_height", convert: (value) => value },
    water: { field: "sea_surface_temperature", convert: (value) => value },
    current: {
      field: "ocean_current_velocity",
      convert: (value) => value * KNOTS_PER_KMH
    }
  };

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 3500);
  }

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function pointValue(point, field, hourIndex = Number(elements.timeSlider.value)) {
    const values = point && point.hourly && point.hourly[field];
    const value = Array.isArray(values) ? values[hourIndex] : null;
    return isNumber(value) ? value : null;
  }

  function formatNumber(value, digits = 1) {
    return isNumber(value)
      ? new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(value)
      : "n/d";
  }

  function directionText(degrees) {
    if (!isNumber(degrees)) return "n/d";
    const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
    return `${directions[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16]} · ${Math.round(degrees)}°`;
  }

  function severity(value, limits) {
    if (!isNumber(value)) return "unknown";
    if (value > limits.caution) return "rough";
    if (value > limits.good) return "caution";
    return "good";
  }

  function temperatureSeverity(value) {
    if (!isNumber(value)) return "unknown";
    if (value < CONFIG.thresholds.waterTempC.cold) return "rough";
    if (value < CONFIG.thresholds.waterTempC.cool) return "caution";
    return "good";
  }

  function pressureSeverity(value) {
    if (!isNumber(value)) return "unknown";
    if (value < CONFIG.thresholds.pressureHpa.low) return "rough";
    if (value < CONFIG.thresholds.pressureHpa.caution) return "caution";
    return "good";
  }

  function severityLabel(status) {
    return { good: "favorable", caution: "à surveiller", rough: "soutenu", unknown: "indisponible" }[status];
  }

  function addMetric(label, value, unit, status = "unknown", secondary = "") {
    const card = document.createElement("div");
    card.className = `metric-card${status === "unknown" ? "" : ` status-${status}`}`;
    const title = document.createElement("span");
    title.className = "metric-label";
    title.textContent = label;
    const main = document.createElement("strong");
    main.className = "metric-value";
    main.textContent = isNumber(value) ? formatNumber(value) : (secondary || "n/d");
    if (isNumber(value) && unit) {
      const suffix = document.createElement("small");
      suffix.textContent = ` ${unit}`;
      main.append(suffix);
    }
    if (secondary && isNumber(value)) {
      const suffix = document.createElement("small");
      suffix.textContent = ` · ${secondary}`;
      main.append(suffix);
    }
    card.append(title, main);
    elements.metricGrid.append(card);
    return main;
  }

  function activeMapMetric(point) {
    const layer = elements.layerSelect.value;
    const metric = metricForLayer[layer];
    if (!metric) return { value: null, direction: 0, status: "unknown" };
    const rawValue = pointValue(point, metric.field);
    const value = isNumber(rawValue) ? metric.convert(rawValue) : null;
    let status = "unknown";
    if (layer === "wind") status = severity(value, CONFIG.thresholds.windKmh);
    if (layer === "waves") status = severity(value, CONFIG.thresholds.waveM);
    if (layer === "current") status = severity(value, CONFIG.thresholds.currentKn);
    if (layer === "water") status = temperatureSeverity(value);
    const directionField = {
      wind: "wind_direction_10m",
      waves: "swell_wave_direction",
      current: "ocean_current_direction"
    }[layer];
    return {
      value,
      direction: directionField ? pointValue(point, directionField) : null,
      status
    };
  }

  function paintMapData() {
    if (!map || !forecast) return;
    const layer = elements.layerSelect.value;
    const canShowVectors = ["wind", "waves", "current"].includes(layer);
    elements.vectorToggle.disabled = !canShowVectors;
    elements.vectorToggle.setAttribute("aria-pressed", String(vectorsEnabled && canShowVectors));
    elements.vectorToggle.querySelector(".toggle-state").textContent = !canShowVectors
      ? "INDISP."
      : vectorsEnabled ? "ACTIFS" : "INACTIFS";
    elements.vectorToggle.classList.toggle("is-active", vectorsEnabled && canShowVectors);
    elements.propagateToggle.disabled = !vectorsEnabled || !canShowVectors;
    elements.propagateToggle.setAttribute(
      "aria-pressed",
      String(propagationEnabled && vectorsEnabled && canShowVectors)
    );
    elements.propagateToggle.querySelector(".toggle-state").textContent =
      propagationEnabled && vectorsEnabled && canShowVectors ? "ACTIF" : "INACTIF";
    elements.propagateToggle.classList.toggle(
      "is-active",
      propagationEnabled && vectorsEnabled && canShowVectors
    );
    updatePointLayer();
    if (bathymetryOverlay) {
      bathymetryOverlay.hidden = layer !== "bathymetry";
      if (layer === "bathymetry") refreshBathymetryTiles();
    }
    const title = {
      wind: "Vent",
      waves: "Hauteur des vagues",
      water: "Température de l’eau",
      current: "Vitesse du courant",
      bathymetry: "Bathymétrie EMODnet"
    }[layer];
    const units = { wind: "km/h", waves: "m", water: "°C", current: "nd", bathymetry: "m" };
    const legend = layer === "bathymetry"
      ? "<span class=\"legend-dot calm\"></span><span>Profondeur et isobathes</span>"
      : "<span class=\"legend-dot calm\"></span><span>Faible</span><span class=\"legend-dot moderate\"></span><span>Modéré</span><span class=\"legend-dot rough\"></span><span>Fort</span><span class=\"legend-dot unknown\"></span><span>n/d à l’heure choisie</span>";
    elements.mapLegend.innerHTML = legend;
    elements.mapLegend.setAttribute("aria-label", `${title}, unités ${units[layer]}`);
  }

  function addMapOverlays() {
    if (!bathymetryOverlay) {
      bathymetryOverlay = document.createElement("div");
      bathymetryOverlay.className = "bathymetry-overlay";
      bathymetryOverlay.setAttribute("aria-hidden", "true");
      bathymetryOverlay.hidden = true;
      bathymetryOverlay.innerHTML = '<div class="bathymetry-depth-tiles"></div><div class="bathymetry-contour-tiles"></div>';
      map.getContainer().append(bathymetryOverlay);
    }
  }

  function pointFeatureCollection() {
    const features = forecast.points.map((point, index) => {
      const metric = activeMapMetric(point);
      return {
        type: "Feature",
        id: index,
        geometry: { type: "Point", coordinates: [point.lon, point.lat] },
        properties: {
          index,
          status: metric.status,
          selected: point === selectedPoint
        }
      };
    });
    if (selectedPoint?.estimated) {
      features.push({
        type: "Feature",
        id: forecast.points.length,
        geometry: { type: "Point", coordinates: [selectedPoint.lon, selectedPoint.lat] },
        properties: {
          index: -1,
          status: activeMapMetric(selectedPoint).status,
          selected: true,
          estimated: true
        }
      });
    }
    return {
      type: "FeatureCollection",
      features
    };
  }

  function distanceKm(lonA, latA, lonB, latB) {
    const radians = Math.PI / 180;
    const latitudeDifference = (latB - latA) * radians;
    const longitudeDifference = (lonB - lonA) * radians;
    const a = Math.sin(latitudeDifference / 2) ** 2
      + Math.cos(latA * radians) * Math.cos(latB * radians)
      * Math.sin(longitudeDifference / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function gridNeighbors(
    lon,
    lat,
    maxDistanceKm = MAX_ESTIMATE_DISTANCE_KM,
    maxCount = MAX_INTERPOLATION_NEIGHBORS,
    restrictRegion = true
  ) {
    const sorted = forecast.points
      .map((point) => ({ point, distance: distanceKm(lon, lat, point.lon, point.lat) }))
      .sort((left, right) => left.distance - right.distance);
    const nearestRegion = sorted[0]?.point.region;
    return sorted
      .filter(({ point, distance }) => (!restrictRegion || point.region === nearestRegion) && distance <= maxDistanceKm)
      .slice(0, maxCount)
      .map((entry) => ({
        ...entry,
        weight: 1 / Math.max(entry.distance, 0.5) ** 2
      }));
  }

  function interpolateValue(neighbors, field, hourIndex, minimumValues = 2) {
    let weightTotal = 0;
    let valueTotal = 0;
    let sineTotal = 0;
    let cosineTotal = 0;
    let validCount = 0;
    const isDirection = DIRECTION_FIELDS.has(field);
    for (const neighbor of neighbors) {
      const value = pointValue(neighbor.point, field, hourIndex);
      if (!isNumber(value)) continue;
      validCount += 1;
      weightTotal += neighbor.weight;
      if (isDirection) {
        const radians = value * Math.PI / 180;
        sineTotal += Math.sin(radians) * neighbor.weight;
        cosineTotal += Math.cos(radians) * neighbor.weight;
      } else {
        valueTotal += value * neighbor.weight;
      }
    }
    if (validCount < minimumValues || weightTotal === 0) return null;
    if (isDirection) {
      if (Math.hypot(sineTotal, cosineTotal) / weightTotal < 0.05) return null;
      return (Math.atan2(sineTotal, cosineTotal) * 180 / Math.PI + 360) % 360;
    }
    return valueTotal / weightTotal;
  }

  function estimatePoint(lon, lat) {
    const nearest = nearestPoint(lon, lat);
    if (!nearest || nearest.distance > MAX_ESTIMATE_DISTANCE_KM) return null;
    const neighbors = gridNeighbors(lon, lat);
    if (neighbors.length < MAX_INTERPOLATION_NEIGHBORS) return null;
    const fields = Object.keys(neighbors[0].point.hourly || {});
    const hourly = Object.fromEntries(fields.map((field) => [
      field,
      forecast.hours.map((_, hourIndex) => interpolateValue(neighbors, field, hourIndex))
    ]));
    return {
      point: {
        lat,
        lon,
        region: neighbors[0].point.region,
        depth_m: null,
        hourly,
        estimated: true,
        estimateNeighborCount: neighbors.length,
        estimateFarthestKm: Math.max(...neighbors.map(({ distance }) => distance))
      },
      distance: nearest.distance
    };
  }

  function vectorFeature(lon, lat, direction, status, index, options = {}) {
    const origin = map.project([lon, lat]);
    const angle = direction * Math.PI / 180;
    const length = options.selectedEstimate ? 24 : options.propagated ? 18 : 15;
    const headLength = options.selectedEstimate ? 6 : options.propagated ? 4 : 3.5;
    const endPixel = {
      x: origin.x + Math.sin(angle) * length,
      y: origin.y - Math.cos(angle) * length
    };
    const end = map.unproject([endPixel.x, endPixel.y]).toArray();
    const leftPixel = {
      x: endPixel.x - Math.sin(angle - Math.PI * 5 / 6) * headLength,
      y: endPixel.y + Math.cos(angle - Math.PI * 5 / 6) * headLength
    };
    const rightPixel = {
      x: endPixel.x - Math.sin(angle + Math.PI * 5 / 6) * headLength,
      y: endPixel.y + Math.cos(angle + Math.PI * 5 / 6) * headLength
    };
    const left = map.unproject([leftPixel.x, leftPixel.y]).toArray();
    const right = map.unproject([rightPixel.x, rightPixel.y]).toArray();
    return {
      type: "Feature",
      id: index,
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [[lon, lat], end],
          [end, left],
          [end, right]
        ]
      },
      properties: {
        index,
        status,
        estimated: Boolean(options.estimated),
        propagated: Boolean(options.propagated),
        selectedEstimate: Boolean(options.selectedEstimate)
      }
    };
  }

  function propagatedVectorFeatures(layer) {
    const metric = metricForLayer[layer];
    if (!metric) return [];
    const directionField = {
      wind: "wind_direction_10m",
      waves: "swell_wave_direction",
      current: "ocean_current_direction"
    }[layer];
    if (!directionField) return [];

    const hourIndex = Number(elements.timeSlider.value);
    const features = [];
    let index = forecast.points.length;
    const bounds = map.getContainer().getBoundingClientRect();
    const step = 42;
    for (let y = 28; y < bounds.height - 24; y += step) {
      for (let x = 28; x < bounds.width - 24; x += step) {
        const { lng: lon, lat } = map.unproject([x, y]);
        const neighbors = gridNeighbors(lon, lat, 150, 8, false);
        if (neighbors.length < 3) continue;
        const direction = interpolateValue(neighbors, directionField, hourIndex, 3);
        const rawValue = interpolateValue(neighbors, metric.field, hourIndex, 3);
        if (!isNumber(direction) || !isNumber(rawValue)) continue;
        const value = metric.convert(rawValue);
        let status = "unknown";
        if (layer === "wind") status = severity(value, CONFIG.thresholds.windKmh);
        if (layer === "waves") status = severity(value, CONFIG.thresholds.waveM);
        if (layer === "current") status = severity(value, CONFIG.thresholds.currentKn);
        features.push(vectorFeature(lon, lat, direction, status, index, {
          estimated: true,
          propagated: true
        }));
        index += 1;
        if (features.length >= 700) return features;
      }
    }
    return features;
  }

  function vectorFeatureCollection() {
    const layer = elements.layerSelect.value;
    const supportsVectors = ["wind", "waves", "current"].includes(layer);
    const measured = vectorsEnabled && supportsVectors ? forecast.points.flatMap((point, index) => {
      const { direction, status } = activeMapMetric(point);
      return isNumber(direction)
        ? [vectorFeature(point.lon, point.lat, direction, status, index)]
        : [];
    }) : [];
    const propagated = propagationEnabled && vectorsEnabled
      ? propagatedVectorFeatures(layer)
      : [];
    const selectedVector = selectedPoint?.estimated && supportsVectors
      ? (() => {
        const { direction, status } = activeMapMetric(selectedPoint);
        return isNumber(direction)
          ? [vectorFeature(selectedPoint.lon, selectedPoint.lat, direction, status, -1, {
            estimated: true,
            selectedEstimate: true
          })]
          : [];
      })()
      : [];
    return { type: "FeatureCollection", features: [...measured, ...propagated, ...selectedVector] };
  }

  function updatePointLayer() {
    if (!map || !forecast || !map.getSource(POINT_SOURCE_ID)) return;
    map.getSource(POINT_SOURCE_ID).setData(pointFeatureCollection());
    if (map.getSource(VECTOR_SOURCE_ID)) {
      map.getSource(VECTOR_SOURCE_ID).setData(vectorFeatureCollection());
    }
    const layer = elements.layerSelect.value;
    const supportsVectors = ["wind", "waves", "current"].includes(layer);
    const showSelectedEstimate = selectedPoint?.estimated && supportsVectors;
    if (map.getLayer(VECTOR_LAYER_ID)) {
      map.setLayoutProperty(VECTOR_LAYER_ID, "visibility", (vectorsEnabled || showSelectedEstimate) && supportsVectors ? "visible" : "none");
    }
    if (map.getLayer(PROPAGATED_VECTOR_LAYER_ID)) {
      map.setLayoutProperty(PROPAGATED_VECTOR_LAYER_ID, "visibility", propagationEnabled && vectorsEnabled && supportsVectors ? "visible" : "none");
    }
  }

  function addPointLayers() {
    if (!map || !forecast) return;
    if (!map.getSource(POINT_SOURCE_ID)) {
      map.addSource(POINT_SOURCE_ID, {
        type: "geojson",
        data: pointFeatureCollection()
      });
    }
    if (!map.getSource(VECTOR_SOURCE_ID)) {
      map.addSource(VECTOR_SOURCE_ID, {
        type: "geojson",
        data: vectorFeatureCollection()
      });
    }
    if (!map.getLayer(POINT_LAYER_ID)) {
      map.addLayer({
        id: POINT_LAYER_ID,
        type: "circle",
        source: POINT_SOURCE_ID,
        paint: {
          "circle-radius": ["case", ["boolean", ["get", "selected"], false], 7, 4.5],
          "circle-color": [
            "match",
            ["get", "status"],
            "good", "#298267",
            "caution", "#d38a26",
            "rough", "#c84c48",
            "#87999b"
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 2.5, 1.5],
          "circle-opacity": 0.98
        }
      });
    }
    if (!map.getLayer(VECTOR_LAYER_ID)) {
      map.addLayer({
        id: VECTOR_LAYER_ID,
        type: "line",
        source: VECTOR_SOURCE_ID,
        filter: ["!=", ["get", "propagated"], true],
        layout: {
          visibility: "none",
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["get", "selectedEstimate"], false],
            "#4d65d9",
            [
              "match",
              ["get", "status"],
              "good", "#146f79",
              "caution", "#9b5c0b",
              "rough", "#a83232",
              "#163b45"
            ]
          ],
          "line-width": ["case", ["boolean", ["get", "selectedEstimate"], false], 2.5, 1.45],
          "line-opacity": 0.95
        }
      });
    }
    if (!map.getLayer(PROPAGATED_VECTOR_LAYER_ID)) {
      map.addLayer({
        id: PROPAGATED_VECTOR_LAYER_ID,
        type: "line",
        source: VECTOR_SOURCE_ID,
        filter: ["==", ["get", "propagated"], true],
        layout: {
          visibility: "none",
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-color": "#536d78",
          "line-width": 1.05,
          "line-opacity": 0.78,
          "line-dasharray": [1, 1.5]
        }
      });
    }
    updatePointLayer();
  }

  function tileX(longitude, zoom) {
    const count = 2 ** zoom;
    return Math.max(0, Math.min(count - 1, Math.floor((longitude + 180) / 360 * count)));
  }

  function tileY(latitude, zoom) {
    const count = 2 ** zoom;
    const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const radians = clampedLatitude * Math.PI / 180;
    return Math.max(0, Math.min(count - 1, Math.floor(
      (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * count
    )));
  }

  function tileNorthwest(x, y, zoom) {
    const count = 2 ** zoom;
    return [(x / count * 360) - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / count))) * 180 / Math.PI];
  }

  function tileBoundingBox(x, y, zoom) {
    const count = 2 ** zoom;
    const tileWidth = 2 * WEB_MERCATOR_HALF_WORLD / count;
    const minX = -WEB_MERCATOR_HALF_WORLD + x * tileWidth;
    const maxY = WEB_MERCATOR_HALF_WORLD - y * tileWidth;
    return [minX, maxY - tileWidth, minX + tileWidth, maxY].join(",");
  }

  function bathymetryTileUrl(layer, x, y, zoom) {
    const params = new URLSearchParams({
      service: "WMS",
      version: "1.1.1",
      request: "GetMap",
      layers: layer,
      styles: "",
      srs: "EPSG:3857",
      format: "image/png",
      transparent: "true",
      width: "256",
      height: "256",
      bbox: tileBoundingBox(x, y, zoom)
    });
    return `${BATHYMETRY_WMS}?${params}`;
  }

  function refreshBathymetryTiles() {
    if (!mapLoaded || !bathymetryOverlay || bathymetryOverlay.hidden) return;
    const zoom = Math.max(3, Math.min(MAX_BATHYMETRY_ZOOM, Math.floor(map.getZoom())));
    const bounds = map.getBounds();
    const minX = tileX(bounds.getWest(), zoom);
    const maxX = tileX(bounds.getEast(), zoom);
    const minY = tileY(bounds.getNorth(), zoom);
    const maxY = tileY(bounds.getSouth(), zoom);
    const visibleKeys = new Set();

    for (const tileLayer of [
      { name: "depth", wmsLayer: "emodnet:mean" },
      { name: "contour", wmsLayer: "emodnet:contours" }
    ]) {
      const pane = bathymetryOverlay.querySelector(`.bathymetry-${tileLayer.name}-tiles`);
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = `${tileLayer.name}/${zoom}/${x}/${y}`;
          visibleKeys.add(key);
          let image = bathymetryTiles.get(key);
          if (!image) {
            const failedAt = failedBathymetryTiles.get(key);
            if (failedAt && Date.now() - failedAt < 60000) continue;
            image = document.createElement("img");
            image.alt = "";
            image.draggable = false;
            image.decoding = "async";
            image.addEventListener("error", () => {
              image.remove();
              if (bathymetryTiles.get(key) === image) bathymetryTiles.delete(key);
              failedBathymetryTiles.set(key, Date.now());
              if (!bathymetryErrorShown && elements.layerSelect.value === "bathymetry") {
                bathymetryErrorShown = true;
                console.warn(`La tuile WMS ${tileLayer.wmsLayer} est indisponible.`);
                showToast("La couche EMODnet est momentanément indisponible.");
              }
            }, { once: true });
            pane.append(image);
            bathymetryTiles.set(key, image);
            image.src = bathymetryTileUrl(tileLayer.wmsLayer, x, y, zoom);
          }
          const northwest = tileNorthwest(x, y, zoom);
          const southeast = tileNorthwest(x + 1, y + 1, zoom);
          const screenNorthwest = map.project(northwest);
          const screenSoutheast = map.project(southeast);
          image.style.left = `${screenNorthwest.x}px`;
          image.style.top = `${screenNorthwest.y}px`;
          image.style.width = `${screenSoutheast.x - screenNorthwest.x}px`;
          image.style.height = `${screenSoutheast.y - screenNorthwest.y}px`;
        }
      }
    }

    for (const [key, image] of bathymetryTiles) {
      if (!visibleKeys.has(key)) {
        image.remove();
        bathymetryTiles.delete(key);
      }
    }
  }

  function scheduleBathymetryRefresh() {
    if (bathymetryRefreshFrame) return;
    bathymetryRefreshFrame = window.requestAnimationFrame(() => {
      bathymetryRefreshFrame = 0;
      refreshBathymetryTiles();
    });
  }

  function updateSelectedFeature() {
    updatePointLayer();
  }

  function nearestPoint(lng, lat) {
    let nearest = null;
    let smallestDistance = Infinity;
    for (const point of forecast.points) {
      const lat1 = lat * Math.PI / 180;
      const lat2 = point.lat * Math.PI / 180;
      const dLat = lat2 - lat1;
      const dLon = (point.lon - lng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      const distance = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (distance < smallestDistance) {
        smallestDistance = distance;
        nearest = point;
      }
    }
    return nearest ? { point: nearest, distance: smallestDistance } : null;
  }

  function pointDisplayName(point) {
    return `Point ${Math.abs(point.lat).toFixed(2)}° ${point.lat >= 0 ? "N" : "S"}, ${Math.abs(point.lon).toFixed(2)}° ${point.lon >= 0 ? "E" : "O"}`;
  }

  function renderAssessment(point) {
    const wind = pointValue(point, "wind_speed_10m");
    const gust = pointValue(point, "wind_gusts_10m");
    const waves = pointValue(point, "wave_height");
    const currentKmh = pointValue(point, "ocean_current_velocity");
    const waterTemp = pointValue(point, "sea_surface_temperature");
    const pressure = pointValue(point, "pressure_msl");
    const currentKn = isNumber(currentKmh) ? currentKmh * KNOTS_PER_KMH : null;
    const checks = [
      severity(waves, CONFIG.thresholds.waveM),
      severity(wind, CONFIG.thresholds.windKmh),
      severity(gust, CONFIG.thresholds.gustKmh),
      severity(currentKn, CONFIG.thresholds.currentKn),
      temperatureSeverity(waterTemp),
      pressureSeverity(pressure)
    ];
    const visibility = !isNumber(waves) || !isNumber(wind)
      ? "visibilité non estimable"
      : waves > CONFIG.thresholds.waveM.caution || wind > CONFIG.thresholds.windKmh.caution
        ? "visibilité probablement réduite (proxy)"
        : waves > CONFIG.thresholds.waveM.good || wind > CONFIG.thresholds.windKmh.good
          ? "visibilité possiblement dégradée (proxy)"
          : "proxy de visibilité plutôt favorable";
    const summaryText = [
      `mer ${formatNumber(waves)} m`,
      `vent ${formatNumber(isNumber(wind) ? wind * KNOTS_PER_KMH : null)} nd`,
      `courant ${formatNumber(currentKn)} nd`,
      `eau ${formatNumber(waterTemp)} °C`,
      `pression ${formatNumber(pressure, 0)} hPa`,
      visibility
    ].join(" · ");

    const known = checks.filter((status) => status !== "unknown");
    const overall = known.includes("rough") ? "rough" : known.includes("caution") ? "caution" : known.length ? "good" : "unknown";
    elements.assessment.replaceChildren();
    const dot = document.createElement("span");
    dot.className = `assessment-dot${overall === "good" ? "" : ` ${overall}`}`;
    const label = document.createElement("strong");
    label.textContent = overall === "unknown" ? "Conditions non évaluables" : `Synthèse : ${severityLabel(overall)}`;
    const summary = document.createElement("span");
    summary.textContent = summaryText;
    elements.assessment.append(dot, label, summary);
  }

  function renderChart(point) {
    const currentIndex = Number(elements.timeSlider.value);
    const definitions = [
      {
        canvas: elements.chartWind,
        value: elements.chartWindValue,
        field: "wind_speed_10m",
        unit: "nd",
        color: "#62b9b3",
        lightColor: "#187b83",
        convert: (value) => value * KNOTS_PER_KMH
      },
      {
        canvas: elements.chartWater,
        value: elements.chartWaterValue,
        field: "sea_surface_temperature",
        unit: "°C",
        color: "#efb858",
        lightColor: "#a96913",
        convert: (value) => value
      },
      {
        canvas: elements.chartWaves,
        value: elements.chartWavesValue,
        field: "wave_height",
        unit: "m",
        color: "#62b9b3",
        lightColor: "#187b83",
        convert: (value) => value
      },
      {
        canvas: elements.chartCurrent,
        value: elements.chartCurrentValue,
        field: "ocean_current_velocity",
        unit: "nd",
        color: "#b1a6f1",
        lightColor: "#6b63a8",
        convert: (value) => value * KNOTS_PER_KMH
      }
    ];
    for (const series of definitions) {
      const current = pointValue(point, series.field, currentIndex);
      series.value.textContent = `${formatNumber(isNumber(current) ? series.convert(current) : null)} ${series.unit}`;
      renderTrendChart(series.canvas, point, series, currentIndex);
    }
  }

  function renderTrendChart(canvas, point, series, firstHour) {
    let state = chartInteractionStates.get(canvas);
    if (!state) {
      state = {
        activeIndex: null,
        pinned: false,
        baseAriaLabel: canvas.getAttribute("aria-label") || ""
      };
      chartInteractionStates.set(canvas, state);
      canvas.addEventListener("pointermove", (event) => {
        if (state.pinned) return;
        const index = chartIndexAtPointer(canvas, state, event);
        if (index !== state.activeIndex) {
          state.activeIndex = index;
          state.draw();
        }
      });
      canvas.addEventListener("pointerleave", () => {
        if (!state.pinned) {
          state.activeIndex = null;
          state.draw();
        }
      });
      canvas.addEventListener("click", (event) => {
        const index = chartIndexAtPointer(canvas, state, event);
        state.pinned = state.pinned && state.activeIndex === index ? false : true;
        state.activeIndex = index;
        state.draw();
      });
      canvas.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const step = event.key === "ArrowRight" ? 1 : -1;
          let next = state.activeIndex === null ? 0 : state.activeIndex + step;
          while (next >= 0 && next < state.values.length && !isNumber(state.values[next])) {
            next += step;
          }
          if (next >= 0 && next < state.values.length) {
            state.activeIndex = next;
            state.pinned = true;
            state.draw();
          }
        } else if (event.key === "Enter" || event.key === " ") {
          if (state.activeIndex !== null) {
            event.preventDefault();
            state.pinned = !state.pinned;
            state.draw();
          }
        }
      });
    }
    const values = [];
    const endHour = Math.min(firstHour + 48, forecast.hours.length - 1);
    for (let index = firstHour; index <= endHour; index += 1) {
      const value = pointValue(point, series.field, index);
      values.push(isNumber(value) ? series.convert(value) : null);
    }
    if ((state.point && state.point !== point) || (state.firstHour !== undefined && state.firstHour !== firstHour)) {
      state.activeIndex = null;
      state.pinned = false;
    }
    state.point = point;
    state.series = series;
    state.firstHour = firstHour;
    state.values = values;
    state.draw = () => drawTrendChart(canvas, state);
    state.draw();
  }

  function chartIndexAtPointer(canvas, state, event) {
    if (!state.values || !state.values.length || !state.plot) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const relativeIndex = Math.round((x - state.plot.left) / state.plot.width * (state.values.length - 1));
    let closestIndex = null;
    let closestDistance = Infinity;
    state.values.forEach((value, index) => {
      if (!isNumber(value)) return;
      const distance = Math.abs(index - relativeIndex);
      if (distance < closestDistance) {
        closestIndex = index;
        closestDistance = distance;
      }
    });
    return closestIndex;
  }

  function drawTrendChart(canvas, state) {
    const { values, series, firstHour } = state;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const valid = values.filter(isNumber);
    if (!valid.length) {
      state.plot = null;
      state.activeIndex = null;
      canvas.title = state.baseAriaLabel;
      canvas.setAttribute("aria-label", state.baseAriaLabel);
      context.fillStyle = getComputedStyle(appShell).getPropertyValue("--muted");
      context.font = "12px system-ui";
      context.fillText("Prévision indisponible", 35, 32);
      return;
    }
    const padding = { left: 38, right: 8, top: 14, bottom: 25 };
    const width = Math.max(1, rect.width - padding.left - padding.right);
    const height = Math.max(1, rect.height - padding.top - padding.bottom);
    state.plot = { left: padding.left, width };
    const low = Math.min(...valid);
    const high = Math.max(...valid);
    const spread = high - low || Math.max(Math.abs(high) * 0.1, 1);
    const min = Math.max(0, low - spread * 0.15);
    const max = high + spread * 0.15 || min + 1;
    const yFor = (value) => padding.top + height - (value - min) / (max - min) * height;
    const xFor = (index) => padding.left + (values.length <= 1 ? 0 : index / (values.length - 1)) * width;
    const themeStyles = getComputedStyle(appShell);
    const textColor = themeStyles.getPropertyValue("--muted");
    context.strokeStyle = themeStyles.getPropertyValue("--chart-grid");
    context.lineWidth = 1;
    context.fillStyle = textColor;
    context.font = "10px system-ui";
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let tick = 0; tick <= 2; tick += 1) {
      const ratioY = tick / 2;
      const y = padding.top + height * ratioY;
      const value = max - (max - min) * ratioY;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(rect.width - padding.right, y);
      context.stroke();
      context.fillText(`${formatNumber(value)} ${series.unit}`, padding.left - 5, y);
    }
    const tickHours = [0, 12, 24, 36, 48];
    context.fillStyle = textColor;
    context.textBaseline = "top";
    for (const hour of tickHours) {
      if (hour > values.length - 1) continue;
      const x = xFor(hour);
      context.beginPath();
      context.moveTo(x, padding.top + height);
      context.lineTo(x, padding.top + height + 3);
      context.stroke();
      context.textAlign = hour === 0 ? "left" : hour === 48 ? "right" : "center";
      context.fillText(hour === 0 ? formatHour(forecast.hours[firstHour]) : `+${hour} h`, x, padding.top + height + 5);
    }
    context.beginPath();
    let drawing = false;
    values.forEach((value, index) => {
      if (!isNumber(value)) {
        drawing = false;
        return;
      }
      if (drawing) context.lineTo(xFor(index), yFor(value));
      else {
        context.moveTo(xFor(index), yFor(value));
        drawing = true;
      }
    });
    context.strokeStyle = appShell.classList.contains("theme-light") ? series.lightColor : series.color;
    context.lineWidth = 2.25;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();

    if (state.activeIndex === null || !isNumber(values[state.activeIndex])) {
      canvas.title = state.baseAriaLabel;
      canvas.setAttribute("aria-label", state.baseAriaLabel);
      return;
    }
    const selectedValue = values[state.activeIndex];
    const selectedHour = firstHour + state.activeIndex;
    const selectedTime = forecast.hours[selectedHour];
    const x = xFor(state.activeIndex);
    const y = yFor(selectedValue);
    const timeLabel = formatChartTime(selectedTime);
    const valueLabel = `${formatNumber(selectedValue)} ${series.unit}`;
    canvas.title = `${timeLabel} · ${valueLabel}`;
    canvas.setAttribute("aria-label", `${state.baseAriaLabel} Valeur sélectionnée : ${timeLabel}, ${valueLabel}.`);
    context.save();
    context.strokeStyle = appShell.classList.contains("theme-light") ? series.lightColor : series.color;
    context.setLineDash([3, 3]);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, padding.top + height);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.arc(x, y, 5, 0, Math.PI * 2);
    context.fillStyle = themeStyles.getPropertyValue("--paper-solid");
    context.fill();
    context.lineWidth = 2;
    context.stroke();
    context.beginPath();
    context.arc(x, y, 2.5, 0, Math.PI * 2);
    context.fillStyle = context.strokeStyle;
    context.fill();
    context.font = "10px system-ui";
    const tooltipWidth = Math.max(context.measureText(timeLabel).width, context.measureText(valueLabel).width) + 12;
    const tooltipHeight = 32;
    const tooltipX = Math.max(0, Math.min(rect.width - tooltipWidth, x + tooltipWidth + 8 > rect.width ? x - tooltipWidth - 8 : x + 8));
    const tooltipY = Math.max(0, Math.min(rect.height - tooltipHeight, y - tooltipHeight - 7));
    context.fillStyle = themeStyles.getPropertyValue("--paper-solid");
    context.fillRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);
    context.strokeStyle = themeStyles.getPropertyValue("--line");
    context.lineWidth = 1;
    context.strokeRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);
    context.fillStyle = themeStyles.getPropertyValue("--ink");
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(timeLabel, tooltipX + 6, tooltipY + 4);
    context.font = "bold 10px system-ui";
    context.fillText(valueLabel, tooltipX + 6, tooltipY + 17);
    context.restore();
  }

  function formatChartTime(time) {
    if (typeof time !== "string") return "—";
    const date = new Date(time);
    return Number.isNaN(date.getTime())
      ? formatHour(time)
      : new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function formatHour(time) {
    if (typeof time !== "string") return "—";
    const date = new Date(time);
    return Number.isNaN(date.getTime())
      ? time.slice(11, 16)
      : new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function renderPoint(point, distance = null) {
    selectedPoint = point;
    if (distance !== null) selectedDistance = distance;
    elements.emptyState.classList.add("is-hidden");
    elements.pointDetails.classList.remove("is-hidden");
    elements.pointRegion.textContent = `${point.region || "POINT MARIN"}${selectedDistance === null ? "" : ` · À ${Math.round(selectedDistance)} KM`}`;
    elements.pointName.textContent = pointDisplayName(point);
    elements.pointCoordinates.textContent = point.estimated
      ? `${point.lat.toFixed(4)}°, ${point.lon.toFixed(4)}° · Estimation pondérée de ${point.estimateNeighborCount} points, non mesurée`
      : `${point.lat.toFixed(4)}°, ${point.lon.toFixed(4)}° · Données du point de grille le plus proche`;
    elements.estimateNote.classList.toggle("is-hidden", !point.estimated);
    if (point.estimated) {
      elements.estimateNote.textContent =
        "Interpolation des points de grille du modèle ; le trait de côte n’est pas masqué. Estimation indicative, non mesurée.";
    }
    if (point.estimated) {
      elements.pointRegion.textContent =
        `ESTIMATION · ${point.region} · VOISINS JUSQU’À ${Math.round(point.estimateFarthestKm)} KM`;
    }
    elements.metricGrid.replaceChildren();

    const wind = pointValue(point, "wind_speed_10m");
    const gust = pointValue(point, "wind_gusts_10m");
    const waves = pointValue(point, "wave_height");
    const current = pointValue(point, "ocean_current_velocity");
    const waterTemp = pointValue(point, "sea_surface_temperature");
    const pressure = pointValue(point, "pressure_msl");
    addMetric("Vent", isNumber(wind) ? wind * KNOTS_PER_KMH : null, "nd", severity(wind, CONFIG.thresholds.windKmh), isNumber(wind) ? `${formatNumber(wind)} km/h` : "");
    addMetric("Rafales", isNumber(gust) ? gust * KNOTS_PER_KMH : null, "nd", severity(gust, CONFIG.thresholds.gustKmh), isNumber(gust) ? `${formatNumber(gust)} km/h` : "");
    addMetric("Direction vent", null, "", "unknown", directionText(pointValue(point, "wind_direction_10m")));
    addMetric("Vagues", waves, "m", severity(waves, CONFIG.thresholds.waveM));
    addMetric("Période vagues", pointValue(point, "wave_period"), "s");
    addMetric("Direction vagues", null, "", "unknown", directionText(pointValue(point, "wave_direction")));
    addMetric("Houle", pointValue(point, "swell_wave_height"), "m", severity(pointValue(point, "swell_wave_height"), CONFIG.thresholds.waveM));
    addMetric("Période houle", pointValue(point, "swell_wave_period"), "s");
    addMetric("Direction houle", null, "", "unknown", directionText(pointValue(point, "swell_wave_direction")));
    addMetric("Eau", waterTemp, "°C", temperatureSeverity(waterTemp));
    addMetric("Courant", isNumber(current) ? current * KNOTS_PER_KMH : null, "nd", severity(isNumber(current) ? current * KNOTS_PER_KMH : null, CONFIG.thresholds.currentKn));
    addMetric("Direction courant", null, "", "unknown", directionText(pointValue(point, "ocean_current_direction")));
    addMetric("Niveau marin", pointValue(point, "sea_level_height_msl"), "m");
    addMetric("Pression", pressure, "hPa", pressureSeverity(pressure));
    elements.depthValue = addMetric(
      "Profondeur · EMODnet",
      null,
      "m",
      "unknown",
      regionConfig.bathymetry ? "Chargement…" : "Non couvert"
    );
    elements.depthValue.closest(".metric-card").classList.add("depth-metric");
    elements.depthValue.title = point.estimated
      ? "Profondeur du fond EMODnet recherchée aux coordonnées du point estimé."
      : "Profondeur du fond EMODnet aux coordonnées du point de grille.";

    renderAssessment(point);
    renderChart(point);
    updateSelectedFeature();
    if (regionConfig.bathymetry) void loadDepth(point);
  }

  async function loadDepth(point) {
    const requestId = ++depthRequestId;
    const cacheKey = `${point.lat},${point.lon}`;
    const cached = depthCache.get(cacheKey);
    if (typeof cached === "number" || cached === null) {
      renderDepth(cached);
      return;
    }
    renderDepth(undefined);
    if (cached instanceof Promise) {
      let depth;
      try {
        depth = await cached;
      } catch {
        depth = null;
      }
      if (requestId === depthRequestId && selectedPoint === point) {
        renderDepth(depth);
      }
      return;
    }
    const delta = 0.005;
    const bbox = `${point.lon - delta},${point.lat - delta},${point.lon + delta},${point.lat + delta}`;
    const params = new URLSearchParams({
      service: "WMS",
      version: "1.1.1",
      request: "GetFeatureInfo",
      layers: "emodnet:mean",
      query_layers: "emodnet:mean",
      styles: "",
      srs: "EPSG:4326",
      bbox,
      width: "101",
      height: "101",
      x: "50",
      y: "50",
      format: "image/png",
      info_format: "text/plain"
    });
    const depthRequest = (async () => {
      const response = await fetch(`${BATHYMETRY_WMS}?${params}`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`EMODnet HTTP ${response.status}`);
      const body = await response.text();
      const depth = body.match(/Depth\s*=\s*(-?\d+(?:\.\d+)?)/i);
      if (!depth || !isNumber(Number(depth[1]))) throw new Error("Valeur de profondeur absente");
      return Math.abs(Number(depth[1]));
    })();
    depthCache.set(cacheKey, depthRequest);
    try {
      const result = await depthRequest;
      depthCache.set(cacheKey, result);
      if (requestId === depthRequestId && selectedPoint === point) {
        renderDepth(result);
      }
    } catch (error) {
      const result = null;
      depthCache.set(cacheKey, result);
      if (requestId !== depthRequestId || selectedPoint !== point) return;
      console.warn("La profondeur EMODnet n’est pas disponible pour ce point.", error);
      renderDepth(result);
    }
  }

  function renderDepth(value) {
    const main = elements.depthValue;
    if (!main) return;
    main.replaceChildren();
    if (value === undefined) {
      main.textContent = "Chargement…";
      return;
    }
    if (!isNumber(value)) {
      main.textContent = "n/d";
      return;
    }
    main.append(document.createTextNode(formatNumber(value, 0)));
    const unit = document.createElement("small");
    unit.textContent = " m";
    main.append(unit);
  }

  function updateTimeLabel() {
    const index = Number(elements.timeSlider.value);
    const time = forecast?.hours[index];
    if (typeof time !== "string") {
      elements.timeLabel.textContent = "—";
      elements.timeOffset.textContent = "Prévision indisponible";
      return;
    }
    const date = new Date(time);
    elements.timeLabel.textContent = Number.isNaN(date.getTime())
      ? time
      : new Intl.DateTimeFormat("fr-FR", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
    const firstDate = new Date(forecast.hours[0]);
    const differenceHours = Math.round((date.getTime() - firstDate.getTime()) / 3600000);
    elements.timeOffset.textContent = differenceHours <= 0 ? "Début de prévision" : `+ ${differenceHours} h`;
  }

  function updateCompass() {
    if (!map || !elements.compass || !elements.compassHeading) return;
    const bearing = ((map.getBearing() % 360) + 360) % 360;
    const roundedBearing = Math.round(bearing) % 360;
    elements.compass.style.setProperty("--compass-bearing", `${bearing}deg`);
    elements.compassHeading.textContent = `${String(roundedBearing).padStart(3, "0")}°`;
    elements.compass.setAttribute("aria-label", `Boussole, cap ${roundedBearing} degrés`);
  }

  function refreshViewVectors() {
    updateCompass();
    if (map && forecast && map.getSource(VECTOR_SOURCE_ID)
      && (vectorsEnabled || propagationEnabled || selectedPoint?.estimated)) {
      if (propagationRefreshFrame) window.cancelAnimationFrame(propagationRefreshFrame);
      propagationRefreshFrame = window.requestAnimationFrame(() => {
        propagationRefreshFrame = 0;
        if (map.getSource(VECTOR_SOURCE_ID)) {
          map.getSource(VECTOR_SOURCE_ID).setData(vectorFeatureCollection());
        }
      });
    }
  }

  function setupSheetResizing() {
    const sheet = elements.detailSheet;
    const handle = elements.sheetResizeHandle;
    const root = document.documentElement;
    let dragStartY = 0;
    let dragStartHeight = 0;
    let activePointerId = null;

    const syncSheetHeight = () => {
      root.style.setProperty("--sheet-height", `${Math.ceil(sheet.getBoundingClientRect().height)}px`);
    };
    const setSheetHeight = (height) => {
      const styles = window.getComputedStyle(sheet);
      const minHeight = Number.parseFloat(styles.minHeight);
      const configuredMaxHeight = Number.parseFloat(styles.maxHeight);
      const maxHeight = Number.isFinite(configuredMaxHeight) ? configuredMaxHeight : window.innerHeight * 0.8;
      sheet.style.height = `${Math.max(minHeight, Math.min(maxHeight, height))}px`;
    };

    new ResizeObserver(syncSheetHeight).observe(sheet);
    syncSheetHeight();

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      activePointerId = event.pointerId;
      dragStartY = event.clientY;
      dragStartHeight = sheet.getBoundingClientRect().height;
      handle.setPointerCapture(event.pointerId);
      sheet.classList.add("is-resizing");
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (event.pointerId !== activePointerId) return;
      setSheetHeight(dragStartHeight + dragStartY - event.clientY);
    });
    const endResize = (event) => {
      if (event.pointerId !== activePointerId) return;
      activePointerId = null;
      sheet.classList.remove("is-resizing");
      syncSheetHeight();
    };
    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? 1 : -1;
      setSheetHeight(sheet.getBoundingClientRect().height + direction * 32);
    });
  }

  function handleTimeChange() {
    updateTimeLabel();
    paintMapData();
    if (selectedPoint) {
      renderPoint(selectedPoint);
    }
  }

  function addMapEvents() {
    let restoringLayers = false;
    function restoreMapDataLayers() {
      if (!map.isStyleLoaded() || restoringLayers) return;
      if (map.getSource(POINT_SOURCE_ID)
        && map.getLayer(POINT_LAYER_ID)
        && map.getLayer(VECTOR_LAYER_ID)
        && map.getLayer(PROPAGATED_VECTOR_LAYER_ID)) {
        mapLoaded = true;
        return;
      }
      restoringLayers = true;
      try {
        mapLoaded = true;
        addMapOverlays();
        addPointLayers();
        paintMapData();
      } finally {
        restoringLayers = false;
      }
    }
    map.on("style.load", () => {
      restoreMapDataLayers();
    });
    map.on("styledata", restoreMapDataLayers);
    map.on("idle", restoreMapDataLayers);
    map.on("load", refreshViewVectors);
    map.on("moveend", refreshViewVectors);
    map.on("zoomend", refreshViewVectors);
    map.on("resize", refreshViewVectors);
    map.on("click", (event) => {
      if (estimateModeEnabled) {
        const estimate = estimatePoint(event.lngLat.lng, event.lngLat.lat);
        if (!estimate) {
          showToast("Estimation indisponible : il faut quatre points de grille dans un rayon de 50 km.");
          return;
        }
        renderPoint(estimate.point, estimate.distance);
        return;
      }
      let point = null;
      if (map.getLayer(POINT_LAYER_ID)) {
        const features = map.queryRenderedFeatures(event.point, { layers: [POINT_LAYER_ID] });
        const feature = features.reduce((closest, candidate) => {
          const [longitude, latitude] = candidate.geometry.coordinates;
          const screenPoint = map.project([longitude, latitude]);
          const distance = Math.hypot(
            screenPoint.x - event.point.x,
            screenPoint.y - event.point.y
          );
          return !closest || distance < closest.distance
            ? { feature: candidate, distance }
            : closest;
        }, null)?.feature;
        const index = Number(feature?.properties?.index);
        if (Number.isInteger(index)) point = forecast?.points[index] || null;
      }
      if (point) {
        renderPoint(point, 0);
        return;
      }
      const nearest = nearestPoint(event.lngLat.lng, event.lngLat.lat);
      if (nearest) renderPoint(nearest.point, nearest.distance);
    });
    map.on("move", scheduleBathymetryRefresh);
    map.on("resize", scheduleBathymetryRefresh);
    map.on("error", (event) => {
      if (event.error) console.warn("Erreur de chargement cartographique.", event.error);
    });
  }

  function initializeMap() {
    if (!window.maplibregl) {
      showToast("La bibliothèque cartographique n’a pas pu être chargée.");
      return;
    }
    map = new maplibregl.Map({
      container: "map",
      style: MAP_STYLES[elements.basemapSelect.value],
      center: regionConfig.map.initialCenter,
      zoom: regionConfig.map.initialZoom,
      minZoom: regionConfig.map.minZoom,
      maxZoom: regionConfig.map.maxZoom,
      attributionControl: false,
      cooperativeGestures: false
    });
    map.scrollZoom.disable();
    map.getContainer().addEventListener("wheel", (event) => {
      event.preventDefault();
      if (event.ctrlKey) {
        const bounds = map.getContainer().getBoundingClientRect();
        const point = map.unproject([event.clientX - bounds.left, event.clientY - bounds.top]);
        const nextZoom = map.getZoom() - event.deltaY * 0.002;
        map.zoomTo(nextZoom, { around: point, duration: 0 });
        return;
      }
      const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
      const vertical = event.shiftKey ? event.deltaX : event.deltaY;
      map.panBy([horizontal, vertical], { duration: 0 });
    }, { passive: false });
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "Données météo © <a href=\"https://open-meteo.com/\" target=\"_blank\" rel=\"noopener noreferrer\">Open-Meteo</a> · Bathymétrie © EMODnet Bathymetry"
    }), "bottom-right");
    const attributionControl = map.getContainer().querySelector(".maplibregl-ctrl-bottom-right");
    if (attributionControl) {
      document.querySelector(".app-shell").append(attributionControl);
      attributionControl.querySelector(".maplibregl-ctrl-attrib-button")?.click();
    }
    addMapEvents();
    $("#locate-button").addEventListener("click", () => {
      if (!navigator.geolocation) {
        showToast("La géolocalisation n’est pas disponible sur cet appareil.");
        return;
      }
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          map.flyTo({ center: [coords.longitude, coords.latitude], zoom: Math.max(map.getZoom(), 8) });
        },
        (error) => showToast(error.code === error.PERMISSION_DENIED ? "Autorisez la géolocalisation dans votre navigateur." : "Position indisponible."),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }

  function formatUpdatedAt(value, isExample) {
    if (isExample) return "Aperçu fictif";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Mise à jour inconnue";
    return `Collecté ${new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: forecast?.timezone || "Europe/Paris"
    }).format(date)}`;
  }

  async function loadForecast() {
    let isExample = false;
    let response = await fetch(regionConfig.dataFile, { cache: "no-store" });
    if (!response.ok && regionKey === "france") {
      response = await fetch("./data/forecast.example.json", { cache: "no-store" });
      isExample = true;
    }
    if (!response.ok) throw new Error(`Fichiers météo introuvables (HTTP ${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data.hours) || !Array.isArray(data.points) || !data.points.length) {
      throw new Error("Le fichier météo ne contient aucune prévision exploitable.");
    }
    forecast = data;
    elements.updatedAt.textContent = formatUpdatedAt(data.updated_at, isExample);
    elements.updatedAt.title = isExample
      ? "Le workflow GitHub Actions remplacera cet exemple après sa première exécution."
      : `Dernière mise à jour : ${data.updated_at}`;
    elements.timeSlider.max = String(Math.max(0, data.hours.length - 1));
    const now = Date.now();
    const firstFutureHour = data.hours.findIndex((hour) => new Date(hour).getTime() >= now);
    elements.timeSlider.value = String(firstFutureHour < 0 ? data.hours.length - 1 : firstFutureHour);
    updateTimeLabel();
    initializeMap();
    if (isExample) {
      showToast("Mode aperçu : ces valeurs sont fictives. Lancez le workflow pour les remplacer.");
    }
  }

  function setupControls() {
    appearanceToggle.addEventListener("click", () => {
      lightAppearance = !lightAppearance;
      appShell.classList.toggle("theme-light", lightAppearance);
      localStorage.setItem("marine-ui-theme", lightAppearance ? "light" : "blue");
      updateAppearanceButton();
      if (selectedPoint) renderChart(selectedPoint);
    });
    menuToggle.addEventListener("click", () => {
      const isCollapsed = mapControls.classList.toggle("is-collapsed");
      menuToggle.setAttribute("aria-expanded", String(!isCollapsed));
      menuToggle.setAttribute("aria-label", isCollapsed ? "Afficher le menu" : "Masquer le menu");
      menuToggle.title = isCollapsed ? "Afficher le menu" : "Masquer le menu";
      if (map) window.requestAnimationFrame(() => map.resize());
    });
    elements.layerSelect.addEventListener("change", () => {
      paintMapData();
      if (selectedPoint) renderPoint(selectedPoint);
    });
    elements.basemapSelect.addEventListener("change", () => {
      map.setStyle(MAP_STYLES[elements.basemapSelect.value], { diff: false });
      mapLoaded = false;
    });
    elements.vectorToggle.addEventListener("click", () => {
      vectorsEnabled = !vectorsEnabled;
      paintMapData();
    });
    elements.propagateToggle.addEventListener("click", () => {
      if (!vectorsEnabled || elements.propagateToggle.disabled) return;
      propagationEnabled = !propagationEnabled;
      paintMapData();
    });
    elements.estimateToggle.addEventListener("click", () => {
      estimateModeEnabled = !estimateModeEnabled;
      elements.estimateToggle.setAttribute("aria-pressed", String(estimateModeEnabled));
      elements.estimateToggle.classList.toggle("is-active", estimateModeEnabled);
      elements.estimateState.textContent = estimateModeEnabled ? "ACTIVE" : "DÉSACTIVÉE";
      elements.mapHint.textContent = estimateModeEnabled
        ? "Touchez la mer pour estimer les conditions (rayon 50 km)"
        : "Touchez la carte pour choisir un point";
      showToast(estimateModeEnabled
        ? "Mode estimation : les valeurs sont calculées, pas mesurées."
        : "Mode points de grille réels.");
    });
    elements.timeSlider.addEventListener("input", handleTimeChange);
    $("#clear-selection").addEventListener("click", () => {
      selectedPoint = null;
      selectedDistance = null;
      depthRequestId += 1;
      elements.pointDetails.classList.add("is-hidden");
      elements.emptyState.classList.remove("is-hidden");
      updateSelectedFeature();
    });
    window.addEventListener("resize", () => {
      updateCompass();
      if (selectedPoint) renderChart(selectedPoint);
    });
  }

  setupSheetResizing();
  setupControls();
  loadForecast().catch((error) => {
    console.error("Impossible de charger les prévisions marines.", error);
    elements.updatedAt.textContent = "Données indisponibles";
    elements.emptyState.querySelector("strong").textContent = "Impossible de charger les données";
    elements.emptyState.querySelector("p").textContent = "Servez le projet en HTTP local ou vérifiez data/forecast.json.";
    showToast(error.message);
  });
})();
