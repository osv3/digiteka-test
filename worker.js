import "dotenv/config";
import { runGeoipUpdate } from "./services/geoipUpdateRunner.js";

// One-shot entrypoint for serverless / scheduled runs (e.g. ECS Fargate task).
// Runs the full GeoIP build + R2 upload exactly once, then exits with a status
// code so the platform knows whether the run succeeded (0) or failed (non-zero).
const triggeredBy = process.env.GEOIP_TRIGGERED_BY || "scheduled";

runGeoipUpdate({ triggeredBy })
  .then(() => {
    console.log("GeoIP worker run complete.");
    process.exit(0);
  })
  .catch(error => {
    console.error("GeoIP worker run failed:", error.message);
    process.exit(1);
  });
