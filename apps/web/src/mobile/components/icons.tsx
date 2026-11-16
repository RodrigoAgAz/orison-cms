// Inline stroke icons (24px grid, currentColor). Decorative unless given a title.

type IconProps = { size?: number; className?: string; title?: string; strokeWidth?: number };

function Svg({ size = 22, className, title, strokeWidth = 2, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const CabsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 17h14v-4.5l-1.8-4.4A2 2 0 0 0 15.3 7H8.7a2 2 0 0 0-1.9 1.1L5 12.5V17Z" />
    <path d="M9.5 7 10 4.5h4l.5 2.5" />
    <path d="M5 12.5h14" />
    <circle cx="8" cy="17.5" r="1.5" />
    <circle cx="16" cy="17.5" r="1.5" />
  </Svg>
);

export const MapIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
    <circle cx="12" cy="10" r="2.4" />
  </Svg>
);

export const VideosIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m10.2 9.2 4.6 2.8-4.6 2.8V9.2Z" fill="currentColor" stroke="none" />
  </Svg>
);

export const UploadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V4" />
    <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
    <path d="M4.5 14.5v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
  </Svg>
);

export const PersonIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.5 20c1.2-3.6 4-5.3 7.5-5.3s6.3 1.7 7.5 5.3" />
  </Svg>
);

export const BackIcon = (p: IconProps) => (
  <Svg {...p} strokeWidth={2.4}>
    <path d="m14.5 5-7 7 7 7" />
  </Svg>
);

export const ChevronIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </Svg>
);

export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5v13l10.5-6.5L8 5.5Z" fill="currentColor" />
  </Svg>
);

export const PauseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth={3} />
  </Svg>
);

export const SwitchIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 9.5A7.5 7.5 0 0 1 18 6.8L20 9" />
    <path d="M20 4.5V9h-4.5" />
    <path d="M19.5 14.5A7.5 7.5 0 0 1 6 17.2L4 15" />
    <path d="M4 19.5V15h4.5" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p} strokeWidth={2.6}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4 2.8 19.5h18.4L12 4Z" />
    <path d="M12 10v4" />
    <path d="M12 17h.01" strokeWidth={2.8} />
  </Svg>
);

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <path d="M12 7.6h.01" strokeWidth={2.8} />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p} strokeWidth={2.4}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);

export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v11" />
    <path d="m8 7.5 4-4 4 4" />
    <path d="M7 10.5H6a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1" />
  </Svg>
);

export const PlusSquareIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3.5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9" />
    <path d="M19.5 4v5h-5" />
  </Svg>
);

export const OfflineIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18" />
    <path d="M8.5 16.5a5 5 0 0 1 7 0" />
    <path d="M5 12.8a10 10 0 0 1 4.3-2.5M19 12.8a10 10 0 0 0-3-2" />
    <path d="M2 9.2a15 15 0 0 1 4.2-2.8M22 9.2A15 15 0 0 0 11 5.1" />
    <path d="M12 20h.01" strokeWidth={2.8} />
  </Svg>
);

export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Svg>
);

export const TeamIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="3.3" />
    <path d="M3 19.5c.9-3 3.2-4.5 6-4.5s5.1 1.5 6 4.5" />
    <circle cx="17" cy="8" r="2.6" />
    <path d="M16.5 13.2c2.4.1 4 1.5 4.6 3.8" />
  </Svg>
);

export const SignOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h7" />
    <path d="M11 12h9.5" />
    <path d="m17 8.5 3.5 3.5-3.5 3.5" />
  </Svg>
);

export const DesktopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16.5V20" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V4.5h5V7" />
    <path d="M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12" />
  </Svg>
);

export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const LayersIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4Z" />
    <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
    <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
  </Svg>
);

// The windmill from the Orison logo, recoloured gold for the dark UI. Generated from
// apps/web/assets/orison-logo.png by scripts/generate-mobile-icons.mjs at 288px high (sharp up
// to 96 CSS px on 3x screens). `size` is its height in CSS px.
const WINDMILL_ASPECT = 215 / 288;

export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/m-app/windmill-gold.png"
      width={Math.round(size * WINDMILL_ASPECT)}
      height={size}
      alt=""
      aria-hidden="true"
      className="m-brandmark"
      draggable={false}
      decoding="async"
    />
  );
}
