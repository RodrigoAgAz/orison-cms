import { updateSlotSchema } from "@orison/shared";

import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";
import { updateSlotContents } from "@/lib/loops";

type Props = {
  params: {
    id: string;
    position: string;
  };
};

export async function PUT(request: Request, { params }: Props) {
  try {
    await requireApiUser();
    const body = await parseJsonBody(request, updateSlotSchema);
    const loop = await updateSlotContents(
      params.id,
      Number.parseInt(params.position, 10),
      body.contents,
      body.staticCreativeId,
    );
    return apiResponse({ loop });
  } catch (error) {
    return apiError(error);
  }
}
