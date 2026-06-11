import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "정보실 예약",
  description: "리로스쿨 로그인 기반 정보실 예약"
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
