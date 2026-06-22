import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public", "geoip");

const MANIFEST_PATH = path.join(PUBLIC_DIR, "manifest.json");
const STATUS_PATH = path.join(PUBLIC_DIR, "update-status.json");
const HISTORY_PATH = path.join(PUBLIC_DIR, "update-history.json");

function getConfiguredCountries() {
  const raw = process.env.GEOIP_COUNTRIES || "ru,cn,ir,ua,ae";

  return [
    ...new Set(
      raw
        .split(",")
        .map(country => country.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

function runGeoipScript(countries) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ROOT, "geoip.js");
    const args = [scriptPath, ...countries, "--refresh"];

    console.log(`Running: node geoip.js ${countries.join(" ")} --refresh`);

    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`geoip.js exited with code ${code}`));
    });
  });
}

function createBuildId(manifest) {
  const parts = [];

  if (manifest.combined?.sha256) {
    parts.push(`geoip:${manifest.combined.sha256}`);
  }

  for (const [country, file] of Object.entries(manifest.countries || {}).sort()) {
    parts.push(`${country}:${file.sha256}`);
  }

  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function createClientDownloads(manifest) {
  const downloads = {};

  if (manifest.combined) {
    downloads.geoip = {
      type: "combined",
      file: manifest.combined.file,
      url: manifest.combined.url,
      bytes: manifest.combined.bytes,
      sha256: manifest.combined.sha256,
    };
  }

  for (const [country, file] of Object.entries(manifest.countries || {}).sort()) {
    downloads[country] = {
      type: "country",
      country,
      file: file.file,
      url: file.url,
      apiDownloadUrl: file.apiDownloadUrl,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  }

  return downloads;
}

async function appendHistory(entry) {
  const history = await readJson(HISTORY_PATH, []);
  history.unshift(entry);

  await writeJson(HISTORY_PATH, history.slice(0, 10));
}

async function writeStatus(statusData) {
  const previous = await readJson(STATUS_PATH, {});

  await writeJson(STATUS_PATH, {
    ...previous,
    ...statusData,
  });
}

export async function runGeoipUpdate({ triggeredBy = "manual" } = {}) {
  const startedAt = new Date().toISOString();
  const countries = getConfiguredCountries();

  await writeStatus({
    status: "running",
    lastRunAt: startedAt,
    triggeredBy,
    countries,
  });

  try {
    await runGeoipScript(countries);

    const manifest = await readJson(MANIFEST_PATH, null);

    if (!manifest) {
      throw new Error("manifest.json was not created");
    }

    const finishedAt = new Date().toISOString();
    const buildId = createBuildId(manifest);
    const clientDownloads = createClientDownloads(manifest);

    const enrichedManifest = {
      schemaVersion: 1,
      ...manifest,
      buildId,
      lastUpdatedAt: finishedAt,
      update: {
        triggeredBy,
        startedAt,
        finishedAt,
        countries,
        schedule: {
          database: "GeoLite2-Country",
          expectedReleaseDays: ["Tuesday", "Friday"],
          cron: process.env.GEOIP_CRON || "0 10 * * 2,5",
          timezone: process.env.GEOIP_TZ || "UTC",
        },
      },
      client: {
        manifestUrl: "/geoip/manifest.json",
        downloadBaseUrl: "/geoip",
        downloads: clientDownloads,
      },
    };

    await writeJson(MANIFEST_PATH, enrichedManifest);

    const status = {
      status: "success",
      lastRunAt: startedAt,
      lastSuccessAt: finishedAt,
      triggeredBy,
      buildId,
      countries,
      manifestUrl: "/geoip/manifest.json",
      downloads: clientDownloads,
    };

    await writeStatus(status);

    await appendHistory({
      ...status,
      finishedAt,
    });

    console.log("GeoIP update finished.");
    console.log(JSON.stringify(status, null, 2));

    return enrichedManifest;
  } catch (error) {
    const failedAt = new Date().toISOString();

    const status = {
      status: "failed",
      lastRunAt: startedAt,
      lastErrorAt: failedAt,
      triggeredBy,
      countries,
      error: error.message,
    };

    await writeStatus(status);

    await appendHistory({
      ...status,
      failedAt,
    });

    throw error;
  }
}