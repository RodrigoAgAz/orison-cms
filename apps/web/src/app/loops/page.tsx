import Link from "next/link";

import { CreateLoopForm } from "@/components/create-loop-form";
import { DirectLoopUploadForm } from "@/components/direct-loop-upload-form";
import { LoopsTable } from "@/components/loops-table";
import { PageErrorNotice } from "@/components/page-error-notice";
import { requireUser } from "@/lib/auth";
import { prisma } from "@orison/db";
import { getLoopListData } from "@/lib/queries";

type Props = {
  searchParams?: {
    page?: string;
  };
};

function parsePage(value: string | undefined) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export default async function LoopsPage({ searchParams }: Props) {
  await requireUser();
  const [result, deviceGroups] = await Promise.all([
    getLoopListData({ page: parsePage(searchParams?.page), pageSize: 12 }),
    prisma.deviceGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }).catch(() => []),
  ]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Loops</span>
          <h1>Loops</h1>
          <p className="muted">
            A loop is what a cab&apos;s screen plays: ten one-minute slots, each an advert followed by fillers, built here
            and compiled into one video.
          </p>
        </div>
      </div>

      <PageErrorNotice message={result.error} title="Loops unavailable" />

      <div className="grid-two loops-entry-grid">
        <div className="card stack">
          <div>
            <span className="eyebrow">Build</span>
            <h2>New loop</h2>
          </div>
          <p className="muted">
            Start an empty loop of ten slots and choose an advert and fillers for each. To start from an existing loop, use
            Duplicate in the list below.
          </p>
          <CreateLoopForm />
        </div>

        <div className="card stack">
          <div>
            <span className="eyebrow">Upload</span>
            <h2>Pre-built loop</h2>
          </div>
          <p className="muted">
            Upload one finished video (MP4 or MOV). It is converted to the cab format and plays from start to end, without
            slots. You choose where it plays before it goes on air.
          </p>
          <DirectLoopUploadForm deviceGroups={deviceGroups} />
        </div>
      </div>

      <div className="card stack">
        <div className="card-header">
          <div>
            <span className="eyebrow">Library</span>
            <h2>All loops</h2>
          </div>
          <span className="muted">
            {result.total} loop{result.total === 1 ? "" : "s"}
          </span>
        </div>
        {result.total > 0 && result.items.length === 0 ? (
          <div className="empty-state">
            <strong>This page is empty</strong>
            <p>
              <Link href="/loops">Go to the first page</Link>
            </p>
          </div>
        ) : (
          <LoopsTable loops={result.items} page={result.page} pageSize={result.pageSize} total={result.total} />
        )}
      </div>
    </div>
  );
}
