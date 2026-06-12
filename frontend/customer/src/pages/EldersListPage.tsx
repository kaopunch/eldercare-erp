import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { eldersApi } from '@shared/api/care'
import { useAuthStore } from '../stores/auth'

const MOBILITY_LABEL: Record<string, string> = {
  walk: th.customer.mobility_walk,
  cane: th.customer.mobility_cane,
  walker: th.customer.mobility_walker,
  wheelchair: th.customer.mobility_wheelchair,
  bedridden: th.customer.mobility_bedridden,
}

export default function EldersListPage() {
  const navigate = useNavigate()
  const clear = useAuthStore((state) => state.clear)
  const queryClient = useQueryClient()
  const elders = useQuery({ queryKey: ['elders'], queryFn: eldersApi.list })
  const removeElder = useMutation({
    mutationFn: eldersApi.remove,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['elders'] }),
  })

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-teal-700">{th.customer.elders_title}</h1>
        <Link to="/bookings" className="text-sm font-medium text-teal-700 underline">
          {th.booking.my_bookings}
        </Link>
        <button
          type="button"
          onClick={() => {
            clear()
            navigate('/login')
          }}
          className="text-sm text-gray-500 underline"
        >
          {th.common.logout}
        </button>
      </header>

      {elders.isLoading && <p className="text-gray-500">{th.common.loading}</p>}
      {elders.isError && <p className="rounded-lg bg-red-50 p-3 text-red-700">{th.common.error_generic}</p>}

      {elders.data?.length === 0 && (
        <p className="rounded-xl bg-teal-50 p-6 text-center text-gray-600">{th.customer.elders_empty}</p>
      )}

      <ul className="flex flex-col gap-3">
        {elders.data?.map((elder) => (
          <li key={elder.id} className="rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-lg font-semibold">
                  {elder.full_name}
                  {elder.nickname && <span className="ml-2 text-gray-500">({elder.nickname})</span>}
                </p>
                <p className="text-sm text-gray-500">
                  {elder.mobility ? MOBILITY_LABEL[elder.mobility] : ''}
                  {elder.primary_hospital ? ` · ${elder.primary_hospital}` : ''}
                </p>
              </div>
              <div className="flex gap-2">
                <Link
                  to={`/elders/${elder.id}/edit`}
                  className="rounded-lg border border-teal-600 px-3 py-2 text-sm font-medium text-teal-700"
                >
                  {th.common.edit}
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(th.customer.delete_confirm)) {
                      removeElder.mutate(elder.id)
                    }
                  }}
                  className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-600"
                >
                  {th.common.delete}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <Link
        to="/elders/new"
        className="mt-2 flex min-h-14 items-center justify-center rounded-xl bg-teal-600 text-lg font-semibold text-white"
      >
        + {th.customer.add_elder}
      </Link>
    </main>
  )
}
