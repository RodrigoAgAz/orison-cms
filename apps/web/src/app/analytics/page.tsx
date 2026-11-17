import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { PageErrorNotice } from "@/components/page-error-notice";
import { requireUser } from "@/lib/auth";
import { getAnalyticsData } from "@/lib/fleet-data";

export default async function AnalyticsPage() {
  await requireUser();
  const analytics = await getAnalyticsData();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Analytics</span>
          <h1>Playback analytics</h1>
          <p className="muted">
            What the screens played over the last 30 days, by London calendar day. Each figure says exactly what it
            counts.
          </p>
        </div>
      </div>

      <PageErrorNotice message={analytics.error} title="Analytics unavailable" />

      <AnalyticsDashboard analytics={analytics} />
    </div>
  );
}
