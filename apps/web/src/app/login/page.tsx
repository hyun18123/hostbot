import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { loginAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await isAuthenticated()) redirect("/");
  const params = await searchParams;

  return (
    <div className="login-card">
      <div className="brand" style={{ marginBottom: 20 }}>
        <span className="brand-mark">HB</span> HostBot
      </div>
      <h1>운영자 로그인</h1>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 24 }}>
        호스팅 운영 콘솔에 접근하려면 비밀번호를 입력하세요.
      </p>
      {params.error ? <div className="alert error">비밀번호가 올바르지 않습니다.</div> : null}
      <form action={loginAction}>
        <div className="form-row">
          <label htmlFor="password">비밀번호</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <button className="btn primary" type="submit" style={{ width: "100%" }}>
          로그인
        </button>
      </form>
    </div>
  );
}
