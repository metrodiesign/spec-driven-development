import { INSURANCE_CATEGORIES, type InsuranceCategory } from "@/app/data/types";
import { RANGES, type PremiumInput } from "@/app/lib/premium";

export interface RawInput {
  category: string;
  age: string;
  sumAssured: string;
}

export type FieldErrors = Partial<
  Record<"category" | "age" | "sumAssured", string>
>;

export type ValidationResult =
  | { ok: true; input: PremiumInput }
  | { ok: false; errors: FieldErrors };

const MSG = {
  category: {
    empty: "กรุณาเลือกประเภทประกัน",
    invalid: "ประเภทประกันไม่ถูกต้อง",
  },
  age: {
    empty: "กรุณากรอกอายุ",
    nan: "อายุต้องเป็นตัวเลข",
    range: "อายุต้องอยู่ระหว่าง 1-80 ปี",
  },
  sumAssured: {
    empty: "กรุณากรอกทุนประกัน",
    nan: "ทุนประกันต้องเป็นตัวเลข",
    range: "ทุนประกันต้องอยู่ระหว่าง 100,000-50,000,000 บาท",
  },
} as const;

function isCategory(v: string): v is InsuranceCategory {
  return (INSURANCE_CATEGORIES as string[]).includes(v);
}

/** parse ตัวเลข: ตัด comma/ช่องว่าง -> number | null (null = ว่าง) | NaN (ไม่ใช่ตัวเลข) */
function parseNumeric(raw: string): number | null {
  const clean = raw.replace(/,/g, "").trim();
  if (clean === "") return null;
  return Number(clean);
}

/**
 * validate ทุกช่อง "พร้อมกัน" (ไม่หยุดที่ช่องแรก) — REQ-8.4-8.7.
 * ลำดับเช็คต่อช่อง: ว่าง -> NaN -> นอกช่วง/<=0.
 */
export function parseAndValidate(raw: RawInput): ValidationResult {
  const errors: FieldErrors = {};

  // --- category ---
  const category = raw.category.trim();
  if (category === "") {
    errors.category = MSG.category.empty;
  } else if (!isCategory(category)) {
    errors.category = MSG.category.invalid;
  }

  // --- age ---
  const age = parseNumeric(raw.age);
  if (age === null) {
    errors.age = MSG.age.empty;
  } else if (Number.isNaN(age)) {
    errors.age = MSG.age.nan;
  } else if (age < RANGES.age.min || age > RANGES.age.max) {
    errors.age = MSG.age.range;
  }

  // --- sumAssured ---
  const sumAssured = parseNumeric(raw.sumAssured);
  if (sumAssured === null) {
    errors.sumAssured = MSG.sumAssured.empty;
  } else if (Number.isNaN(sumAssured)) {
    errors.sumAssured = MSG.sumAssured.nan;
  } else if (
    sumAssured < RANGES.sumAssured.min ||
    sumAssured > RANGES.sumAssured.max
  ) {
    errors.sumAssured = MSG.sumAssured.range;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    input: {
      category: category as InsuranceCategory,
      age: age as number,
      sumAssured: sumAssured as number,
    },
  };
}
