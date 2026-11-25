import { ImageResponse } from "next/og";

/**
 * iOS home-screen face: the ASImposium kylix emblem in the clay accent on the
 * warm paper ground, matching `app/icon.svg` and `components/site-emblem.tsx`.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f7f2e8",
        border: "8px solid #a2442a",
      }}
    >
      <svg width="128" height="128" viewBox="0 0 40 40" fill="none">
        <path d="M4 13.5h32c-1 7.2-7.6 11.6-16 11.6S5 20.7 4 13.5Z" fill="#a2442a" />
        <path
          d="M7.2 16.2c-4.6.2-5.6-4.9-2.1-5.4M32.8 16.2c4.6.2 5.6-4.9 2.1-5.4"
          stroke="#a2442a"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path d="M18.5 24.8h3l-.5 5.4h-2Z" fill="#a2442a" />
        <path d="M11.5 33.4c2.4-3 14.6-3 17 0-2.6 1.2-14.4 1.2-17 0Z" fill="#a2442a" />
        <path
          d="M9 17.4h22M12.5 17.4v-1.8h2.4v1.8M18.8 17.4v-1.8h2.4v1.8M25.1 17.4v-1.8h2.4v1.8"
          stroke="#f7f2e8"
          strokeWidth="1.1"
        />
      </svg>
    </div>,
    size,
  );
}
