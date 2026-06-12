import { Container } from "@/app/components/ui/Container";
import { Icon } from "@/app/components/ui/Icon";
import { APP_FEATURES } from "@/app/data/appFeatures";

// store badge เป็น inline SVG — REQ-12.2
function StoreBadge({ store }: { store: "apple" | "google" }) {
  const isApple = store === "apple";
  return (
    <a
      href="#download"
      className="flex items-center gap-3 rounded-lg border border-surface/20 bg-primary-dark px-4 py-2.5 transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-label={isApple ? "ดาวน์โหลดบน App Store" : "ดาวน์โหลดบน Google Play"}
    >
      {isApple ? (
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="#FFFFFF"
          aria-hidden="true"
        >
          <path d="M16.4 12.6c0-2.2 1.8-3.3 1.9-3.3-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.3.8-.7 0-1.7-.8-2.8-.8-1.4 0-2.8.9-3.5 2.2-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.1 1.1 0 1.5-.7 2.8-.7s1.7.7 2.8.7c1.2 0 1.9-1 2.6-2.1.8-1.2 1.2-2.4 1.2-2.4s-2.3-.9-2.3-3.5Z" />
          <path d="M14.5 6.3c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.6.6-1.1 1.6-.9 2.6 1 .1 2-.5 2.5-1.2Z" />
        </svg>
      ) : (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4 3.5 13.5 12 4 20.5c-.3-.2-.5-.6-.5-1V4.5c0-.4.2-.8.5-1Z"
            fill="#34D399"
          />
          <path
            d="M16.5 9 13.5 12 4 3.5c.4-.2.9-.2 1.3 0L16.5 9Z"
            fill="#60A5FA"
          />
          <path
            d="M16.5 15 5.3 20.5c-.4.2-.9.2-1.3 0L13.5 12l3 3Z"
            fill="#F87171"
          />
          <path
            d="M20 10.7c.6.4.6 1.2 0 1.6l-3.5 2-3-3 3-3 3.5 2.4Z"
            fill="#FBBF24"
          />
        </svg>
      )}
      <span className="flex flex-col leading-tight text-surface">
        <span className="text-[0.65rem] opacity-80">
          {isApple ? "Download on the" : "GET IT ON"}
        </span>
        <span className="text-body font-semibold">
          {isApple ? "App Store" : "Google Play"}
        </span>
      </span>
    </a>
  );
}

// phone mockup ที่มี UI จำลองข้างในจริง — REQ-12.1 (ไม่ใช่กล่องว่าง)
function PhoneMockup() {
  return (
    <div className="relative mx-auto w-[260px]" aria-hidden="true">
      <div className="rounded-[2.5rem] border-[10px] border-primary-dark bg-bg shadow-banner">
        {/* notch */}
        <div className="relative h-6 rounded-t-[1.8rem] bg-primary-dark">
          <span className="absolute left-1/2 top-1.5 h-1.5 w-16 -translate-x-1/2 rounded-full bg-surface/30" />
        </div>
        {/* status bar */}
        <div className="flex items-center justify-between bg-primary px-4 py-2 text-[0.6rem] text-surface">
          <span>9:41</span>
          <span className="flex items-center gap-1">
            <Icon name="globe" size={11} />
            <Icon name="shield" size={11} />
          </span>
        </div>
        {/* app header */}
        <div className="bg-primary px-4 pb-4 text-surface">
          <p className="text-caption opacity-80">สวัสดี,</p>
          <p className="text-body font-semibold">คุณสมหญิง รักดี</p>
        </div>
        {/* policy card */}
        <div className="-mt-2 space-y-3 rounded-t-2xl bg-surface p-4">
          <div className="rounded-lg bg-gradient-to-br from-primary to-primary-light p-3 text-surface">
            <div className="flex items-center justify-between">
              <span className="text-[0.6rem] opacity-80">กรมธรรม์สุขภาพ</span>
              <Icon name="health" size={16} />
            </div>
            <p className="mt-1 text-body font-bold">฿5,000,000</p>
            <p className="text-[0.6rem] opacity-80">คุ้มครองถึง 31 ธ.ค. 2569</p>
          </div>
          {/* quick actions */}
          <div className="grid grid-cols-3 gap-2 text-center">
            {(["claim", "renew", "pay"] as const).map((ic, i) => (
              <div key={ic} className="rounded-lg bg-bg py-2">
                <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Icon name={ic} size={15} />
                </span>
                <span className="mt-1 block text-[0.55rem] text-text-muted">
                  {["เคลม", "ต่ออายุ", "ชำระ"][i]}
                </span>
              </div>
            ))}
          </div>
          {/* cta */}
          <div className="rounded-lg bg-accent py-2 text-center text-caption font-semibold text-primary-dark">
            แจ้งเคลมใหม่
          </div>
          <div className="space-y-1.5">
            <div className="h-2 w-3/4 rounded-full bg-border" />
            <div className="h-2 w-1/2 rounded-full bg-border" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppDownload() {
  return (
    <section
      id="app"
      aria-labelledby="app-heading"
      className="bg-primary-dark py-14 text-surface lg:py-20"
    >
      <Container className="grid items-center gap-10 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-accent">
            แอปวิริยะ
          </p>
          <h2 id="app-heading" className="text-surface">
            จัดการประกันทั้งหมดได้ในมือคุณ
          </h2>
          <p className="mt-3 max-w-md text-body text-surface/80">
            ดาวน์โหลดแอปวิริยะประกันภัย เพื่อดูกรมธรรม์ แจ้งเคลม
            และต่ออายุได้ทุกที่ทุกเวลา
          </p>
          <ul className="mt-6 space-y-3">
            {APP_FEATURES.map((f) => (
              <li key={f.id} className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                  <Icon name={f.icon} size={18} />
                </span>
                <span className="text-body text-surface/90">{f.label}</span>
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-wrap gap-3">
            <StoreBadge store="apple" />
            <StoreBadge store="google" />
          </div>
        </div>
        <PhoneMockup />
      </Container>
    </section>
  );
}
