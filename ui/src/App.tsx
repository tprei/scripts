import { useSignalEffect } from '@preact/signals'
import { sessions, isLoading, error, refresh } from './store'
import { SessionList } from './components/SessionList'
import type { MinionSession } from './types'

function handleThreadClick(session: MinionSession) {
  if (window.Telegram?.WebApp) {
    const webapp = window.Telegram.WebApp
    if (session.threadId && session.chatId) {
      const threadUrl = `https://t.me/c/${Math.abs(session.chatId)}/${session.threadId}`
      webapp.openTelegramLink?.(threadUrl)
    }
  } else if (session.threadId && session.chatId) {
    const threadUrl = `https://t.me/c/${Math.abs(session.chatId)}/${session.threadId}`
    window.open(threadUrl, '_blank')
  }
}

function ErrorMessage() {
  if (!error.value) return null
  return (
    <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
      {error.value}
    </div>
  )
}

function RefreshButton() {
  return (
    <button
      onClick={() => refresh()}
      disabled={isLoading.value}
      class="bg-telegram-button text-telegram-buttonText px-4 py-2 rounded font-medium disabled:opacity-50"
    >
      {isLoading.value ? 'Refreshing...' : 'Refresh'}
    </button>
  )
}

export default function App() {
  useSignalEffect(() => {
    refresh()
  })

  return (
    <div class="min-h-screen p-4">
      <header class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-bold text-telegram-text">Minions Dashboard</h1>
        <RefreshButton />
      </header>

      <ErrorMessage />

      <section>
        <h2 class="text-lg font-semibold text-telegram-text mb-3">Sessions</h2>
        <SessionList
          sessions={sessions.value}
          isLoading={isLoading.value}
          onThreadClick={handleThreadClick}
        />
      </section>
    </div>
  )
}
