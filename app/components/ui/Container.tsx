import type { ElementType, ReactNode } from "react";

interface ContainerProps {
  children: ReactNode;
  /** render as a different element (e.g. "section", "header") */
  as?: ElementType;
  className?: string;
}

// max-width ~1280px + padding ซ้าย/ขวาเท่ากันทุก section — REQ-1.2
export function Container({
  children,
  as: Tag = "div",
  className = "",
}: ContainerProps) {
  return (
    <Tag
      className={`mx-auto w-full max-w-container px-4 sm:px-6 lg:px-8 ${className}`}
    >
      {children}
    </Tag>
  );
}
