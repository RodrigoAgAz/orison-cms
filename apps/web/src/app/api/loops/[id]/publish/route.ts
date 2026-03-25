import { revalidatePath } from "next/cache";

import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { publishLoop } from "@/lib/loops";
import { enqueueLoopPublishJob } from "@/lib/queues";

type Props = {
  params: {
    id: string;
  };
};

export async function POST(_: Request, { params }: Props) {
  try {
    const user = await getSessionUser();
    if (!user) {
      throw new ApiError("Unauthenticated", 401);
    }

    if (env.inlineMediaJobs || !(await enqueueLoopPublishJob({ loopId: params.id, publishedByUserId: user.id }))) {
      const result = await publishLoop(params.id, user.id);
      revalidatePath("/");
      revalidatePath("/loops");
      revalidatePath(`/loops/${params.id}`);
      revalidatePath("/devices");
      return apiResponse(result);
    }

    return apiResponse(
      {
        queued: true,
      },
      { status: 202 },
    );
  } catch (error) {
    return apiError(error);
  }
}
