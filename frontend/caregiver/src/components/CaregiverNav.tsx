import { Link } from 'react-router-dom'
import { th } from '@shared/i18n/th'

const TABS = [
  { key: 'jobs', to: '/jobs', label: th.caregiver.nav_jobs, icon: '💼' },
  { key: 'availability', to: '/availability', label: th.caregiver.nav_availability, icon: '📅' },
  { key: 'profile', to: '/onboard', label: th.caregiver.nav_profile, icon: '👤' },
] as const

export default function CaregiverNav({ active }: { active: (typeof TABS)[number]['key'] }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 mx-auto flex max-w-md border-t border-gray-200 bg-white">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          className={`flex min-h-16 flex-1 flex-col items-center justify-center gap-0.5 text-sm font-medium ${
            active === tab.key ? 'text-amber-700' : 'text-gray-400'
          }`}
        >
          <span aria-hidden>{tab.icon}</span>
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
