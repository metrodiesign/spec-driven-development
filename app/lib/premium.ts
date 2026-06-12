import type { InsuranceCategory } from "@/app/data/types";

export interface PremiumInput {
  category: InsuranceCategory;
  age: number; // จำนวนเต็มปี
  sumAssured: number; // บาท
}

// เบี้ยต่อทุน 1,000 บาท ต่อปี (THB), แยกตามประเภท — LOCKED (REQ-8.3)
export const BASE_RATES: Record<InsuranceCategory, number> = {
  life: 8.0,
  health: 12.0,
  motor: 18.0,
  travel: 3.0,
  accident: 5.0,
  home: 2.5,
  cancer: 6.0,
  savings: 10.0,
};

// ตัวคูณตามช่วงอายุ (อายุมาก = เสี่ยงมาก = เบี้ยสูง) — LOCKED
export const AGE_FACTORS: { max: number; factor: number }[] = [
  { max: 17, factor: 0.8 },
  { max: 30, factor: 1.0 },
  { max: 40, factor: 1.2 },
  { max: 50, factor: 1.5 },
  { max: 60, factor: 2.0 },
  { max: 70, factor: 2.8 },
  { max: 80, factor: 3.5 },
];

export const RANGES = {
  age: { min: 1, max: 80 },
  sumAssured: { min: 100_000, max: 50_000_000 },
} as const;

export function ageFactor(age: number): number {
  // age รับประกันว่า <= 80 หลัง validate
  return AGE_FACTORS.find((b) => age <= b.max)!.factor;
}

/**
 * สูตร: premium = base_rate[type] x (sumAssured / 1000) x ageFactor(age)
 * ปัดเป็นจำนวนเต็มบาท. deterministic ล้วน (input เดียวกัน -> ผลเดียวกันเสมอ).
 * ตัวอย่าง (acceptance #4): life, age 30, sum 1,000,000
 *   = 8.0 x (1_000_000/1000) x 1.0 = 8,000 บาท/ปี
 */
export function calcPremium(input: PremiumInput): number {
  const rate = BASE_RATES[input.category];
  const perThousand = input.sumAssured / 1000;
  return Math.round(rate * perThousand * ageFactor(input.age));
}
