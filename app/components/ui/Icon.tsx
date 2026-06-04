import type { SVGProps } from "react";

// Inline SVG icon set — รูปทรงจริง, ห้าม icon font / กล่องเปล่า (tech.md, REQ-15.2, 6.1)
// ทุกตัว 24x24 viewBox, stroke = currentColor.

const PATHS: Record<string, React.ReactNode> = {
  // --- navigation / ui ---
  menu: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>
  ),
  close: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  chevronDown: <polyline points="6 9 12 15 18 9" />,
  chevronLeft: <polyline points="15 18 9 12 15 6" />,
  chevronRight: <polyline points="9 18 15 12 9 6" />,
  arrowRight: (
    <>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  user: (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  cart: (
    <>
      <circle cx="9" cy="21" r="1.6" />
      <circle cx="19" cy="21" r="1.6" />
      <path d="M2.5 3h2.2l2.3 12.4a2 2 0 0 0 2 1.6h8.4a2 2 0 0 0 2-1.6l1.3-7.4H6.2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
    </>
  ),
  location: (
    <>
      <path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0Z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  phone: (
    <path d="M22 16.9v2.1a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h2.1a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L7.6 9.7a16 16 0 0 0 6 6l1-1a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z" />
  ),
  star: (
    <polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.6 5.8 21 7 14.1 2 9.3 8.9 8.6" />
  ),
  // --- product categories ---
  life: (
    <path d="M19.5 4.5a5.2 5.2 0 0 0-7.5.4 5.2 5.2 0 0 0-7.5-.4 5.4 5.4 0 0 0 0 7.6L12 19.6l7.5-7.5a5.4 5.4 0 0 0 0-7.6Z" />
  ),
  health: (
    <>
      <path d="M3 12h3l2-5 4 10 2.5-7 1.5 2H21" />
    </>
  ),
  motor: (
    <>
      <path d="M5 16V11l1.8-4.2A2 2 0 0 1 8.6 5.6h6.8a2 2 0 0 1 1.8 1.2L19 11v5" />
      <path d="M3 16h18" />
      <circle cx="7.5" cy="16.5" r="1.8" />
      <circle cx="16.5" cy="16.5" r="1.8" />
    </>
  ),
  travel: (
    <path d="M2 16l8-2 4.5-8a1.5 1.5 0 0 1 2.7 1.2L15 13l5-1.2a1.2 1.2 0 0 1 .9 2.2L4 21l-1-4 3-1" />
  ),
  accident: (
    <>
      <path d="M12 2v6l-3 4h6l-3 4v6" />
    </>
  ),
  home: (
    <>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
      <rect x="10" y="14" width="4" height="6" />
    </>
  ),
  cancer: (
    <path d="M12 14c-2 3-6 2.5-6-.5S9 9 12 14c3-5 6-3.5 6-.5S14 17 12 14Zm0 0-3.5 7M12 14l3.5 7" />
  ),
  savings: (
    <>
      <path d="M3 12a6 6 0 0 1 6-6h5a6 6 0 0 1 6 6 5 5 0 0 1-3 4.6V20h-3v-2H9v2H6v-3.4A6 6 0 0 1 3 12Z" />
      <circle cx="16.5" cy="10.5" r="0.9" />
      <path d="M9 6c0-1.7 1.3-3 3-3" />
    </>
  ),
  // --- services ---
  cartPlus: (
    <>
      <circle cx="9" cy="21" r="1.6" />
      <circle cx="18" cy="21" r="1.6" />
      <path d="M2.5 3h2.2l2.3 12.4a2 2 0 0 0 2 1.6h8.6" />
      <line x1="15" y1="6" x2="21" y2="6" />
      <line x1="18" y1="3" x2="18" y2="9" />
    </>
  ),
  claim: (
    <>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <polyline points="9 14 11 16 15 11" />
    </>
  ),
  renew: (
    <>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <polyline points="21 3 21 8 16 8" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <polyline points="3 21 3 16 8 16" />
    </>
  ),
  changePlan: (
    <>
      <polyline points="17 2 21 6 17 10" />
      <path d="M3 6h18" />
      <polyline points="7 22 3 18 7 14" />
      <path d="M21 18H3" />
    </>
  ),
  agent: (
    <>
      <path d="M4 18a8 8 0 0 1 16 0" />
      <circle cx="12" cy="8" r="4" />
      <path d="M9 21h6" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  status: (
    <>
      <path d="M3 12h4l2 5 4-12 2 9 1.5-2H21" />
    </>
  ),
  pay: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <line x1="2" y1="10" x2="22" y2="10" />
      <line x1="6" y1="15" x2="10" y2="15" />
    </>
  ),
  hospital: (
    <>
      <path d="M4 21V7l8-4 8 4v14" />
      <path d="M9 21v-5h6v5" />
      <line x1="12" y1="7" x2="12" y2="13" />
      <line x1="9" y1="10" x2="15" y2="10" />
    </>
  ),
  points: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5l1.4 2.9 3.1.5-2.3 2.2.6 3.1L12 14.7 9.2 16.2l.6-3.1-2.3-2.2 3.1-.5Z" />
    </>
  ),
  calculator: (
    <>
      <rect x="5" y="2" width="14" height="20" rx="2.5" />
      <line x1="8" y1="6" x2="16" y2="6" />
      <line x1="8" y1="10" x2="8.01" y2="10" />
      <line x1="12" y1="10" x2="12.01" y2="10" />
      <line x1="16" y1="10" x2="16.01" y2="10" />
      <line x1="8" y1="14" x2="8.01" y2="14" />
      <line x1="12" y1="14" x2="12.01" y2="14" />
      <line x1="16" y1="14" x2="16" y2="18" />
      <line x1="8" y1="18" x2="12" y2="18" />
    </>
  ),
  shield: (
    <>
      <path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5Z" />
      <polyline points="9 12 11 14 15 10" />
    </>
  ),
  document: (
    <>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="16" x2="13" y2="16" />
    </>
  ),
  contact: (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
      <line x1="8" y1="9" x2="16" y2="9" />
      <line x1="8" y1="13" x2="13" y2="13" />
    </>
  ),
  // --- social ---
  facebook: (
    <path d="M14 8.5h2.5V5H14a3.5 3.5 0 0 0-3.5 3.5V11H8v3.5h2.5V22H14v-7.5h2.5L17 11h-3V8.7c0-.6.4-.2 0-.2Z" />
  ),
  line: (
    <>
      <rect x="3" y="4" width="18" height="14" rx="5" />
      <path d="M8 16l-1 3 4-3" />
      <line x1="7.5" y1="9" x2="7.5" y2="13" />
      <path d="M10.5 13V9l2.5 4V9" />
      <line x1="15.5" y1="9" x2="15.5" y2="13" />
    </>
  ),
  youtube: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="3.5" />
      <polygon points="10 9.5 15 12 10 14.5" />
    </>
  ),
  instagram: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17" cy="7" r="0.9" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
  /** decorative icons get aria-hidden; pass a label for meaningful ones (REQ-16.2) */
  label?: string;
}

export function Icon({ name, size = 24, label, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
