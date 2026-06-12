"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/app/components/ui/Badge";
import { Card } from "@/app/components/ui/Card";
import { Container } from "@/app/components/ui/Container";
import { Icon } from "@/app/components/ui/Icon";
import { SectionHeading } from "@/app/components/ui/SectionHeading";
import { SmartImage } from "@/app/components/ui/SmartImage";
import { INSURANCE_TYPES } from "@/app/data/insuranceTypes";
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  INSURANCE_CATEGORIES,
  type InsuranceCategory,
} from "@/app/data/types";

type Filter = InsuranceCategory | "all";

// กริดประเภทประกัน + search + category filter (AND) + empty state — REQ-5.1..5.6
export function InsuranceTypes() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Filter>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return INSURANCE_TYPES.filter((t) => {
      const categoryMatch = category === "all" || t.category === category;
      const textMatch =
        q === "" ||
        t.name.toLowerCase().includes(q) ||
        t.tagline.toLowerCase().includes(q) ||
        CATEGORY_LABELS[t.category].toLowerCase().includes(q);
      return categoryMatch && textMatch; // AND (REQ-5.6)
    });
  }, [query, category]);

  return (
    <section
      id="insurance-types"
      aria-labelledby="types-heading"
      className="bg-bg pb-14 lg:pb-20"
    >
      <Container>
        <SectionHeading
          eyebrow="ผลิตภัณฑ์ประกันภัย"
          title="เลือกความคุ้มครองที่ใช่สำหรับคุณ"
          description="ครบทุกประเภทประกัน พร้อมแผนที่ปรับให้เหมาะกับทุกไลฟ์สไตล์"
        />

        {/* search + filter (REQ-5.2) */}
        <div className="mb-8 flex flex-col gap-4">
          <div className="relative max-w-md">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
              <Icon name="search" size={18} />
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="ค้นหาประเภทประกัน"
              placeholder="ค้นหาประเภทประกัน เช่น สุขภาพ, รถยนต์"
              className="h-11 w-full rounded-md border border-border bg-surface pl-10 pr-4 text-body text-text shadow-card transition-colors placeholder:text-text-muted focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>

          <div
            role="group"
            aria-label="กรองตามหมวด"
            className="flex flex-wrap gap-2"
          >
            {(["all", ...INSURANCE_CATEGORIES] as Filter[]).map((c) => {
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
        </div>

        {filtered.length > 0 ? (
          <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {filtered.map((t) => (
              <li key={t.id}>
                <Card interactive>
                  <div className="relative aspect-[3/2] w-full bg-bg">
                    <SmartImage
                      src={t.imageUrl}
                      alt={t.name}
                      fill
                      sizes="(max-width:640px) 100vw, (max-width:1024px) 50vw, 25vw"
                      className="object-cover"
                      fallbackIcon={CATEGORY_ICONS[t.category]}
                    />
                  </div>
                  <div className="flex flex-1 flex-col gap-2 p-5">
                    <span className="self-start">
                      <Badge tone="accent">{CATEGORY_LABELS[t.category]}</Badge>
                    </span>
                    <h3 className="text-h3 text-text">{t.name}</h3>
                    <p className="flex-1 text-caption text-text-muted">
                      {t.tagline}
                    </p>
                    <a
                      href={t.planHref}
                      className="mt-1 inline-flex items-center gap-1.5 text-body font-semibold text-primary transition-colors hover:text-primary-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      ดูแผนประกัน
                      <Icon name="arrowRight" size={17} />
                    </a>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          // empty state สื่อความหมาย — REQ-5.5
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface px-6 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/8 text-primary">
              <Icon name="search" size={28} />
            </span>
            <p className="text-h3 text-text">ไม่พบประเภทประกันที่ค้นหา</p>
            <p className="max-w-sm text-caption text-text-muted">
              ลองปรับคำค้นหรือเลือกหมวดอื่น เรามีแผนประกันหลากหลายให้เลือก
            </p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setCategory("all");
              }}
              className="mt-1 inline-flex items-center gap-1.5 text-body font-semibold text-primary transition-colors hover:text-primary-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              ล้างตัวกรองทั้งหมด
            </button>
          </div>
        )}
      </Container>
    </section>
  );
}
