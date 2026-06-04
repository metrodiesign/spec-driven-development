import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";

type Variant = "primary" | "accent" | "outline" | "ghost";
type Size = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

// state ครบ default/hover/focus(ring)/active/disabled — REQ-17.3
const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-surface hover:bg-primary-light active:bg-primary-dark",
  accent:
    "bg-accent text-primary-dark hover:bg-accent-dark active:bg-accent-dark",
  outline:
    "border border-border bg-surface text-text hover:border-primary hover:text-primary active:bg-bg",
  ghost: "text-primary hover:bg-primary/5 active:bg-primary/10",
};

// exported for regression test (token `13` backs `h-13` — see tailwind.config.ts)
export const SIZES: Record<Size, string> = {
  sm: "h-9 px-3 text-caption",
  md: "h-11 px-5 text-body",
  lg: "h-13 px-7 text-body",
};

interface CommonProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}

type ButtonAsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
    as?: "button";
  };

type ButtonAsLink = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children"> & {
    as: "a";
    href: string;
  };

type ButtonProps = ButtonAsButton | ButtonAsLink;

export function Button(props: ButtonProps) {
  const {
    variant = "primary",
    size = "md",
    className = "",
    children,
    ...rest
  } = props;
  const cls = `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`;

  if (props.as === "a") {
    const { as: _as, ...anchorRest } = rest as ButtonAsLink;
    return (
      <a className={cls} {...anchorRest}>
        {children}
      </a>
    );
  }
  const { as: _as, ...buttonRest } = rest as ButtonAsButton;
  return (
    <button className={cls} {...buttonRest}>
      {children}
    </button>
  );
}
