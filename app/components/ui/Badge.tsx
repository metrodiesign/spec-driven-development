import type { ReactNode } from "react";

type Tone = "primary" | "accent" | "neutral";

const TONES: Record<Tone, string> = {
  primary: "bg-primary-dark text-surface shadow-card",
  accent: "bg-accent text-primary-dark shadow-card",
  neutral: "bg-bg text-text-muted",
};

interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}

export function Badge({
  children,
  tone = "primary",
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-sm px-2.5 py-1 text-caption font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
