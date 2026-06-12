"use client";

import Image from "next/image";
import { useState } from "react";
import { Icon, type IconName } from "./Icon";

// gradient blur ระหว่างโหลด (REQ-15.6) — inline SVG data URI, ไม่ง้อ network
const BLUR_DATA_URL =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#24398A"/><stop offset="1" stop-color="#0E1C50"/></linearGradient></defs><rect width="8" height="6" fill="url(#g)"/></svg>`,
  );

interface SmartImageProps {
  src: string;
  alt: string;
  fill?: boolean;
  width?: number;
  height?: number;
  sizes?: string;
  className?: string;
  /** icon shown in the "intended" fallback when remote image fails (REQ-15.3) */
  fallbackIcon?: IconName;
  priority?: boolean;
}

export function SmartImage({
  src,
  alt,
  fill = false,
  width,
  height,
  sizes,
  className = "",
  fallbackIcon = "shield",
  priority = false,
}: SmartImageProps) {
  const [errored, setErrored] = useState(false);

  // fallback ที่ดู "ตั้งใจ": gradient กรมท่า + ลวดลาย + icon (ไม่ใช่ภาพแตก/กล่องว่าง)
  if (errored) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`relative flex items-center justify-center overflow-hidden bg-gradient-to-br from-primary-light to-primary-dark ${
          fill ? "absolute inset-0 h-full w-full" : ""
        } ${className}`}
        style={!fill && width && height ? { width, height } : undefined}
      >
        <svg
          className="absolute inset-0 h-full w-full opacity-20"
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          <defs>
            <pattern
              id="smartimg-dots"
              width="22"
              height="22"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="2" cy="2" r="1.5" fill="#FDB913" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#smartimg-dots)" />
        </svg>
        <Icon name={fallbackIcon} size={44} className="text-accent" />
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill={fill}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      sizes={sizes}
      placeholder="blur"
      blurDataURL={BLUR_DATA_URL}
      priority={priority}
      className={className}
      onError={() => setErrored(true)}
    />
  );
}
