import type { IconName } from "@/app/components/ui/Icon";

export type { IconName };

// ประเภทประกัน 8 หมวด — ใช้ร่วมกันทั้ง lib (premium) + data + filter
export type InsuranceCategory =
  | "life"
  | "health"
  | "motor"
  | "travel"
  | "accident"
  | "home"
  | "cancer"
  | "savings";

export const INSURANCE_CATEGORIES: InsuranceCategory[] = [
  "life",
  "health",
  "motor",
  "travel",
  "accident",
  "home",
  "cancer",
  "savings",
];

export const CATEGORY_LABELS: Record<InsuranceCategory, string> = {
  life: "ประกันชีวิต",
  health: "ประกันสุขภาพ",
  motor: "ประกันรถยนต์",
  travel: "ประกันเดินทาง",
  accident: "ประกันอุบัติเหตุ",
  home: "ประกันบ้าน",
  cancer: "ประกันมะเร็ง",
  savings: "ประกันสะสมทรัพย์",
};

// icon ประจำหมวด (ใช้ใน badge/การ์ด)
export const CATEGORY_ICONS: Record<InsuranceCategory, IconName> = {
  life: "life",
  health: "health",
  motor: "motor",
  travel: "travel",
  accident: "accident",
  home: "home",
  cancer: "cancer",
  savings: "savings",
};

export interface NavItem {
  label: string;
  anchor: `#${string}`;
  children?: { label: string; anchor: `#${string}` }[];
}

export interface InsuranceType {
  id: string;
  category: InsuranceCategory;
  name: string; // ไทย
  tagline: string; // ป้ายกำกับ/คำโปรย
  imageUrl: string; // picsum
  planHref: string; // ดูแผน (placeholder)
}

export interface ServiceItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
}

export interface Promotion {
  id: string;
  category: InsuranceCategory; // ใช้ filter (REQ-7.3)
  title: string;
  badge: string;
  priceCurrent: number; // THB
  priceOriginal: number; // > current -> ขีดฆ่า (REQ-7.4)
  expiresOn: string; // ISO date
  imageUrl: string;
  detailsHref: string;
  buyHref: string;
}

export interface Stat {
  id: string;
  value: string;
  label: string;
  icon: IconName;
}

export interface Article {
  id: string;
  title: string;
  category: string;
  imageUrl: string;
  author: { name: string; avatarUrl: string };
  date: string; // ISO date
}

export interface Testimonial {
  id: string;
  quote: string;
  name: string;
  role: string;
  avatarUrl: string;
  rating: number; // 1-5
}

export interface AppFeature {
  id: string;
  label: string;
  icon: IconName;
}

export interface HeroCampaignItem {
  label: string;
  sublabel: string;
}

export interface HeroCampaign {
  id: string;
  headline: string; // ข้อความบนกลาง
  display: string; // สโลแกนตัวใหญ่กลางสไลด์
  items: HeroCampaignItem[]; // แถวหมวดล่าง (bullet + ชื่อย่อย)
  ctaLabel: string;
  ctaHref: `#${string}`;
  imageUrl: string; // ภาพ banner (text/CTA ฝังในรูป)
  icon: IconName; // ไอคอน fallback เมื่อรูปโหลดไม่ได้
}
