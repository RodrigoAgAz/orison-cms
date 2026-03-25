import { duplicateLoop } from "@/lib/loops";
import { apiError, apiResponse } from "@/lib/http";

type Props = {
  params: {
    id: string;
  };
};

export async function POST(_: Request, { params }: Props) {
  try {
    const loop = await duplicateLoop(params.id);
    return apiResponse(loop, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

