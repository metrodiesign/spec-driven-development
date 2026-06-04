"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/app/components/ui/Button";
import { Container } from "@/app/components/ui/Container";
import { Icon } from "@/app/components/ui/Icon";
import { calcPremium } from "@/app/lib/premium";
import { formatTHB } from "@/app/lib/format";
import {
  parseAndValidate,
  type FieldErrors,
  type RawInput,
} from "@/app/lib/validatePremium";
import {
  CATEGORY_LABELS,
  INSURANCE_CATEGORIES,
  type InsuranceCategory,
} from "@/app/data/types";

const EMPTY: RawInput = { category: "", age: "", sumAssured: "" };

// ฟอร์มคำนวณเบี้ย -> wire เข้า lib (validate + calc) — REQ-8.1..8.9 (ไม่ฝังสูตรใน JSX)
export function PremiumCalculator() {
  const [raw, setRaw] = useState<RawInput>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [premium, setPremium] = useState<number | null>(null);

  function update(field: keyof RawInput, value: string) {
    setRaw((prev) => ({ ...prev, [field]: value }));
    // เคลียร์ error ของช่องที่กำลังแก้ — REQ-8.8
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault(); // on-submit เท่านั้น — REQ-8.2
    const result = parseAndValidate(raw);
    if (!result.ok) {
      setErrors(result.errors);
      setPremium(null);
      return;
    }
    setErrors({});
    setPremium(calcPremium(result.input));
  }

  const fieldBase =
    "h-12 w-full rounded-md border bg-surface px-4 text-body text-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const errBorder = (f: keyof FieldErrors) =>
    errors[f] ? "border-red-500" : "border-border focus-visible:border-primary";

  return (
    <section
      id="calculator"
      aria-labelledby="calc-heading"
      className="bg-bg py-14 lg:py-20"
    >
      <Container>
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card lg:grid lg:grid-cols-[1.1fr_0.9fr]">
          {/* form */}
          <div className="p-6 sm:p-10">
            <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-accent-dark">
              เครื่องคำนวณเบี้ยประกัน
            </p>
            <h2 id="calc-heading" className="text-text">
              ประเมินเบี้ยประกันของคุณ
            </h2>
            <p className="mt-2 text-body text-text-muted">
              กรอกข้อมูลเพื่อดูเบี้ยประกันโดยประมาณ
              ผลลัพธ์เป็นการประเมินเบื้องต้น
            </p>

            <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-5">
              {/* ประเภท */}
              <div>
                <label
                  htmlFor="calc-category"
                  className="mb-1.5 block text-caption font-medium text-text"
                >
                  ประเภทประกัน
                </label>
                <select
                  id="calc-category"
                  value={raw.category}
                  onChange={(e) => update("category", e.target.value)}
                  aria-invalid={!!errors.category}
                  aria-describedby={
                    errors.category ? "err-category" : undefined
                  }
                  className={`${fieldBase} ${errBorder("category")} cursor-pointer`}
                >
                  <option value="">-- เลือกประเภทประกัน --</option>
                  {INSURANCE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
                {errors.category && (
                  <p
                    id="err-category"
                    className="mt-1.5 text-caption text-red-600"
                  >
                    {errors.category}
                  </p>
                )}
              </div>

              {/* อายุ */}
              <div>
                <label
                  htmlFor="calc-age"
                  className="mb-1.5 block text-caption font-medium text-text"
                >
                  อายุ (ปี)
                </label>
                <input
                  id="calc-age"
                  type="text"
                  inputMode="numeric"
                  value={raw.age}
                  onChange={(e) => update("age", e.target.value)}
                  aria-invalid={!!errors.age}
                  aria-describedby={errors.age ? "err-age" : undefined}
                  placeholder="เช่น 30 (รับ 1-80 ปี)"
                  className={`${fieldBase} ${errBorder("age")}`}
                />
                {errors.age && (
                  <p id="err-age" className="mt-1.5 text-caption text-red-600">
                    {errors.age}
                  </p>
                )}
              </div>

              {/* ทุนประกัน */}
              <div>
                <label
                  htmlFor="calc-sum"
                  className="mb-1.5 block text-caption font-medium text-text"
                >
                  ทุนประกัน (บาท)
                </label>
                <input
                  id="calc-sum"
                  type="text"
                  inputMode="numeric"
                  value={raw.sumAssured}
                  onChange={(e) => update("sumAssured", e.target.value)}
                  aria-invalid={!!errors.sumAssured}
                  aria-describedby={errors.sumAssured ? "err-sum" : undefined}
                  placeholder="เช่น 1,000,000 (100,000-50,000,000)"
                  className={`${fieldBase} ${errBorder("sumAssured")}`}
                />
                {errors.sumAssured && (
                  <p id="err-sum" className="mt-1.5 text-caption text-red-600">
                    {errors.sumAssured}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full"
              >
                <Icon name="calculator" size={20} />
                คำนวณเบี้ยประกัน
              </Button>
            </form>
          </div>

          {/* result panel */}
          <div className="flex flex-col justify-center bg-primary p-6 text-surface sm:p-10">
            <p className="text-caption uppercase tracking-wide text-accent">
              เบี้ยประกันโดยประมาณ
            </p>
            {premium !== null ? (
              <div className="animate-fade-in">
                <p className="mt-3 flex items-baseline gap-2">
                  <span className="text-h1 font-bold text-accent">
                    {formatTHB(premium)}
                  </span>
                  <span className="text-h3 text-surface/90">บาท / ปี</span>
                </p>
                <p className="mt-2 text-body text-surface/80">
                  สำหรับ
                  {raw.category &&
                    ` ${CATEGORY_LABELS[raw.category as InsuranceCategory]}`}{" "}
                  อายุ {raw.age} ปี ทุนประกัน ฿
                  {formatTHB(Number(raw.sumAssured.replace(/,/g, "")))}
                </p>
                <div className="mt-6 flex items-start gap-2 rounded-lg bg-surface/10 p-4 text-caption text-surface/80">
                  <Icon
                    name="shield"
                    size={18}
                    className="mt-0.5 shrink-0 text-accent"
                  />
                  เบี้ยนี้เป็นการประเมินเบื้องต้น
                  เบี้ยจริงขึ้นกับเงื่อนไขการพิจารณารับประกัน
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <p className="flex items-baseline gap-2">
                  <span className="text-h1 font-bold text-surface/40">— —</span>
                  <span className="text-h3 text-surface/60">บาท / ปี</span>
                </p>
                <p className="mt-2 max-w-xs text-body text-surface/70">
                  กรอกข้อมูลด้านซ้ายแล้วกด &ldquo;คำนวณเบี้ยประกัน&rdquo;
                  เพื่อดูผลลัพธ์
                </p>
                <ul className="mt-6 space-y-2.5 text-caption text-surface/80">
                  {[
                    "คำนวณได้ทันที ไม่ต้องลงทะเบียน",
                    "ครบทุกประเภทประกัน",
                    "ผลลัพธ์เป็นค่าประเมินเบื้องต้น",
                  ].map((t) => (
                    <li key={t} className="flex items-center gap-2">
                      <Icon name="check" size={16} className="text-accent" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </Container>
    </section>
  );
}
