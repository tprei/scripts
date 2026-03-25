import { useSignalEffect } from '@preact/signals'
import {
  sessions,
  dags,
  isLoading,
  error,
  refresh,
  sendReply,
  stopMinion,
  closeSession,
  startSse,
  stopSse,
  sseConnected,
  actionState,
  clearActionError,
} from './store'
import { SessionList } from './components/SessionList'
import { DagList } from './components/DagView'
import type { MinionSession, DagNode } from './types'

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

function handleDagNodeClick(node: DagNode) {
  if (node.session) {
    handleThreadClick(node.session)
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

function ActionError() {
  if (!actionState.value.error) return null
  return (
    <div class="bg-orange-100 border border-orange-400 text-orange-700 px-4 py-3 rounded mb-4 flex items-center justify-between">
      <span>{actionState.value.error}</span>
      <button onClick={clearActionError} class="text-orange-700 hover:text-orange-900 font-medium">
        Dismiss
      </button>
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

function ConnectionStatus() {
  return (
    <div class="flex items-center gap-2 text-xs text-telegram-hint">
      <span
        class={`w-2 h-2 rounded-full ${sseConnected.value ? 'bg-green-500' : 'bg-gray-400'}`}
      />
      <span>{sseConnected.value ? 'Live' : 'Offline'}</span>
    </div>
  )
}

export default function App() {
  useSignalEffect(() => {
    refresh()
    startSse()
  })

  // Cleanup SSE on unmount
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', stopSse)
  }

  return (
    <div class="min-h-screen p-4">
      <header class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-bold text-telegram-text">Minions Dashboard</h1>
        <div class="flex items-center gap-4">
          <ConnectionStatus />
          <RefreshButton />
        </div>
      </header>

      <ErrorMessage />
      <ActionError />

      <section>
        <h2 class="text-lg font-semibold text-telegram-text mb-3">Sessions</h2>
        <SessionList
          sessions={sessions.value}
          isLoading={isLoading.value}
          onThreadClick={handleThreadClick}
          onSendReply={sendReply}
          onStopMinion={stopMinion}
          onCloseSession={closeSession}
          isActionLoading={actionState.value.isLoading}
        />
      </section>

      <DagList
        dags={dags.value}
        isLoading={isLoading.value}
        onNodeClick={handleDagNodeClick}
      />
    </div>
  )
}
