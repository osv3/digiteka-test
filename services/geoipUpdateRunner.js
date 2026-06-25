import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { uploadGeoipFilesToR2 } from "./r2UploadService.js";

const ROOT = process.cwd();
const BUILD_DIR = path.join(ROOT, "tmp", "geoip-output");
const STATE_DIR = path.join(ROOT, "tmp", "geoip-state");

const MANIFEST_PATH = path.join(BUILD_DIR, "manifest.json");
const STATUS_PATH = path.join(STATE_DIR, "update-status.json");

let activeUpdatePromise = null;

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

async function writeStatus(statusData) {
  const previous = await readJson(STATUS_PATH, {});

  await writeJson(STATUS_PATH, {
    ...previous,
    ...statusData,
  });
}
async function runGeoipUpdateInternal({ triggeredBy = "manual" } = {}) {
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
  manifestUrl: process.env.R2_PUBLIC_BASE_URL
    ? `${process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/manifest.json`
    : "manifest.json",
  downloadBaseUrl: process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "") || "",
  downloads: createClientDownloads(manifest),
},
    };

    await writeJson(MANIFEST_PATH, enrichedManifest);

    let r2Upload = null;

    if (process.env.R2_UPLOAD_ENABLED === "true") {
      r2Upload = await uploadGeoipFilesToR2();
    }

    const finalManifest = r2Upload ? r2Upload.manifest : enrichedManifest;


    const status = {
      status: "success",
      lastRunAt: startedAt,
      lastSuccessAt: finishedAt,
      triggeredBy,
      buildId,
      countries,
      manifestUrl: finalManifest.client.manifestUrl,
      storage: finalManifest.storage,
      downloads: finalManifest.client.downloads,
    };

    await writeStatus(status);

    console.log("GeoIP update finished.");
    console.log(JSON.stringify(status, null, 2));

    return finalManifest;
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

    throw error;
  }
}

export async function runGeoipUpdate(options = {}) {
  if (activeUpdatePromise) {
    console.log("GeoIP update already running. Reusing active update.");
    return activeUpdatePromise;
  }

  activeUpdatePromise = runGeoipUpdateInternal(options);

  try {
    return await activeUpdatePromise;
  } finally {
    activeUpdatePromise = null;
  }
}