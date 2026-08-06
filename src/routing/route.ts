export type Route =
  | { type: "session"; sessionSlug: string }
  | { type: "group"; groupId: string }
  | { type: "home" }

export function parseHash(hash: string): Route {
  const sessionMatch = hash.match(/^#\/s\/([^/]+)/)
  if (sessionMatch) {
    return { type: "session", sessionSlug: decodeURIComponent(sessionMatch[1]) }
  }

  const groupMatch = hash.match(/^#\/g\/([^/]+)/)
  if (groupMatch) {
    return { type: "group", groupId: decodeURIComponent(groupMatch[1]) }
  }

  return { type: "home" }
}

export function buildHash(route: Route): string {
  switch (route.type) {
    case "session":
      return `#/s/${encodeURIComponent(route.sessionSlug)}`
    case "group":
      return `#/g/${encodeURIComponent(route.groupId)}`
    case "home":
      return "#/"
  }
}
