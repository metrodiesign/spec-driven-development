// Pure i18n dictionary + resolution logic (REQ-22). Dependency-free: a typed
// dictionary keyed by LocaleKey, TH checked complete against EN at typecheck
// time (`th` is typed `Record<LocaleKey, string>` — a missing key is a type
// error). The view (I18nContext.tsx) owns the Context/localStorage side
// effects — same split as logic/theme.ts.
//
// UI chrome only (design.md "H"). Backend-authored strings (event payloads,
// CLI output, error details, the INV-13 quota label), spec feature codenames
// (F-Loop/F-Sched/...), and domain/audit values (risk class, task/session
// ids, state-machine states) never go through t() — translating them would
// falsify evidence (REQ-22.3).

export type Locale = 'en' | 'th';

export const LOCALE_STORAGE_KEY = 'console-locale';

export function isLocale(value: string | null): value is Locale {
  return value === 'en' || value === 'th';
}

/** WHEN no preference is stored, follow the browser's language (REQ-22.2, same pattern as theme.ts's resolveInitialTheme). */
export function resolveInitialLocale(stored: string | null, prefersThai: boolean): Locale {
  if (isLocale(stored)) return stored;
  return prefersThai ? 'th' : 'en';
}

/** A stored/toggled choice wins over the browser default in both directions. */
export function toggleLocale(current: Locale): Locale {
  return current === 'th' ? 'en' : 'th';
}

