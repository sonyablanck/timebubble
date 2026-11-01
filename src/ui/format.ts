// Small formatting helpers for the readouts (kept pure for tests).

export function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

export function formatElevation(m: number): string {
  return m >= 0 ? `${Math.round(m).toLocaleString("en-GB")} m` : `${Math.round(-m).toLocaleString("en-GB")} m below sea level`;
}

export function formatCoast(km: number): string {
  if (km === 0) return "on the coast";
  return km > 0 ? `${Math.round(km).toLocaleString("en-GB")} km inland` : `${Math.round(-km).toLocaleString("en-GB")} km offshore`;
}

export function formatPrecip(mmYr: number): string {
  return `${Math.round(mmYr).toLocaleString("en-GB")} mm/yr`;
}
