"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { StatusPill } from "@/components/status-pill";
import { useToast } from "@/components/toast-provider";

type LoopRow = {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  completeSlots: number;
  isDirectUpload: boolean;
};

type Props = {
  loops: LoopRow[];
};

export function LoopsTable({ loops }: Props) {
  const router = useRouter();
  const { toast } = useToast();

  async function handleDelete(loop: LoopRow) {
    const confirmed = window.confirm(`Delete draft loop "${loop.name}"?`);
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/loops/${loop.id}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      toast({
        title: "Delete failed",
        message: body?.error ?? "Unable to delete the loop.",
        tone: "error",
      });
      return;
    }

    toast({
      title: "Loop deleted",
      message: `${loop.name} was removed.`,
      tone: "success",
    });
    router.refresh();
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Updated</th>
            <th>Slot Coverage</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {loops.map((loop) => (
            <tr key={loop.id}>
              <td>{loop.name}</td>
              <td>
                <StatusPill value={loop.status} />
              </td>
              <td>{new Date(loop.updatedAt).toLocaleString()}</td>
              <td>
                {loop.isDirectUpload ? (
                  <div className="stack-sm">
                    <strong>Direct upload</strong>
                    <span className="muted loop-table-subtext">Published from one pre-built MP4</span>
                  </div>
                ) : (
                  `${loop.completeSlots}/10 complete`
                )}
              </td>
              <td>
                <div className="button-row table-actions">
                  <Link className="button button-secondary" href={`/loops/${loop.id}`}>
                    {loop.isDirectUpload ? "View" : "Open"}
                  </Link>
                  {loop.status === "DRAFT" ? (
                    <button
                      className="button button-danger"
                      onClick={() => void handleDelete(loop)}
                      type="button"
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
