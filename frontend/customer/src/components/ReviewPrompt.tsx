import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { th } from '@shared/i18n/th'
import { reviewsApi } from '@shared/api/care'

const TAGS = [
  th.review.tag_ontime,
  th.review.tag_care,
  th.review.tag_comm,
  th.review.tag_polite,
  th.review.tag_report,
]

/** Spec C7: first open after a completed job prompts for a review. */
export default function ReviewPrompt() {
  const queryClient = useQueryClient()
  const pending = useQuery({ queryKey: ['pending-reviews'], queryFn: reviewsApi.pending })
  const [dismissed, setDismissed] = useState(false)
  const [stars, setStars] = useState(5)
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [done, setDone] = useState(false)

  const target = pending.data?.[0]

  const submit = useMutation({
    mutationFn: () =>
      reviewsApi.create({ booking_id: target!.id, stars, comment: comment || null, tags }),
    onSuccess: async () => {
      setDone(true)
      setTimeout(async () => {
        setDone(false)
        await queryClient.invalidateQueries({ queryKey: ['pending-reviews'] })
      }, 1500)
    },
  })

  if (!target || dismissed) return null

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5">
        {done ? (
          <p className="p-6 text-center text-lg font-semibold text-green-700">{th.review.thanks}</p>
        ) : (
          <>
            <h2 className="text-lg font-bold">{th.review.title}</h2>
            <p className="mt-1 text-sm text-gray-600">
              {th.review.prompt} ({target.scheduled_date} · {target.destination_name})
            </p>
            <div className="mt-3 flex justify-center gap-2 text-4xl">
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStars(value)}
                  className={value <= stars ? 'text-amber-400' : 'text-gray-300'}
                  aria-label={`${value} ${th.review.stars_label}`}
                >
                  ★
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() =>
                    setTags(tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag])
                  }
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                    tags.includes(tag) ? 'bg-teal-600 text-white' : 'border border-gray-300 text-gray-600'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={th.review.comment_label}
              rows={2}
              className="mt-3 w-full rounded-xl border border-gray-300 p-3"
            />
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="min-h-12 flex-1 rounded-xl border border-gray-300 font-medium"
              >
                {th.review.later}
              </button>
              <button
                type="button"
                disabled={submit.isPending}
                onClick={() => submit.mutate()}
                className="min-h-12 flex-1 rounded-xl bg-teal-600 font-semibold text-white disabled:opacity-50"
              >
                {submit.isPending ? th.common.loading : th.review.submit}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
