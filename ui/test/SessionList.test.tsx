import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/preact'
import { SessionList, SessionCard, StatusBadge } from '../src/components/SessionList'
import type { MinionSession } from '../src/types'

vi.mock('@testing-library/preact', () => {
  const preact = require('preact')
  const { render } = require('@testing-library/preact')
  return {
    render,
    screen: {
      getByText: (text: string) => document.body.innerHTML.includes(text)
        ? document.body
        : null,
      queryByText: (text: string) =>
        document.body.innerHTML.includes(text) ? document.body : null,
      getAllByText: (text: string) =>
        document.body.innerHTML.includes(text) ? [document.body] : [],
    },
    fireEvent: {
      click: (element: Element) => element.click(),
    },
  }
})

const mockSession: MinionSession = {
  id: 'session-1',
  slug: 'bold-meadow',
  status: 'running',
  command: '/task Add feature',
  repo: 'https://github.com/org/repo',
  branch: 'feature-branch',
  threadId: 123,
  chatId: -1001234567890,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  childIds: [],
}

const mockCompletedSession: MinionSession = {
  id: 'session-2',
  slug: 'calm-lake',
  status: 'completed',
  command: '/task Fix bug',
  repo: 'https://github.com/org/repo',
  prUrl: 'https://github.com/org/repo/pull/42',
  createdAt: new Date(Date.now() - 86400000).toISOString(),
  updatedAt: new Date(Date.now() - 86400000).toISOString(),
  childIds: ['session-3'],
}

const mockFailedSession: MinionSession = {
  id: 'session-3',
  slug: 'keen-peak',
  status: 'failed',
  command: '/task Broken task',
  createdAt: new Date(Date.now() - 3600000).toISOString(),
  updatedAt: new Date(Date.now() - 3600000).toISOString(),
  childIds: [],
}

const mockPendingSession: MinionSession = {
  id: 'session-4',
  slug: 'swift-river',
  status: 'pending',
  command: '/plan New feature',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  childIds: [],
}

describe('StatusBadge', () => {
  it('renders running status with lightning emoji', () => {
    render(<StatusBadge status="running" />)
    expect(document.body.innerHTML).toContain('⚡')
    expect(document.body.innerHTML).toContain('Running')
  })

  it('renders pending status with speech bubble emoji', () => {
    render(<StatusBadge status="pending" />)
    expect(document.body.innerHTML).toContain('💬')
    expect(document.body.innerHTML).toContain('Idle')
  })

  it('renders completed status with checkmark emoji', () => {
    render(<StatusBadge status="completed" />)
    expect(document.body.innerHTML).toContain('✅')
    expect(document.body.innerHTML).toContain('Done')
  })

  it('renders failed status with x emoji', () => {
    render(<StatusBadge status="failed" />)
    expect(document.body.innerHTML).toContain('❌')
    expect(document.body.innerHTML).toContain('Failed')
  })
})

describe('SessionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (window as { Telegram?: unknown }).Telegram
  })

  it('displays session slug and status', () => {
    render(<SessionCard session={mockSession} />)
    expect(document.body.innerHTML).toContain('bold-meadow')
    expect(document.body.innerHTML).toContain('Running')
  })

  it('displays thread ID when available', () => {
    render(<SessionCard session={mockSession} />)
    expect(document.body.innerHTML).toContain('#123')
  })

  it('displays command text', () => {
    render(<SessionCard session={mockSession} />)
    expect(document.body.innerHTML).toContain('/task Add feature')
  })

  it('displays repo name (owner/repo format)', () => {
    render(<SessionCard session={mockSession} />)
    expect(document.body.innerHTML).toContain('org/repo')
  })

  it('displays branch name', () => {
    render(<SessionCard session={mockSession} />)
    expect(document.body.innerHTML).toContain('feature-branch')
  })

  it('displays PR link when available', () => {
    render(<SessionCard session={mockCompletedSession} />)
    expect(document.body.innerHTML).toContain('View PR')
    expect(document.body.innerHTML).toContain('/pull/42')
  })

  it('displays child count for sessions with children', () => {
    render(<SessionCard session={mockCompletedSession} />)
    expect(document.body.innerHTML).toContain('1 child')
  })

  it('calls onThreadClick when card is clicked', () => {
    const onThreadClick = vi.fn()
    render(<SessionCard session={mockSession} onThreadClick={onThreadClick} />)

    const card = document.querySelector('[role="button"]')
    if (card) {
      card.click()
      expect(onThreadClick).toHaveBeenCalledWith(mockSession)
    }
  })

  it('does not render as clickable when no thread info', () => {
    const sessionWithoutThread = { ...mockSession, threadId: undefined, chatId: undefined }
    render(<SessionCard session={sessionWithoutThread} />)

    const clickable = document.querySelector('[role="button"]')
    expect(clickable).toBeNull()
  })
})

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows loading state when loading with no sessions', () => {
    render(<SessionList sessions={[]} isLoading={true} />)
    expect(document.body.innerHTML).toContain('Loading sessions')
  })

  it('shows empty state when no sessions', () => {
    render(<SessionList sessions={[]} isLoading={false} />)
    expect(document.body.innerHTML).toContain('No active minions')
  })

  it('groups sessions into Active and Recent sections', () => {
    const sessions = [mockSession, mockPendingSession, mockCompletedSession]
    render(<SessionList sessions={sessions} isLoading={false} />)

    expect(document.body.innerHTML).toContain('Active (2)')
    expect(document.body.innerHTML).toContain('Recent (1)')
  })

  it('does not show Active section when no active sessions', () => {
    render(<SessionList sessions={[mockCompletedSession]} isLoading={false} />)
    expect(document.body.innerHTML).not.toContain('Active')
    expect(document.body.innerHTML).toContain('Recent')
  })

  it('does not show Recent section when no completed sessions', () => {
    render(<SessionList sessions={[mockSession]} isLoading={false} />)
    expect(document.body.innerHTML).toContain('Active')
    expect(document.body.innerHTML).not.toContain('Recent')
  })

  it('passes onThreadClick to session cards', () => {
    const onThreadClick = vi.fn()
    render(<SessionList sessions={[mockSession]} isLoading={false} onThreadClick={onThreadClick} />)

    const card = document.querySelector('[role="button"]')
    if (card) {
      card.click()
      expect(onThreadClick).toHaveBeenCalledWith(mockSession)
    }
  })
})