const en = {
  // common
  loading: 'loading…',
  fetchUnavailable: 'unavailable — try again later',
  appErrorBoundaryFallback: 'Something went wrong — try reloading the page.',
  approve: 'Approve',
  deny: 'Deny',
  reject: 'Reject',
  themeToggleToDark: 'Dark mode',
  themeToggleToLight: 'Light mode',
  localeToggleToThai: 'ภาษาไทย',
  localeToggleToEnglish: 'English',

  // App shell
  appTitle: 'Platform Console',
  appStatusDisclaimerFallback:
    'Third-party tool operating on your local Claude Code installation — not an Anthropic product.',
  appStatusHeading: 'Status',
  appCliStatusAriaLabel: 'CLI status',
  appAuthStatusAriaLabel: 'Auth status',
  appCliVersionPrefix: 'CLI version:',
  appActiveRunsInfix: '· active runs:',
  appUsageHeading: 'Usage (estimate)',
  appUsageAriaLabel: 'Usage estimate',
  appWindowsOpenedLine: '5h windows opened in the last 7 days: {count}',
  appWeeklySinceLine: 'Weekly since {date}: {count} entries',
  appCalibratedSuffix: ' · calibrated at {percent}%',
  appProjectsHeading: 'Projects',
  appNoProjectsFallback: 'no projects yet',
  appSessionsCountSuffix: '({count} sessions)',
  appSessionsHeadingPrefix: 'Sessions —',
  appSessionsAriaLabel: 'Sessions',
  appSessionsCaption: 'Sessions read live from local transcripts',
  appThSession: 'session',
  appThFirst: 'first',
  appThLast: 'last',
  appThEntries: 'entries',

  // Chat (F-Chat)
  chatHeading: 'Chat',
  chatNonParityBanner: 'Not at CLI parity — no slash commands/plan mode; use Terminal for 100% parity',
  chatQuotaLabel: 'Quota:',
  chatResumeLabel: 'resume session id (optional)',
  chatForkLabel: 'fork',
  chatStartButton: 'Start chat',
  chatTranscriptAriaLabel: 'Transcript',
  chatEmptyTranscript: 'say something…',
  chatApproveToolPrefix: 'approve tool',
  chatApproveToolSuffix: '?',
  chatMessageAriaLabel: 'Message',
  chatSend: 'Send',
  chatSessionCreateFailed: 'session create failed: {error}',

  // Issues (F-Issue)
  issuesHeading: 'Issues',
  issuesUntrustedNotice: 'issue text is untrusted data — shown as plain text, never executed or run automatically',
  issuesFileHeading: 'File an issue',
  issuesTitleLabel: 'title',
  issuesBodyLabel: 'body',
  issuesFileButton: 'File',
  issuesFilingFailed: 'filing failed: {error}',
  issuesActionFailed: '{action} failed: {status}',
  issuesNoIssuesYet: 'no issues yet',
  issuesIssueAriaLabel: 'Issue {id}',
  issuesConvertButton: 'Convert to draft goal',
  issuesDraftLabel: 'draft:',

  // Login
  loginSignInWithGoogle: 'Sign in with Google',
  loginFormAriaLabel: 'Login',
  loginPasswordLabel: 'Password',
  loginSigningIn: 'Signing in…',
  loginSignIn: 'Sign in',
  loginNetworkError: 'network error — try again',

  // Loop (F-Loop)
  loopHeading: 'Loop',
  loopRunsHeading: 'Runs',
  loopNoRuns: 'no discovered runs — start one with `platform loop run --live`',
  loopStateEnded: 'ended',
  loopStateLive: 'live',
  loopSelectedRunAriaLabel: 'Selected run',
  loopPause: 'Pause',
  loopResume: 'Resume',
  loopKill: 'Kill',
  loopSteeringGuidanceLabel: 'Steering guidance',
  loopQueueAtNextBoundary: 'Queue at next boundary',
  loopInjectNow: 'Inject now',
  loopApprovalPackagesHeading: 'Approval packages',
  loopNonePending: 'none pending',
  loopPollFailed: 'poll failed (events {events}, approvals {approvals})',
  loopPollFailedNetwork: 'poll failed: network error',
  loopActionFailed: '{path} failed: {status}',
  loopApprovalAriaLabel: 'Approval {id}',
  loopTaskPrefix: 'task',
  loopRiskInfix: '· risk',
  loopAcsInfix: '· ACs',
  loopUnresolvedPrefix: 'unresolved:',
  loopAttestationsLegend: 'Attestations',
  loopDeployHeading: 'Deploy',
  loopDeploySimulationNote: '(command-level simulation)',
  loopDeployStateLabel: 'state',
  loopDeployStatePending: 'pending',
  loopProbesSummary: '· probes {pass} passed / {fail} failed',
  loopRollBackButton: 'Roll back',

  // Sched (F-Sched)
  schedHeading: 'Sched',
  schedStarted: 'started (pid {pid})',
  schedStartRefused: 'start refused: {reason}',
  schedStopped: 'stopped',
  schedNothingRunning: 'nothing was running',
  schedScriptStarted: 'script started (pid {pid})',
  schedScriptRefused: 'script refused: {error}',
  schedLoopRunHeading: 'Loop run',
  schedGoalPathLabel: 'goal.yaml path',
  schedTaskIdLabel: 'task id (optional)',
  schedLiveLabel: 'live',
  schedStartButton: 'Start',
  schedStopButton: 'Stop',
  schedConfirmStartAriaLabel: 'Confirm start',
  schedConfirmAndStartButton: 'Confirm and start',
  schedCancelButton: 'Cancel',
  schedScriptSectionAriaLabel: 'Script',
  schedAllowlistedScriptHeading: 'Allowlisted script',
  schedScriptNameLabel: 'script name',
  schedRunButton: 'Run',

  // Surfaces (F-MCP/F-Hook/F-Sub/F-Skill/F-Sys)
  surfacesHeading: 'Governance',
  surfacesAriaLabel: 'Governance surfaces',
  surfacesSystemHeading: 'System',
  surfacesDoctorPrefix: 'doctor:',
  surfacesDoctorOk: 'ok',
  surfacesDoctorUnavailable: 'unavailable',
  surfacesMcpHeading: 'MCP (project)',
  surfacesMcpAriaLabel: 'MCP servers',
  surfacesSelectProjectHint: 'select a project to view its',
  surfacesNoMcpYet: 'no .mcp.json yet',
  surfacesAuthenticateButton: 'Authenticate',
  surfacesHooksHeading: 'Hooks (user)',
  surfacesHooksAriaLabel: 'Hooks',
  surfacesHooksConsentNote: 'Edits require two-step consent (preview + confirm token) — see the CLI or the hook editor.',
  surfacesNoUserSettings: 'no user settings.json',
  surfacesSubagentsHeading: 'Subagents (user)',
  surfacesSubagentsAriaLabel: 'Subagents',
  surfacesSkillsHeading: 'Skills (user)',
  surfacesSkillsAriaLabel: 'Skills',

  // Terminal (F-Term)
  termHeading: 'Terminal',
  termOpenButton: 'Open Terminal (claude)',
  termResumeAriaLabel: 'Resume session id',
  termResumePlaceholder: 'resume session id (optional)',
  termDetachButton: 'Detach',
  termCreateFailed: 'create failed: {error}',
  termAttachFailed: 'attach failed: {status}',
  termDetachedNote: 'detached — the PTY keeps running on the backend (re-attach to resume)',
  termExitedSuffix: ' (exited)',
  termReattachButton: 'Re-attach',
  termPtyPrefix: 'PTY',
  termAttachedStatus: 'attached (single active writer)',
  termNotAttachedStatus: 'not attached',
};

