import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { PageErrorNotice } from "@/components/page-error-notice";
import { requireUser } from "@/lib/auth";
import { getAnalyticsData } from "@/lib/queries";

export default async function AnalyticsPage() {
  await requireUser();
  const analytics = await getAnalyticsData();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Reporting</span>
          <h1>Playback Analytics</h1>
          <p className="muted">High-level pilot metrics for impressions, ad plays, and uptime.</p>
        </div>
      </div>

      <PageErrorNotice message={analytics.error} title="Analytics unavailable" />

      <AnalyticsDashboard analytics={analytics} />
    </div>
  );
}
