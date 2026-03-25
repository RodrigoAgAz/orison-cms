import { buildPreviewManifest } from "@/lib/loops";
import { apiError, apiResponse } from "@/lib/http";

type Props = {
  params: {
    id: string;
  };
};

export async function GET(_: Request, { params }: Props) {
  try {
    return apiResponse(await buildPreviewManifest(params.id));
  } catch (error) {
    return apiError(error);
  }
}

