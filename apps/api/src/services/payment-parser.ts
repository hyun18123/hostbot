import type { ParsedDeposit } from "@hostbot/shared";

/**
 * Bank notification formats differ by bank, app version, OS, and whether the
 * notification arrived via the bank app or SMS. The generic rules below cover
 * common Korean formats, but operators MUST verify them against real
 * notifications and can override them via admin_settings.bank_parsers.
 */
export interface BankParserRule {
  id: string;
  bankName: string;
  /** Matched against app name + title + body. */
  keywords?: string[];
  amountPatterns?: string[];
  depositorPatterns?: string[];
  txnIdPatterns?: string[];
  /** If true, this rule is only used for amount/depositor if its keyword matched. */
  requireKeyword?: boolean;
}

export interface ParsedNotificationInput {
  title?: string | null;
  body: string;
  appName?: string | null;
  source?: string | null;
  receivedAt?: Date;
}

const MAX_AMOUNT = 100_000_000;

const DEPOSIT_KEYWORDS = /입금|입금완료|송금받|받은\s*금액|received|deposit|credited/i;
const NON_DEPOSIT_KEYWORDS = /출금|지출|결제|승인|사용|이체\s*출금|withdraw|payment|purchase/i;

const BALANCE_KEYWORDS = /잔액|잔고|balance/i;
const ACCOUNT_KEYWORDS = /계좌|account/i;
const NAME_STOPWORDS = new Set([
  "은행",
  "뱅크",
  "입금",
  "출금",
  "잔액",
  "계좌",
  "이체",
  "카드",
  "결제",
  "송금",
  "받는분",
  "보낸분",
  "고객",
  "알림",
  "토스",
  "카카오",
]);

interface AmountCandidate {
  amount: number;
  index: number;
  score: number;
  source: string;
}

