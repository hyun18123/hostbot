import {
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  SlashCommandStringOption,
  SlashCommandIntegerOption,
  SlashCommandAttachmentOption,
} from "discord.js";

function botOption(option: SlashCommandStringOption, required = true): SlashCommandStringOption {
  return option
    .setName("bot")
    .setDescription("호스팅 봇을 선택하세요.")
    .setAutocomplete(true)
    .setRequired(required);
}

const hosting = new SlashCommandBuilder()
  .setName("호스팅")
  .setDescription("디스코드 봇 호스팅을 관리합니다.")
  .addSubcommand((sub) =>
    sub
      .setName("등록")
      .setDescription("ZIP 파일과 봇 토큰으로 새 봇을 등록합니다.")
      .addAttachmentOption((option) =>
        option.setName("zip").setDescription("봇 소스 ZIP 파일 (최대 20MB)").setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName("목록").setDescription("내가 등록한 봇 목록을 확인합니다."))
  .addSubcommand((sub) =>
    sub
      .setName("정보")
      .setDescription("봇 상태와 이용 만료일을 확인합니다.")
      .addStringOption((option) => botOption(option)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("시작")
      .setDescription("봇을 시작합니다.")
      .addStringOption((option) => botOption(option)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("종료")
      .setDescription("봇을 종료합니다.")
      .addStringOption((option) => botOption(option)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("재시작")
      .setDescription("봇을 재시작합니다.")
      .addStringOption((option) => botOption(option)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("로그")
      .setDescription("봇 실행 로그를 확인합니다.")
      .addStringOption((option) => botOption(option))
      .addIntegerOption((option) =>
        option
          .setName("lines")
          .setDescription("가져올 로그 줄 수 (기본 100)")
          .setMinValue(10)
          .setMaxValue(300)
          .setRequired(false),
      ),
  );

const payment = new SlashCommandBuilder()
  .setName("결제")
  .setDescription("호스팅 이용료를 결제합니다.")
  .addSubcommand((sub) =>
    sub
      .setName("신청")
      .setDescription("입금 대기 신청을 등록합니다.")
      .addStringOption((option) => botOption(option))
      .addIntegerOption((option) =>
        option
          .setName("months")
          .setDescription("결제할 개월 수 (1~3, 기본 1개월)")
          .setMinValue(1)
          .setMaxValue(3)
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName("상태").setDescription("결제 신청과 승인 내역을 확인합니다."));

const pricing = new SlashCommandBuilder()
  .setName("요금제")
  .setDescription("호스팅 요금과 입금 계좌를 확인합니다.");

function adminBotOption(option: SlashCommandStringOption): SlashCommandStringOption {
  return option
    .setName("bot")
    .setDescription("대상 봇을 선택하세요.")
    .setAutocomplete(true)
    .setRequired(true);
}

const admin = new SlashCommandBuilder()
  .setName("관리자")
  .setDescription("호스팅 운영자 전용 명령어입니다.")
  .addSubcommand((sub) => sub.setName("통계").setDescription("전체 호스팅 통계를 확인합니다."))
  .addSubcommand((sub) =>
    sub
      .setName("결제내역")
      .setDescription("결제 신청과 승인 내역을 조회합니다.")
      .addStringOption((option) =>
        option
          .setName("status")
          .setDescription("조회할 상태")
          .setRequired(false)
          .addChoices(
            { name: "입금 대기", value: "awaiting_deposit" },
            { name: "관리자 확인 필요", value: "manual_review" },
            { name: "승인", value: "approved" },
            { name: "거절", value: "rejected" },
            { name: "만료", value: "expired" },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("결제승인")
      .setDescription("결제 신청을 수동으로 승인합니다.")
      .addStringOption((option) =>
        option.setName("code").setDescription("신청 코드 (예: HB-AB12CD) 또는 ID").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("결제거절")
      .setDescription("결제 신청을 거절합니다.")
      .addStringOption((option) =>
        option.setName("code").setDescription("신청 코드 (예: HB-AB12CD) 또는 ID").setRequired(true),
      )
      .addStringOption((option) => option.setName("reason").setDescription("거절 사유").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("호스팅정지")
      .setDescription("특정 봇을 강제로 정지합니다.")
      .addStringOption((option) => adminBotOption(option)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("호스팅삭제")
      .setDescription("특정 봇의 호스팅 데이터를 삭제합니다.")
      .addStringOption((option) => adminBotOption(option))
      .addStringOption((option) =>
        option.setName("confirm").setDescription("'삭제'를 정확히 입력하세요.").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("공지")
      .setDescription("전체 사용자에게 DM 공지를 발송합니다.")
      .addStringOption((option) => option.setName("message").setDescription("공지 내용").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("설정")
      .setDescription("서비스 설정을 조회하거나 변경합니다.")
      .addStringOption((option) =>
        option.setName("key").setDescription("설정 키 (예: bank_account)").setRequired(false),
      )
      .addStringOption((option) =>
        option.setName("value").setDescription("새 값 (JSON 또는 문자열)").setRequired(false),
      ),
  );

export const commandDefinitions = [hosting, payment, pricing, admin] as const;

export const commandNames = commandDefinitions.map((command) => command.name);

export function commandsJson(): unknown[] {
  return commandDefinitions.map((command) => command.toJSON());
}

export function subcommandsOf(commandName: string): string[] {
  const command = commandDefinitions.find((candidate) => candidate.name === commandName);
  const data = command?.toJSON() as { options?: Array<{ type: number; name: string; options?: Array<{ type: number; name: string }> }> } | undefined;
  return (data?.options ?? [])
    .filter((option) => option.type === 1)
    .map((option) => option.name);
}

export type { SlashCommandSubcommandBuilder };
