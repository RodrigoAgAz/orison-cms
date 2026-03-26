"use client";

import type { Route } from "next";
import Link from "next/link";

type Props = {
  pathname: string;
  page: number;
  pageSize: number;
  total: number;
  query?: Record<string, string | number | undefined | null>;
};

function buildHref(
  pathname: string,
  page: number,
  query: Record<string, string | number | undefined | null>,
) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    params.set(key, String(value));
  }

  if (page > 1) {
    params.set("page", String(page));
  } else {
    params.delete("page");
  }

  const search = params.toString();
  return (search ? `${pathname}?${search}` : pathname) as Route;
}

export function PaginationControls({ pathname, page, pageSize, total, query = {} }: Props) {
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);

  if (total <= pageSize) {
    return null;
  }

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <div className="pagination-bar">
      <span className="pagination-summary">
        Showing {start}-{end} of {total}
      </span>
      <div className="button-row">
        <Link
          aria-disabled={page <= 1}
          className={`button button-secondary ${page <= 1 ? "is-disabled" : ""}`}
          href={buildHref(pathname, Math.max(page - 1, 1), query)}
          tabIndex={page <= 1 ? -1 : undefined}
        >
          Previous
        </Link>
        <span className="pagination-page">
          Page {page} of {totalPages}
        </span>
        <Link
          aria-disabled={page >= totalPages}
          className={`button button-secondary ${page >= totalPages ? "is-disabled" : ""}`}
          href={buildHref(pathname, Math.min(page + 1, totalPages), query)}
          tabIndex={page >= totalPages ? -1 : undefined}
        >
          Next
        </Link>
      </div>
    </div>
  );
}
