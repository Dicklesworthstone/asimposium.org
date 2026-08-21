import { ImageResponse } from "next/og";

/**
 * iOS home-screen face: the Greek alpha that marks every landing section,
 * in the clay accent on the light paper. The masthead's classical-building
 * emoji does not survive satori's font stack, so the typographic mark stands
 * in — same palette, same family of ornaments.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f7f2e8",
          border: "8px solid #a6482e",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 104,
            lineHeight: 1,
            color: "#a6482e",
            marginTop: -10,
          }}
        >
          α
        </div>
      </div>
    ),
    size,
  );
}
