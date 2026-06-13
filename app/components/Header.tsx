"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/Button";
import { Icon } from "@/app/components/ui/Icon";
import { MAIN_NAV } from "@/app/data/navigation";

function Logo() {
  return (
    <a
      href="#main"
      className="flex items-center gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-label="วิริยะประกันภัย หน้าแรก"
    >
      <svg width="38" height="38" viewBox="0 0 40 40" aria-hidden="true">
        <path
          d="M20 3 5 8v9c0 8.5 5.7 14.4 15 18 9.3-3.6 15-9.5 15-18V8Z"
          fill="#13266B"
        />
        <path
          d="M20 3 5 8v9c0 8.5 5.7 14.4 15 18 9.3-3.6 15-9.5 15-18V8Z"
          fill="none"
          stroke="#FDB913"
          strokeWidth="1.5"
        />
        <path
          d="M13 19l4.5 4.5L28 13"
          fill="none"
          stroke="#FDB913"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="flex flex-col leading-none">
        <span className="text-h3 font-bold text-primary">วิริยะประกันภัย</span>
        <span className="text-[0.7rem] text-text-muted">VIRIYAH INSURANCE</span>
      </span>
    </a>
  );
}

export function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-surface/95 shadow-card backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <div className="mx-auto flex h-16 w-full max-w-container items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Logo />

        {/* desktop nav */}
        <nav
          aria-label="เมนูหลัก"
          className="hidden items-center gap-1 lg:flex"
        >
          {MAIN_NAV.map((item) =>
            item.children ? (
              <div key={item.label} className="group relative">
                <a
                  href={item.anchor}
                  className="flex items-center gap-1 rounded-md px-3 py-2 text-body font-medium text-text transition-colors hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-haspopup="true"
                >
                  {item.label}
                  <Icon name="chevronDown" size={16} />
                </a>
                {/* dropdown: เปิดเมื่อ hover/focus + คีย์บอร์ดเข้าถึง (REQ-3.5) */}
                <ul className="invisible absolute left-0 top-full z-50 min-w-[15rem] translate-y-1 rounded-lg border border-border bg-surface p-2 opacity-0 shadow-cardHover transition-all duration-200 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100">
                  {item.children.map((c) => (
                    <li key={c.label}>
                      <a
                        href={c.anchor}
                        className="block rounded-md px-3 py-2 text-body text-text transition-colors hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {c.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <a
                key={item.label}
                href={item.anchor}
                className="rounded-md px-3 py-2 text-body font-medium text-text transition-colors hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {item.label}
              </a>
            ),
          )}
        </nav>

        {/* hotline + cta (desktop) */}
        <div className="hidden items-center gap-3 lg:flex">
          <a
            href="tel:1557"
            className="flex items-center gap-2 rounded-md px-2 py-1 text-body font-semibold text-primary transition-colors hover:text-primary-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="phone" size={18} />
            สายด่วน 1557
          </a>
          <Button as="a" href="#calculator" variant="accent" size="sm">
            คำนวณเบี้ย
          </Button>
        </div>

        {/* hamburger (mobile/tablet) */}
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md p-2 text-primary transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:hidden"
          aria-label={open ? "ปิดเมนู" : "เปิดเมนู"}
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? "close" : "menu"} size={26} />
        </button>
      </div>

      {/* mobile menu panel */}
      {open && (
        <nav
          id="mobile-menu"
          aria-label="เมนูหลัก (มือถือ)"
          className="border-t border-border bg-surface lg:hidden"
        >
          <ul className="mx-auto flex w-full max-w-container flex-col gap-1 px-4 py-4 sm:px-6">
            {MAIN_NAV.map((item) => (
              <li key={item.label}>
                <a
                  href={item.anchor}
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-3 py-2.5 text-body font-medium text-text transition-colors hover:bg-primary/5 hover:text-primary"
                >
                  {item.label}
                </a>
                {item.children && (
                  <ul className="ml-3 border-l border-border pl-2">
                    {item.children.map((c) => (
                      <li key={c.label}>
                        <a
                          href={c.anchor}
                          onClick={() => setOpen(false)}
                          className="block rounded-md px-3 py-2 text-caption text-text-muted transition-colors hover:text-primary"
                        >
                          {c.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
            <li className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-3">
              <a
                href="tel:1557"
                className="flex items-center gap-2 text-body font-semibold text-primary"
              >
                <Icon name="phone" size={18} />
                สายด่วน 1557
              </a>
              <Button
                as="a"
                href="#calculator"
                variant="accent"
                size="sm"
                onClick={() => setOpen(false)}
              >
                คำนวณเบี้ย
              </Button>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
