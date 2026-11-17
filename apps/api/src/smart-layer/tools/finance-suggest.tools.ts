/**
 * Phase E4: finance tools beyond `expense_add` (finance.tools.ts).
 *
 * The owner's binding accounting decision (2026-11-14): the AI PROPOSES each journal entry / bank match / FX fix and the merchant clicks each one.
 * So every write here is ONE card = ONE record: the args schema has no list of entries, matches or rates, `run` calls the posting service exactly
 * once, and there is deliberately NO batch apply (a reconciliation of 30 bank lines is 30 `bank_match_suggest` cards).
 *
 *   journal_entry_suggest  finance.journal-accounts  `postManualEntry` (the service `POST /finance/journal` calls). EGP lines only; DR must equal CR.
 *                          RESIDUAL (see JOURNAL_ROLES): the route is `authorize('super_admin')` today; the capability says owner may.
 *   account_add            finance.journal-accounts  `createChildAccount` (`POST /finance/accounts`).
 *   bank_match_suggest     finance.bank-reconciliation  `applyManualMatch` (`PATCH .../bank-statements/:sid/transactions/:tid`): match | unmatch | ignore.
 *   fx_rate_set            finance.fx-anomalies      `recordFxRate` (extracted from `POST /finance/fx-rates`).
 *   profit_anomaly_ack     finance.fx-anomalies      `acknowledgeProfitAnomaly` (extracted from `POST /finance/anomalies/:id/acknowledge`).
 *   vat_registration_submit finance.tax-vat          `TaxProfileService.submit` (`POST /tax/profile/submit`): sends the merchant's VAT registration for review.
 *   finance_overview / finance_profit_and_loss / finance_balance_sheet / finance_vat_report / bank_unmatched_list / profit_anomalies_list
 *                          finance.overview-reports (free reads, same services as the GET routes); invoices_list / invoice_get  finance.invoices-fiscal.
 * There is no "close/file a VAT period" feature in the codebase and no accounting period lock (finance.routes.ts has none), so neither is faked here.
 */
import { z } from 'zod/v3';
import type { ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';
import {
  ALLOWED_CURRENCIES,
  TAX_PROFILE_EDITABLE_STATUSES,
  zonedDayEnd,
  zonedDayStart,
  zonedMonthStartDay,
} from '@ebda/shared';
import type { Role } from '../../middleware/rbac';
import { AppError } from '../../middleware/error-handler';
import { storeDb } from '../../lib/repo-factory';
import { runInStoreCtx } from '../../lib/jobs/store-db';
import { readInStoreContext } from '../../lib/store-scoped-read';
import { storeTimeZone } from '../../lib/report-range';
import { MerchantForbidden, assertMerchantMay } from '../../mcp/run-as-merchant';
import { postManualEntry } from '../../services/accounting/journal.service';
import {
  createChildAccount,
  listAccountsTree,
  type AccountsTreeNode,
} from '../../services/accounting/account.service';
import { applyManualMatch } from '../../services/accounting/bank-reconcile.service';
import { latestFxRate, recordFxRate } from '../../services/accounting/fx-rate.service';
import {
  acknowledgeProfitAnomaly,
  getProfitAnomaly,
} from '../../services/accounting/profit-anomaly.service';
import {
  balanceSheet,
  profitAndLoss,
  type TrialBalanceRow,
} from '../../services/accounting/reports.service';
import { AnalyticsService, cogsFromPnl, ledgerCostsFields } from '../../services/analytics.service';
import { dashboardStockValues } from '../../services/accounting/dashboard-stock';
import { generateTaxReport } from '../../services/accounting/tax-report.service';
import {
  FiscalDocumentService,
  type FiscalDocTypeValue,
} from '../../services/fiscal-document.service';
import { TaxProfileService } from '../../services/tax-profile.service';
import { change, egp, f, pair, row, shape, type Described } from './kit';

type Rec = Record<string, unknown>;
const STORE_ROLES = ['store_admin'] as const; // the routes' `authorize('store_admin', 'super_admin')`; a super admin never acts through the assistant
/**
 * `POST /finance/journal` is `authorize('super_admin')` (finance.routes.ts) with the comment "store admins post via service helpers, not raw GL, in v1",
 * while capability finance.journal-accounts lists the owner and the owner's decision is "the AI proposes, the merchant clicks each entry". The tool
 * is therefore CLOSED (empty list: every role is refused at preview and apply) until the route lets owners post; then set this to STORE_ROLES.
 */
const JOURNAL_ROLES: readonly Role[] = []; // fail closed: no role may use the tool until the route allows owners
const minor = (v: number) => Math.round(v * 100);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const ymd = {
  z: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
    .refine(v => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), 'not a real date'),
  js: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'A date, YYYY-MM-DD.' },
};

const flatten = (nodes: AccountsTreeNode[]): AccountsTreeNode[] =>
  nodes.flatMap(n => [n, ...flatten(n.children)]);
const allAccounts = async (storeId: string): Promise<AccountsTreeNode[]> =>
  Object.values(await listAccountsTree(storeId)).flatMap(n => flatten(n as AccountsTreeNode[]));
