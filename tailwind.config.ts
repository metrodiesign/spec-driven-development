import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./app/components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // LOCKED brand palette — REQ-17.1 (single source of truth)
        primary: {
          DEFAULT: "#13266B",
          dark: "#0E1C50",
          light: "#24398A",
        },
        accent: {
          DEFAULT: "#FDB913",
          dark: "#E0A500",
        },
        bg: "#F5F7FB",
        surface: "#FFFFFF",
        text: {
          DEFAULT: "#1A2238",
          muted: "#5B6479",
        },
        border: "#E2E6EF",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      fontSize: {
        // typographic scale — REQ-15.4 (size / line-height)
        h1: ["3rem", { lineHeight: "1.2", fontWeight: "700" }],
        h2: ["2rem", { lineHeight: "1.25", fontWeight: "700" }],
        h3: ["1.25rem", { lineHeight: "1.3", fontWeight: "600" }],
        body: ["1rem", { lineHeight: "1.6", fontWeight: "400" }],
        caption: ["0.875rem", { lineHeight: "1.5", fontWeight: "400" }],
      },
      spacing: {
        // fills the gap in Tailwind's default scale (h-12=3rem -> h-14=3.5rem);
        // backs `h-13` used by Button size="lg" (52px, keeps 36/44/52 progression)
        "13": "3.25rem",
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "16px",
        xl: "24px",
      },
      boxShadow: {
        card: "0 1px 3px rgba(19, 38, 107, 0.08), 0 1px 2px rgba(19, 38, 107, 0.06)",
        cardHover:
          "0 10px 25px rgba(19, 38, 107, 0.12), 0 4px 10px rgba(19, 38, 107, 0.08)",
        banner: "0 20px 50px rgba(14, 28, 80, 0.35)",
      },
      maxWidth: {
        container: "1440px",
      },
      transitionDuration: {
        DEFAULT: "200ms",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "fade-in": "fade-in 250ms ease-out both",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