const th: Record<keyof typeof en, string> = {
  // common
  loading: 'กำลังโหลด…',
  fetchUnavailable: 'ใช้งานไม่ได้ตอนนี้ — ลองใหม่ภายหลัง',
  appErrorBoundaryFallback: 'เกิดข้อผิดพลาด — ลองโหลดหน้านี้ใหม่',
  approve: 'อนุมัติ',
  deny: 'ปฏิเสธ',
  reject: 'ปฏิเสธ',
  themeToggleToDark: 'โหมดมืด',
  themeToggleToLight: 'โหมดสว่าง',
  localeToggleToThai: 'ภาษาไทย',
  localeToggleToEnglish: 'English',

  // App shell
  appTitle: 'Platform Console',
  appStatusDisclaimerFallback: 'เครื่องมือจากบุคคลที่สาม ทำงานบน Claude Code ที่ติดตั้งในเครื่องของคุณ — ไม่ใช่ผลิตภัณฑ์ของ Anthropic',
  appStatusHeading: 'สถานะ',
  appCliStatusAriaLabel: 'สถานะ CLI',
  appAuthStatusAriaLabel: 'สถานะการยืนยันตัวตน',
  appCliVersionPrefix: 'เวอร์ชัน CLI:',
  appActiveRunsInfix: '· run ที่กำลังทำงาน:',
  appUsageHeading: 'การใช้งาน (ประมาณการ)',
  appUsageAriaLabel: 'ประมาณการการใช้งาน',
  appWindowsOpenedLine: 'จำนวนหน้าต่าง 5 ชม. ที่เปิดใน 7 วันล่าสุด: {count}',
  appWeeklySinceLine: 'รายสัปดาห์ตั้งแต่ {date}: {count} รายการ',
  appCalibratedSuffix: ' · ปรับเทียบที่ {percent}%',
  appProjectsHeading: 'โปรเจกต์',
  appNoProjectsFallback: 'ยังไม่มีโปรเจกต์',
  appSessionsCountSuffix: '({count} เซสชัน)',
  appSessionsHeadingPrefix: 'เซสชัน —',
  appSessionsAriaLabel: 'เซสชัน',
  appSessionsCaption: 'เซสชันอ่านสดจาก transcript ในเครื่อง',
  appThSession: 'เซสชัน',
  appThFirst: 'เริ่มแรก',
  appThLast: 'ล่าสุด',
  appThEntries: 'รายการ',

  // Chat (F-Chat)
  chatHeading: 'แชท',
  chatNonParityBanner: 'ไม่ครบเท่า CLI — slash commands/plan mode ไม่มี; ใช้ Terminal สำหรับ 100% parity',
  chatQuotaLabel: 'โควตา:',
  chatResumeLabel: 'resume session id (ไม่บังคับ)',
  chatForkLabel: 'fork',
  chatStartButton: 'เริ่มแชท',
  chatTranscriptAriaLabel: 'บทสนทนา',
  chatEmptyTranscript: 'พิมพ์อะไรสักอย่าง…',
  chatApproveToolPrefix: 'อนุมัติ tool',
  chatApproveToolSuffix: '?',
  chatMessageAriaLabel: 'ข้อความ',
  chatSend: 'ส่ง',
  chatSessionCreateFailed: 'สร้างเซสชันไม่สำเร็จ: {error}',

  // Issues (F-Issue)
  issuesHeading: 'Issues',
  issuesUntrustedNotice: 'ข้อความ issue เป็นข้อมูลที่ไม่น่าเชื่อถือ (untrusted) — แสดงเป็นข้อความล้วน ไม่ถูกรันหรือ execute โดยอัตโนมัติ',
  issuesFileHeading: 'แจ้ง issue',
  issuesTitleLabel: 'หัวข้อ',
  issuesBodyLabel: 'รายละเอียด',
  issuesFileButton: 'แจ้ง',
  issuesFilingFailed: 'แจ้ง issue ไม่สำเร็จ: {error}',
  issuesActionFailed: '{action} ไม่สำเร็จ: {status}',
  issuesNoIssuesYet: 'ยังไม่มี issue',
  issuesIssueAriaLabel: 'Issue {id}',
  issuesConvertButton: 'แปลงเป็น draft goal',
  issuesDraftLabel: 'draft:',

  // Login
  loginSignInWithGoogle: 'เข้าสู่ระบบด้วย Google',
  loginFormAriaLabel: 'เข้าสู่ระบบ',
  loginPasswordLabel: 'รหัสผ่าน',
  loginSigningIn: 'กำลังเข้าสู่ระบบ…',
  loginSignIn: 'เข้าสู่ระบบ',
  loginNetworkError: 'เครือข่ายมีปัญหา — ลองใหม่อีกครั้ง',

  // Loop (F-Loop)
  loopHeading: 'Loop',
  loopRunsHeading: 'Runs',
  loopNoRuns: 'ยังไม่พบ run — เริ่มได้ด้วย `platform loop run --live`',
  loopStateEnded: 'จบแล้ว',
  loopStateLive: 'กำลังทำงาน',
  loopSelectedRunAriaLabel: 'Run ที่เลือก',
  loopPause: 'หยุดชั่วคราว',
  loopResume: 'ทำงานต่อ',
  loopKill: 'ยกเลิก',
  loopSteeringGuidanceLabel: 'คำแนะนำการบังคับทิศทาง',
  loopQueueAtNextBoundary: 'จัดคิวที่ boundary ถัดไป',
  loopInjectNow: 'ฉีดตอนนี้เลย',
  loopApprovalPackagesHeading: 'แพ็กเกจอนุมัติ',
  loopNonePending: 'ไม่มีรายการรออนุมัติ',
  loopPollFailed: 'poll ไม่สำเร็จ (events {events}, approvals {approvals})',
  loopPollFailedNetwork: 'poll ไม่สำเร็จ: เครือข่ายมีปัญหา',
  loopActionFailed: '{path} ไม่สำเร็จ: {status}',
  loopApprovalAriaLabel: 'อนุมัติ {id}',
  loopTaskPrefix: 'task',
  loopRiskInfix: '· risk',
  loopAcsInfix: '· ACs',
  loopUnresolvedPrefix: 'ยังไม่คลี่คลาย:',
  loopAttestationsLegend: 'Attestations',
  loopDeployHeading: 'Deploy',
  loopDeploySimulationNote: '(จำลองระดับคำสั่ง)',
  loopDeployStateLabel: 'state',
  loopDeployStatePending: 'รอดำเนินการ',
  loopProbesSummary: '· probes ผ่าน {pass} / ไม่ผ่าน {fail}',
  loopRollBackButton: 'ย้อนกลับ',

  // Sched (F-Sched)
  schedHeading: 'Sched',
  schedStarted: 'เริ่มแล้ว (pid {pid})',
  schedStartRefused: 'เริ่มไม่สำเร็จ: {reason}',
  schedStopped: 'หยุดแล้ว',
  schedNothingRunning: 'ไม่มีอะไรทำงานอยู่',
  schedScriptStarted: 'สคริปต์เริ่มแล้ว (pid {pid})',
  schedScriptRefused: 'สคริปต์ถูกปฏิเสธ: {error}',
  schedLoopRunHeading: 'รัน Loop',
  schedGoalPathLabel: 'พาธ goal.yaml',
  schedTaskIdLabel: 'task id (ไม่บังคับ)',
  schedLiveLabel: 'live',
  schedStartButton: 'เริ่ม',
  schedStopButton: 'หยุด',
  schedConfirmStartAriaLabel: 'ยืนยันการเริ่ม',
  schedConfirmAndStartButton: 'ยืนยันและเริ่ม',
  schedCancelButton: 'ยกเลิก',
  schedScriptSectionAriaLabel: 'สคริปต์',
  schedAllowlistedScriptHeading: 'สคริปต์ที่อนุญาต',
  schedScriptNameLabel: 'ชื่อสคริปต์',
  schedRunButton: 'รัน',

  // Surfaces (F-MCP/F-Hook/F-Sub/F-Skill/F-Sys)
  surfacesHeading: 'Governance',
  surfacesAriaLabel: 'Governance surfaces',
  surfacesSystemHeading: 'ระบบ',
  surfacesDoctorPrefix: 'doctor:',
  surfacesDoctorOk: 'ปกติ',
  surfacesDoctorUnavailable: 'ใช้งานไม่ได้',
  surfacesMcpHeading: 'MCP (โปรเจกต์)',
  surfacesMcpAriaLabel: 'เซิร์ฟเวอร์ MCP',
  surfacesSelectProjectHint: 'เลือกโปรเจกต์เพื่อดู',
  surfacesNoMcpYet: 'ยังไม่มี .mcp.json',
  surfacesAuthenticateButton: 'ยืนยันตัวตน',
  surfacesHooksHeading: 'Hooks (ผู้ใช้)',
  surfacesHooksAriaLabel: 'Hooks',
  surfacesHooksConsentNote: 'การแก้ไขต้องยืนยันสองขั้นตอน (preview + confirm token) — ดูที่ CLI หรือตัวแก้ไข hook',
  surfacesNoUserSettings: 'ยังไม่มี user settings.json',
  surfacesSubagentsHeading: 'Subagents (ผู้ใช้)',
  surfacesSubagentsAriaLabel: 'Subagents',
  surfacesSkillsHeading: 'Skills (ผู้ใช้)',
  surfacesSkillsAriaLabel: 'Skills',

  // Terminal (F-Term)
  termHeading: 'Terminal',
  termOpenButton: 'เปิด Terminal (claude)',
  termResumeAriaLabel: 'Resume session id',
  termResumePlaceholder: 'resume session id (ไม่บังคับ)',
  termDetachButton: 'Detach',
  termCreateFailed: 'สร้างไม่สำเร็จ: {error}',
  termAttachFailed: 'attach ไม่สำเร็จ: {status}',
  termDetachedNote: 'detach แล้ว — PTY ยังทำงานอยู่ฝั่ง backend (re-attach เพื่อกลับมาต่อ)',
  termExitedSuffix: ' (exited)',
  termReattachButton: 'Re-attach',
  termPtyPrefix: 'PTY',
  termAttachedStatus: 'attached (ตัวเขียนที่ทำงานอยู่หนึ่งเดียว)',
  termNotAttachedStatus: 'ยังไม่ attach',
};

export type LocaleKey = keyof typeof en;

const dicts: Record<Locale, Record<LocaleKey, string>> = { en, th };

/** Fills `{param}` placeholders; a missing param leaves the literal placeholder in place. */
export function translate(locale: Locale, key: LocaleKey, params?: Record<string, string | number>): string {
  const template = dicts[locale][key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (literal, name: string) => (name in params ? String(params[name]) : literal));
}
