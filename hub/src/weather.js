// Weather from Open-Meteo (free, no key, no account). Fetched by the hub so the phone never calls a third party.

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

// WMO weather codes -> label + icon key used by the app.
export const WMO = {
  0: ["Clear", "sun"], 1: ["Mostly clear", "sun"], 2: ["Partly cloudy", "partly"], 3: ["Overcast", "cloud"],
  45: ["Fog", "fog"], 48: ["Rime fog", "fog"], 51: ["Light drizzle", "drizzle"], 53: ["Drizzle", "drizzle"],
  55: ["Heavy drizzle", "drizzle"], 56: ["Freezing drizzle", "drizzle"], 57: ["Freezing drizzle", "drizzle"],
  61: ["Light rain", "rain"], 63: ["Rain", "rain"], 65: ["Heavy rain", "rain"], 66: ["Freezing rain", "rain"],
  67: ["Freezing rain", "rain"], 71: ["Light snow", "snow"], 73: ["Snow", "snow"], 75: ["Heavy snow", "snow"],
  77: ["Snow grains", "snow"], 80: ["Showers", "rain"], 81: ["Showers", "rain"], 82: ["Violent showers", "rain"],
  85: ["Snow showers", "snow"], 86: ["Snow showers", "snow"], 95: ["Thunderstorm", "storm"],
  96: ["Thunderstorm, hail", "storm"], 99: ["Thunderstorm, hail", "storm"],
};

export async function geocode(name, fetchImpl = fetch) {
  const url = `${GEO}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`geocoding HTTP ${r.status}`);
  const j = await r.json();
  const g = j.results && j.results[0];
  if (!g) return null;
  return { name: g.name, country: g.country_code || g.country || "", lat: g.latitude, lon: g.longitude, tz: g.timezone };
}

export async function fetchWeather(city, fetchImpl = fetch) {
  const q = new URLSearchParams({
    latitude: String(city.lat),
    longitude: String(city.lon),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    forecast_hours: "12",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    timezone: "auto",
    forecast_days: "5",
  });
  const r = await fetchImpl(`${FORECAST}?${q}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`forecast HTTP ${r.status}`);
  const j = await r.json();
  const c = j.current || {};
  const d = j.daily || {};
  const label = (code) => (WMO[code] || ["-", "cloud"]);
  return {
    at: Date.now(),
    city: city.name,
    current: {
      temp: c.temperature_2m,
      feels: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      wind: c.wind_speed_10m,
      code: c.weather_code,
      text: label(c.weather_code)[0],
      icon: label(c.weather_code)[1],
      isDay: c.is_day === 1,
    },
    daily: (d.time || []).map((date, i) => ({
      date,
      max: d.temperature_2m_max[i],
      min: d.temperature_2m_min[i],
      rain: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
      code: d.weather_code[i],
      icon: label(d.weather_code[i])[1],
    })),
    hourly: hourlyOf(j.hourly, label),
    umbrella: umbrellaOf(j.hourly, c.weather_code),
    sunrise: d.sunrise ? d.sunrise[0] : null,
    sunset: d.sunset ? d.sunset[0] : null,
  };
}

// The next 12 hours from the current hour (Open-Meteo's forecast_hours starts there).
function hourlyOf(h, label) {
  if (!h || !h.time) return [];
  return h.time.map((t, i) => ({ time: t.slice(11, 16), temp: h.temperature_2m[i], rain: h.precipitation_probability ? h.precipitation_probability[i] : null,
    code: h.weather_code[i], icon: label(h.weather_code[i])[1] }));
}

const WET = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
// Take an umbrella: it is raining now, or rain is 50% likely or more in the next 12 hours.
export function umbrellaOf(h, nowCode) {
  if (WET.has(nowCode)) return { yes: true, why: "raining now" };
  if (!h || !h.time || !h.precipitation_probability) return { yes: false, why: "" };
  let best = -1;
  h.precipitation_probability.forEach((p, i) => { if (p != null && (best < 0 || p > h.precipitation_probability[best])) best = i; });
  const p = best >= 0 ? h.precipitation_probability[best] : 0;
  return p >= 50 ? { yes: true, why: `${p}% rain around ${h.time[best].slice(11, 16)}` } : { yes: false, why: p ? `rain at most ${p}%` : "" };
}
