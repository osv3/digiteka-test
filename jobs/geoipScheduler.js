import cron from "node-cron";
import { runGeoipUpdate } from "../services/geoipUpdateRunner.js";

export function startGeoipScheduler() {
  if (process.env.GEOIP_AUTO_UPDATE !== "true") {
    console.log("GeoIP auto-update disabled.");
    return;
  }

  const schedule = process.env.GEOIP_CRON || "0 10 * * 2,5";
  const timezone = process.env.GEOIP_TZ || "UTC";

  cron.schedule(
    schedule,
    async () => {
      try {
        await runGeoipUpdate({ triggeredBy: "scheduled" });
      } catch (error) {
        console.error("Scheduled GeoIP update failed:", error.message);
      }
    },
    { timezone },
  );

  console.log(`GeoIP auto-update scheduled: "${schedule}" timezone=${timezone}`);
}