import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  /** interactive cards get hover lift + focus ring */
  interactive?: boolean;
  className?: string;
}

// การ์ดมาตรฐาน: รัศมี/เงา/transition สอดคล้องทั้งหน้า — REQ-17.3, 14.5
export function Card({
  children,
  interactive = false,
  className = "",
}: CardProps) {
  const interactiveCls = interactive
    ? "transition-all duration-200 hover:-translate-y-1 hover:shadow-cardHover focus-within:-translate-y-1 focus-within:shadow-cardHover"
    : "";
  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-card ${interactiveCls} ${className}`}
    >
      {children}
    </div>
  );
}
