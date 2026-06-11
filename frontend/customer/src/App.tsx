import { th } from '@shared/i18n/th'

function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-6">
      <h1 className="text-2xl font-bold">{th.customer.portalName}</h1>
      <p className="text-gray-600">{th.customer.scaffold_welcome}</p>
    </main>
  )
}

export default App