const acctLabel = (a: { code: string; nameAr?: string | null; nameEn: string }) =>
  `${a.code} ${a.nameAr ?? a.nameEn}`;
const notFound = () =>
  new AppError(404, 'NOT_FOUND', 'One or more referenced records were not found');

// ---- journal_entry_suggest ---------------------------------------------------------------------------------------------------------------
type JournalLine = { accountId: string; debitEgp?: number; creditEgp?: number; lineMemo?: string };
type JournalArgs = { memo?: string; memoAr?: string; postedAt?: string; lines: JournalLine[] };

const journalShape = shape<JournalArgs>(
  {
    memo: f.text('Memo in English.', { max: 500 }),
    memoAr: f.text('Memo in Arabic.', { max: 500 }),
    postedAt: ymd,
    lines: f.list(
      f.obj(
        {
          accountId: f.id('Chart-of-accounts id of the account.'),
          debitEgp: f.num('Debit in EGP (decimal), or leave out.', { max: 100_000_000 }),
          creditEgp: f.num('Credit in EGP (decimal), or leave out.', { max: 100_000_000 }),
          lineMemo: f.text('Note on this line.', { max: 300 }),
        },
        ['accountId']
      ),
      {
        min: 2,
        max: 20,
        description: 'The lines of ONE entry. Total debit must equal total credit.',
      }
    ),
  },
  ['lines']
);

