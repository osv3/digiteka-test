import "dotenv/config";
import { startGeoipScheduler } from "./jobs/geoipScheduler.js";
import { runGeoipUpdate } from "./services/geoipUpdateRunner.js";

async function main() {
  console.log("GeoIP R2 worker starting...");

  if (process.env.GEOIP_RUN_ON_START === "true") {
    console.log("Running GeoIP update on start...");

    try {
      await runGeoipUpdate({ triggeredBy: "startup" });
    } catch (error) {
      console.error("Startup GeoIP update failed:", error.message);
    }
  }

  startGeoipScheduler();

  console.log("GeoIP R2 worker is running.");
}

main().catch(error => {
  console.error("GeoIP worker failed:", error.message);
  process.exit(1);
});