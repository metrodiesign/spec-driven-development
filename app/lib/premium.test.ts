import { describe, expect, it } from "vitest";
import {
  AGE_FACTORS,
  BASE_RATES,
  ageFactor,
  calcPremium,
  type PremiumInput,
} from "@/app/lib/premium";

describe("calcPremium", () => {
  // acceptance #4 — REQ-8.3
  it("life / age 30 / sum 1,000,000 -> 8,000", () => {
    expect(
      calcPremium({ category: "life", age: 30, sumAssured: 1_000_000 }),
    ).toBe(8000);
  });

  // ตรงสูตร base x (sum/1000) x factor — REQ-8.3
  it.each<[PremiumInput, number]>([
    [{ category: "health", age: 45, sumAssured: 500_000 }, 9000], // 12 x 500 x 1.5
    [{ category: "motor", age: 25, sumAssured: 300_000 }, 5400], // 18 x 300 x 1.0
    [{ category: "travel", age: 35, sumAssured: 250_000 }, 900], // 3 x 250 x 1.2
    [{ category: "accident", age: 65, sumAssured: 1_000_000 }, 14000], // 5 x 1000 x 2.8
    [{ category: "savings", age: 80, sumAssured: 2_000_000 }, 70000], // 10 x 2000 x 3.5
  ])("%o -> %i", (input, expected) => {
    expect(calcPremium(input)).toBe(expected);
  });

  // ปัดเศษเป็นจำนวนเต็มบาท — REQ-8.9
  it("rounds to integer baht", () => {
    // home: 2.5 x 100.5 x 1.0 = 251.25 -> 251
    expect(
      calcPremium({ category: "home", age: 30, sumAssured: 100_500 }),
    ).toBe(251);
  });

  // deterministic — REQ-8.3
  it("is deterministic (same input -> same result)", () => {
    const input: PremiumInput = {
      category: "cancer",
      age: 52,
      sumAssured: 750_000,
    };
    const a = calcPremium(input);
    const b = calcPremium(input);
    expect(a).toBe(b);
    expect(a).toBe(Math.round(6 * 750 * 2.0)); // 9000
  });

  it("every category has a base rate", () => {
    for (const cat of Object.keys(BASE_RATES)) {
      expect(BASE_RATES[cat as keyof typeof BASE_RATES]).toBeGreaterThan(0);
    }
  });
});

describe("ageFactor band edges", () => {
  it.each<[number, number]>([
    [1, 0.8],
    [17, 0.8],
    [18, 1.0],
    [30, 1.0],
    [31, 1.2],
    [40, 1.2],
    [50, 1.5],
    [60, 2.0],
    [70, 2.8],
    [80, 3.5],
  ])("age %i -> factor %f", (age, factor) => {
    expect(ageFactor(age)).toBe(factor);
  });

  it("AGE_FACTORS covers up to max age 80", () => {
    expect(AGE_FACTORS[AGE_FACTORS.length - 1].max).toBe(80);
  });
});
