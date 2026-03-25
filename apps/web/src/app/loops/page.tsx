import { CreateLoopForm } from "@/components/create-loop-form";
import { DirectLoopUploadForm } from "@/components/direct-loop-upload-form";
import { LoopsTable } from "@/components/loops-table";
import { requireUser } from "@/lib/auth";
import { getLoopListData } from "@/lib/queries";

export default async function LoopsPage() {
  await requireUser();
  const loops = await getLoopListData();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Programming</span>
          <h1>Loop Library</h1>
          <p className="muted">Create, duplicate, inspect, and publish ten-minute playback loops.</p>
        </div>
      </div>

      <div className="grid-two loops-entry-grid">
        <div className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Primary Workflow</span>
              <h2>Create a Loop</h2>
            </div>
          </div>
          <p className="muted">
            Start with the ten-slot builder when you need ad assignment, filler control, and per-slot
            validation.
          </p>
          <CreateLoopForm />
        </div>

        <div className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Quick Publish</span>
              <h2>Upload Pre-built Loop</h2>
            </div>
          </div>
          <p className="muted">
            Upload one finished MP4 master loop. The CMS will transcode, store, manifest, and publish it
            directly without using the slot builder.
          </p>
          <DirectLoopUploadForm />
        </div>
      </div>

      <div className="card stack">
        <div className="card-header">
          <div>
            <span className="eyebrow">Existing Loops</span>
            <h2>All Programmes</h2>
          </div>
        </div>

        <LoopsTable
          loops={loops.map((loop) => ({
            id: loop.id,
            name: loop.name,
            status: loop.status,
            updatedAt: loop.updatedAt.toISOString(),
            completeSlots: loop.slots.filter((slot) => slot.contents.length > 0).length,
            isDirectUpload:
              loop.slots.length === 0 && Boolean(loop.compiledVideoUrl),
          }))}
        />
      </div>
    </div>
  );
}
