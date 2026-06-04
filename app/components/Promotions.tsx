"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/app/components/ui/Badge";
import { Card } from "@/app/components/ui/Card";
import { Container } from "@/app/components/ui/Container";
import { Icon } from "@/app/components/ui/Icon";
import { SectionHeading } from "@/app/components/ui/SectionHeading";
import { SmartImage } from "@/app/components/ui/SmartImage";
import { formatTHB } from "@/app/lib/format";
import { PROMOTIONS } from "@/app/data/promotions";
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  INSURANCE_CATEGORIES,
  type InsuranceCategory,
} from "@/app/data/types";

type Filter = InsuranceCategory | "all";

const TH_MONTHS = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

function formatThaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

// หมวดที่มีโปรจริง (ไม่โชว์ชิปว่าง)
const PROMO_CATEGORIES = INSURANCE_CATEGORIES.filter((c) =>
  PROMOTIONS.some((p) => p.category === c),
);

// กริดโปรโมชั่น >= 8 + type filter + ราคาเดิมขีดฆ่า — REQ-7.1..7.4
export function Promotions() {
  const [category, setCategory] = useState<Filter>("all");

  const filtered = useMemo(
    () =>
      category === "all"
        ? PROMOTIONS
        : PROMOTIONS.filter((p) => p.category === category),
    [category],
  );

  return (
    <section
      id="promotions"
      aria-labelledby="promo-heading"
      className="bg-surface pb-14 lg:pb-20"
    >
      <Container>
        <SectionHeading
          eyebrow="โปรโมชั่นแนะนำ"
          title="ดีลประกันสุดคุ้มประจำเดือนนี้"
          description="รวมแผนประกันราคาพิเศษ พร้อมส่วนลดที่คัดมาให้แล้ว"
          action={
            // currency UI-only เหนือกริด — REQ-7.2 (ราคายังคงเป็น THB)
            <label className="flex items-center gap-2 text-caption text-text-muted">
              สกุลเงิน:
              <select
                aria-label="สกุลเงินที่แสดง (ราคายังคงเป็น THB)"
                className="cursor-pointer rounded-md border border-border bg-surface px-2 py-1.5 text-caption text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                defaultValue="THB"
              >
                <option value="THB">THB (฿)</option>
                <option value="USD">USD ($)</option>
              </select>
            </label>
          }
        />

        <div
          role="group"
          aria-label="กรองโปรโมชั่นตามประเภท"
          className="mb-8 flex flex-wrap gap-2"
        >
          {(["all", ...PROMO_CATEGORIES] as Filter[]).map((c) => {
            const active = category === c;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={active}
                onClick={() => setCategory(c)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  active
                    ? "border-primary bg-primary text-surface"
                    : "border-border bg-surface text-text hover:border-primary hover:text-primary"
                }`}
              >
                {c !== "all" && <Icon name={CATEGORY_ICONS[c]} size={15} />}
                {c === "all" ? "ทั้งหมด" : CATEGORY_LABELS[c]}
              </button>
            );
          })}
        </div>

        <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((p) => (
            <li key={p.id}>
              <Card interactive>
                <div className="relative aspect-[3/2] w-full bg-bg">
                  <SmartImage
                    src={p.imageUrl}
                    alt={p.title}
                    fill
                    sizes="(max-width:640px) 100vw, (max-width:1024px) 50vw, 25vw"
                    className="object-cover"
                    fallbackIcon={CATEGORY_ICONS[p.category]}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-3 p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="primary">{CATEGORY_LABELS[p.category]}</Badge>
                    <Badge tone="primary">{p.badge}</Badge>
                  </div>
                  <h3 className="text-h3 text-text">{p.title}</h3>
                  {/* ราคา: ปัจจุบัน accent + เดิมขีดฆ่า (REQ-7.4) */}
                  <div className="flex items-baseline gap-2">
                    <span className="text-h3 font-bold text-accent-dark">
                      ฿{formatTHB(p.priceCurrent)}
                    </span>
                    <span className="text-caption text-text-muted line-through">
                      ฿{formatTHB(p.priceOriginal)}
                    </span>
                  </div>
                  <p className="flex items-center gap-1.5 text-caption text-text-muted">
                    <Icon name="renew" size={14} />
                    หมดเขต {formatThaiDate(p.expiresOn)}
                  </p>
                  <div className="mt-auto flex gap-2 pt-1">
                    <a
                      href={p.detailsHref}
                      className="inline-flex h-10 flex-1 items-center justify-center rounded-md border border-border bg-surface text-caption font-medium text-text transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      รายละเอียด
                    </a>
                    <a
                      href={p.buyHref}
                      className="inline-flex h-10 flex-1 items-center justify-center rounded-md bg-accent text-caption font-semibold text-primary-dark transition-colors hover:bg-accent-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      ซื้อเลย
                    </a>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
