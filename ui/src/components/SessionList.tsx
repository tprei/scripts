import { useState, useCallback } from 'preact/hooks'
import type { MinionSession } from '../types'
import { ConfirmDialog, ReplyDialog } from './ConfirmDialog'

type StatusType = MinionSession['status']

interface StatusBadgeProps {
  status: StatusType
}

const STATUS_CONFIG: Record<StatusType, { emoji: string; label: string; className: string }> = {
  pending: { emoji: '💬', label: 'Idle', className: 'bg-gray-100 text-gray-700' },
  running: { emoji: '⚡', label: 'Running', className: 'bg-blue-100 text-blue-700' },
  completed: { emoji: '✅', label: 'Done', className: 'bg-green-100 text-green-700' },
  failed: { emoji: '❌', label: 'Failed', className: 'bg-red-100 text-red-700' },
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status]
  return (
    <span class={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${config.className}`}>
      <span>{config.emoji}</span>
      <span>{config.label}</span>
    </span>
  )
}

interface SessionCardProps {
  session: MinionSession
  onThreadClick?: (session: MinionSession) => void
  onSendReply?: (sessionId: string, message: string) => Promise<void>
  onStopMinion?: (sessionId: string) => Promise<void>
  onCloseSession?: (sessionId: string) => Promise<void>
  isActionLoading?: boolean
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

export function SessionCard({
  session,
  onThreadClick,
  onSendReply,
  onStopMinion,
  onCloseSession,
  isActionLoading = false,
}: SessionCardProps) {
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [showReplyDialog, setShowReplyDialog] = useState(false)

  const handleCardClick = useCallback(() => {
    if (onThreadClick) {
      onThreadClick(session)
    } else if (session.threadId && session.chatId) {
      const threadUrl = `https://t.me/c/${Math.abs(session.chatId)}/${session.threadId}`
      window.open(threadUrl, '_blank')
    }
  }, [session, onThreadClick])

  const handleStopClick = useCallback((e: Event) => {
    e.stopPropagation()
    setShowStopConfirm(true)
  }, [])

  const handleCloseClick = useCallback((e: Event) => {
    e.stopPropagation()
    setShowCloseConfirm(true)
  }, [])

  const handleReplyClick = useCallback((e: Event) => {
    e.stopPropagation()
    setShowReplyDialog(true)
  }, [])

  const handleConfirmStop = useCallback(async () => {
    if (onStopMinion) {
      await onStopMinion(session.id)
      setShowStopConfirm(false)
    }
  }, [session.id, onStopMinion])

  const handleConfirmClose = useCallback(async () => {
    if (onCloseSession) {
      await onCloseSession(session.id)
      setShowCloseConfirm(false)
    }
  }, [session.id, onCloseSession])

  const handleSendReply = useCallback(
    async (_sessionId: string, message: string) => {
      if (onSendReply) {
        await onSendReply(session.id, message)
        setShowReplyDialog(false)
      }
    },
    [session.id, onSendReply]
  )

  const isActive = session.status === 'running' || session.status === 'pending'
  const isClickable = Boolean(session.threadId && session.chatId)

  return (
    <>
      <div
        class={`bg-telegram-secondary rounded-lg p-4 mb-3 ${isClickable ? 'cursor-pointer hover:opacity-90 transition-opacity active:scale-[0.98]' : ''}`}
        onClick={isClickable ? handleCardClick : undefined}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
      >
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <h3 class="font-semibold text-telegram-text">{session.slug}</h3>
            {session.threadId && (
              <span class="text-xs text-telegram-hint font-mono">#{session.threadId}</span>
            )}
          </div>
          <StatusBadge status={session.status} />
        </div>

        <p class="text-sm text-telegram-hint mb-2 line-clamp-2">{session.command}</p>

        <div class="flex items-center justify-between text-xs text-telegram-hint">
          <div class="flex items-center gap-2">
            {session.repo && (
              <span class="truncate max-w-[180px]">{session.repo.split('/').slice(-2).join('/')}</span>
            )}
            {session.branch && (
              <span class="bg-telegram-secondary px-1.5 py-0.5 rounded text-telegram-hint">
                {session.branch}
              </span>
            )}
          </div>
          <span>{formatRelativeTime(session.updatedAt)}</span>
        </div>

        {session.prUrl && (
          <a
            href={session.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs text-telegram-link underline mt-2 block hover:opacity-80"
            onClick={(e) => e.stopPropagation()}
          >
            View PR
          </a>
        )}

        {session.childIds.length > 0 && (
          <div class="mt-2 text-xs text-telegram-hint">
            {session.childIds.length} child{session.childIds.length > 1 ? 'ren' : ''}
          </div>
        )}

        {/* Action buttons for active sessions */}
        {isActive && (onSendReply || onStopMinion || onCloseSession) && (
          <div class="flex gap-2 mt-3 pt-3 border-t border-gray-200">
            {onSendReply && (
              <button
                onClick={handleReplyClick}
                disabled={isActionLoading}
                class="flex-1 px-3 py-1.5 text-xs font-medium bg-telegram-button text-telegram-buttonText rounded hover:opacity-90 transition-opacity disabled:opacity-50"
                title="Send a reply to the minion thread"
              >
                Reply
              </button>
            )}
            {onStopMinion && session.status === 'running' && (
              <button
                onClick={handleStopClick}
                disabled={isActionLoading}
                class="px-3 py-1.5 text-xs font-medium bg-orange-100 text-orange-700 rounded hover:bg-orange-200 transition-colors disabled:opacity-50"
                title="Stop the running minion"
              >
                Stop
              </button>
            )}
            {onCloseSession && (
              <button
                onClick={handleCloseClick}
                disabled={isActionLoading}
                class="px-3 py-1.5 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors disabled:opacity-50"
                title="Close this session"
              >
                Close
              </button>
            )}
          </div>
        )}
      </div>

      {/* Confirmation dialogs */}
      <ConfirmDialog
        isOpen={showStopConfirm}
        title="Stop Minion"
        message="Are you sure you want to stop this minion? Any in-progress work will be interrupted."
        confirmLabel="Stop"
        confirmVariant="danger"
        isLoading={isActionLoading}
        onConfirm={handleConfirmStop}
        onCancel={() => setShowStopConfirm(false)}
      />

      <ConfirmDialog
        isOpen={showCloseConfirm}
        title="Close Session"
        message="Are you sure you want to close this session? This will terminate the minion and clean up resources."
        confirmLabel="Close"
        confirmVariant="danger"
        isLoading={isActionLoading}
        onConfirm={handleConfirmClose}
        onCancel={() => setShowCloseConfirm(false)}
      />

      <ReplyDialog
        isOpen={showReplyDialog}
        sessionId={session.id}
        isLoading={isActionLoading}
        onSend={handleSendReply}
        onCancel={() => setShowReplyDialog(false)}
      />
    </>
  )
}

