import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as tar from "tar";

const ROOT = process.cwd();

const TMP_DIR = path.join(ROOT, "tmp");
const MAXMIND_DIR = path.join(TMP_DIR, "maxmind");
const BUILD_DIR = path.join(TMP_DIR, "geoip-output");
const PUBLIC_DIR = path.join(ROOT, "public", "geoip");

const ARCHIVE_PATH = path.join(TMP_DIR, "GeoLite2-Country.tar.gz");
const MMDB_PATH = path.join(TMP_DIR, "GeoLite2-Country.mmdb");

const MAXMIND_DOWNLOAD_URL =
  "https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=tar.gz";

const DEFAULT_COUNTRIES = ["ru", "cn", "ir", "ua", "ae"];

const args = process.argv.slice(2);
const forceRefresh = args.includes("--refresh");

const countries = args
  .filter(arg => !arg.startsWith("--"))
  .map(country => country.toLowerCase());

const wantedCountries = countries.length ? countries : DEFAULT_COUNTRIES;

function toConfigPath(filePath) {
  return "./" + path.relative(ROOT, filePath).replaceAll("\\", "/");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function validateCountries(countries) {
  for (const country of countries) {
    if (!/^[a-z]{2}$/.test(country)) {
      throw new Error(`Invalid country code: ${country}`);
    }
  }
}

async function downloadMaxMindDatabase() {
  const accountId = process.env.MAXMIND_ACCOUNT_ID;
  const licenseKey = process.env.MAXMIND_LICENSE_KEY;

  if (!accountId || !licenseKey) {
    throw new Error(
      "Missing MAXMIND_ACCOUNT_ID or MAXMIND_LICENSE_KEY environment variable.",
    );
  }

  await fs.mkdir(TMP_DIR, { recursive: true });

  console.log("Downloading MaxMind GeoLite2-Country database...");

  const auth = Buffer.from(`${accountId}:${licenseKey}`).toString("base64");

  const res = await fetch(MAXMIND_DOWNLOAD_URL, {
    headers: {
      Authorization: `Basic ${auth}`,
    },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to download MaxMind database: ${res.status} ${res.statusText}`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  await fs.writeFile(ARCHIVE_PATH, buffer);

  console.log(`Downloaded ${ARCHIVE_PATH}`);
  console.log(`Size: ${buffer.length} bytes`);

  if (buffer.length < 1_000_000) {
    throw new Error("Downloaded archive looks too small.");
  }
}

async function findFileByName(dir, fileName) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const found = await findFileByName(fullPath, fileName);
      if (found) return found;
    }

    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
  }

  return null;
}

async function extractMaxMindDatabase() {
  console.log("Extracting MaxMind database...");

  await fs.rm(MAXMIND_DIR, { recursive: true, force: true });
  await fs.mkdir(MAXMIND_DIR, { recursive: true });

  await tar.x({
    file: ARCHIVE_PATH,
    cwd: MAXMIND_DIR,
  });

  const extractedMmdb = await findFileByName(MAXMIND_DIR, "GeoLite2-Country.mmdb");

  if (!extractedMmdb) {
    throw new Error("GeoLite2-Country.mmdb was not found in extracted archive.");
  }

  await fs.copyFile(extractedMmdb, MMDB_PATH);

  console.log(`MMDB ready: ${MMDB_PATH}`);
}

async function ensureMaxMindDatabase() {
  if (!forceRefresh && (await fileExists(MMDB_PATH))) {
    console.log(`Using cached MMDB: ${MMDB_PATH}`);
    return;
  }

  await downloadMaxMindDatabase();
  await extractMaxMindDatabase();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function sha256(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function copyGeneratedFilesToPublic() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });

  const files = await fs.readdir(BUILD_DIR);
  const datFiles = files.filter(file => file.toLowerCase().endsWith(".dat"));

  for (const file of datFiles) {
    await fs.copyFile(
      path.join(BUILD_DIR, file),
      path.join(PUBLIC_DIR, file),
    );
  }
}

async function buildManifest() {
  const files = await fs.readdir(PUBLIC_DIR);
  const datFiles = files.filter(file => file.toLowerCase().endsWith(".dat"));

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: {
      type: "maxmindMMDB",
      database: "GeoLite2-Country.mmdb",
    },
    combined: null,
    countries: {},
  };

  for (const file of datFiles) {
    const filePath = path.join(PUBLIC_DIR, file);
    const stat = await fs.stat(filePath);
    const name = path.basename(file, ".dat").toLowerCase();

    const info = {
      file,
      bytes: stat.size,
      sha256: await sha256(filePath),
      url: `/geoip/${file}`,
    };

    if (file === "geoip.dat") {
      manifest.combined = info;
      continue;
    }

    if (/^[a-z]{2}$/.test(name)) {
      manifest.countries[name] = {
        ...info,
        apiDownloadUrl: `/api/geoip/${name}/download`,
      };
    }
  }

  await fs.writeFile(
    path.join(PUBLIC_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  return manifest;
}

async function main() {
  validateCountries(wantedCountries);

  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(PUBLIC_DIR, { recursive: true });

  await ensureMaxMindDatabase();

  await fs.rm(BUILD_DIR, { recursive: true, force: true });
  await fs.mkdir(BUILD_DIR, { recursive: true });

  const configPath = path.join(TMP_DIR, "geoip-config.json");

  const config = {
    input: [
      {
        type: "maxmindMMDB",
        action: "add",
        args: {
          uri: toConfigPath(MMDB_PATH),
        },
      },
    ],
    output: [
      {
        type: "v2rayGeoIPDat",
        action: "output",
        args: {
          outputDir: toConfigPath(BUILD_DIR),
          outputName: "geoip.dat",
          wantedList: wantedCountries,
        },
      },
      ...wantedCountries.map(country => ({
        type: "v2rayGeoIPDat",
        action: "output",
        args: {
          outputDir: toConfigPath(BUILD_DIR),
          outputName: `${country}.dat`,
          wantedList: [country],
        },
      })),
    ],
  };

  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  console.log("GeoIP config:");
  console.log(JSON.stringify(config, null, 2));

  console.log("Generating GeoIP .dat files from MaxMind MMDB...");
  await run("geoip", ["-c", toConfigPath(configPath)]);

  await copyGeneratedFilesToPublic();

  const manifest = await buildManifest();

  console.log("Done.");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => {
  console.error("FAILED:", error.message);
  process.exit(1);
});