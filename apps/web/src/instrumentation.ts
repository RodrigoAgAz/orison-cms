// Runs once when the server process starts (Next instrumentation hook).
export async function register() {
  // Written as a positive check so the edge bundle drops the Node-only import entirely.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { removeStaleUploadTempDirs } = await import("./lib/upload-temp");
    const removed = await removeStaleUploadTempDirs().catch((error) => {
      console.warn("could not clean upload temp folders", error);
      return [] as string[];
    });
    if (removed.length > 0) {
      console.log(`removed ${removed.length} stale upload temp folder(s)`);
    }
  }
}
