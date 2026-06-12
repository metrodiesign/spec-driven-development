import type { Stat } from "@/app/data/types";

// >= 4 ตัวเลขความน่าเชื่อถือ — REQ-9.1
export const STATS: Stat[] = [
  {
    id: "customers",
    value: "5.2 ล้าน",
    label: "ลูกค้าที่ไว้วางใจ",
    icon: "user",
  },
  {
    id: "claim-rate",
    value: "99.3%",
    label: "อัตราการจ่ายเคลม",
    icon: "shield",
  },
  {
    id: "since",
    value: "พ.ศ. 2490",
    label: "ปีที่ก่อตั้งบริษัท",
    icon: "renew",
  },
  {
    id: "assets",
    value: "1.8 แสนล้าน",
    label: "มูลค่าสินทรัพย์ (บาท)",
    icon: "savings",
  },
  { id: "branches", value: "180+", label: "สาขาทั่วประเทศ", icon: "location" },
];
