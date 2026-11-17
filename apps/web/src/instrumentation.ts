// Runs once when the server process starts (Next instrumentation hook).
export async function register() {
  // Written as a positive check so the edge bundle drops the Node-only imports entirely.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { removeStaleUploadTempDirs } = await import("./lib/upload-temp");
    const removed = await removeStaleUploadTempDirs().catch((error) => {
      console.warn("could not clean upload temp folders", error);
      return [] as string[];
    });
    if (removed.length > 0) {
      console.log(`removed ${removed.length} stale upload temp folder(s)`);
    }

    // Latest cab state on the Device row for cabs that have not reported since the upgrade.
    const { backfillDeviceStatus } = await import("./lib/device-backfill");
    await backfillDeviceStatus()
      .then((count) => {
        if (count > 0) {
          console.log(`filled in the latest reported state for ${count} cab(s)`);
        }
      })
      .catch((error) => console.warn("could not fill in cab state from heartbeats", error));

    // Daily deletion of old heartbeats (and playback logs only if configured).
    const { scheduleRetention } = await import("./lib/retention");
    scheduleRetention();
  }
}