function normalizeText(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function parseIntAmount(value: string): number | null {
  const cleaned = value.replace(/[^\d]/g, "");
  if (!cleaned) return null;
  const amount = Number.parseInt(cleaned, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  return amount;
}

function contextAround(text: string, index: number, radius = 22): string {
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

function collectAmountCandidates(text: string, rules: BankParserRule[]): AmountCandidate[] {
  const candidates: AmountCandidate[] = [];
  const seen = new Set<string>();

  const add = (amountText: string, index: number, score: number, source: string, matchedLength: number) => {
    const amount = parseIntAmount(amountText);
    if (amount === null || amount < 100) return;
    const key = `${amount}:${index}`;
    if (seen.has(key)) return;
    // Only the text immediately before an amount tells us whether it is a
    // balance. A later "잔액" must not suppress the actual deposit amount.
    const before = text.slice(Math.max(0, index - 14), index);
    const context = contextAround(text, index);
    if (BALANCE_KEYWORDS.test(before)) score -= 90;
    if (NON_DEPOSIT_KEYWORDS.test(before) && !/입금/.test(before)) score -= 60;
    // Account-number-like values are usually longer and grouped differently.
    const rawDigits = amountText.replace(/[^\d]/g, "");
    if (rawDigits.length >= 10) score -= 40;
    if (/출금|결제|승인/.test(context) && !/입금/.test(context)) score -= 30;
    seen.add(key);
    candidates.push({ amount, index: index + matchedLength, score, source });
  };

  // 0) Operator-supplied bank-specific patterns.
  for (const rule of rules) {
    if (rule.requireKeyword) {
      const matched = (rule.keywords ?? []).some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase()),
      );
      if (!matched) continue;
    }
    for (const pattern of rule.amountPatterns ?? []) {
      const regex = safeRegExp(pattern);
      if (!regex) continue;
      const global = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
      for (const match of text.matchAll(global)) {
        if (!match[1]) continue;
        add(match[1], match.index ?? 0, 95, `rule:${rule.id}`, match[0].length);
      }
    }
  }

  // 1) Explicitly labelled deposit amount: highest confidence.
  for (const pattern of [
    /입금액\s*[:：]?\s*([0-9][0-9,]{1,12})\s*원?/gi,
    /입금\s*금액\s*[:：]?\s*([0-9][0-9,]{1,12})\s*원?/gi,
  ]) {
    for (const match of text.matchAll(pattern)) {
      add(match[1]!, match.index ?? 0, 100, "labelled", match[0].length);
    }
  }

  // 2) "<amount>원 입금" / "입금 <amount>원".
  for (const pattern of [
    /([0-9][0-9,]{2,12})\s*원\s*(?:이|가)?\s*입금/gi,
    /입금(?:\s*완료)?\s*[:：]?\s*([0-9][0-9,]{2,12})\s*원/gi,
  ]) {
    for (const match of text.matchAll(pattern)) {
      add(match[1]!, match.index ?? 0, 70, "near-keyword", match[0].length);
    }
  }

  // 3) Generic "3,900원" mentions, scored by context.
  for (const match of text.matchAll(/([0-9][0-9,]{2,12})\s*원/g)) {
    const amountText = match[1]!;
    const index = match.index ?? 0;
    const context = contextAround(text, index, 28);
    let score = 20;
    if (/입금/.test(context)) score += 30;
    if (BALANCE_KEYWORDS.test(context)) score -= 60;
    if (NON_DEPOSIT_KEYWORDS.test(context) && !/입금/.test(context)) score -= 80;
    add(amountText, index, score, "generic", match[0].length);
  }

  return candidates.sort((a, b) => b.score - a.score || a.index - b.index);
}

function pickAmount(candidates: AmountCandidate[]): {
  amount: number | null;
  confidence: "high" | "medium" | "low";
  ambiguous: boolean;
} {
  if (candidates.length === 0) return { amount: null, confidence: "low", ambiguous: false };
  const best = candidates[0]!;
  if (best.score < 10) return { amount: null, confidence: "low", ambiguous: false };
  const tied = candidates.filter((candidate) => candidate.score === best.score && candidate.amount !== best.amount);
  if (tied.length > 0) {
    return { amount: best.amount, confidence: "low", ambiguous: true };
  }
  if (best.score >= 70) return { amount: best.amount, confidence: "high", ambiguous: false };
  if (best.score >= 30) return { amount: best.amount, confidence: "medium", ambiguous: false };
  return { amount: best.amount, confidence: "low", ambiguous: false };
}

function cleanName(value: string): string | null {
  let name = value
    .normalize("NFKC")
    .replace(/^[\s:：\-–—]+/, "")
    .replace(/[\s,.;:：]+$/, "")
    .replace(/님$/, "")
    .trim();
  if (name.length < 1 || name.length > 30) return null;
  if (NAME_STOPWORDS.has(name)) return null;
  if (/^[0-9,]+$/.test(name)) return null;
  if (/입금|출금|잔액|계좌|은행|카드|결제/.test(name)) return null;
  return name;
}

function extractDepositor(
  text: string,
  rules: BankParserRule[],
): { name: string | null; confidence: "high" | "medium" | "low"; ambiguous: boolean } {
  const labeledPatterns = [
    /입금자(?:명)?\s*[:：]?\s*([가-힣A-Za-z0-9*○●]{2,30})/i,
    /보낸(?:사람|분|이)\s*[:：]?\s*([가-힣A-Za-z0-9*○●]{2,30})/i,
    /송금인\s*[:：]?\s*([가-힣A-Za-z0-9*○●]{2,30})/i,
    /from\s*[:：]?\s*([A-Za-z0-9* ]{2,30})/i,
  ];
  const customPatterns = rules.flatMap((rule) =>
    (rule.depositorPatterns ?? []).map((pattern) => safeRegExp(pattern)).filter((value): value is RegExp => Boolean(value)),
  );

  const names = new Set<string>();
  for (const pattern of [...customPatterns, ...labeledPatterns]) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const name = cleanName(match[1]);
    if (name) names.add(name);
  }
  if (names.size === 1) return { name: [...names][0]!, confidence: "high", ambiguous: false };
  if (names.size > 1) return { name: [...names][0]!, confidence: "low", ambiguous: true };

  // Unlabelled: "홍길동 3,900원 입금" / "홍길동님 3,900원 입금"
  const generic = [
    /([가-힣][가-힣*○●]{1,4})\s*(?:님)?\s*(?:이|가)?\s*[0-9][0-9,]{2,12}\s*원\s*(?:을|를)?\s*입금/i,
    /([가-힣][가-힣*○●]{1,4})\s*(?:님)?\s*입금\s*[0-9][0-9,]{2,12}\s*원/i,
    /([A-Za-z][A-Za-z ]{1,20})\s+[0-9][0-9,]{2,12}\s*원\s*(?:입금|deposit)/i,
  ];
  for (const pattern of generic) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const name = cleanName(match[1]);
    if (name) return { name, confidence: "high", ambiguous: false };
  }

  return { name: null, confidence: "low", ambiguous: false };
}

function detectBank(text: string, rules: BankParserRule[]): string | null {
  for (const rule of rules) {
    if (rule.keywords && rule.keywords.length > 0) {
      if (rule.keywords.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()))) {
        return rule.bankName;
      }
    }
  }
  const known = [
    "국민",
    "신한",
    "우리",
    "하나",
    "농협",
    "기업",
    "카카오뱅크",
    "토스뱅크",
    "케이뱅크",
    "부산",
    "대구",
    "경남",
    "광주",
    "전북",
    "제주",
    "수협",
    "SC제일",
    "씨티",
  ];
  for (const bank of known) {
    if (text.includes(bank)) return bank;
  }
  return null;
}

