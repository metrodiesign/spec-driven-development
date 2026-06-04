import type { NavItem } from "@/app/data/types";

// เมนูหลัก 5 รายการ + anchor mapping — REQ-1.3, 3.1
// ผลิตภัณฑ์->#insurance-types, คำนวณเบี้ย->#calculator, แจ้งเคลม->#services,
// เกี่ยวกับเรา->#stats, บทความ->#articles
export const MAIN_NAV: NavItem[] = [
  {
    label: "ผลิตภัณฑ์",
    anchor: "#insurance-types",
    children: [
      { label: "ประกันชีวิต", anchor: "#insurance-types" },
      { label: "ประกันสุขภาพ", anchor: "#insurance-types" },
      { label: "ประกันรถยนต์", anchor: "#insurance-types" },
      { label: "ประกันเดินทาง", anchor: "#insurance-types" },
      { label: "โปรโมชั่นทั้งหมด", anchor: "#promotions" },
    ],
  },
  { label: "คำนวณเบี้ย", anchor: "#calculator" },
  { label: "แจ้งเคลม", anchor: "#services" },
  { label: "เกี่ยวกับเรา", anchor: "#stats" },
  { label: "บทความ", anchor: "#articles" },
];
