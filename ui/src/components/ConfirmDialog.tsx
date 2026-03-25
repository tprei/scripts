import { useCallback, useEffect } from 'preact/hooks'

interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: 'danger' | 'primary'
  isLoading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      } else if (e.key === 'Enter' && !isLoading) {
        onConfirm()
      }
    },
    [onCancel, onConfirm, isLoading]
  )

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  if (!isOpen) return null

  const confirmButtonClass =
    confirmVariant === 'danger'
      ? 'bg-red-500 text-white hover:bg-red-600'
      : 'bg-telegram-button text-telegram-buttonText hover:opacity-90'

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div
        class="relative bg-telegram-bg rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <h3 id="dialog-title" class="text-lg font-semibold text-telegram-text mb-2">
          {title}
        </h3>
        <p class="text-sm text-telegram-hint mb-4">{message}</p>
        <div class="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isLoading}
            class="px-4 py-2 text-sm font-medium text-telegram-hint hover:bg-telegram-secondary rounded transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            class={`px-4 py-2 text-sm font-medium rounded transition-colors disabled:opacity-50 ${confirmButtonClass}`}
          >
            {isLoading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ReplyDialogProps {
  isOpen: boolean
  sessionId: string
  isLoading?: boolean
  onSend: (sessionId: string, message: string) => void
  onCancel: () => void
}

export function ReplyDialog({ isOpen, sessionId, isLoading, onSend, onCancel }: ReplyDialogProps) {
  const handleSubmit = useCallback(
    (e: Event) => {
      e.preventDefault()
      const form = e.target as HTMLFormElement
      const input = form.elements.namedItem('message') as HTMLInputElement
      const message = input.value.trim()
      if (message) {
        onSend(sessionId, message)
      }
    },
    [sessionId, onSend]
  )

  if (!isOpen) return null

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/50" onClick={onCancel} />
      <form
        onSubmit={handleSubmit}
        class="relative bg-telegram-bg rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reply-dialog-title"
      >
        <h3 id="reply-dialog-title" class="text-lg font-semibold text-telegram-text mb-2">
          Send Reply
        </h3>
        <p class="text-xs text-telegram-hint mb-3">
          Your message will be sent to the minion's Telegram thread.
        </p>
        <textarea
          name="message"
          rows={3}
          placeholder="Enter your message..."
          disabled={isLoading}
          class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-telegram-button focus:border-transparent disabled:opacity-50 bg-telegram-secondary text-telegram-text"
          autoFocus
        />
        <div class="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            class="px-4 py-2 text-sm font-medium text-telegram-hint hover:bg-telegram-secondary rounded transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            class="bg-telegram-button text-telegram-buttonText px-4 py-2 text-sm font-medium rounded hover:opacity-90 transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}
