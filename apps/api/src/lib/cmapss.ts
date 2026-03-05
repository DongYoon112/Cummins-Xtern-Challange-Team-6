import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CMAPSS_SOURCE_URL = "https://data.nasa.gov/dataset/cmapss-jet-engine-simulated-data";
export const CMAPSS_DOWNLOAD_URL =
  process.env.CMAPSS_DOWNLOAD_URL?.trim() || "https://data.nasa.gov/docs/legacy/CMAPSSData.zip";

const SENSOR_COLUMNS = Array.from({ length: 21 }, (_entry, idx) => `sensor_${idx + 1}`);

type CmapssRow = {
  unit_id: number;
  cycle: number;
  setting_1: number;
  setting_2: number;
  setting_3: number;
} & Record<string, number>;

function toNumber(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function ensureDirectory(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadOnce(url: string, targetPath: string) {
  if (await fileExists(targetPath)) {
    return;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CMAPSS download failed: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetPath, bytes);
}

async function unzipArchive(zipPath: string, destination: string) {
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`
    ]);
    return;
  }

  try {
    await execFileAsync("unzip", ["-o", zipPath, "-d", destination]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Failed to unzip CMAPSS archive. Install unzip or use source=local. ${message}`);
  }
}

function parseCmapssContent(raw: string): CmapssRow[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rows: CmapssRow[] = [];
  for (const line of lines) {
    const values = line.split(/\s+/).map((entry) => Number(entry));
    if (values.length < 26 || values.some((entry) => Number.isNaN(entry))) {
      continue;
    }

    const row: CmapssRow = {
      unit_id: values[0],
      cycle: values[1],
      setting_1: values[2],
      setting_2: values[3],
      setting_3: values[4]
    };
    SENSOR_COLUMNS.forEach((sensor, idx) => {
      row[sensor] = values[5 + idx];
    });
    rows.push(row);
  }
  return rows;
}

async function resolveFd001Path(cacheDir: string) {
  const candidates = [
    path.join(cacheDir, "train_FD001.txt"),
    path.join(cacheDir, "FD001_train.txt"),
    path.join(cacheDir, "CMAPSSData", "train_FD001.txt"),
    path.join(cacheDir, "CMAPSSData", "FD001_train.txt")
  ];
  for (const filePath of candidates) {
    if (await fileExists(filePath)) {
      return filePath;
    }
  }
  return "";
}

export async function loadCmapssFd001(params: {
  unitId: number;
  source: "local" | "download";
  cacheDir: string;
  window: number;
}) {
  const { unitId, source, cacheDir, window } = params;
  await ensureDirectory(cacheDir);

  let fd001Path = await resolveFd001Path(cacheDir);
  if (!fd001Path && source === "download") {
    const zipPath = path.join(cacheDir, "CMAPSSData.zip");
    await downloadOnce(CMAPSS_DOWNLOAD_URL, zipPath);
    await unzipArchive(zipPath, cacheDir);
    fd001Path = await resolveFd001Path(cacheDir);
  }

  if (!fd001Path) {
    throw new Error(
      `CMAPSS FD001 file not found in ${cacheDir}. Use source=download or place train_FD001.txt under data/CMAPSS.`
    );
  }

  const raw = await fs.readFile(fd001Path, "utf8");
  const parsed = parseCmapssContent(raw);
  const engineRows = parsed.filter((row) => row.unit_id === unitId);
  if (engineRows.length === 0) {
    throw new Error(`No CMAPSS rows found for unit_id=${unitId} in FD001.`);
  }

  return {
    engine_rows: engineRows,
    columns: ["unit_id", "cycle", "setting_1", "setting_2", "setting_3", ...SENSOR_COLUMNS],
    dataset_meta: {
      source_url: CMAPSS_SOURCE_URL,
      dataset: "FD001",
      unit_id: unitId,
      source_mode: source,
      file_path: fd001Path,
      row_count: engineRows.length,
      window_requested: window
    }
  };
}

function linearSlope(series: number[]) {
  if (series.length < 2) {
    return 0;
  }
  const n = series.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    const x = i;
    const y = series[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) {
    return 0;
  }
  return (n * sumXY - sumX * sumY) / denominator;
}

function mean(series: number[]) {
  if (series.length === 0) {
    return 0;
  }
  return series.reduce((acc, value) => acc + value, 0) / series.length;
}

function stddev(series: number[]) {
  if (series.length < 2) {
    return 0;
  }
  const avg = mean(series);
  const variance = series.reduce((acc, value) => acc + (value - avg) ** 2, 0) / series.length;
  return Math.sqrt(variance);
}

export function buildCmapssFeatures(params: { engineRows: Array<Record<string, unknown>>; window: number; slopeWindow: number }) {
  const rows = params.engineRows
    .map((row) => row as Record<string, unknown>)
    .filter((row) => Number.isFinite(Number(row.cycle)))
    .sort((a, b) => toNumber(a.cycle, 0) - toNumber(b.cycle, 0));

  const window = Math.max(5, toNumber(params.window, 50));
  const slopeWindow = Math.max(3, toNumber(params.slopeWindow, 10));
  const windowRows = rows.slice(-window);
  const slopeRows = rows.slice(-slopeWindow);

  const sensorStats = SENSOR_COLUMNS.map((sensor) => {
    const fullSeries = windowRows.map((row) => toNumber(row[sensor], 0));
    const slopeSeries = slopeRows.map((row) => toNumber(row[sensor], 0));
    const latest = fullSeries.length > 0 ? fullSeries[fullSeries.length - 1] : 0;
    const sensorMean = mean(fullSeries);
    const sensorStd = stddev(fullSeries);
    const slope = linearSlope(slopeSeries);
    const z = sensorStd > 0 ? (latest - sensorMean) / sensorStd : 0;
    const score = Math.max(Math.abs(slope), Math.abs(z));
    return {
      sensor,
      mean: Number(sensorMean.toFixed(5)),
      std: Number(sensorStd.toFixed(5)),
      slope: Number(slope.toFixed(6)),
      latest: Number(latest.toFixed(5)),
      zscore_latest: Number(z.toFixed(6)),
      anomaly_score: Number(score.toFixed(6))
    };
  });

  const topAnomalies = sensorStats
    .slice()
    .sort((a, b) => b.anomaly_score - a.anomaly_score)
    .slice(0, 5);

  return {
    engine_features: {
      window,
      slope_window: slopeWindow,
      row_count: rows.length,
      cycle_start: toNumber(windowRows[0]?.cycle, 0),
      cycle_end: toNumber(windowRows[windowRows.length - 1]?.cycle, 0),
      sensor_stats: sensorStats
    },
    top_anomalies: topAnomalies,
    window_rows: windowRows
  };
}