function extractTxnId(text: string, rules: BankParserRule[]): string | null {
  const patterns = [
    ...rules.flatMap((rule) =>
      (rule.txnIdPatterns ?? []).map((pattern) => safeRegExp(pattern)).filter((value): value is RegExp => Boolean(value)),
    ),
    /거래\s*(?:번호|ID)\s*[:：]?\s*([A-Za-z0-9-]{6,40})/i,
    /승인\s*번호\s*[:：]?\s*([A-Za-z0-9-]{4,40})/i,
    /(?:TXN|TRX|transaction)\s*(?:ID|NO)?\s*[:：]?\s*([A-Za-z0-9-]{6,40})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * Parses a bank deposit notification. Returns isDeposit=false for unrelated
 * notifications. Low-confidence results are routed to an operator instead of
 * being auto-approved.
 */
export function parseDepositNotification(
  input: ParsedNotificationInput,
  rules: BankParserRule[] = [],
): ParsedDeposit {
  const text = normalizeText(input.title, input.appName, input.body);
  const rawText = input.body;

  if (!text) {
    return {
      isDeposit: false,
      amount: null,
      depositorName: null,
      depositorMasked: false,
      bankName: null,
      txnId: null,
      confidence: "low",
      reason: "empty_notification",
      rawText,
    };
  }

  const hasDepositKeyword = DEPOSIT_KEYWORDS.test(text);
  const looksLikeWithdrawalOnly = NON_DEPOSIT_KEYWORDS.test(text) && !/입금|received|deposit|credited/i.test(text);
  if (!hasDepositKeyword || looksLikeWithdrawalOnly) {
    return {
      isDeposit: false,
      amount: null,
      depositorName: null,
      depositorMasked: false,
      bankName: detectBank(text, rules),
      txnId: null,
      confidence: "low",
      reason: looksLikeWithdrawalOnly ? "not_a_deposit" : "no_deposit_keyword",
      rawText,
    };
  }

  const amountResult = pickAmount(collectAmountCandidates(text, rules));
  const depositorResult = extractDepositor(text, rules);
  const bankName = detectBank(text, rules);
  const txnId = extractTxnId(text, rules);

  const depositorMasked = /[*○●]/.test(depositorResult.name ?? "");
  const reasons: string[] = [];
  if (amountResult.ambiguous) reasons.push("multiple_amounts");
  if (depositorResult.ambiguous) reasons.push("multiple_depositors");
  if (amountResult.amount === null) reasons.push("amount_not_found");
  if (depositorResult.name === null) reasons.push("depositor_not_found");
  if (amountResult.confidence === "low") reasons.push("low_amount_confidence");
  if (depositorResult.confidence === "low") reasons.push("low_depositor_confidence");

  let confidence: ParsedDeposit["confidence"] = "low";
  if (
    amountResult.confidence === "high" &&
    depositorResult.confidence === "high" &&
    !amountResult.ambiguous &&
    !depositorResult.ambiguous
  ) {
    confidence = "high";
  } else if (
    amountResult.amount !== null &&
    depositorResult.name !== null &&
    !amountResult.ambiguous &&
    !depositorResult.ambiguous &&
    amountResult.confidence !== "low"
  ) {
    confidence = "medium";
  }

  return {
    isDeposit: true,
    amount: amountResult.amount,
    depositorName: depositorResult.name,
    depositorMasked,
    bankName,
    txnId,
    confidence,
    reason: reasons.length > 0 ? reasons.join(",") : "ok",
    rawText,
  };
}

export function parseBankParserRules(value: unknown): BankParserRule[] {
  if (!Array.isArray(value)) return [];
  const rules: BankParserRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.bankName !== "string") continue;
    rules.push({
      id: candidate.id,
      bankName: candidate.bankName,
      keywords: Array.isArray(candidate.keywords)
        ? candidate.keywords.filter((keyword): keyword is string => typeof keyword === "string")
        : undefined,
      amountPatterns: Array.isArray(candidate.amountPatterns)
        ? candidate.amountPatterns.filter((pattern): pattern is string => typeof pattern === "string")
        : undefined,
      depositorPatterns: Array.isArray(candidate.depositorPatterns)
        ? candidate.depositorPatterns.filter((pattern): pattern is string => typeof pattern === "string")
        : undefined,
      txnIdPatterns: Array.isArray(candidate.txnIdPatterns)
        ? candidate.txnIdPatterns.filter((pattern): pattern is string => typeof pattern === "string")
        : undefined,
      requireKeyword: candidate.requireKeyword === true,
    });
  }
  return rules;
}
