import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PORT = 3999;
const BASE_URL = `http://localhost:${PORT}`;

const REQUIRED_COUNTRIES = ["ru", "cn", "ir", "ua", "ae"];

let serverProcess;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options,
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function runNodeScript(scriptPath, args = [], options = {}) {
  return run(process.execPath, [scriptPath, ...args], options);
}

async function waitForServer() {
  const maxAttempts = 40;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);

      if (res.ok) {
        return;
      }
    } catch {
      // server not ready yet
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error("Server did not start in time");
}

function startServer() {
  serverProcess = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      GEOIP_AUTO_UPDATE: "false",
    },
    stdio: "inherit",
    shell: false,
  });
}

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);

  assert.equal(
    res.ok,
    true,
    `Expected GET ${path} to be OK, got ${res.status}`,
  );

  return res.json();
}

async function download(path) {
  const res = await fetch(`${BASE_URL}${path}`);

  assert.equal(
    res.ok,
    true,
    `Expected GET ${path} to be OK, got ${res.status}`,
  );

  const buffer = Buffer.from(await res.arrayBuffer());

  return {
    buffer,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
    contentType: res.headers.get("content-type"),
  };
}

before(async () => {
  if (process.env.SKIP_GEOIP_UPDATE !== "true") {
    console.log("Running GeoIP update before tests...");
    await runNodeScript("scripts/updateGeoip.js");
  } else {
    console.log("Skipping GeoIP update because SKIP_GEOIP_UPDATE=true");
  }

  startServer();
  await waitForServer();
});

after(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

test("health endpoint works", async () => {
  const health = await getJson("/health");

  assert.equal(health.ok, true);
});

test("manifest exists and has update metadata", async () => {
  const manifest = await getJson("/geoip/manifest.json");

  assert.equal(manifest.source.type, "maxmindMMDB");
  assert.equal(manifest.source.database, "GeoLite2-Country.mmdb");

  assert.ok(manifest.generatedAt);
  assert.ok(manifest.buildId);
  assert.ok(manifest.lastUpdatedAt);

  assert.ok(manifest.combined);
  assert.equal(manifest.combined.file, "geoip.dat");
  assert.ok(manifest.combined.bytes > 0);
  assert.ok(manifest.combined.sha256);

  for (const country of REQUIRED_COUNTRIES) {
    assert.ok(manifest.countries[country], `Missing ${country} in manifest.countries`);
    assert.equal(manifest.countries[country].file, `${country}.dat`);
    assert.ok(manifest.countries[country].bytes > 0);
    assert.ok(manifest.countries[country].sha256);
    assert.equal(manifest.countries[country].url, `/geoip/${country}.dat`);
  }

  assert.ok(manifest.client);
  assert.ok(manifest.client.downloads);

  for (const country of REQUIRED_COUNTRIES) {
    assert.ok(manifest.client.downloads[country], `Missing ${country} in client downloads`);
  }
});

test("status endpoint returns latest update result", async () => {
  const status = await getJson("/api/geoip/status");

  assert.equal(status.status, "success");
  assert.ok(status.lastSuccessAt);
  assert.ok(status.buildId);

  for (const country of REQUIRED_COUNTRIES) {
    assert.ok(status.countries.includes(country), `Status missing ${country}`);
  }
});

test("history endpoint returns update history", async () => {
  const history = await getJson("/api/geoip/history");

  assert.equal(Array.isArray(history), true);
  assert.ok(history.length > 0);
  assert.equal(history[0].status, "success");
});

test("countries endpoint lists generated countries", async () => {
  const result = await getJson("/api/geoip/countries");

  for (const country of REQUIRED_COUNTRIES) {
    assert.ok(result.countries.includes(country), `Countries endpoint missing ${country}`);
    assert.ok(result.files[country], `Files object missing ${country}`);
  }
});

test("country info endpoint returns metadata", async () => {
  const ru = await getJson("/api/geoip/ru");

  assert.equal(ru.country, "ru");
  assert.equal(ru.file, "ru.dat");
  assert.ok(ru.bytes > 0);
  assert.ok(ru.sha256);
  assert.equal(ru.url, "/geoip/ru.dat");
});

test("static .dat download matches manifest hash", async () => {
  const manifest = await getJson("/geoip/manifest.json");
  const expected = manifest.countries.ru;

  const file = await download("/geoip/ru.dat");

  assert.equal(file.bytes, expected.bytes);
  assert.equal(file.sha256, expected.sha256);
});

test("API .dat download matches manifest hash", async () => {
  const manifest = await getJson("/geoip/manifest.json");
  const expected = manifest.countries.ru;

  const file = await download("/api/geoip/ru/download");

  assert.equal(file.bytes, expected.bytes);
  assert.equal(file.sha256, expected.sha256);
});

test("combined geoip.dat download works", async () => {
  const manifest = await getJson("/geoip/manifest.json");
  const expected = manifest.combined;

  const file = await download("/geoip/geoip.dat");

  assert.equal(file.bytes, expected.bytes);
  assert.equal(file.sha256, expected.sha256);
});

test("config endpoint generates routing config", async () => {
  const result = await getJson("/api/config?countries=ru,cn&outboundTag=Proxy-2");

  assert.deepEqual(result.countries, ["cn", "ru"]);
  assert.equal(result.outboundTag, "Proxy-2");
  assert.ok(result.file);
  assert.ok(result.downloadUrl);

  assert.ok(result.config.routing);
  assert.equal(result.config.routing.domainStrategy, "IPIfNonMatch");

  const rule = result.config.routing.rules[0];

  assert.equal(rule.type, "field");
  assert.equal(rule.outboundTag, "Proxy-2");
  assert.deepEqual(rule.ip, ["ext:cn.dat:cn", "ext:ru.dat:ru"]);
});

test("config download endpoint works", async () => {
  const file = await download("/api/config/download?countries=ru,cn&outboundTag=Proxy-2");

  assert.ok(file.bytes > 0);

  const json = JSON.parse(file.buffer.toString("utf8"));

  assert.ok(json.routing);
  assert.equal(json.routing.rules[0].outboundTag, "Proxy-2");
});

test("invalid country returns error", async () => {
  const res = await fetch(`${BASE_URL}/api/geoip/russia`);

  assert.equal(res.status, 400);

  const body = await res.json();

  assert.equal(body.error, "Invalid country code");
});

test("manual API update works when enabled", async t => {
  if (process.env.INCLUDE_API_UPDATE_TEST !== "true") {
    t.skip("Skipping POST /api/geoip/update because INCLUDE_API_UPDATE_TEST is not true");
    return;
  }

  const res = await fetch(`${BASE_URL}/api/geoip/update`, {
    method: "POST",
  });

  assert.equal(res.ok, true);

  const body = await res.json();

  assert.equal(body.ok, true);
  assert.ok(body.buildId);
  assert.ok(body.lastUpdatedAt);
});