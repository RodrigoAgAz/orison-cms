import { MobileShell } from "@/mobile/components/shell";

export default function MobileAppLayout({ children }: { children: React.ReactNode }) {
  return <MobileShell>{children}</MobileShell>;
}
