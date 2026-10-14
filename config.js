/* Seuils personnalisables : vitesses en km/h, hauteurs en metres, courant en noeuds. */
window.MARINE_CONFIG = {
  thresholds: {
    windKmh: { good: 15, caution: 30 },
    gustKmh: { good: 25, caution: 45 },
    waveM: { good: 0.8, caution: 1.5 },
    currentKn: { good: 0.5, caution: 1.0 },
    waterTempC: { cold: 12, cool: 16 },
    pressureHpa: { low: 1000, caution: 1010 }
  },
  map: {
    initialCenter: [1.8, 44.7],
    initialZoom: 3.5,
    minZoom: 3.5,
    maxZoom: 12
  }
};
