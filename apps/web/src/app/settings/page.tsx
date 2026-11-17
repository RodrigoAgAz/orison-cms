import type { Metadata } from "next";
import { PageErrorNotice } from "@/components/page-error-notice";
import { SettingsForm } from "@/components/settings-form";
import { requireUser } from "@/lib/auth";
import { getSettingsData } from "@/lib/queries";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireUser();
  const { settings, users, safetyAssets, error } = await getSettingsData();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Settings</span>
          <h1>Settings</h1>
          <p className="muted">The filler template, the screen format loops are compiled to, the safety message, and how often cabs check in.</p>
        </div>
      </div>

      <PageErrorNotice message={error} title="Settings unavailable" />

      {settings ? <SettingsForm safetyAssets={safetyAssets} settings={settings} users={users} /> : null}
    </div>
  );
}
