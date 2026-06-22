import express from "express";
import { ensureConfig, normalizeCountries } from "../services/configService.js";

const router = express.Router();

function getOutboundTag(req) {
  if (typeof req.query.outboundTag === "string" && req.query.outboundTag.trim()) {
    return req.query.outboundTag.trim();
  }

  return "Proxy-2";
}

router.get("/", async (req, res) => {
  try {
    const countries = normalizeCountries(req.query.countries);
    const outboundTag = getOutboundTag(req);

    const result = await ensureConfig(countries, outboundTag);

    res.json({
      countries: result.countries,
      outboundTag: result.outboundTag,
      configGenerated: result.configGenerated,
      geoipGenerated: result.geoipGenerated,
      missingGeoipCountries: result.missingGeoipCountries,
      file: result.fileName,
      url: `/configs/${result.fileName}`,
      downloadUrl: `/api/config/download?countries=${countries.join(",")}&outboundTag=${encodeURIComponent(outboundTag)}`,
      config: result.config,
    });
  } catch (error) {
    res.status(400).json({
      error: error.message,
      example: "/api/config?countries=us,ca&outboundTag=Proxy-2",
    });
  }
});

router.get("/download", async (req, res) => {
  try {
    const countries = normalizeCountries(req.query.countries);
    const outboundTag = getOutboundTag(req);

    const result = await ensureConfig(countries, outboundTag);

    res.download(result.filePath, result.fileName);
  } catch (error) {
    res.status(400).json({
      error: error.message,
      example: "/api/config/download?countries=us,ca&outboundTag=Proxy-2",
    });
  }
});

export default router;