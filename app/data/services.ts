import type { ServiceItem } from "@/app/data/types";

// >= 12 รายการ, ไอคอน inline SVG — REQ-6.1
export const SERVICES: ServiceItem[] = [
  {
    id: "buy",
    label: "ซื้อประกันออนไลน์",
    icon: "cartPlus",
    href: "#insurance-types",
  },
  { id: "claim", label: "แจ้งเคลม", icon: "claim", href: "#services" },
  { id: "renew", label: "ต่ออายุกรมธรรม์", icon: "renew", href: "#services" },
  {
    id: "change",
    label: "เปลี่ยน/ปรับแผน",
    icon: "changePlan",
    href: "#services",
  },
  { id: "agent", label: "ปรึกษาตัวแทน", icon: "agent", href: "#services" },
  {
    id: "download",
    label: "ดาวน์โหลดกรมธรรม์",
    icon: "download",
    href: "#services",
  },
  { id: "status", label: "ตรวจสถานะเคลม", icon: "status", href: "#services" },
  { id: "pay", label: "ชำระเบี้ยประกัน", icon: "pay", href: "#services" },
  {
    id: "hospital",
    label: "โรงพยาบาลคู่สัญญา",
    icon: "hospital",
    href: "#services",
  },
  {
    id: "points",
    label: "สะสมแต้ม/สิทธิพิเศษ",
    icon: "points",
    href: "#services",
  },
  {
    id: "calc",
    label: "คำนวณเบี้ยประกัน",
    icon: "calculator",
    href: "#calculator",
  },
  {
    id: "card",
    label: "บัตรลูกค้าดิจิทัล",
    icon: "document",
    href: "#services",
  },
  {
    id: "contact",
    label: "ติดต่อศูนย์บริการ",
    icon: "contact",
    href: "#services",
  },
  { id: "branch", label: "ค้นหาสาขา", icon: "location", href: "#services" },
];
