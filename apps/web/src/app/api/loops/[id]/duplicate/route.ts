import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { toApiError } from "@/lib/loop-api";
import { duplicateLoop } from "@/lib/loops";

type Props = {
  params: {
    id: string;
  };
};

export async function POST(_: Request, { params }: Props) {
  try {
    await requireApiUser();
    const loop = await duplicateLoop(params.id);
    return apiResponse(loop, { status: 201 });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
