import { updateSlotSchema } from "@orison/shared";

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
    const body = await parseJsonBody(request, updateSlotSchema);
    const loop = await updateSlotContents(
      params.id,
      Number.parseInt(params.position, 10),
      body.contents,
    );
    return apiResponse({ loop });
  } catch (error) {
    return apiError(error);
  }
}
