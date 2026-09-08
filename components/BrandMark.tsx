type BrandMarkProps = {
  size?: number;
  className?: string;
};

/**
 * The StarDust brand mark. Renders `app/icon.svg` via `<img>`, which
 * Next.js serves at `/icon.svg`. Using `<img>` keeps each instance in
 * its own SVG document scope, so the gradient IDs inside `icon.svg`
 * never collide when the mark appears more than once on a page.
 */
export default function BrandMark({ size = 20, className }: BrandMarkProps) {
  return (
    <img
      src="/icon.svg"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    />
  );
}
