import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const GEOIP_DIR = path.join(ROOT, "public", "geoip");
const CONFIG_DIR = path.join(ROOT, "public", "configs");

export function normalizeCountries(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Missing countries. Example: ?countries=us,ca");
  }

  const countries = [
    ...new Set(
      value
        .split(",")
        .map(country => country.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

  for (const country of countries) {
    if (!/^[a-z]{2}$/.test(country)) {
      throw new Error(`Invalid country code: ${country}`);
    }
  }

  if (countries.length === 0) {
    throw new Error("No valid countries provided");
  }

  return countries.sort();
}

function safeFilePart(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runGeoipGenerator(countries) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ROOT, "geoip.js");

    console.log(`Running: node geoip.js ${countries.join(" ")}`);

    const child = spawn(process.execPath, [scriptPath, ...countries], {
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

async function ensureGeoipFiles(countries) {
  await fs.mkdir(GEOIP_DIR, { recursive: true });

  const missingCountries = [];

  for (const country of countries) {
    const filePath = path.join(GEOIP_DIR, `${country}.dat`);

    if (!(await fileExists(filePath))) {
      missingCountries.push(country);
    }
  }

  if (missingCountries.length === 0) {
    return {
      generated: false,
      missingCountries: [],
    };
  }

  await runGeoipGenerator(countries);

  for (const country of countries) {
    const filePath = path.join(GEOIP_DIR, `${country}.dat`);

    if (!(await fileExists(filePath))) {
      throw new Error(`GeoIP generation failed. Missing ${country}.dat`);
    }
  }

  return {
    generated: true,
    missingCountries,
  };
}

function createRoutingConfig(countries, outboundTag) {
  return {
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: [
        {
          type: "field",
          outboundTag,
          ip: countries.map(country => `ext:${country}.dat:${country}`),
        },
      ],
    },
  };
}

function getConfigFileName(countries, outboundTag) {
  const countriesPart = countries.join("-");
  const outboundPart = safeFilePart(outboundTag);

  return `routing-${countriesPart}-${outboundPart}.json`;
}

export async function ensureConfig(countries, outboundTag = "Proxy-2") {
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  const geoipResult = await ensureGeoipFiles(countries);

  const fileName = getConfigFileName(countries, outboundTag);
  const filePath = path.join(CONFIG_DIR, fileName);

  const configAlreadyExists = await fileExists(filePath);

  if (!configAlreadyExists) {
    const config = createRoutingConfig(countries, outboundTag);
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));
  }

  const config = JSON.parse(await fs.readFile(filePath, "utf8"));

  return {
    countries,
    outboundTag,
    fileName,
    filePath,
    config,
    configGenerated: !configAlreadyExists,
    geoipGenerated: geoipResult.generated,
    missingGeoipCountries: geoipResult.missingCountries,
  };
}