import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/preact'
import { parsePrUrl, PrLink } from '../src/components/PrLink'

describe('parsePrUrl', () => {
  it('extracts owner, repo, and PR number from a standard GitHub PR URL', () => {
    const result = parsePrUrl('https://github.com/acme/widgets/pull/42')
    expect(result).toEqual({ owner: 'acme', repo: 'widgets', number: 42 })
  })

  it('handles URLs with trailing path segments', () => {
    const result = parsePrUrl('https://github.com/org/repo/pull/123/files')
    expect(result).toEqual({ owner: 'org', repo: 'repo', number: 123 })
  })

  it('returns null for non-GitHub URLs', () => {
    expect(parsePrUrl('https://gitlab.com/org/repo/merge_requests/1')).toBeNull()
  })

  it('returns null for GitHub URLs without a pull number', () => {
    expect(parsePrUrl('https://github.com/org/repo')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parsePrUrl('')).toBeNull()
  })

  it('handles hyphenated owner and repo names', () => {
    const result = parsePrUrl('https://github.com/my-org/my-repo/pull/7')
    expect(result).toEqual({ owner: 'my-org', repo: 'my-repo', number: 7 })
  })
})

describe('PrLink', () => {
  beforeEach(() => {
    cleanup()
    delete (window as { Telegram?: unknown }).Telegram
  })

  it('renders full owner/repo#number label by default', () => {
    render(<PrLink prUrl="https://github.com/acme/widgets/pull/42" />)
    expect(screen.getByText('acme/widgets#42')).toBeTruthy()
  })

  it('renders compact #number label when compact is true', () => {
    render(<PrLink prUrl="https://github.com/acme/widgets/pull/42" compact />)
    expect(screen.getByText('#42')).toBeTruthy()
  })

  it('falls back to "View PR" for non-parseable URLs', () => {
    render(<PrLink prUrl="https://example.com/some-pr" />)
    expect(screen.getByText('View PR')).toBeTruthy()
  })

  it('renders as an anchor tag with correct href', () => {
    render(<PrLink prUrl="https://github.com/acme/widgets/pull/42" />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/42')
  })

  it('has title attribute with full PR info', () => {
    render(<PrLink prUrl="https://github.com/acme/widgets/pull/42" />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('title')).toBe('acme/widgets PR #42')
  })

  it('sets target="_blank" and rel="noopener noreferrer"', () => {
    render(<PrLink prUrl="https://github.com/acme/widgets/pull/42" />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })
})
