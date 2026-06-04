import { describe, expect, it } from "vitest";
import { formatTHB } from "@/app/lib/format";

describe("formatTHB", () => {
  it.each<[number, string]>([
    [8000, "8,000"],
    [12500, "12,500"],
    [900, "900"],
    [70000, "70,000"],
    [1000000, "1,000,000"],
    [0, "0"],
  ])("%i -> %s", (n, expected) => {
    expect(formatTHB(n)).toBe(expected);
  });

  it("rounds to integer baht", () => {
    expect(formatTHB(251.25)).toBe("251");
    expect(formatTHB(8000.6)).toBe("8,001");
  });
});
