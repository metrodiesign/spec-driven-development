import { describe, expect, it } from "vitest";
import { parseAndValidate } from "@/app/lib/validatePremium";

const valid = { category: "life", age: "30", sumAssured: "1000000" };

describe("parseAndValidate — valid", () => {
  it("returns ok + typed input (REQ-8.2)", () => {
    const r = parseAndValidate(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input).toEqual({
        category: "life",
        age: 30,
        sumAssured: 1_000_000,
      });
    }
  });

  it("accepts sumAssured with comma separators", () => {
    const r = parseAndValidate({ ...valid, sumAssured: "1,000,000" });
    expect(r.ok).toBe(true);
  });
});

describe("parseAndValidate — empty (REQ-8.4)", () => {
  it("flags age AND sumAssured at once", () => {
    const r = parseAndValidate({ category: "life", age: "", sumAssured: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.age).toBeDefined();
      expect(r.errors.sumAssured).toBeDefined();
    }
  });

  it("flags empty category", () => {
    const r = parseAndValidate({ ...valid, category: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.category).toBeDefined();
  });
});

describe("parseAndValidate — NaN (REQ-8.7)", () => {
  it("non-numeric age/sumAssured -> 'ต้องเป็นตัวเลข'", () => {
    const r = parseAndValidate({
      category: "life",
      age: "abc",
      sumAssured: "xyz",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.age).toContain("ตัวเลข");
      expect(r.errors.sumAssured).toContain("ตัวเลข");
    }
  });
});

describe("parseAndValidate — age range (REQ-8.5)", () => {
  it.each(["0", "81", "-5"])("age %s -> range error", (age) => {
    const r = parseAndValidate({ ...valid, age });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.age).toContain("1-80");
  });

  it("boundary ages 1 and 80 are valid", () => {
    expect(parseAndValidate({ ...valid, age: "1" }).ok).toBe(true);
    expect(parseAndValidate({ ...valid, age: "80" }).ok).toBe(true);
  });
});

describe("parseAndValidate — sumAssured range (REQ-8.6)", () => {
  it.each(["0", "99999", "50000001"])("sum %s -> range error", (sumAssured) => {
    const r = parseAndValidate({ ...valid, sumAssured });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.sumAssured).toBeDefined();
  });

  it("boundary sums 100,000 and 50,000,000 are valid", () => {
    expect(parseAndValidate({ ...valid, sumAssured: "100000" }).ok).toBe(true);
    expect(parseAndValidate({ ...valid, sumAssured: "50000000" }).ok).toBe(
      true,
    );
  });
});

describe("parseAndValidate — invalid category", () => {
  it("unknown category -> error", () => {
    const r = parseAndValidate({ ...valid, category: "spaceship" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.category).toBeDefined();
  });
});
