import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import configRoutes from "./routes/configRoutes.js";
import { startGeoipScheduler } from "./jobs/geoipScheduler.js";
import { runGeoipUpdate } from "./services/geoipUpdateRunner.js";

const app = express();
const PORT = process.env.PORT || 3000;

const geoipDir = path.join(process.cwd(), "public", "geoip");
const configDir = path.join(process.cwd(), "public", "configs");

app.use(express.json());


app.use(
  "/geoip",
  express.static(geoipDir, {
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    },
  }),
);
app.get("/api/debug/geoip-path", async (req, res) => {
  try {
    const files = await fs.readdir(geoipDir);

    res.json({
      cwd: process.cwd(),
      geoipDir,
      files,
    });
  } catch (error) {
    res.status(500).json({
      cwd: process.cwd(),
      geoipDir,
      error: error.message,
    });
  }
});
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/geoip/countries", async (req, res) => {
  try {
    const manifestPath = path.join(geoipDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

    res.json({
      generatedAt: manifest.generatedAt,
      countries: Object.keys(manifest.countries),
      files: manifest.countries,
    });
  } catch (error) {
    res.status(404).json({
     error: "GeoIP manifest not found. Run: npm run update:geoip",
    });
  }
});
app.get("/api/geoip/status", async (req, res) => {
  try {
    const statusPath = path.join(geoipDir, "update-status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));

    res.json(status);
  } catch (error) {
    res.status(404).json({
      error: "GeoIP update status not found yet. Run update first.",
    });
  }
});

app.get("/api/geoip/history", async (req, res) => {
  try {
    const historyPath = path.join(geoipDir, "update-history.json");
    const history = JSON.parse(await fs.readFile(historyPath, "utf8"));

    res.json(history);
  } catch (error) {
    res.json([]);
  }
});

app.post("/api/geoip/update", async (req, res) => {
  try {
    const manifest = await runGeoipUpdate({ triggeredBy: "manual-api" });

    res.json({
      ok: true,
      buildId: manifest.buildId,
      lastUpdatedAt: manifest.lastUpdatedAt,
      manifestUrl: "/geoip/manifest.json",
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/api/geoip/:country", async (req, res) => {
  try {
    const country = req.params.country.toLowerCase();

    if (!/^[a-z]{2}$/.test(country)) {
      return res.status(400).json({ error: "Invalid country code" });
    }

    const manifestPath = path.join(geoipDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const item = manifest.countries[country];

    if (!item) {
      return res.status(404).json({ error: `No GeoIP file for ${country}` });
    }

    res.json({
      country,
      ...item,
      downloadUrl: `/api/geoip/${country}/download`,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to read GeoIP manifest" });
  }
});

app.get("/api/geoip/:country/download", async (req, res) => {
  try {
    const country = req.params.country.toLowerCase();

    if (!/^[a-z]{2}$/.test(country)) {
      return res.status(400).json({ error: "Invalid country code" });
    }

    const filePath = path.join(geoipDir, `${country}.dat`);

    await fs.access(filePath);

    res.download(filePath, `${country}.dat`);
  } catch (error) {
    res.status(404).json({
      error: `GeoIP file not found. Generate it first: node geoip.js ${req.params.country}`,
    });
  }
});

app.use(
  "/configs",
  express.static(configDir, {
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    },
  }),
);

app.use("/api/config", configRoutes);

startGeoipScheduler();
app.listen(PORT, () => {
  console.log(`GeoIP download server running on http://localhost:${PORT}`);
});