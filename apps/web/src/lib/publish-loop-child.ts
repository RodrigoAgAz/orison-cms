function formatErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Loop publish failed unexpectedly";
}

async function failLoop(loopId: string | undefined, error: unknown) {
  if (!loopId) {
    return;
  }

  const message = formatErrorMessage(error);

  try {
    const { prisma } = await import("@orison/db");
    await prisma.loop.update({
      where: { id: loopId },
      data: {
        status: "DRAFT",
        publishError: message,
      },
    });
    await prisma.$disconnect().catch(() => undefined);
  } catch (updateError) {
    console.error(`[publish-loop-child] failed to update loop ${loopId} after error:`, updateError);
  }
}

process.on("unhandledRejection", (error) => {
  void failLoop(process.argv[2], error).finally(() => {
    console.error("[publish-loop-child] unhandled rejection:", error);
    process.exit(1);
  });
});

process.on("uncaughtException", (error) => {
  void failLoop(process.argv[2], error).finally(() => {
    console.error("[publish-loop-child] uncaught exception:", error);
    process.exit(1);
  });
});

async function main() {
  const loopId = process.argv[2];
  const publishedByUserId = process.argv[3];

  if (!loopId || !publishedByUserId) {
    throw new Error("loopId and publishedByUserId are required");
  }

  try {
    const [{ prisma }, { publishLoop }] = await Promise.all([
      import("@orison/db"),
      import("./loops"),
    ]);

    await publishLoop(loopId, publishedByUserId);
    await prisma.$disconnect().catch(() => undefined);
  } catch (error) {
    console.error(`[publish-loop-child] publish failed for ${loopId}:`, error);
    await failLoop(loopId, error);
    process.exitCode = 1;
  } finally {
    if (typeof process.disconnect === "function") {
      process.disconnect();
    }
  }
}

void main();
