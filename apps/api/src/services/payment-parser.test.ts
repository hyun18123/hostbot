import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDepositNotification } from "./payment-parser.js";

test("parses a typical Korean bank SMS", () => {
  const result = parseDepositNotification({
    title: "[KB국민은행]",
    body: "12/20 14:03 123456-78-901234 홍길동 3,900원 입금 잔액 50,000원",
    appName: "메시지",
  });
  assert.equal(result.isDeposit, true);
  assert.equal(result.amount, 3900);
  assert.equal(result.depositorName, "홍길동");
  assert.equal(result.bankName, "국민");
  assert.equal(result.confidence, "high");
});

test("ignores balance and picks deposit amount", () => {
  const result = parseDepositNotification({
    body: "입금 3,900원 잔액 103,900원",
  });
  assert.equal(result.amount, 3900);
});

test("does not treat a withdrawal as a deposit", () => {
  const result = parseDepositNotification({
    body: "12/20 출금 3,900원 잔액 10,000원",
  });
  assert.equal(result.isDeposit, false);
});

test("masks are preserved", () => {
  const result = parseDepositNotification({
    body: "홍*동 3,900원 입금",
  });
  assert.equal(result.isDeposit, true);
  assert.equal(result.depositorMasked, true);
  assert.equal(result.depositorName, "홍*동");
});

test("labelled depositor and transaction id win", () => {
  const result = parseDepositNotification({
    body: "입금액 3,900원 입금자명: 홍길동 거래번호: 2026122012345678",
  });
  assert.equal(result.depositorName, "홍길동");
  assert.equal(result.txnId, "2026122012345678");
  assert.equal(result.confidence, "high");
});

test("multiple equal-score amounts lower confidence", () => {
  const result = parseDepositNotification({
    body: "입금 3,900원 입금 7,800원",
  });
  assert.equal(result.isDeposit, true);
  assert.equal(result.confidence, "low");
});

test("unrelated notification is ignored", () => {
  const result = parseDepositNotification({ body: "새로운 업데이트가 있습니다" });
  assert.equal(result.isDeposit, false);
});
