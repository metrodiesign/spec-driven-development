import type { Testimonial } from "@/app/data/types";

const avatar = (seed: string) => `https://picsum.photos/seed/${seed}/120/120`;

// >= 3 รายการ — REQ-11.1
export const TESTIMONIALS: Testimonial[] = [
  {
    id: "t-1",
    quote:
      "แจ้งเคลมรถผ่านแอปง่ายมาก เจ้าหน้าที่มาถึงที่เกิดเหตุภายในครึ่งชั่วโมง ประทับใจบริการจริง ๆ",
    name: "คุณกานต์ ธนวัฒน์",
    role: "ลูกค้าประกันรถยนต์ชั้น 1",
    avatarUrl: avatar("review-1"),
    rating: 5,
  },
  {
    id: "t-2",
    quote:
      "ทำประกันสุขภาพให้คุณแม่ เบิกค่ารักษาได้เต็มจำนวนไม่ต้องสำรองจ่าย อุ่นใจทั้งครอบครัว",
    name: "คุณพิมพ์ชนก ศรีสุข",
    role: "ลูกค้าประกันสุขภาพ",
    avatarUrl: avatar("review-2"),
    rating: 5,
  },
  {
    id: "t-3",
    quote:
      "ซื้อประกันเดินทางก่อนไปยุโรป กระเป๋าหายได้รับชดเชยรวดเร็ว ขั้นตอนไม่ยุ่งยากเลย",
    name: "คุณธีรภัทร อินทร์ทอง",
    role: "ลูกค้าประกันเดินทาง",
    avatarUrl: avatar("review-3"),
    rating: 4,
  },
  {
    id: "t-4",
    quote:
      "ตัวแทนให้คำปรึกษาดีมาก ช่วยเลือกแผนสะสมทรัพย์ที่เหมาะกับเป้าหมายเกษียณของผมพอดี",
    name: "คุณวรเดช มงคล",
    role: "ลูกค้าประกันสะสมทรัพย์",
    avatarUrl: avatar("review-4"),
    rating: 5,
  },
];
