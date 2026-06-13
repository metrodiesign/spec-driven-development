import type { ReactNode } from "react";

interface SectionHeadingProps {
  eyebrow?: string;
  title: string;
  description?: string;
  /** light text on dark (พื้นกรมท่า) sections */
  invert?: boolean;
  action?: ReactNode;
  className?: string;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  invert = false,
  action,
  className = "",
}: SectionHeadingProps) {
  return (
    <div
      className={`mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between ${className}`}
    >
      <div className="max-w-2xl">
        {eyebrow && (
          <p
            className={`mb-2 text-caption font-semibold uppercase tracking-wide ${
              invert ? "text-accent" : "text-accent-dark"
            }`}
          >
            {eyebrow}
          </p>
        )}
        <h2 className={invert ? "text-surface" : "text-text"}>{title}</h2>
        {description && (
          <p
            className={`mt-3 text-body ${
              invert ? "text-surface/80" : "text-text-muted"
            }`}
          >
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
