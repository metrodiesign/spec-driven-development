import type { AppFeature } from "@/app/data/types";

// ฟีเจอร์เด่นในแอป — ใช้แสดงข้าง phone mockup (REQ-12)
export const APP_FEATURES: AppFeature[] = [
  { id: "policy", label: "ดูกรมธรรม์ทั้งหมดในที่เดียว", icon: "document" },
  { id: "claim", label: "แจ้งเคลมพร้อมถ่ายรูปในแอป", icon: "claim" },
  { id: "card", label: "บัตรลูกค้าดิจิทัลแสดงที่ รพ.", icon: "shield" },
  { id: "pay", label: "ชำระเบี้ย/ต่ออายุอัตโนมัติ", icon: "pay" },
];