interface SessionListProps {
  sessions: MinionSession[]
  isLoading: boolean
  onThreadClick?: (session: MinionSession) => void
  onSendReply?: (sessionId: string, message: string) => Promise<void>
  onStopMinion?: (sessionId: string) => Promise<void>
  onCloseSession?: (sessionId: string) => Promise<void>
  isActionLoading?: boolean
}

export function SessionList({
  sessions,
  isLoading,
  onThreadClick,
  onSendReply,
  onStopMinion,
  onCloseSession,
  isActionLoading = false,
}: SessionListProps) {
  if (isLoading && sessions.length === 0) {
    return (
      <div class="text-center py-8">
        <div class="animate-pulse text-telegram-hint">Loading sessions...</div>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div class="text-center py-8">
        <div class="text-telegram-hint">No active minions</div>
        <div class="text-xs text-telegram-hint mt-1">Start a task with /task or /plan</div>
      </div>
    )
  }

  const activeSessions = sessions.filter((s) => s.status === 'running' || s.status === 'pending')
  const completedSessions = sessions.filter((s) => s.status === 'completed' || s.status === 'failed')

  return (
    <div>
      {activeSessions.length > 0 && (
        <section class="mb-6">
          <h3 class="text-sm font-medium text-telegram-hint mb-3 uppercase tracking-wide">
            Active ({activeSessions.length})
          </h3>
          {activeSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onThreadClick={onThreadClick}
              onSendReply={onSendReply}
              onStopMinion={onStopMinion}
              onCloseSession={onCloseSession}
              isActionLoading={isActionLoading}
            />
          ))}
        </section>
      )}

      {completedSessions.length > 0 && (
        <section>
          <h3 class="text-sm font-medium text-telegram-hint mb-3 uppercase tracking-wide">
            Recent ({completedSessions.length})
          </h3>
          {completedSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onThreadClick={onThreadClick}
              onCloseSession={onCloseSession}
              isActionLoading={isActionLoading}
            />
          ))}
        </section>
      )}
    </div>
  )
}
