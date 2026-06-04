"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Swiper, SwiperSlide } from "swiper/react";
import type { Swiper as SwiperClass } from "swiper/types";
import { A11y, Autoplay, EffectFade, Keyboard } from "swiper/modules";
import "swiper/css";
import "swiper/css/effect-fade";
import { Icon } from "@/app/components/ui/Icon";
import { SmartImage } from "@/app/components/ui/SmartImage";
import { HERO_CAMPAIGNS } from "@/app/data/heroCampaigns";

// hero campaign slider — Swiper.js (engine เดียวกับต้นฉบับ bangkokhospital.com):
//   effect fade + crossFade:false (พื้นทึบเสมอ ไม่กระพริบ), speed 300, autoplay 3s วิ่งต่อหลังคลิก,
//   ไม่หยุดตอน hover, touch/mouse swipe. แต่ละสไลด์ = รูป banner เดียว (text/CTA ฝังในรูป) คลิกทั้งใบ.
// custom arrows (ซ่อน-โผล่ตอน hover) + custom dots (responsive) คุมเอง; Swiper จัดการ slide/fade/swipe/autoplay.
// a11y: autoplay ปิดเมื่อ prefers-reduced-motion (gate ใน JS); transition reduced ครอบโดย globals.css.
const AUTOPLAY_MS = 3000; // = Swiper autoplay.delay ต้นฉบับ
const SPEED_MS = 300; // = Swiper speed ต้นฉบับ

export function HeroCampaignSlider({ className = "" }: { className?: string }) {
  const swiperRef = useRef<SwiperClass | null>(null);
  const [index, setIndex] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  // ตรวจ prefers-reduced-motion (live) — gate autoplay
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // คุม autoplay แบบ imperative — Swiper ไม่ stop เองเมื่อ prop เปลี่ยน (REQ a11y reduced-motion)
  useEffect(() => {
    const ap = swiperRef.current?.autoplay;
    if (!ap) return;
    if (reduceMotion) ap.stop();
    else ap.start();
  }, [reduceMotion]);

  const navBtn =
    "absolute top-1/2 z-30 hidden h-16 w-12 -translate-y-1/2 items-center justify-center rounded-md bg-border/80 text-text-muted backdrop-blur transition hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:flex lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100";
  // slides ไม่ขึ้นกับ index -> memoize ให้ setIndex (ตอนเปลี่ยนสไลด์) re-render เฉพาะ dots
  // ไม่แตะ 6 next/image (กัน flicker จาก React re-render กลาง CSS transition ของ Swiper — BKK vanilla ไม่ re-render)
  const slides = useMemo(
    () =>
      HERO_CAMPAIGNS.map((c, i) => (
        <SwiperSlide key={c.id} className="bg-primary-dark">
          <a
            href={c.ctaHref}
            aria-label={c.headline}
            className="relative block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <SmartImage
              src={c.imageUrl}
              alt={c.headline}
              fill
              sizes="(max-width:1024px) 100vw, 70vw"
              className="object-cover"
              fallbackIcon={c.icon}
              priority={i === 0}
            />
          </a>
        </SwiperSlide>
      )),
    [],
  );

  // dots: mobile/tablet ใต้กรอบภาพ (พื้นสว่าง -> primary/border) | desktop ทับบนรูป (surface ขาว)
  const dotBtn = (active: boolean) =>
    `h-2.5 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
      active
        ? "w-6 bg-primary lg:bg-surface"
        : "w-2.5 bg-border hover:bg-text-muted lg:bg-surface/50 lg:hover:bg-surface/80"
    }`;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="แคมเปญแนะนำ"
      // min-w-0 ตัดวงจร Swiper ขยายไม่จำกัดใน grid/flex item ที่ min-width:auto (mobile single-col)
      className={`relative flex min-w-0 flex-col gap-3 ${className}`}
    >
      {/* กรอบภาพ — Swiper + side arrows (hover-reveal) */}
      <div className="group relative aspect-[7/3] overflow-hidden rounded-xl shadow-banner">
        <Swiper
          modules={[EffectFade, Autoplay, A11y, Keyboard]}
          effect="fade"
          fadeEffect={{ crossFade: false }}
          speed={SPEED_MS}
          rewind
          keyboard={{ enabled: true }}
          autoplay={{
            delay: AUTOPLAY_MS,
            disableOnInteraction: false,
            pauseOnMouseEnter: false,
          }}
          onSwiper={(s) => {
            swiperRef.current = s;
            if (reduceMotion) s.autoplay?.stop();
          }}
          onSlideChange={(s) => setIndex(s.activeIndex)}
          className="h-full w-full"
        >
          {slides}
        </Swiper>

        {/* side arrows — desktop (ซ่อน default, โผล่ตอน hover/focus hero) */}
        <button
          type="button"
          onClick={() => swiperRef.current?.slidePrev()}
          aria-label="แคมเปญก่อนหน้า"
          className={`${navBtn} left-5`}
        >
          <Icon name="chevronLeft" size={24} />
        </button>
        <button
          type="button"
          onClick={() => swiperRef.current?.slideNext()}
          aria-label="แคมเปญถัดไป"
          className={`${navBtn} right-5`}
        >
          <Icon name="chevronRight" size={24} />
        </button>
      </div>

      {/* dots/bullets — mobile/tablet: ใต้กรอบภาพ | desktop (lg): ทับบนรูปกลางล่าง */}
      <div className="flex items-center justify-center gap-2 lg:absolute lg:bottom-4 lg:left-1/2 lg:z-30 lg:-translate-x-1/2">
        {HERO_CAMPAIGNS.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={() => swiperRef.current?.slideTo(i)}
            aria-label={`ไปยังแคมเปญที่ ${i + 1}`}
            aria-current={i === index}
            className={dotBtn(i === index)}
          />
        ))}
      </div>
    </div>
  );
}
