"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  ApiError,
  approveRequest,
  deleteBot,
  refundPayment,
  rejectRequest,
  restartBot,
  saveSetting,
  stopBot,
} from "@/lib/api";
import {
  checkPassword,
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
} from "@/lib/auth";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}

function withMessage(path: string, key: "ok" | "error", message: string): string {
  return `${path}?${key}=${encodeURIComponent(message)}`;
}

/** Only allow in-app absolute paths as a post-action redirect target. */
function backTo(formData: FormData, fallback: string): string {
  const value = String(formData.get("back") ?? "");
  return /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(value) ? value : fallback;
}

export async function loginAction(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  if (!checkPassword(password)) {
    redirect("/login?error=1");
  }
  await setSessionCookie();
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}

export async function approveAction(formData: FormData): Promise<void> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  let target: string;
  try {
    await approveRequest(id);
    revalidatePath("/payments");
    revalidatePath("/");
    target = withMessage("/payments", "ok", "결제를 승인했습니다.");
  } catch (error) {
    target = withMessage("/payments", "error", errorMessage(error));
  }
  redirect(target);
}

export async function rejectAction(formData: FormData): Promise<void> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  let target: string;
  if (!reason) {
    target = withMessage("/payments", "error", "거절 사유를 입력해 주세요.");
  } else {
    try {
      await rejectRequest(id, reason);
      revalidatePath("/payments");
      target = withMessage("/payments", "ok", "결제 신청을 거절했습니다.");
    } catch (error) {
      target = withMessage("/payments", "error", errorMessage(error));
    }
  }
  redirect(target);
}

export async function refundAction(formData: FormData): Promise<void> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  let target: string;
  if (!reason) {
    target = withMessage("/payments", "error", "환불 사유를 입력해 주세요.");
  } else {
    try {
      await refundPayment(id, reason);
      revalidatePath("/payments");
      revalidatePath("/bots");
      revalidatePath("/");
      target = withMessage("/payments", "ok", "결제를 환불 처리했습니다.");
    } catch (error) {
      target = withMessage("/payments", "error", errorMessage(error));
    }
  }
  redirect(target);
}

export async function stopBotAction(formData: FormData): Promise<void> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const back = backTo(formData, "/bots");
  let target: string;
  try {
    await stopBot(id);
    revalidatePath("/bots");
    revalidatePath("/");
    target = withMessage(back, "ok", "봇을 정지했습니다.");
  } catch (error) {
    target = withMessage(back, "error", errorMessage(error));
  }
  redirect(target);
}

export async function restartBotAction(formData: FormData): Promise<void> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const back = backTo(formData, "/bots");
  let target: string;
  try {
    await restartBot(id);
    revalidatePath("/bots");
    revalidatePath(`/bots/${id}`);
    revalidatePath("/");
    target = withMessage(back, "ok", "봇을 재시작했습니다.");
  } catch (error) {
    target = withMessage(back, "error", errorMessage(error));
  }
  redirect(target);
}

export async function deleteBotAction(formData: FormData): Promise<void> {
  await requireAuth();
  const id = String(formData.get("id") ?? "");
  const confirm = String(formData.get("confirm") ?? "").trim();
  let target: string;
  if (confirm !== "삭제") {
    target = withMessage("/bots", "error", "삭제하려면 확인란에 '삭제'를 입력해 주세요.");
  } else {
    try {
      await deleteBot(id);
      revalidatePath("/bots");
      revalidatePath("/");
      target = withMessage("/bots", "ok", "호스팅 데이터를 삭제했습니다.");
    } catch (error) {
      target = withMessage("/bots", "error", errorMessage(error));
    }
  }
  redirect(target);
}

export async function saveSettingAction(formData: FormData): Promise<void> {
  await requireAuth();
  const key = String(formData.get("key") ?? "");
  const raw = String(formData.get("value") ?? "");
  let target: string;
  try {
    const value = JSON.parse(raw) as unknown;
    await saveSetting(key, value);
    revalidatePath("/settings");
    target = withMessage("/settings", "ok", `${key} 설정을 저장했습니다.`);
  } catch (error) {
    target =
      error instanceof SyntaxError
        ? withMessage("/settings", "error", `${key} 값이 올바른 JSON이 아닙니다.`)
        : withMessage("/settings", "error", errorMessage(error));
  }
  redirect(target);
}
