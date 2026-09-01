import { useId } from 'react';

type OrbitMarkProps = {
  size?: number;
};

/**
 * The brand mark shared by the nav and the footer — a simplified take on
 * Konstelasi's own ringed-planet logo (fitting, since "Konstelasi" is
 * Indonesian for "constellation"), in their icon gradient. One definition
 * so both call sites stay pixel-identical instead of drifting apart.
 *
 * `useId()` keeps the gradient id collision-free when both instances are
 * on the page at once — duplicate SVG ids are invalid markup even though
 * most browsers render them tolerably.
 */
export default function OrbitMark({ size = 20 }: OrbitMarkProps) {
  const gradientId = `orbit-mark-${useId()}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand-a)" />
          <stop offset="1" stopColor="var(--brand-b)" />
        </linearGradient>
      </defs>
      <ellipse
        cx="12"
        cy="12"
        rx="11"
        ry="4"
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.6"
        transform="rotate(-20 12 12)"
      />
      <circle cx="12" cy="12" r="6.5" fill={`url(#${gradientId})`} />
    </svg>
  );
}
