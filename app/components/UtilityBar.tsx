"use client";

import { useState } from "react";
import { Icon } from "@/app/components/ui/Icon";

type Lang = "TH" | "EN";
type Currency = "THB" | "USD";

// แถบทางลัด/ตั้งค่าด้านบนสุด — REQ-2.1; toggle/search/currency เป็น UI-only (REQ-2.2/2.4/2.5)
export function UtilityBar() {
  const [lang, setLang] = useState<Lang>("TH");
  const [currency, setCurrency] = useState<Currency>("THB");

  return (
    <div className="border-b-2 border-accent bg-primary text-surface">
      <div className="mx-auto flex h-10 w-full max-w-container items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        {/* ซ้าย: ช่องทาง + กรมธรรม์ของฉัน */}
        <div className="flex items-center gap-4 text-caption">
          <span className="hidden items-center gap-1.5 sm:flex">
            <Icon name="globe" size={15} />
            วิริยะประกันภัย
          </span>
          <a
            href="#services"
            className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 transition-colors hover:text-accent"
          >
            <Icon name="shield" size={15} />
            กรมธรรม์ของฉัน
          </a>
        </div>

        {/* ขวา: search + lang + currency + login */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* search UI-only (REQ-2.4) */}
          <form
            role="search"
            onSubmit={(e) => e.preventDefault()}
            className="hidden items-center rounded-sm bg-surface/10 px-2 md:flex"
          >
            <Icon name="search" size={15} />
            <input
              type="search"
              aria-label="ค้นหา (ทั่วเว็บไซต์)"
              placeholder="ค้นหา..."
              className="w-28 bg-transparent px-2 py-1 text-caption text-surface placeholder:text-surface/60 focus-visible:outline-none lg:w-40"
            />
          </form>

          {/* lang toggle UI-only (REQ-2.2) */}
          <div
            role="group"
            aria-label="เลือกภาษา"
            className="flex items-center rounded-sm bg-surface/10 p-0.5 text-caption"
          >
            {(["TH", "EN"] as Lang[]).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={lang === l}
                onClick={() => setLang(l)}
                className={`rounded-[4px] px-2 py-0.5 transition-colors ${
                  lang === l
                    ? "bg-accent text-primary-dark"
                    : "text-surface/80 hover:text-surface"
                }`}
              >
                {l}
              </button>
            ))}
          </div>

          {/* currency UI-only (REQ-2.5) */}
          <label className="hidden items-center gap-1 text-caption sm:flex">
            <span className="sr-only">สกุลเงิน</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
              className="cursor-pointer rounded-sm bg-surface/10 px-1.5 py-1 text-caption text-surface focus-visible:outline-none [&>option]:text-text"
            >
              <option value="THB">THB ฿</option>
              <option value="USD">USD $</option>
            </select>
          </label>

          <a
            href="#calculator"
            className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-caption transition-colors hover:text-accent"
          >
            <Icon name="user" size={15} />
            <span className="hidden sm:inline">เข้าสู่ระบบ / สมัครสมาชิก</span>
            <span className="sm:hidden">เข้าสู่ระบบ</span>
          </a>

          <a
            href="#promotions"
            aria-label="ตะกร้าของฉัน"
            className="rounded-sm p-1 transition-colors hover:text-accent"
          >
            <Icon name="cart" size={17} />
          </a>
        </div>
      </div>
    </div>
  );
}
