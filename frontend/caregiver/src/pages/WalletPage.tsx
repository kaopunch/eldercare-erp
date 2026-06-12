import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { walletApi, reviewsApi } from '@shared/api/care'
import type { ApiError } from '@shared/api/client'
import CaregiverNav from '../components/CaregiverNav'

const inputClass = 'rounded-xl border border-gray-300 p-3 text-base'

function baht(satang: number): string {
  return (satang / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 })
}

const TYPE_LABEL: Record<string, string> = {
  earning: th.wallet.type_earning,
  withdrawal: th.wallet.type_withdrawal,
  adjustment: th.wallet.type_adjustment,
}

const WD_LABEL: Record<string, string> = {
  pending: th.wallet.wd_pending,
  paid: th.wallet.wd_paid,
  rejected: th.wallet.wd_rejected,
}

export default function WalletPage() {
  const queryClient = useQueryClient()
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: walletApi.get })
  const reviews = useQuery({ queryKey: ['my-reviews'], queryFn: reviewsApi.received })

  const [showWithdraw, setShowWithdraw] = useState(false)
  const [amount, setAmount] = useState('')
  const [bank, setBank] = useState('')
  const [accountNo, setAccountNo] = useState('')
  const [accountName, setAccountName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const withdrawMutation = useMutation({
    mutationFn: () =>
      walletApi.withdraw({
        amount_satang: Math.round(Number(amount) * 100),
        bank_info: { bank, account_no: accountNo, account_name: accountName },
      }),
    onSuccess: async () => {
      setNotice(th.wallet.requested)
      setShowWithdraw(false)
      setAmount('')
      await queryClient.invalidateQueries({ queryKey: ['wallet'] })
    },
    onError: (err) => setError((err as unknown as ApiError).message || th.common.error_generic),
  })

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4 pb-24">
      <h1 className="text-xl font-bold text-amber-700">{th.wallet.title}</h1>

      <section className="rounded-2xl bg-amber-600 p-6 text-white">
        <p className="text-sm opacity-80">{th.wallet.balance}</p>
        <p className="text-4xl font-extrabold">
          {wallet.data ? baht(wallet.data.balance_satang) : '–'} <span className="text-lg">{th.booking.baht}</span>
        </p>
        <button
          type="button"
          onClick={() => setShowWithdraw(!showWithdraw)}
          className="mt-4 min-h-12 w-full rounded-xl bg-white font-bold text-amber-700"
        >
          {th.wallet.withdraw}
        </button>
      </section>

      {notice && <p className="rounded-lg bg-green-50 p-3 text-green-700">{notice}</p>}
      {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}

      {showWithdraw && (
        <section className="flex flex-col gap-3 rounded-xl border border-amber-200 p-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.wallet.amount_baht}</span>
            <input type="number" min={100} value={amount} onChange={(event) => setAmount(event.target.value)} className={inputClass} />
            <span className="text-sm text-gray-500">{th.wallet.withdraw_min}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{th.wallet.bank}</span>
            <input value={bank} onChange={(event) => setBank(event.target.value)} className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="font-medium">{th.wallet.account_no}</span>
              <input value={accountNo} onChange={(event) => setAccountNo(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium">{th.wallet.account_name}</span>
              <input value={accountName} onChange={(event) => setAccountName(event.target.value)} className={inputClass} />
            </label>
          </div>
          <button
            type="button"
            disabled={withdrawMutation.isPending || !amount || !bank || !accountNo || !accountName}
            onClick={() => {
              setError(null)
              withdrawMutation.mutate()
            }}
            className="min-h-14 rounded-xl bg-amber-600 text-lg font-semibold text-white disabled:opacity-50"
          >
            {withdrawMutation.isPending ? th.common.loading : th.wallet.submit_withdraw}
          </button>
          <p className="text-center text-sm text-gray-500">{th.wallet.withdraw_note}</p>
        </section>
      )}

      {wallet.data && wallet.data.withdrawals.length > 0 && (
        <ul className="flex flex-col gap-2">
          {wallet.data.withdrawals.map((withdrawal) => (
            <li key={withdrawal.id} className="flex justify-between rounded-lg border border-gray-100 p-3 text-sm">
              <span>
                {th.wallet.withdraw} {baht(withdrawal.amount)} {th.booking.baht}
              </span>
              <span className={withdrawal.status === 'paid' ? 'text-green-600' : withdrawal.status === 'rejected' ? 'text-red-600' : 'text-amber-600'}>
                {WD_LABEL[withdrawal.status]}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="font-bold text-gray-700">{th.wallet.history}</h2>
      <ul className="flex flex-col gap-2">
        {wallet.data?.ledger.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between rounded-lg border border-gray-100 p-3">
            <div>
              <p className="font-medium">{TYPE_LABEL[entry.type]}</p>
              {entry.note && <p className="text-xs text-gray-500">{entry.note}</p>}
            </div>
            <div className="text-right">
              <p className={`font-semibold ${entry.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {entry.amount >= 0 ? '+' : ''}
                {baht(entry.amount)}
              </p>
              <p className="text-xs text-gray-400">= {baht(entry.balance_after)}</p>
            </div>
          </li>
        ))}
      </ul>

      <h2 className="mt-2 font-bold text-gray-700">{th.review.received_title}</h2>
      {reviews.data?.length === 0 && <p className="text-gray-500">{th.review.no_reviews}</p>}
      <ul className="flex flex-col gap-2">
        {reviews.data?.map((review) => (
          <li key={review.id} className="rounded-lg border border-gray-100 p-3">
            <p className="text-amber-500">{'★'.repeat(review.stars)}{'☆'.repeat(5 - review.stars)}</p>
            {review.comment && <p className="mt-1 text-sm">{review.comment}</p>}
            {review.tags.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">
                {review.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                    {tag}
                  </span>
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>

      <CaregiverNav active="wallet" />
    </main>
  )
}
