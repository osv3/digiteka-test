import "dotenv/config";
import { runGeoipUpdate } from "../services/geoipUpdateRunner.js";

runGeoipUpdate({ triggeredBy: "manual-cli" }).catch(error => {
  console.error("GeoIP update failed:", error.message);
  process.exit(1);
});