import { PageErrorNotice } from "@/components/page-error-notice";
import { SettingsForm } from "@/components/settings-form";
import { requireUser } from "@/lib/auth";
import { getSettingsData } from "@/lib/queries";

export default async function SettingsPage() {
  await requireUser();
  const { settings, users, error } = await getSettingsData();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Configuration</span>
          <h1>Settings</h1>
          <p className="muted">Tune filler defaults, sync intervals, operators, and notifications.</p>
        </div>
      </div>

      <PageErrorNotice message={error} title="Settings unavailable" />

      <SettingsForm settings={settings} users={users} />
    </div>
  );
}