// pq-allow(unused-export): imported by tests/unit/assistant-tools-finance-suggest.test.ts (built and tested, deliberately not offered: Ruling SL-E4-1)
export const journalEntrySuggest = change<JournalArgs>({
  name: 'journal_entry_suggest',
  capabilityId: 'finance.journal-accounts',
  description:
    'Propose ONE manual journal entry (قيد يومية) for the merchant to approve: its lines (account, debit or credit in EGP as a decimal) with total debit equal to total credit, optional memo and date. One card posts one entry; to post several entries, call this tool once per entry. Works with EGP only.',
  schema: journalShape,
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  gate: { roles: JOURNAL_ROLES, feature: 'accounting.basic' },
  audit: { action: 'journal.assistant_posted', resourceType: 'journal_entry' },
  state: async (ctx, a) => {
    const all = await allAccounts(ctx.storeId); // store-scoped: a foreign account id is simply not in it
    return [...new Set(a.lines.map(l => l.accountId))].sort().map(id => {
      const x = all.find(n => n.id === id);
      if (!x) throw notFound();
      return { id: x.id, code: x.code, nameEn: x.nameEn, nameAr: x.nameAr, isActive: x.isActive };
    });
  },
  describe: (_ctx, a, st): Described => {
    type Acct = {
      id: string;
      code: string;
      nameAr: string | null;
      nameEn: string;
      isActive: boolean;
    };
    const accts = new Map((st as Acct[]).map(x => [x.id, x]));
    let dr = 0;
    let cr = 0;
    const lineRows = a.lines.map((l, i) => {
      const d = minor(l.debitEgp ?? 0);
      const c = minor(l.creditEgp ?? 0);
      if (d > 0 === c > 0)
        throw new AppError(400, 'INVALID_LINE', 'Each line needs exactly one of debit or credit.');
      const acct = accts.get(l.accountId)!;
      if (!acct.isActive)
        throw new AppError(409, 'ACCOUNT_DISABLED', `Account ${acct.code} is disabled.`);
      dr += d;
      cr += c;
      return row(
        `سطر ${i + 1}`,
        `Line ${i + 1}`,
        null,
        `${acctLabel(acct)} | ${d > 0 ? `مدين / debit ${egp(d)}` : `دائن / credit ${egp(c)}`}${l.lineMemo ? ` | ${l.lineMemo}` : ''}`
      );
    });
    if (dr !== cr)
      throw new AppError(
        400,
        'UNBALANCED',
        `Total debit (${egp(dr)}) must equal total credit (${egp(cr)}).`
      );
    return {
      summary: pair(
        `ترحيل قيد يومية واحد بإجمالي ${egp(dr)} ج.م (${a.lines.length} سطور). التراجع بقيد عكسي من صفحة اليومية.`,
        `Post ONE journal entry totalling EGP ${egp(dr)} (${a.lines.length} lines). Corrected later with a reversing entry on the Journal page.`
      ),
      rows: [
        ...lineRows,
        row('إجمالي المدين (ج.م)', 'Total debit (EGP)', null, egp(dr)),
        row('إجمالي الدائن (ج.م)', 'Total credit (EGP)', null, egp(cr)),
        row('التاريخ', 'Date', null, a.postedAt ?? 'اليوم / today'),
        ...(a.memoAr || a.memo
          ? [row('البيان', 'Memo', null, [a.memoAr, a.memo].filter(Boolean).join(' / '))]
          : []),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) =>
    runInStoreCtx(ctx.storeId, () =>
      postManualEntry({
        storeId: ctx.storeId,
        source: 'manual',
        memo: a.memo || undefined,
        memoAr: a.memoAr || undefined,
        postedAt: a.postedAt ? new Date(`${a.postedAt}T00:00:00.000Z`) : undefined,
        postedBy: ctx.userId,
        lines: a.lines.map(l => ({
          accountId: l.accountId,
          debit: minor(l.debitEgp ?? 0),
          credit: minor(l.creditEgp ?? 0),
          lineMemo: l.lineMemo || undefined,
          currency: 'EGP',
        })),
      })
    ),
});

// ---- account_add -------------------------------------------------------------------------------------------------------------------------
type AccountArgs = { parentId: string; code: string; nameEn: string; nameAr?: string };
const accountAdd = change<AccountArgs>({
  name: 'account_add',
  capabilityId: 'finance.journal-accounts',
  description:
    'Add a custom account (حساب جديد) under an existing chart-of-accounts parent: parent id, a 4-6 digit code, an English name and optionally an Arabic name. The account type is inherited from the parent.',
  schema: shape<AccountArgs>(
    {
      parentId: f.id('The parent account id.'),
      code: f.str('4-6 digit account code, e.g. 510010.', { max: 6, min: 4 }),
      nameEn: f.str('English name.', { max: 120 }),
      nameAr: f.str('Arabic name.', { max: 120 }),
    },
    ['parentId', 'code', 'nameEn']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  gate: { roles: STORE_ROLES, feature: 'accounting.basic' },
  audit: {
    action: 'account.assistant_created',
    resourceType: 'account',
    resourceId: a => a.parentId,
  },
  state: async (ctx, a) => {
    const p = (await allAccounts(ctx.storeId)).find(n => n.id === a.parentId);
    if (!p) throw notFound();
    return { id: p.id, code: p.code, nameEn: p.nameEn, nameAr: p.nameAr, type: p.type };
  },
  describe: (_ctx, a, st): Described => {
    const p = st as { code: string; nameAr: string | null; nameEn: string; type: string };
    if (!/^\d{4,6}$/.test(a.code))
      throw new AppError(400, 'INVALID_CODE', 'Code must be 4-6 digits.');
    return {
      summary: pair(
        `إضافة حساب ${a.code} ${a.nameAr ?? a.nameEn} تحت ${acctLabel(p)}.`,
        `Add account ${a.code} ${a.nameEn} under ${p.code} ${p.nameEn}.`
      ),
      rows: [
        row('الحساب الأب', 'Parent account', null, acctLabel(p)),
        row('الكود', 'Code', null, a.code),
        row('الاسم', 'Name', null, a.nameEn),
        ...(a.nameAr ? [row('الاسم (عربي)', 'Name (Arabic)', null, a.nameAr)] : []),
        row('النوع', 'Type', null, p.type),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) =>
    runInStoreCtx(ctx.storeId, () =>
      createChildAccount({
        storeId: ctx.storeId,
        parentId: a.parentId,
        code: a.code,
        nameEn: a.nameEn,
        ...(a.nameAr ? { nameAr: a.nameAr } : {}),
      })
    ),
});

// ---- bank_match_suggest ------------------------------------------------------------------------------------------------------------------
type BankArgs = {
  transactionId: string;
  action: 'match' | 'unmatch' | 'ignore';
  journalEntryId?: string;
};
type BankState = {
  id: string;
  date: string | null;
  description: string;
  amountFils: number;
  direction: string;
  matchStatus: string;
  matchedJournalEntryId: string | null;
};
const BANK_FEATURE = 'accounting.bank_reconcile' as const;
const bankMatch = change<BankArgs>({
  name: 'bank_match_suggest',
  capabilityId: 'finance.bank-reconciliation',
  description:
    'Propose ONE bank-statement line action (مطابقة كشف البنك): match this bank transaction to a journal entry, unmatch it, or ignore it. One card = one bank line; for many lines call it once per line. Use bank_unmatched_list first to get the transaction ids and the candidate journal entries.',
  schema: shape<BankArgs>(
    {
      transactionId: f.id('The bank transaction id.'),
      action: f.enum(['match', 'unmatch', 'ignore'], 'match needs journalEntryId.'),
      journalEntryId: f.id('The journal entry to match (action=match).'),
    },
    ['transactionId', 'action']
  ),
  policy: 'confirm',
  undo: 'reversible',
  gate: { roles: STORE_ROLES, feature: BANK_FEATURE },
  audit: {
    action: 'bank.assistant_matched',
    resourceType: 'bank_transaction',
    resourceId: a => a.transactionId,
  },
  state: async (ctx, a): Promise<BankState> => {
    const t = await (
      await storeDb(ctx.storeId)
    ).bankTransaction.findFirst({
      where: { id: a.transactionId, storeId: ctx.storeId },
      select: {
        id: true,
        date: true,
        description: true,
        amountFils: true,
        direction: true,
        matchStatus: true,
        matchedJournalEntryId: true,
      },
    });
    if (!t) throw notFound();
    return {
      ...t,
      date: iso(t.date),
      direction: String(t.direction),
      matchStatus: String(t.matchStatus),
    };
  },
  describe: async (ctx, a, st): Promise<Described> => {
    const s = st as BankState;
    let entry: { entryNumber: unknown; memo: string | null } | null = null;
    if (a.action === 'match') {
      if (!a.journalEntryId)
        throw new AppError(400, 'bad_request', 'journalEntryId required for match action');
      entry = await readInStoreContext(ctx.storeId, async () =>
        (await storeDb(ctx.storeId)).journalEntry.findFirst({
          where: { id: a.journalEntryId, storeId: ctx.storeId },
          select: { entryNumber: true, memo: true },
        })
      );
      if (!entry) throw new AppError(404, 'journal_entry_not_found', 'journal_entry_not_found');
    }
    const after =
      a.action === 'match'
        ? `مطابق مع قيد ${String(entry!.entryNumber)} / matched to entry ${String(entry!.entryNumber)}`
        : a.action === 'ignore'
          ? 'متجاهل / ignored'
          : 'غير مطابق / unmatched';
    return {
      summary: pair(
        `بند البنك ${egp(s.amountFils)} ج.م (${s.direction === 'debit' ? 'مدين' : 'دائن'}): ${after.split(' / ')[0]}.`,
        `Bank line EGP ${egp(s.amountFils)} (${s.direction}): ${after.split(' / ')[1]}.`
      ),
      rows: [
        row('وصف البنك', 'Bank description', null, s.description),
        row('المبلغ (ج.م)', 'Amount (EGP)', null, egp(s.amountFils)),
        row('الحالة', 'Match status', s.matchStatus, after),
        ...(entry?.memo ? [row('بيان القيد', 'Entry memo', null, entry.memo)] : []),
      ],
      affectedCount: 1,
      restore: { matchStatus: s.matchStatus, matchedJournalEntryId: s.matchedJournalEntryId },
    };
  },
  run: (ctx, a) =>
    applyManualMatch({
      storeId: ctx.storeId,
      transactionId: a.transactionId,
      action: a.action,
      journalEntryId: a.action === 'match' ? a.journalEntryId : undefined,
    }),
  inverse: (a, restore) => {
    const r = restore as { matchStatus: string; matchedJournalEntryId: string | null };
    const action: BankArgs['action'] =
      r.matchStatus === 'ignored' ? 'ignore' : r.matchedJournalEntryId ? 'match' : 'unmatch';
    return {
      tool: 'bank_match_suggest',
      args: {
        transactionId: a.transactionId,
        action,
        ...(action === 'match' ? { journalEntryId: r.matchedJournalEntryId } : {}),
      },
    };
  },
});

// ---- fx_rate_set + profit_anomaly_ack ----------------------------------------------------------------------------------------------------
type FxArgs = { currency: string; rate: number; rateDate?: string };
const FX_FEATURE = 'accounting.multi_currency' as const;
const fxRateSet = change<FxArgs>({
  name: 'fx_rate_set',
  capabilityId: 'finance.fx-anomalies',
  description:
    'Record an exchange rate (سعر الصرف): the currency (e.g. USD) and how many EGP one unit is worth (a decimal, e.g. 48.5), optionally for a date. Rates are added as new entries, the latest one is used.',
  schema: shape<FxArgs>(
    {
      currency: f.enum(
        ALLOWED_CURRENCIES.filter(c => c !== 'EGP') as [string, ...string[]],
        'Currency code other than EGP.'
      ),
      rate: f.num('EGP per ONE unit of the currency, e.g. 48.5.', {
        min: 0.000001,
        max: 1_000_000,
      }),
      rateDate: ymd,
    },
    ['currency', 'rate']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  gate: { roles: STORE_ROLES, feature: FX_FEATURE },
  audit: {
    action: 'fx_rate.assistant_recorded',
    resourceType: 'fx_rate',
    resourceId: a => a.currency,
  },
  state: async (ctx, a) => {
    const l = await latestFxRate(ctx.storeId, a.currency);
    return l ? { id: l.id, rate: String(l.rate), rateDate: iso(l.rateDate) } : null;
  },
  describe: (_ctx, a, st): Described => {
    const prev = st as { rate: string; rateDate: string } | null;
    return {
      summary: pair(
        `تسجيل سعر ${a.currency} = ${a.rate} ج.م (لا يمكن التراجع من المساعد).`,
        `Record ${a.currency} = EGP ${a.rate} (cannot be undone from the assistant).`
      ),
      rows: [
        row('السعر (ج.م لكل وحدة)', 'Rate (EGP per unit)', prev?.rate ?? null, String(a.rate)),
        row('التاريخ', 'Date', prev?.rateDate?.slice(0, 10) ?? null, a.rateDate ?? 'اليوم / today'),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) =>
    runInStoreCtx(ctx.storeId, () =>
      recordFxRate(ctx.storeId, {
        currency: a.currency,
        rate: a.rate,
        rateDate: a.rateDate ? new Date(a.rateDate) : new Date(),
        recordedBy: ctx.userId,
      })
    ),
});

type AnomalyArgs = { anomalyId: string };
const anomalyAck = change<AnomalyArgs>({
  name: 'profit_anomaly_ack',
  capabilityId: 'finance.fx-anomalies',
  description:
    'Mark ONE profit anomaly (شذوذ الربحية) as seen/acknowledged, by its id (get ids from profit_anomalies_list). The alert stays in history.',
  schema: shape<AnomalyArgs>({ anomalyId: f.id('The anomaly id.') }, ['anomalyId']),
  policy: 'confirm',
  undo: 'irreversible',
  gate: { roles: STORE_ROLES, feature: 'accounting.profit_anomaly' },
  audit: {
    action: 'profit_anomaly.assistant_acknowledged',
    resourceType: 'profit_anomaly',
    resourceId: a => a.anomalyId,
  },
  state: async (ctx, a) => {
    const x = await getProfitAnomaly(ctx.storeId, a.anomalyId);
    if (!x) throw notFound();
    return { id: x.id, acknowledged: x.acknowledged };
  },
  describe: async (ctx, a, st): Promise<Described> => {
    const s = st as { acknowledged: boolean };
    const x = (await getProfitAnomaly(ctx.storeId, a.anomalyId))!;
    return {
      summary: pair(
        s.acknowledged ? 'التنبيه متعلّم عليه أصلاً.' : 'تعليم تنبيه الربحية كمقروء.',
        s.acknowledged ? 'This alert is already acknowledged.' : 'Acknowledge this profit alert.'
      ),
      rows: [
        row('المقياس', 'Metric', null, String(x.metric)),
        row('الخطورة', 'Severity', null, String(x.severity)),
        row('التغيّر %', 'Change %', null, x.deltaPercent.toFixed(1)),
        row('الحالة', 'Acknowledged', s.acknowledged, true),
      ],
      affectedCount: s.acknowledged ? 0 : 1,
    };
  },
  run: (ctx, a) =>
    runInStoreCtx(ctx.storeId, () =>
      acknowledgeProfitAnomaly(ctx.storeId, a.anomalyId, ctx.userId)
    ),
});

// ---- vat_registration_submit ------------------------------------------------------------------------------------------------------------
/** The legal statement the route demands (`taxProfileSubmitSchema.attest`), verbatim from the VAT screen's copy (admin i18n `attest`). The card shows it and the confirm covers it. */
const VAT_ATTESTATION = {
  ar: 'أقرّ بأن هذه المنشأة مسجّلة في ضريبة القيمة المضافة لدى مصلحة الضرائب المصرية',
  en: 'I confirm this business is registered for VAT with the Egyptian Tax Authority',
} as const;
const attestField = {
  z: z.literal(true),
  js: {
    type: 'boolean',
    enum: [true],
    description: 'Must be true: the merchant attests, on the card, the statement it shows.',
  },
};
const vatSubmit = change<{ attest: true }>({
  name: 'vat_registration_submit',
  capabilityId: 'finance.tax-vat',
  description:
    "Submit the merchant's VAT registration (تسجيل ضريبة القيمة المضافة) for review: sends the saved tax registration number, legal name and uploaded documents to Ebda Store for verification. It cannot be withdrawn from the assistant; VAT is only charged after approval.",
  schema: shape<{ attest: true }>({ attest: attestField }, ['attest']),
  policy: 'confirm',
  undo: 'irreversible',
  gate: { roles: STORE_ROLES }, // routes/tax.routes.ts: authorize('store_admin', 'super_admin'), no requireFeature
  audit: { action: 'tax_profile.assistant_submitted', resourceType: 'tax_profile' },
  state: async ctx => {
    const p = await TaxProfileService.get(ctx.storeId);
    return {
      status: p.status,
      taxRegistrationNumber: p.taxRegistrationNumber,
      legalName: p.legalName,
      documents: p.documents.map(d => d.id).sort(),
      submittedAt: iso(p.submittedAt),
    };
  },
  describe: (_ctx, a, st): Described => {
    if (a.attest !== true)
      throw new AppError(
        400,
        'ATTESTATION_REQUIRED',
        'The VAT attestation must be shown and confirmed.'
      );
    const s = st as {
      status: string;
      taxRegistrationNumber: string | null;
      legalName: string | null;
      documents: string[];
    };
    if (!(TAX_PROFILE_EDITABLE_STATUSES as readonly string[]).includes(s.status))
      throw new AppError(409, 'NOT_EDITABLE', `The VAT registration is already ${s.status}.`);
    if (!s.taxRegistrationNumber || !s.legalName)
      throw new AppError(
        400,
        'INCOMPLETE',
        'Save the tax registration number and legal name first.'
      );
    if (s.documents.length === 0)
      throw new AppError(400, 'NO_DOCUMENTS', 'Upload at least one VAT document first.');
    return {
      summary: pair(
        'إرسال طلب تسجيل ضريبة القيمة المضافة للمراجعة (لا يمكن سحبه من المساعد).',
        'Send the VAT registration for review (cannot be withdrawn from the assistant).'
      ),
      rows: [
        row('الرقم الضريبي', 'Tax registration number', null, s.taxRegistrationNumber),
        row('الاسم القانوني', 'Legal name', null, s.legalName),
        row('عدد المستندات', 'Documents', null, s.documents.length),
        row(
          'الإقرار (يشمله التأكيد)',
          'Attestation (covered by your confirmation)',
          null,
          `${VAT_ATTESTATION.ar} / ${VAT_ATTESTATION.en}`
        ),
        row('الحالة', 'Status', s.status, 'submitted'),
      ],
      affectedCount: 1,
      restore: { attestation: VAT_ATTESTATION },
    };
  },
  run: ctx => TaxProfileService.submit(ctx.storeId, { userId: ctx.userId }),
});

// ---- free reads -------------------------------------------------------------------------------------------------------------------------
type Gate = {
  roles: readonly Role[];
  feature?: Parameters<typeof assertMerchantMay>[0]['feature'];
};
const FINANCE_READ: Gate = { roles: STORE_ROLES, feature: 'accounting.basic' };
async function readGate(ctx: TurnCtx, tool: string, g: Gate): Promise<void> {
  try {
    await assertMerchantMay({
      ...g,
      storeId: ctx.storeId,
      userId: ctx.userId,
      role: ctx.role,
      tool,
    });
  } catch (err) {
    if (err instanceof MerchantForbidden) throw new Error(`forbidden: ${tool}`);
    throw err;
  }
}
function readTool<A>(d: {
  name: string;
  capabilityId: string;
  description: string;
  schema: { args: z.ZodType<A>; jsonSchema: Record<string, unknown> };
  gate: Gate;
  untrusted?: boolean;
  read: (ctx: TurnCtx, a: A) => Promise<unknown>;
}): ToolSpec {
  return {
    name: d.name,
    capabilityId: d.capabilityId,
    description: d.description,
    args: d.schema.args,
    jsonSchema: d.schema.jsonSchema,
    policy: 'free',
    undo: 'none',
    resultTrust: d.untrusted ? 'untrusted' : 'store-data',
    read: async (ctx: TurnCtx, a: A) => {
      await readGate(ctx, d.name, d.gate);
      return readInStoreContext(ctx.storeId, () => d.read(ctx, a));
    },
  } as unknown as ToolSpec;
}
const money = (v: number) => egp(v);
const top = <T>(rows: T[]) => rows.slice(0, 10);
const bsRow = (r: TrialBalanceRow) => ({
  code: r.code,
  name: r.nameAr ?? r.nameEn,
  balance: money(r.balance),
});
async function window(
  storeId: string,
  a: { from?: string; to?: string },
  defaults: { from?: Date }
): Promise<{ from: Date; to: Date }> {
  const tz = await storeTimeZone(storeId);
  const now = new Date();
  const from = a.from
    ? zonedDayStart(a.from, tz)
    : (defaults.from ?? zonedDayStart(zonedMonthStartDay(now, tz), tz));
  const to = a.to ? zonedDayEnd(a.to, tz) : now;
  if (!from || !to) throw new AppError(422, 'invalid_date', 'from and to must be valid dates');
  return { from, to };
}
const rangeShape = shape<{ from?: string; to?: string }>({
  from: {
    z: ymd.z,
    js: { ...ymd.js, description: 'Start day, YYYY-MM-DD (default: start of this month).' },
  },
  to: { z: ymd.z, js: { ...ymd.js, description: 'End day, YYYY-MM-DD (default: today).' } },
});

const financeOverview = readTool<{ from?: string; to?: string }>({
  name: 'finance_overview',
  capabilityId: 'finance.overview-reports',
  description:
    'The finance dashboard (أرباحي الشهر ده كام؟ / المصروفات كام؟): revenue, expenses and net profit for a period (default this month), cash and bank balances, stock value and balance-sheet totals, all in EGP.',
  schema: rangeShape,
  gate: FINANCE_READ,
  read: async (ctx, a) => {
    const { from, to } = await window(ctx.storeId, a, {});
    const [pnl, bs, stock, coverage] = await Promise.all([
      profitAndLoss(ctx.storeId, from, to),
      balanceSheet(ctx.storeId, to),
      dashboardStockValues(ctx.storeId),
      AnalyticsService.soldLineCostCoverage(ctx.storeId, from, to),
    ]);
    const costs = ledgerCostsFields(pnl.totalRevenue, cogsFromPnl(pnl), coverage);
    return {
      revenueEgp: money(pnl.totalRevenue),
      expensesEgp: money(pnl.totalExpenses),
      // Revenue with no (or only some) cost of goods is not a real profit: say "unknown" / "partial", never the revenue.
      netProfitEgp: costs.costsStatus === 'unknown' ? null : money(pnl.netIncome),
      netProfitNote:
        costs.costsStatus === 'unknown'
          ? 'Unknown: no cost of goods is booked for this period, so net profit cannot be stated.'
          : costs.costsStatus === 'partial'
            ? `Partial: ${costs.costsMissing} of ${costs.costsTotal} sold items have no cost price, so the real profit is lower than stated.`
            : undefined,
      cash: top(bs.assets.filter(x => x.code.startsWith('10')).map(bsRow)),
      stockValueEgp:
        stock.stockedProducts > 0 && stock.uncostedProducts === stock.stockedProducts
          ? null
          : money(stock.stockValue),
      stockValueCoverage: `${stock.stockedProducts - stock.uncostedProducts} of ${stock.stockedProducts} stocked products have a cost price`,
      totalAssetsEgp: money(bs.totalAssets),
      totalLiabilitiesEgp: money(bs.totalLiabilities),
      totalEquityEgp: money(bs.totalEquity),
    };
  },
});
const financePnl = readTool<{ from?: string; to?: string }>({
  name: 'finance_profit_and_loss',
  capabilityId: 'finance.overview-reports',
  description:
    'Profit and loss report (تقرير الأرباح والخسائر) for a period (default last 30 days): top revenue and expense accounts, totals and net income in EGP.',
  schema: rangeShape,
  gate: FINANCE_READ,
  read: async (ctx, a) => {
    const { from, to } = await window(ctx.storeId, a, {
      from: new Date(Date.now() - 30 * 86_400_000),
    });
    const r = await profitAndLoss(ctx.storeId, from, to);
    return {
      totalRevenueEgp: money(r.totalRevenue),
      totalExpensesEgp: money(r.totalExpenses),
      netIncomeEgp: money(r.netIncome),
      revenue: top(
        r.revenue.map(x => ({
          code: x.code,
          name: x.nameAr ?? x.nameEn,
          egp: money(x.creditTotal - x.debitTotal),
        }))
      ),
      expenses: top(
        r.expenses.map(x => ({
          code: x.code,
          name: x.nameAr ?? x.nameEn,
          egp: money(x.debitTotal - x.creditTotal),
        }))
      ),
    };
  },
});
const financeBalanceSheet = readTool<{ asOf?: string }>({
  name: 'finance_balance_sheet',
  capabilityId: 'finance.overview-reports',
  description:
    'Balance sheet (الميزانية العمومية) as of a day (default today): assets, liabilities and equity totals in EGP and the biggest accounts of each.',
  schema: shape<{ asOf?: string }>({ asOf: ymd }),
  gate: FINANCE_READ,
  read: async (ctx, a) => {
    const { to } = await window(ctx.storeId, { to: a.asOf }, {});
    const r = await balanceSheet(ctx.storeId, to);
    return {
      totalAssetsEgp: money(r.totalAssets),
      totalLiabilitiesEgp: money(r.totalLiabilities),
      totalEquityEgp: money(r.totalEquity),
      assets: top(r.assets.map(bsRow)),
      liabilities: top(r.liabilities.map(bsRow)),
    };
  },
});
const financeVatReport = readTool<{ from: string; to: string }>({
  name: 'finance_vat_report',
  capabilityId: 'finance.overview-reports',
  description:
    'VAT / tax report (تقرير الضريبة) for a period: taxable sales, tax collected and the breakdown by rate, in EGP. Needs the Business plan. Totals only, no customer rows.',
  schema: shape<{ from: string; to: string }>({ from: ymd, to: ymd }, ['from', 'to']),
  gate: { roles: STORE_ROLES, feature: 'accounting.tax_reports' },
  read: async (ctx, a) => {
    const tz = await storeTimeZone(ctx.storeId);
    const from = zonedDayStart(a.from, tz);
    const to = zonedDayEnd(a.to, tz);
    if (!from || !to) throw new AppError(422, 'invalid_date', 'from and to must be valid dates');
    const r = await generateTaxReport(ctx.storeId, { from, to, timeZone: tz });
    return {
      orderCount: r.summary.orderCount,
      taxableSalesEgp: money(r.summary.totalTaxableSales),
      taxCollectedEgp: money(r.summary.totalTaxCollected),
      byRate: top(
        r.summary.byRate.map(x => ({
          taxRate: x.taxRate,
          taxableEgp: money(x.totalSubtotal),
          taxEgp: money(x.totalTaxCollected),
        }))
      ),
    };
  },
});
const bankUnmatchedList = readTool<{ statementId?: string }>({
  name: 'bank_unmatched_list',
  capabilityId: 'finance.overview-reports',
  description:
    'Bank reconciliation worklist (مطابقة كشف البنك): without an id, the latest imported bank statements; with a statement id, up to 10 unmatched bank lines each with candidate journal entries of the same amount. Then propose each line with bank_match_suggest, one card per line.',
  schema: shape<{ statementId?: string }>({ statementId: f.id('A bank statement id.') }),
  gate: { roles: STORE_ROLES, feature: BANK_FEATURE },
  untrusted: true, // bank descriptions are third-party text
  read: async (ctx, a) => {
    const db = await storeDb(ctx.storeId);
    if (!a.statementId) {
      const rows = await db.bankStatement.findMany({
        where: { storeId: ctx.storeId },
        orderBy: [{ importedAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: { id: true, fileName: true, importedAt: true, status: true },
      });
      return rows.map(r => ({
        id: r.id,
        fileName: r.fileName,
        importedAt: iso(r.importedAt),
        status: String(r.status),
      }));
    }
    const txs = await db.bankTransaction.findMany({
      where: { storeId: ctx.storeId, statementId: a.statementId, matchStatus: 'unmatched' },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      take: 10,
      select: { id: true, date: true, description: true, amountFils: true, direction: true },
    });
    return Promise.all(
      txs.map(async t => {
        const lines = await db.journalLine.findMany({
          where: {
            account: { storeId: ctx.storeId },
            ...(t.direction === 'debit'
              ? { debit: { gte: t.amountFils - 5, lte: t.amountFils + 5 } }
              : { credit: { gte: t.amountFils - 5, lte: t.amountFils + 5 } }),
            entry: {
              storeId: ctx.storeId,
              status: { in: ['posted', 'reversed'] },
              postedAt: {
                gte: new Date(t.date.getTime() - 3 * 86_400_000),
                lte: new Date(t.date.getTime() + 3 * 86_400_000),
              },
            },
          },
          take: 3,
          select: { entry: { select: { id: true, entryNumber: true, memo: true } } },
        });
        return {
          id: t.id,
          date: iso(t.date)?.slice(0, 10),
          description: t.description,
          amountEgp: egp(t.amountFils),
          direction: String(t.direction),
          candidates: lines.map(l => ({
            journalEntryId: l.entry.id,
            entryNumber: String(l.entry.entryNumber),
            memo: l.entry.memo,
          })),
        };
      })
    );
  },
});
const anomaliesList = readTool<Record<string, never>>({
  name: 'profit_anomalies_list',
  capabilityId: 'finance.overview-reports',
  description:
    'Open profit anomalies (شذوذ الربحية): up to 10 unacknowledged alerts with id, metric, severity and the change. Acknowledge one with profit_anomaly_ack.',
  schema: shape<Record<string, never>>({}),
  gate: { roles: STORE_ROLES, feature: 'accounting.profit_anomaly' },
  read: async ctx => {
    const rows = await (
      await storeDb(ctx.storeId)
    ).profitAnomaly.findMany({
      where: { storeId: ctx.storeId, acknowledged: false },
      orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }],
      take: 10,
      select: {
        id: true,
        metric: true,
        severity: true,
        deltaPercent: true,
        explanationAr: true,
        explanationEn: true,
        detectedAt: true,
      },
    });
    return rows.map(r => ({
      id: r.id,
      metric: String(r.metric),
      severity: String(r.severity),
      deltaPercent: Number(r.deltaPercent.toFixed(1)),
      explanation: r.explanationAr ?? r.explanationEn,
      detectedAt: iso(r.detectedAt),
    }));
  },
});

const INVOICE_GATE: Gate = { roles: ['store_admin', 'staff'] }; // routes/fiscal-document.routes.ts: authorize('store_admin', 'super_admin', 'staff'), no requireFeature
const DOC_TYPES = [
  'tax_invoice',
  'receipt',
  'credit_note',
  'refund_receipt',
  'order_record',
  'billing_record',
] as [string, ...string[]];
const docRow = (d: Rec) => ({
  id: d.id,
  number: d.number,
  docType: d.docType,
  status: d.status,
  issuedAt: iso(d.issuedAt as Date),
  originalNumber: d.originalNumber ?? null,
  netEgp: money(d.netAmount as number),
  vatEgp: money(d.vatAmount as number),
  totalEgp: money(d.totalAmount as number),
  currency: d.currency,
});
const invoicesList = readTool<{ docType?: string; q?: string }>({
  name: 'invoices_list',
  capabilityId: 'finance.invoices-fiscal',
  description:
    'List the latest invoices, receipts and credit notes (فواتيري / اشعار دائن): up to 10, newest first, optionally by type or by document number (e.g. INV-000042). Totals in EGP.',
  schema: shape<{ docType?: string; q?: string }>({
    docType: f.enum(DOC_TYPES, 'Document type.'),
    q: f.str('Document number to search.', { max: 64 }),
  }),
  gate: INVOICE_GATE,
  read: async (ctx, a) => {
    const r = await FiscalDocumentService.list(ctx.storeId, {
      limit: 10,
      docType: a.docType as FiscalDocTypeValue | undefined,
      q: a.q,
    });
    return {
      documents: r.documents.map(d => ({
        ...docRow(d as unknown as Rec),
        orderNumber: d.orderNumber,
      })),
      hasMore: r.nextCursor !== null,
    };
  },
});
const invoiceGet = readTool<{ documentId: string }>({
  name: 'invoice_get',
  capabilityId: 'finance.invoices-fiscal',
  description:
    'One invoice, receipt or credit note by its id (from invoices_list): number, type, status, date and totals in EGP. The printable PDF is on the Invoices page.',
  schema: shape<{ documentId: string }>({ documentId: f.id('The document id.') }, ['documentId']),
  gate: INVOICE_GATE,
  read: async (ctx, a) =>
    docRow((await FiscalDocumentService.getById(ctx.storeId, a.documentId)) as unknown as Rec),
});

export function financeSuggestTools(): ToolSpec[] {
  return [
    // Ruling SL-E4-1: `journalEntrySuggest` is NOT offered. The route is super_admin only ("store admins post via service helpers, not raw GL, in v1"), so a
    // merchant could not post a raw journal entry themselves and the assistant may not either (it never does more than the merchant could). It stays
    // built and tested; offering it is one line here once the route allows owners. Cost if wrong: the assistant cannot post a raw entry, only suggest the
    // matched/booked ones the screens allow.
    accountAdd,
    bankMatch,
    fxRateSet,
    anomalyAck,
    vatSubmit,
    financeOverview,
    financePnl,
    financeBalanceSheet,
    financeVatReport,
    bankUnmatchedList,
    anomaliesList,
    invoicesList,
    invoiceGet,
  ];
}
