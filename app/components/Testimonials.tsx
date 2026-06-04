"use client";

import { useState } from "react";
import { Container } from "@/app/components/ui/Container";
import { Icon } from "@/app/components/ui/Icon";
import { SmartImage } from "@/app/components/ui/SmartImage";
import { TESTIMONIALS } from "@/app/data/testimonials";

function Stars({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5" aria-label={`ให้คะแนน ${rating} จาก 5 ดาว`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className={i < rating ? "text-accent" : "text-border"}>
          <Icon name="star" size={18} />
        </span>
      ))}
    </div>
  );
}

// สไลด์รีวิว >= 3 + prev/next + dots + keyboard — REQ-11.1..11.4
export function Testimonials() {
  const [index, setIndex] = useState(0);
  const count = TESTIMONIALS.length;

  const go = (i: number) => setIndex(((i % count) + count) % count);
  const prev = () => go(index - 1);
  const next = () => go(index + 1);

  return (
    <section
      id="testimonials"
      aria-labelledby="testi-heading"
      aria-roledescription="carousel"
      className="bg-surface py-14 lg:py-20"
    >
      <Container>
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-accent-dark">
            เสียงจากลูกค้า
          </p>
          <h2 id="testi-heading" className="text-text">
            ลูกค้ากว่า 5 ล้านคนไว้วางใจเรา
          </h2>
        </div>

        <div
          className="relative mx-auto max-w-3xl"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") prev();
            if (e.key === "ArrowRight") next();
          }}
        >
          {/* track */}
          <div className="overflow-hidden rounded-2xl">
            <div
              className="flex transition-transform duration-300 ease-out"
              style={{ transform: `translateX(-${index * 100}%)` }}
            >
              {TESTIMONIALS.map((t, i) => (
                <figure
                  key={t.id}
                  aria-hidden={i !== index}
                  aria-roledescription="slide"
                  aria-label={`รีวิวที่ ${i + 1} จาก ${count}`}
                  className="w-full shrink-0 px-1"
                >
                  <div className="mx-1 flex flex-col items-center gap-5 rounded-2xl border border-border bg-bg p-8 text-center shadow-card sm:p-12">
                    <span className="text-accent">
                      <Icon name="contact" size={36} />
                    </span>
                    <Stars rating={t.rating} />
                    <blockquote className="max-w-xl text-h3 font-normal leading-relaxed text-text">
                      &ldquo;{t.quote}&rdquo;
                    </blockquote>
                    <figcaption className="flex items-center gap-3">
                      <span className="relative h-12 w-12 overflow-hidden rounded-full bg-surface">
                        <SmartImage
                          src={t.avatarUrl}
                          alt={t.name}
                          fill
                          sizes="48px"
                          className="object-cover"
                          fallbackIcon="user"
                        />
                      </span>
                      <span className="text-left">
                        <span className="block text-body font-semibold text-text">
                          {t.name}
                        </span>
                        <span className="block text-caption text-text-muted">
                          {t.role}
                        </span>
                      </span>
                    </figcaption>
                  </div>
                </figure>
              ))}
            </div>
          </div>

          {/* prev / next */}
          <button
            type="button"
            onClick={prev}
            aria-label="รีวิวก่อนหน้า"
            className="absolute -left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-primary shadow-card transition-colors hover:bg-primary hover:text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:-left-5"
          >
            <Icon name="chevronLeft" size={22} />
          </button>
          <button
            type="button"
            onClick={next}
            aria-label="รีวิวถัดไป"
            className="absolute -right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-primary shadow-card transition-colors hover:bg-primary hover:text-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:-right-5"
          >
            <Icon name="chevronRight" size={22} />
          </button>

          {/* dots */}
          <div className="mt-6 flex justify-center gap-2">
            {TESTIMONIALS.map((t, i) => (
              <button
                key={t.id}
                type="button"
                onClick={() => go(i)}
                aria-label={`ไปยังรีวิวที่ ${i + 1}`}
                aria-current={i === index}
                className={`h-2.5 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  i === index
                    ? "w-6 bg-primary"
                    : "w-2.5 bg-border hover:bg-text-muted"
                }`}
              />
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
