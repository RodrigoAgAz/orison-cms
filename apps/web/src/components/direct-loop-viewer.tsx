import Link from "next/link";

import { StatusPill } from "@/components/status-pill";

type Props = {
  loop: {
    id: string;
    name: string;
    status: string;
    compiledVideoUrl: string | null;
    manifestUrl: string | null;
    publishedAt: string | null;
    updatedAt: string;
  };
};

export function DirectLoopViewer({ loop }: Props) {
  return (
    <div className="stack-lg">
      <div className="card stack">
        <div className="loop-builder-header">
          <div className="stack-sm">
            <span className="eyebrow">Direct Loop Upload</span>
            <div className="loop-title-row">
              <h1 className="direct-loop-title">{loop.name}</h1>
              <StatusPill value={loop.status} />
            </div>
            <p className="muted direct-loop-copy">
              This programme was published from a single pre-built MP4. Slot programming and slot-level
              validation are bypassed for this loop.
            </p>
          </div>
          <div className="button-row">
            <Link className="button button-secondary" href="/loops">
              Back to loops
            </Link>
            {loop.compiledVideoUrl ? (
              <a
                className="button button-primary"
                href={loop.compiledVideoUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open Video File
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card stack direct-loop-viewer-card">
        <div className="card-header">
          <div>
            <span className="eyebrow">Published Output</span>
            <h2>Master Loop Preview</h2>
          </div>
        </div>

        {loop.compiledVideoUrl ? (
          <div className="direct-loop-frame">
            <video controls src={loop.compiledVideoUrl} />
          </div>
        ) : (
          <div className="empty-state compact">
            <strong>No compiled video available</strong>
            <p>The published loop file could not be resolved.</p>
          </div>
        )}

        <div className="meta-grid">
          <span>Published</span>
          <span>{loop.publishedAt ? new Date(loop.publishedAt).toLocaleString() : "Not recorded"}</span>
          <span>Last updated</span>
          <span>{new Date(loop.updatedAt).toLocaleString()}</span>
          <span>Manifest</span>
          <span>{loop.manifestUrl ? "Generated and available to devices" : "Unavailable"}</span>
          <span>Mode</span>
          <span>Direct upload</span>
        </div>
      </div>
    </div>
  );
}
