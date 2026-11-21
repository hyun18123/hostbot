import type { Metadata } from "next";
import Link from "next/link";
import { isAuthenticated } from "@/lib/auth";
import { logoutAction } from "./actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "HostBot 운영 콘솔",
  description: "디스코드 봇 호스팅 운영자 대시보드",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const authed = await isAuthenticated();
  return (
    <html lang="ko">
      <body>
        {authed ? (
          <header className="topbar">
            <div className="topbar-inner">
              <Link href="/" className="brand">
                <span className="brand-mark">HB</span> HostBot
              </Link>
              <nav className="nav">
                <Link href="/">개요</Link>
                <Link href="/bots">봇</Link>
                <Link href="/payments">결제</Link>
                <Link href="/parser">파서</Link>
                <Link href="/settings">설정</Link>
              </nav>
              <form action={logoutAction}>
                <button className="btn ghost" type="submit">
                  로그아웃
                </button>
              </form>
            </div>
          </header>
        ) : null}
        <main className={authed ? "container" : "container login-container"}>{children}</main>
        <footer className="footer">HostBot · 디스코드 봇 호스팅 운영 콘솔</footer>
      </body>
    </html>
  );
}
