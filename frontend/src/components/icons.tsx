/**
 * Line icons, drawn on a 24-unit grid with a 1.5 stroke so they sit with the
 * console's hairlines. Inline SVG, `currentColor`: an icon takes the colour of
 * the text it labels, and there is no icon font to load in the field.
 */

import type { ReactNode, SVGProps } from "react";

function Icon({ children, size = 20, ...rest }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

type P = { size?: number; className?: string };

/** Operations: a sensing volume with a reticle. */
export const IconOps = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" />
  </Icon>
);

/** Subjects: tracked individuals. */
export const IconSubjects = (p: P) => (
  <Icon {...p}>
    <path d="M12 3l6 6-6 6-6-6z" />
    <path d="M4 21h16" />
    <path d="M12 15v6" />
  </Icon>
);

/** Vitals: a respiration trace. */
export const IconVitals = (p: P) => (
  <Icon {...p}>
    <path d="M1.5 12h4l2-5 3.5 11 3-9 2 3h6.5" />
  </Icon>
);

/** RF: an antenna radiating. */
export const IconRF = (p: P) => (
  <Icon {...p}>
    <path d="M12 11v11M9 22h6" />
    <circle cx="12" cy="9" r="1.5" />
    <path d="M8.2 5.2a5.4 5.4 0 000 7.6M15.8 5.2a5.4 5.4 0 010 7.6" />
    <path d="M5.4 2.4a9.4 9.4 0 000 13.2M18.6 2.4a9.4 9.4 0 010 13.2" />
  </Icon>
);

/** Session log: a ruled record. */
export const IconLog = (p: P) => (
  <Icon {...p}>
    <path d="M4 3h16v18H4z" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </Icon>
);

/** System: a configuration stack. */
export const IconSystem = (p: P) => (
  <Icon {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
    <path d="M8 4v4M16 10v4M11 16v4" />
  </Icon>
);

export const IconLock = (p: P) => (
  <Icon {...p}>
    <path d="M5 11h14v10H5z" />
    <path d="M8 11V7.5a4 4 0 018 0V11" />
    <path d="M12 15v2" />
  </Icon>
);

export const IconFullscreen = (p: P) => (
  <Icon {...p}>
    <path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6" />
  </Icon>
);

export const IconBackspace = (p: P) => (
  <Icon {...p}>
    <path d="M8 5h13v14H8l-6-7z" />
    <path d="M11.5 9.5l5 5M16.5 9.5l-5 5" />
  </Icon>
);

/**
 * The SENTINEL mark: a watch-eye inside a shield chevron. Two strokes and a
 * pupil — it has to survive being drawn at 22px in a header.
 */
export function Emblem({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden className={className}>
      <path d="M20 2.5L36 9v11.5C36 29.6 29 35.6 20 38 11 35.6 4 29.6 4 20.5V9z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 20.5s4.2-6.5 11-6.5 11 6.5 11 6.5-4.2 6.5-11 6.5S9 20.5 9 20.5z" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="20" cy="20.5" r="3" fill="currentColor" />
      <path d="M20 6v4M20 31v3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
