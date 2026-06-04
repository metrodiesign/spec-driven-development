import { describe, expect, it } from "vitest";
import config from "@/tailwind.config";
import { SIZES } from "@/app/components/ui/Button";

// Regression: bugfix-lg-button — `h-13` (Button size="lg") ต้องมี token รองรับ
// มิฉะนั้น utility ไม่ emit CSS -> ปุ่ม lg ยุบความสูง.

const extend = config.theme?.extend as Record<string, any>;

describe("bug fixed — h-13 token exists (B1.1, B1.2)", () => {
  it("theme.extend.spacing['13'] = '3.25rem' (52px)", () => {
    expect(extend.spacing?.["13"]).toBe("3.25rem");
  });

  it("SIZES.lg ยังอ้าง h-13 (token + class จับคู่กัน)", () => {
    expect(SIZES.lg).toContain("h-13");
  });
});

describe("SHALL CONTINUE — sizes/behavior ไม่เปลี่ยน", () => {
  it("sm คง h-9 px-3 text-caption (B2.1)", () => {
    expect(SIZES.sm).toBe("h-9 px-3 text-caption");
  });

  it("md คง h-11 px-5 text-body (B2.2)", () => {
    expect(SIZES.md).toBe("h-11 px-5 text-body");
  });

  it("lg คง px-7 text-body (B2.3 — แก้เฉพาะ height token)", () => {
    expect(SIZES.lg).toContain("px-7");
    expect(SIZES.lg).toContain("text-body");
  });

  it("brand hex ไม่เปลี่ยน (B2.6)", () => {
    expect(extend.colors?.primary?.DEFAULT).toBe("#13266B");
    expect(extend.colors?.accent?.DEFAULT).toBe("#FDB913");
  });
});
